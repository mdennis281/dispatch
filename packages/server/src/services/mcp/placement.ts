/**
 * MCP PLACEMENT — an MCP server a chat's agent talks to, running on ANOTHER
 * machine (a terminal backend's `spawnProcess`), behind a local stdio shim.
 *
 *   runtime ──stdio──▶ lazy-browser-shim.mjs --relay ──socket──▶ THIS ──▶ backend handle ──▶ the process over there
 *
 * WHY THE RECONNECT CONTRACT LIVES HERE. Measured 2026-11-06 with a probe
 * server (project memory `stdio-mcp-exit-behaviour-by-provider`): when a stdio
 * MCP server exits, Claude Code respawns it on the next call with a fresh
 * `initialize` — silently losing every open page — and Codex never respawns
 * it at all, so one exit kills the tools for the rest of the thread. A link to
 * another machine drops far more often than a local process dies (a laptop
 * sleeps, Wi-Fi blinks), so neither runtime may ever see one. This service
 * owns the process over there, and the shim only ever talks to it:
 *
 *   - A dropped link (`stalled`) fails the requests in flight with a JSON-RPC
 *     error, and fails new ones at once until `resumed`. It never exits and
 *     never queues an agent's call behind a reconnect of unknown length; a
 *     half-open SSH channel would otherwise hold a tool call forever.
 *   - A re-attach (`resumed`) is to the SAME process, still initialized — no
 *     second `initialize` is sent. A late reply to a failed request is dropped.
 *   - Every client `initialize` is answered HERE, from the process's own
 *     cached answer: the shim re-handshakes after any reconnect, and Claude
 *     Code re-handshakes a shim it respawned. The process is initialized
 *     exactly once per life, with the client's own params.
 *   - Upstream request ids are ours. A respawned shim starts again at id 0, and
 *     a stale reply from before must not answer its new request.
 *   - A process that is GONE (`exit`) is started again on the next call, and
 *     that call's result says so — the pages it had are gone, and an agent
 *     that is not told will act on a page that no longer exists.
 *
 * One process per chat + server name. One attached shim at a time; a newer
 * attach wins, the older shim fails its own in-flight calls and re-attaches
 * only if its client calls again. With nothing attached for {@link
 * McpPlacementOptions.graceMs} the process is ended, so a session restart
 * inside the grace keeps the browser.
 */
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type {
  TerminalExitReason,
  TerminalProcessHandle,
  TerminalProcessSpawnInfo,
  TerminalStallInfo,
} from "@dispatch/shared";

/** What the relay needs from the terminal backend registry. */
export interface McpPlacementHost {
  /** Throws, with a message fit for the agent, when the backend cannot host one now. */
  spawnProcess(backendId: string, info: TerminalProcessSpawnInfo): Promise<TerminalProcessHandle>;
  labelOf(backendId: string): string | undefined;
}

/** One server to place: everything `spawnProcess` is told but the signal. */
export type PlacedServerSpec = Omit<TerminalProcessSpawnInfo, "signal" | "purpose">;

export interface McpPlacementOptions {
  host: McpPlacementHost;
  /** Where to listen. Default: a fresh named pipe (Windows) or temp socket, unique per instance. */
  socketPath?: string;
  /** Nothing attached for this long ends the process. Default 60 s. */
  graceMs?: number;
  /** After `stdin.end()`, how long the process gets before `kill()`. Default 5 s. */
  killAfterEndMs?: number;
  /** How long the process gets to answer its `initialize`. Default 120 s. */
  initTimeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
}

/**
 * The relay's own control lines — the only frames on the socket that are not
 * JSON-RPC. The shim repeats these strings (it is a dependency-free `.mjs`), and
 * the relay test pins both sides to them.
 */
export const RELAY_ATTACH = "attach";
export const RELAY_ATTACHED = "attached";
export const RELAY_REFUSED = "refused";
/** The env var that carries a server's relay token to its shim. Env, not argv: argv is world-readable. */
export const RELAY_TOKEN_ENV = "DISPATCH_MCP_RELAY_TOKEN";

/** JSON-RPC's "server error" band; what a client shows as a failed tool call. */
const RELAY_ERROR = -32000;

type JsonRpc = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

/** How many failed upstream ids to remember, to drop their late replies. */
const FAILED_IDS_KEPT = 1_000;

/* ------------------------------------------------------------- attachment */

/** One connected shim. */
class Attachment {
  closed = false;
  constructor(private readonly socket: Socket) {}
  send(msg: unknown): void {
    if (this.closed) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Destroyed once the last line is flushed, not merely ended: a half-close
    // on a Windows named pipe never reaches the other end as EOF, so a
    // displaced shim would sit on a socket it believes is still live.
    this.socket.end(() => this.socket.destroy());
  }
}

