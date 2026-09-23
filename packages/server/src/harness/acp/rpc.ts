/**
 * An Agent Client Protocol connection: newline-delimited JSON-RPC 2.0 on stdio.
 *
 * ONE PROCESS PER SESSION, deliberately — the opposite of the Codex side.
 *
 * `codex app-server` hosts many threads in one process, so `codex/rpc.ts` is a
 * ref-counted multiplexer that fans notifications out by `threadId`. ACP agents
 * can do that too (goose advertises `sessionCapabilities.list/delete/close`),
 * but taking it would buy one saved process and cost two things worth more:
 *
 *   - `pid()`. Dispatch kills a chat by its process TREE, because every MCP
 *     server the session spawned descends from the agent. A shared process has
 *     no per-chat pid to name — which is exactly why `CodexSession` has to omit
 *     `pid()` and accept the consequence. One process per session gets it back.
 *   - Blast radius. A wedged agent takes down one chat instead of all of them.
 *
 * THREE MESSAGE SHAPES arrive on stdout and must not be confused:
 *   - a RESPONSE     (`id` + `result`/`error`) — answers something we asked
 *   - a REQUEST      (`id` + `method`)         — the agent asking US something:
 *                                                a permission prompt, a file
 *                                                read, a terminal. MUST be
 *                                                answered or the turn hangs
 *                                                forever with no error.
 *   - a NOTIFICATION (`method`, no `id`)       — `session/update`, fire and forget
 *
 * The "MUST be answered" is not theoretical. During the spike a client that
 * advertised `terminal: true` and did not implement `terminal/create` left the
 * agent's tool call pinned at `in_progress` indefinitely — no error, no timeout,
 * no stderr. See {@link DISPATCH_CLIENT_CAPABILITIES}.
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

/** An agent→client request awaiting our answer. */
export interface AgentRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** How the connection spawns its process — injectable so tests never fork. */
export interface AcpProcess {
  pid?: number;
  stdin: { write(chunk: string): void; end(): void };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", cb: (code: number | null) => void): void;
}

/** What the agent said it can do, from the `initialize` response. */
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: Record<string, unknown>;
  };
  agentInfo?: { name?: string; version?: string };
}

export interface AcpConnectionOpts {
  /** Path to the agent binary. */
  exePath: string;
  /** Argv that puts it in ACP-on-stdio mode, e.g. `["acp"]`. */
  args: string[];
  /** Working directory for the agent process. */
  cwd?: string;
  /** Env overlaid on the agent process (provider config, model selection). */
  env?: Record<string, string>;
  /** Injectable spawner (tests). */
  spawnProcess?: () => AcpProcess;
  /** Called for every stderr line — surfaced in the boot log. */
  onStderr?: (line: string) => void;
}

/** How long to wait for the initialize handshake before giving up. */
const INIT_TIMEOUT_MS = 30_000;

/**
 * The ACP protocol version Dispatch speaks.
 *
 * Sent at `initialize`; the agent answers with its own and the lower of the two
 * governs. Pinned rather than echoed back from the agent so a protocol bump is
 * a code change we notice, not a silent behaviour change.
 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The client capabilities Dispatch advertises.
 *
 * `terminal: false` is LOAD-BEARING, not a TODO. Advertising it true moves
 * command execution to the client: the agent stops running shell commands and
 * starts sending `terminal/create` / `terminal/output` / `terminal/release`
 * requests instead. That is arguably where this should end up — it would put
 * every command through Dispatch's own guard and give the provider a real
 * `preToolGuard` — but it is an implementation, not a flag, and claiming the
 * capability without implementing it hangs the turn silently.
 *
 * `fs` is false for the same reason: the agent reads and writes files itself,
 * inside the cwd we give it.
 */
export const DISPATCH_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

