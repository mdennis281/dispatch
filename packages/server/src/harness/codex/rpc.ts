/**
 * The `codex app-server` JSON-RPC connection.
 *
 * Codex's app server is a long-lived process speaking newline-delimited
 * JSON-RPC 2.0 over stdio. Unlike the Agent SDK — where every `query()` spawns
 * its own subprocess owning exactly one session — ONE app-server process hosts
 * many threads at once, and every notification carries the `threadId` it
 * belongs to. So this module is a multiplexer: one process, one reader loop,
 * fanned out to per-thread listeners.
 *
 * That difference is load-bearing for Dispatch. Six concurrent Claude chats
 * means six `claude` subprocesses; six concurrent Codex chats means six threads
 * inside one process. The connection is therefore reference-counted rather than
 * per-session, and only tears down when the last session lets go.
 *
 * Three message shapes arrive on stdout and must not be confused:
 *   - a RESPONSE  (`id` + `result`/`error`) — answers something we asked
 *   - a REQUEST   (`id` + `method`)         — the server asking US something,
 *                                             e.g. an approval; MUST be answered
 *                                             or the agent blocks forever
 *   - a NOTIFICATION (`method`, no `id`)    — fire and forget
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

/** A JSON-RPC frame in either direction. */
export interface RpcFrame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** A server→client request awaiting our answer. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** How the connection spawns its process — injectable so tests never fork. */
export interface CodexProcess {
  stdin: { write(chunk: string): void; end(): void };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", cb: (code: number | null) => void): void;
}

export interface CodexConnectionOpts {
  /** Path to the `codex` binary. */
  exePath: string;
  /** Extra `-c key=value` config overrides applied to every thread. */
  configOverrides?: string[];
  /** Injectable spawner (tests). */
  spawnProcess?: () => CodexProcess;
  /** Called for every stderr line — surfaced in the boot log. */
  onStderr?: (line: string) => void;
  /** Client identity sent at initialize. */
  clientInfo?: { name: string; title?: string; version: string };
}

/** How long to wait for the initialize handshake before giving up. */
const INIT_TIMEOUT_MS = 30_000;

/**
 * A live connection to one `codex app-server`.
 *
 * Not exported as a singleton — {@link sharedCodexConnection} owns the
 * ref-counted instance the harness actually uses. Keeping the class free of
 * global state is what makes it testable against a scripted fake process.
 */
export class CodexConnection {
  private proc?: CodexProcess;
  private nextId = 1;
  private readonly pending = new Map<number | string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  /** Per-thread notification listeners, keyed by threadId. */
  private readonly threadListeners = new Map<string, Set<(f: RpcFrame) => void>>();
  /** Listeners for notifications that carry no threadId (account-level). */
  private readonly globalListeners = new Set<(f: RpcFrame) => void>();
  /** Handlers for server→client requests, keyed by threadId. */
  private readonly requestHandlers = new Map<string, (req: ServerRequest) => void>();
  private readyPromise?: Promise<void>;
  private closed = false;
  private exitError?: Error;

  /** Emits "close" when the process dies, so sessions can fail loudly. */
  readonly events = new EventEmitter();

  constructor(private readonly opts: CodexConnectionOpts) {}

  /** Spawn + handshake, at most once. Safe to await from many callers. */
  ready(): Promise<void> {
    return (this.readyPromise ??= this.boot());
  }