/* -------------------------------------------------------- placed server */

interface InFlight {
  att: Attachment;
  clientId: string | number;
  method: string;
}

type State = "idle" | "spawning" | "ready" | "stalled";

class PlacedServer {
  state: State = "idle";
  private handle: TerminalProcessHandle | null = null;
  /** The process's own `initialize` answer, for every client that asks again. */
  private initResult: unknown = null;
  /** The client's `initialize` params — replayed to every process this server starts. */
  private clientInit: unknown = null;
  private attachment: Attachment | null = null;
  private readonly inflight = new Map<string, InFlight>();
  private readonly failed = new Set<string>();
  /** Frames that arrived while the process was starting. */
  private queue: Array<{ att: Attachment; msg: JsonRpc }> = [];
  /** Set once a process has run, so the NEXT one's first tool result can say it restarted. */
  private everStarted = false;
  private restartNotice = false;
  private seq = 0;
  private stdoutBuf = "";
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnAbort: AbortController | null = null;
  /** Bumped on every process life, so a late event from a dead handle is ignored. */
  private generation = 0;
  private stallDetail: string | undefined;

  constructor(
    readonly key: string,
    readonly backendId: string,
    readonly spec: PlacedServerSpec,
    readonly token: string,
    private readonly opts: Required<Omit<McpPlacementOptions, "socketPath" | "log">> & Pick<McpPlacementOptions, "log">,
  ) {}

  private get label(): string {
    return this.opts.host.labelOf(this.backendId) ?? this.backendId;
  }
  private get name(): string {
    return this.spec.name;
  }

  /* ---------------------------------------------------------- attachment */