/** A live ACP connection to one agent process. */
export class AcpConnection {
  private proc?: AcpProcess;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cancel?: () => void }
  >();
  private readonly notifyListeners = new Set<(f: RpcFrame) => void>();
  private requestHandler?: (req: AgentRequest) => void;
  private readyPromise?: Promise<AcpInitializeResult>;
  private initResult?: AcpInitializeResult;
  private closed = false;
  private exitError?: Error;

  /** Emits "close" when the process dies, so the session can fail loudly. */
  readonly events = new EventEmitter();

  constructor(private readonly opts: AcpConnectionOpts) {}

  /** Spawn + handshake, at most once. Safe to await from many callers. */
  ready(): Promise<AcpInitializeResult> {
    return (this.readyPromise ??= this.boot());
  }

  /** What the agent advertised, once `ready()` has resolved. */
  capabilities(): AcpInitializeResult | undefined {
    return this.initResult;
  }

  private async boot(): Promise<AcpInitializeResult> {
    const proc =
      this.opts.spawnProcess?.() ??
      (spawn(this.opts.exePath, this.opts.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        ...(this.opts.env && Object.keys(this.opts.env).length
          ? { env: { ...process.env, ...this.opts.env } }
          : {}),
      }) as unknown as ChildProcessWithoutNullStreams as unknown as AcpProcess);
    this.proc = proc;

    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    if (proc.stderr) {
      createInterface({ input: proc.stderr }).on("line", (l) => this.opts.onStderr?.(l));
    }
    proc.on("exit", (code) => {
      this.closed = true;
      this.exitError = new Error(`acp agent exited (code ${code ?? "null"})`);
      // Nothing in flight can ever be answered now — fail them rather than
      // letting a chat hang on a promise that will never settle.
      for (const [, p] of this.pending) {
        p.cancel?.();
        p.reject(this.exitError);
      }
      this.pending.clear();
      this.events.emit("close", this.exitError);
    });

    const initAbort = new AbortController();
    const initTimer = setTimeout(
      () => initAbort.abort(new Error("acp agent initialize timed out")),
      INIT_TIMEOUT_MS,
    );
    initTimer.unref?.();
    try {
      this.initResult = await this.request<AcpInitializeResult>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: DISPATCH_CLIENT_CAPABILITIES,
          clientInfo: { name: "dispatch", version: "0.0.0" },
        },
        initAbort.signal,
      );
      return this.initResult;
    } finally {
      clearTimeout(initTimer);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      // Agents print non-JSON diagnostics to stdout occasionally; ignoring them
      // is correct — a parse failure here must not kill the reader loop.
      return;
    }

    // A response to something we sent.
    if (frame.id !== undefined && frame.method === undefined) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      p.cancel?.();
      if (frame.error) p.reject(new Error(frame.error.message ?? "acp rpc error"));
      else p.resolve(frame.result);
      return;
    }

    // An agent→client request. Anything we have no handler for still gets an
    // answer, because an unanswered request blocks the turn forever.
    if (frame.id !== undefined && frame.method) {
      const params = (frame.params ?? {}) as Record<string, unknown>;
      if (this.requestHandler) this.requestHandler({ id: frame.id, method: frame.method, params });
      else this.respondError(frame.id, `unhandled acp request: ${frame.method}`);
      return;
    }

    if (frame.method) {
      for (const l of this.notifyListeners) l(frame);
    }
  }

  /** Send a request and await its response. */
  async request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw this.exitError ?? new Error("acp agent is closed");
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("acp rpc request aborted");
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const p = new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", onAbort);
        reject(
          signal?.reason instanceof Error ? signal.reason : new Error("acp rpc request aborted"),
        );
      };
      this.pending.set(id, {
        resolve,
        reject,
        cancel: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the race between the initial check and listener registration.
      if (signal?.aborted) onAbort();
    });
    if (this.pending.has(id)) this.proc?.stdin.write(frame + "\n");
    return (await p) as T;
  }

  /** Send a request, but only once the handshake has completed. */
  async call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.ready();
    return this.request<T>(method, params, signal);
  }

  /** Fire a notification. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Answer an agent→client request. */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  /** Answer an agent→client request with an error. */
  respondError(id: number | string, message: string): void {
    if (this.closed) return;
    this.proc?.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }) + "\n",
    );
  }

  /** Subscribe to notifications. Returns an unsubscribe fn. */
  onNotify(listener: (f: RpcFrame) => void): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  /** Register the handler for agent→client requests. Returns an unregister fn. */
  onRequest(handler: (req: AgentRequest) => void): () => void {
    this.requestHandler = handler;
    return () => {
      if (this.requestHandler === handler) this.requestHandler = undefined;
    };
  }

  /** Pid of the agent process — the root of this chat's process tree. */
  pid(): number | undefined {
    return this.proc?.pid;
  }

  /** True once the process has exited. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Kill the process. */
  dispose(): void {
    this.closed = true;
    const error = new Error("acp connection disposed");
    for (const [, pending] of this.pending) {
      pending.cancel?.();
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.proc?.stdin.end();
    } catch {
      /* already gone */
    }
    this.proc?.kill();
  }
}