  private async boot(): Promise<void> {
    const proc =
      this.opts.spawnProcess?.() ??
      (spawn(this.opts.exePath, ["app-server", ...(this.opts.configOverrides ?? [])], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as unknown as ChildProcessWithoutNullStreams as unknown as CodexProcess);
    this.proc = proc;

    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    if (proc.stderr) {
      createInterface({ input: proc.stderr }).on("line", (l) => this.opts.onStderr?.(l));
    }
    proc.on("exit", (code) => {
      this.closed = true;
      this.exitError = new Error(`codex app-server exited (code ${code ?? "null"})`);
      // Nothing in flight can ever be answered now — fail them rather than
      // letting a chat hang on a promise that will never settle.
      for (const [, p] of this.pending) p.reject(this.exitError);
      this.pending.clear();
      this.events.emit("close", this.exitError);
    });

    const init = this.request("initialize", {
      clientInfo: {
        name: this.opts.clientInfo?.name ?? "dispatch",
        title: this.opts.clientInfo?.title ?? "Dispatch",
        version: this.opts.clientInfo?.version ?? "0.0.0",
      },
      // `experimentalApi` is what unlocks the v2 surface we depend on:
      // thread/*, turn/*, item/* notifications, and requestUserInput.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const timed = await Promise.race([
      init,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("codex app-server initialize timed out")), INIT_TIMEOUT_MS).unref?.(),
      ),
    ]);
    void timed;
    this.notify("initialized", {});
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      // The app server occasionally prints non-JSON diagnostics; ignoring them
      // is correct — a parse failure here must not kill the reader loop.
      return;
    }

    // A response to something we sent.
    if (frame.id !== undefined && frame.method === undefined) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error.message ?? "codex rpc error"));
      else p.resolve(frame.result);
      return;
    }

    // A server→client request. Route by threadId; anything unroutable still
    // gets an answer, because an unanswered request blocks the agent.
    if (frame.id !== undefined && frame.method) {
      const params = (frame.params ?? {}) as Record<string, unknown>;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const handler = threadId ? this.requestHandlers.get(threadId) : undefined;
      if (handler) handler({ id: frame.id, method: frame.method, params });
      else this.respond(frame.id, {});
      return;
    }

    // A notification.
    if (frame.method) {
      const params = (frame.params ?? {}) as Record<string, unknown>;
      const threadId = this.threadIdOf(params);
      if (threadId) {
        for (const l of this.threadListeners.get(threadId) ?? []) l(frame);
      }
      for (const l of this.globalListeners) l(frame);
    }
  }

  /**
   * Find the thread a notification belongs to.
   *
   * Most carry `threadId` directly; `thread/started` nests it under `thread`,
   * and `turn/*` carry it alongside the turn. Anything without one is
   * account-level (rate limits, login) and goes to the global listeners.
   */
  private threadIdOf(params: Record<string, unknown>): string | undefined {
    if (typeof params.threadId === "string") return params.threadId;
    const thread = params.thread as { id?: unknown } | undefined;
    if (thread && typeof thread.id === "string") return thread.id;
    return undefined;
  }

  /** Send a request and await its response. */
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) throw this.exitError ?? new Error("codex app-server is closed");
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc?.stdin.write(frame + "\n");
    return (await p) as T;
  }

  /** Send a request, but only once the handshake has completed. */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ready();
    return this.request<T>(method, params);
  }

  /** Fire a notification. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Answer a server→client request. */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  /** Answer a server→client request with an error. */
  respondError(id: number | string, message: string): void {
    if (this.closed) return;
    this.proc?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n",
    );
  }

  /** Subscribe to one thread's notifications. Returns an unsubscribe fn. */
  onThread(threadId: string, listener: (f: RpcFrame) => void): () => void {
    let set = this.threadListeners.get(threadId);
    if (!set) this.threadListeners.set(threadId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.threadListeners.delete(threadId);
    };
  }

  /** Subscribe to account-level notifications. Returns an unsubscribe fn. */
  onGlobal(listener: (f: RpcFrame) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /** Register the handler for one thread's server→client requests. */
  onRequest(threadId: string, handler: (req: ServerRequest) => void): () => void {
    this.requestHandlers.set(threadId, handler);
    return () => this.requestHandlers.delete(threadId);
  }

  /** True once the process has exited. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Kill the process. */
  dispose(): void {
    this.closed = true;
    try {
      this.proc?.stdin.end();
    } catch {
      /* already gone */
    }
    this.proc?.kill();
  }
}

/* ------------------------------------------------------- shared, ref-counted */

let shared: { conn: CodexConnection; refs: number } | undefined;

/**
 * Borrow the process-wide connection, spawning it on first use.
 *
 * Ref-counted because Codex threads are cheap but the process is not: opening a
 * seventh chat should not mean a seventh app server. Call the returned
 * `release` when a session is done; the process dies when the count hits zero.
 */
export function acquireCodexConnection(opts: CodexConnectionOpts): {
  conn: CodexConnection;
  release: () => void;
} {
  if (shared?.conn.isClosed()) shared = undefined;
  if (!shared) {
    const conn = new CodexConnection(opts);
    shared = { conn, refs: 0 };
    // A dead process must not stay cached, or every later session inherits it.
    conn.events.once("close", () => {
      if (shared?.conn === conn) shared = undefined;
    });
  }
  shared.refs += 1;
  const held = shared;
  let released = false;
  return {
    conn: held.conn,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs <= 0 && shared === held) {
        shared = undefined;
        held.conn.dispose();
      }
    },
  };
}

/** Drop the shared connection (process teardown, tests). */
export function disposeSharedCodexConnection(): void {
  shared?.conn.dispose();
  shared = undefined;
}