  attach(att: Attachment): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const prev = this.attachment;
    this.attachment = att;
    // Newest wins. The old shim's own in-flight calls are failed by the shim
    // when its socket closes; their replies, if any arrive, find a closed
    // attachment and are dropped.
    if (prev && prev !== att) prev.close();
  }

  detached(att: Attachment): void {
    att.closed = true;
    this.queue = this.queue.filter((q) => q.att !== att);
    if (this.attachment !== att) return;
    this.attachment = null;
    this.graceTimer = setTimeout(() => this.retire(), this.opts.graceMs);
    this.graceTimer.unref?.();
  }

  /* -------------------------------------------------------- client → us */

  fromClient(att: Attachment, msg: JsonRpc): void {
    if (msg.method === undefined) {
      // A response to a request the PROCESS sent the client (`roots/list`).
      // Its id is the process's own, so it goes back untouched.
      if (this.state === "ready") this.write(msg);
      return;
    }
    if (msg.method === "initialize") {
      this.clientInit = msg.params ?? null;
      if (msg.id === undefined) return;
      // `stalled` too: the answer is cached here and goes back over the LOCAL
      // socket, so it does not need the link. Queued instead, it would never
      // be answered (nothing drains the queue on `resumed`), and a shim
      // respawned during a drop would hang every call behind its handshake.
      if ((this.state === "ready" || this.state === "stalled") && this.initResult) {
        att.send({ jsonrpc: "2.0", id: msg.id, result: this.initResult });
        return;
      }
      this.queue.push({ att, msg });
      this.ensureStarted();
      return;
    }
    // Ours is sent once per process life, right after its `initialize`.
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "notifications/cancelled") {
      const p = (msg.params ?? {}) as { requestId?: string | number };
      const up = this.upstreamIdOf(att, p.requestId);
      if (up !== undefined && this.state === "ready") this.write({ ...msg, params: { ...p, requestId: up } });
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      // Any other notification only means something to a live process.
      if (this.state === "ready") this.write(msg);
      else if (this.state === "spawning") this.queue.push({ att, msg });
      return;
    }
    // A liveness ping with nothing running needs no process started for it.
    if (msg.method === "ping" && this.state === "idle") {
      att.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    switch (this.state) {
      case "ready":
        this.forward(att, msg);
        return;
      case "stalled":
        this.fail(att, msg.id, this.stalledMessage(false));
        return;
      case "spawning":
        this.queue.push({ att, msg });
        return;
      case "idle":
        this.queue.push({ att, msg });
        this.ensureStarted();
        return;
    }
  }

  private upstreamIdOf(att: Attachment, clientId: string | number | undefined): string | undefined {
    if (clientId === undefined) return undefined;
    for (const [up, f] of this.inflight) if (f.att === att && f.clientId === clientId) return up;
    return undefined;
  }

  private forward(att: Attachment, msg: JsonRpc): void {
    const up = `dispatch-relay-${++this.seq}`;
    this.inflight.set(up, { att, clientId: msg.id as string | number, method: msg.method! });
    this.write({ ...msg, id: up });
  }

  private write(msg: unknown): void {
    try {
      this.handle?.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.opts.log?.(`mcp placement "${this.key}": write failed`, err);
    }
  }

  private fail(att: Attachment, id: string | number | null | undefined, message: string): void {
    if (id === undefined || id === null) return;
    att.send({ jsonrpc: "2.0", id, error: { code: RELAY_ERROR, message } });
  }

  /* ------------------------------------------------------------- process */

  private ensureStarted(): void {
    if (this.state !== "idle") return;
    if (this.clientInit === null) {
      // The shim guarantees `initialize` comes first; this is a client
      // talking to the socket directly, and there is nothing to start with.
      for (const q of this.takeQueue()) this.fail(q.att, q.msg.id, `${this.name}: initialize first`);
      return;
    }
    this.state = "spawning";
    const gen = ++this.generation;
    const abort = new AbortController();
    this.spawnAbort = abort;
    void this.start(gen, abort.signal);
  }

  private async start(gen: number, signal: AbortSignal): Promise<void> {
    let handle: TerminalProcessHandle;
    try {
      handle = await this.opts.host.spawnProcess(this.backendId, { ...this.spec, purpose: "mcp", signal });
    } catch (err) {
      if (gen !== this.generation) return;
      this.state = "idle";
      const why = err instanceof Error ? err.message : String(err);
      this.failQueue(`Could not start ${this.name} on ${this.label}: ${why}`);
      return;
    }
    if (gen !== this.generation || signal.aborted) {
      // Retired while it was starting: nobody wants this process any more.
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    this.handle = handle;
    this.stdoutBuf = "";
    handle.stdout.on("data", (chunk) => {
      if (gen === this.generation) this.onStdout(String(chunk));
    });
    handle.stdin.on?.("error", (err) => this.opts.log?.(`mcp placement "${this.key}": stdin`, err));
    const on = handle.on as (event: string, listener: (...args: unknown[]) => void) => unknown;
    on.call(handle, "exit", (code: unknown, reason: unknown) => {
      if (gen === this.generation) this.onExit(code as number | null, reason as TerminalExitReason | undefined);
    });
    on.call(handle, "error", (err: unknown) => this.opts.log?.(`mcp placement "${this.key}": process error`, err));
    on.call(handle, "stalled", (info: unknown) => {
      if (gen === this.generation) this.onStalled(info as TerminalStallInfo | undefined);
    });
    on.call(handle, "resumed", () => {
      if (gen === this.generation) this.onResumed();
    });
    this.initialize(gen);
  }

  /** The one `initialize` this process life gets, with the client's own params. */
  private pendingInit: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  private initialize(gen: number): void {
    const id = `dispatch-relay-init-${gen}`;
    const timer = setTimeout(() => {
      if (gen !== this.generation || !this.pendingInit) return;
      this.pendingInit = null;
      this.endProcess(`${this.name} on ${this.label} did not answer initialize in ${Math.round(this.opts.initTimeoutMs / 1000)} s`);
    }, this.opts.initTimeoutMs);
    timer.unref?.();
    this.pendingInit = { id, timer };
    this.write({ jsonrpc: "2.0", id, method: "initialize", params: this.clientInit });
  }

  private onInitialized(msg: JsonRpc): void {
    clearTimeout(this.pendingInit!.timer);
    this.pendingInit = null;
    if (!msg.result) {
      const e = (msg.error ?? {}) as { message?: string };
      this.endProcess(`${this.name} on ${this.label} refused initialize: ${e.message ?? "no reason given"}`);
      return;
    }
    this.initResult = msg.result;
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.state = "ready";
    if (this.everStarted) this.restartNotice = true;
    this.everStarted = true;
    for (const q of this.takeQueue()) this.fromClient(q.att, q.msg);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl === -1) break;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(line) as JsonRpc;
      } catch {
        continue; // a server's stray log line on stdout is its bug, not a reason to fall over
      }
      this.fromProcess(msg);
    }
  }

  private fromProcess(msg: JsonRpc): void {
    if (this.pendingInit && msg.id === this.pendingInit.id) {
      this.onInitialized(msg);
      return;
    }
    if (msg.method !== undefined) {
      // A request or notification for the CLIENT (`roots/list`, progress).
      const att = this.attachment;
      if (att && !att.closed) att.send(msg);
      else if (msg.id !== undefined && msg.id !== null) {
        // Nobody to ask: answer so the process does not wait on it forever.
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: RELAY_ERROR, message: "no client attached" } });
      }
      return;
    }
    const id = msg.id === undefined || msg.id === null ? undefined : String(msg.id);
    if (id === undefined) return;
    const f = this.inflight.get(id);
    if (!f) return; // failed already (a stall), or never ours
    this.inflight.delete(id);
    let out: JsonRpc = { ...msg, id: f.clientId };
    if (this.restartNotice && f.method === "tools/call" && msg.result) {
      out = withNotice(out, this.restartedText());
      this.restartNotice = false;
    }
    f.att.send(out);
  }

  private onStalled(info?: TerminalStallInfo): void {
    if (this.state !== "ready" && this.state !== "stalled") return;
    this.state = "stalled";
    this.stallDetail = info?.detail;
    // A half line from before the drop can never be completed by what comes
    // after the re-attach; keeping it would corrupt the first line after.
    this.stdoutBuf = "";
    this.failInflight(this.stalledMessage(true));
  }

  private onResumed(): void {
    if (this.state !== "stalled") return;
    this.state = "ready";
    this.stallDetail = undefined;
  }

  private onExit(code: number | null, reason?: TerminalExitReason): void {
    const why =
      reason?.kind === "transport-lost"
        ? `the connection to ${this.label} was lost`
        : reason?.kind === "killed"
          ? "it was stopped"
          : `it exited${code === null ? "" : ` (code ${code})`}`;
    const detail = reason?.detail ? `: ${reason.detail}` : "";
    this.reset(
      `${this.name} on ${this.label} stopped — ${why}${detail}. This call did not complete. ` +
        `The next call starts ${this.name} again; pages and state from before are gone.`,
    );
  }

  /** Back to idle: fail everything waiting, forget the process. */
  private reset(message: string): void {
    this.generation++;
    if (this.pendingInit) clearTimeout(this.pendingInit.timer);
    this.pendingInit = null;
    this.handle = null;
    this.initResult = null;
    this.state = "idle";
    this.stdoutBuf = "";
    this.failInflight(message);
    this.failQueue(message);
  }

  /** Stop the process (it misbehaved): fail what waits on it, kill it. */
  private endProcess(message: string): void {
    const handle = this.handle;
    this.reset(message);
    try {
      handle?.kill();
    } catch {
      /* already gone */
    }
  }

  private failInflight(message: string): void {
    for (const [up, f] of this.inflight) {
      this.fail(f.att, f.clientId, message);
      this.failed.add(up);
    }
    this.inflight.clear();
    while (this.failed.size > FAILED_IDS_KEPT) this.failed.delete(this.failed.values().next().value!);
  }

  private takeQueue(): Array<{ att: Attachment; msg: JsonRpc }> {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  private failQueue(message: string): void {
    for (const q of this.takeQueue()) this.fail(q.att, q.msg.id, message);
  }

  private stalledMessage(inFlight: boolean): string {
    const detail = this.stallDetail ? ` (${this.stallDetail})` : "";
    return (
      `Lost the connection to ${this.label}${detail}. ${this.name} is still running there and ` +
      `Dispatch is reconnecting. ${inFlight ? "This call did not complete" : "Nothing was sent"}; ` +
      `retry it in a moment.`
    );
  }

  private restartedText(): string {
    return (
      `[dispatch] ${this.name} was restarted on ${this.label}. Pages, tabs and state from before ` +
      `the restart are gone; open what you need again.`
    );
  }

  /* ----------------------------------------------------------- teardown */

  /** Nothing attached for the grace period, or the server was re-placed: end the process gracefully. */
  retire(message = `${this.name} on ${this.label} was stopped`): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.spawnAbort?.abort();
    const handle = this.handle;
    this.reset(message);
    if (!handle) return;
    try {
      handle.stdin.end?.();
    } catch {
      /* already gone */
    }
    // Stdin EOF is how an MCP stdio server is meant to be stopped (it lets a
    // browser close its pages and release its profile); the kill is only a
    // bound for one that ignores it.
    const t = setTimeout(() => {
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
    }, this.opts.killAfterEndMs);
    t.unref?.();
  }

  /** The chat or the backend is gone: no grace. */
  destroy(message: string): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.spawnAbort?.abort();
    const handle = this.handle;
    this.reset(message);
    this.attachment?.close();
    this.attachment = null;
    try {
      handle?.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Append one text block to a tool result. */
function withNotice(msg: JsonRpc, text: string): JsonRpc {
  const result = (msg.result ?? {}) as { content?: unknown[] };
  const content = Array.isArray(result.content) ? result.content : [];
  return { ...msg, result: { ...result, content: [...content, { type: "text", text }] } };
}

/* ----------------------------------------------------------------- service */

/** A fresh, instance-unique place to listen: a named pipe on Windows, a temp unix socket elsewhere. */
export function defaultRelaySocketPath(): string {
  const id = randomBytes(8).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\dispatch-mcp-relay-${id}`
    : join(tmpdir(), `dispatch-mcp-${id}.sock`);
}

export class McpPlacementService {
  readonly socketPath: string;
  private server: Server | null = null;
  private readonly byKey = new Map<string, PlacedServer>();
  private readonly byToken = new Map<string, PlacedServer>();
  private readonly opts: Required<Omit<McpPlacementOptions, "socketPath" | "log">> & Pick<McpPlacementOptions, "log">;

  constructor(options: McpPlacementOptions) {
    this.socketPath = options.socketPath ?? defaultRelaySocketPath();
    this.opts = {
      host: options.host,
      graceMs: options.graceMs ?? 60_000,
      killAfterEndMs: options.killAfterEndMs ?? 5_000,
      initTimeoutMs: options.initTimeoutMs ?? 120_000,
      log: options.log,
    };
  }

  /** Start listening. Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => this.opts.log?.("mcp placement relay: server error", err));
  }

  /**
   * Place one server for one chat's session and return the token its shim
   * attaches with. The SAME placement (backend + spec) keeps its process and
   * token across sessions — a session restart inside the grace keeps the
   * browser. A changed one retires the old process first.
   */
  place(backendId: string, spec: PlacedServerSpec): { token: string } {
    // A relay entry pointing at a socket nobody listens on would fail every
    // call; refusing here keeps the session's servers local instead.
    if (!this.server) throw new Error("the MCP placement relay is not listening");
    const key = `${spec.chatId}\u0000${spec.name}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.backendId === backendId && sameSpec(existing.spec, spec)) return { token: existing.token };
      existing.retire(`${spec.name} moved; this call did not complete`);
      this.drop(existing);
    }
    const token = randomBytes(24).toString("base64url");
    const placed = new PlacedServer(key, backendId, spec, token, this.opts);
    this.byKey.set(key, placed);
    this.byToken.set(token, placed);
    return { token };
  }

  /** The chat was deleted: end its processes now. */
  chatDeleted(chatId: string): void {
    for (const p of [...this.byKey.values()]) {
      if (p.spec.chatId !== chatId) continue;
      p.destroy(`${p.spec.name}: the chat was deleted`);
      this.drop(p);
    }
  }

  /** A backend was unregistered (its plugin went away): its processes are unreachable now. */
  backendDetached(backendId: string): void {
    for (const p of [...this.byKey.values()]) {
      if (p.backendId !== backendId) continue;
      p.destroy(`${p.spec.name}: ${backendId} is no longer available (its plugin was turned off)`);
      this.drop(p);
    }
  }

  /** Placed servers, for tests and diagnostics. */
  list(): Array<{ chatId: string; name: string; backendId: string; state: State }> {
    return [...this.byKey.values()].map((p) => ({
      chatId: p.spec.chatId,
      name: p.spec.name,
      backendId: p.backendId,
      state: p.state,
    }));
  }

  async dispose(): Promise<void> {
    for (const p of [...this.byKey.values()]) {
      p.destroy(`${p.spec.name}: Dispatch is shutting down`);
      this.drop(p);
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await rm(this.socketPath, { force: true }).catch(() => {});
  }

  private drop(p: PlacedServer): void {
    this.byKey.delete(p.key);
    this.byToken.delete(p.token);
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    const att = new Attachment(socket);
    let placed: PlacedServer | null = null;
    let buf = "";
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!placed) {
          const p = msg.dispatchRelay === RELAY_ATTACH ? this.byToken.get(String(msg.token)) : undefined;
          if (!p) {
            att.send({ dispatchRelay: RELAY_REFUSED, error: "unknown or expired relay token" });
            att.close();
            return;
          }
          placed = p;
          p.attach(att);
          att.send({ dispatchRelay: RELAY_ATTACHED });
          continue;
        }
        placed.fromClient(att, msg as JsonRpc);
      }
    });
    const gone = () => placed?.detached(att);
    socket.on("close", gone);
    socket.on("error", () => socket.destroy());
  }
}

function sameSpec(a: PlacedServerSpec, b: PlacedServerSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
