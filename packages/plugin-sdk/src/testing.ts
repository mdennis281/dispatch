/**
 * `@dispatch/plugin-sdk/testing` — a fake `PluginContext` so a server plugin's
 * `activate` runs in a unit test with no Dispatch server.
 *
 * Every member the real context has is here, in memory: `kv` is a Map, the bus
 * is a listener list you `publish` into, routes are a table you `call`,
 * settings are a value you `set` to fire `onChange`, sends and asks are
 * recorded. The shape is the SDK's {@link PluginContext}, so a plugin written
 * against it needs no test-only seam — and a test that passes here has
 * exercised the same code the host will call.
 *
 * What it does NOT do: enforce the 30 s activate budget or persist anything.
 * Those are the host's job and its test suite's. Two plugins that depend on
 * each other run together under {@link createTestHost}. Verify against a real
 * instance before shipping (docs/plugins.md → "Testing").
 */
import type {
  AttentionItem,
  Harness,
  PluginApprovalDecision,
  PluginApprovalRequest,
  PluginApprovalResult,
  PluginReservedPort,
  PluginRunnerProcess,
  PluginAskResult,
  PluginCapability,
  PluginChatState,
  PluginChatSummary,
  PluginInstance,
  PluginLiveChat,
  PluginModule,
  PluginShutdownReason,
  PluginMemoryInput,
  PluginProjectSummary,
  PluginSendResult,
  ProviderDescriptor,
  QuestionAnswer,
  TerminalAfterRunInfo,
  TerminalAfterRunResult,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalBeforeRunResult,
  TerminalPortForward,
  TerminalBackendStatusInput,
  TerminalBackendUpdate,
  TerminalProcessHandle,
  TerminalProcessSpawnInfo,
  TerminalRunEvent,
  TerminalRunInFlight,
  TerminalRunInfo,
  TerminalSpawnInfo,
  WsServerEvent,
  WsServerEventType,
  PluginTool,
  PluginToolCall,
  PluginToolCallResult,
  PluginToolInputSchema,
  MembraneParty,
  PluginCaller,
  PluginDependencySpec,
  PluginDependencyStatus,
  PluginDependent,
  PluginExportFactory,
  PluginLinkCaller,
  PluginMembrane,
  PluginStatus,
} from "@dispatch/shared";
import {
  PLUGIN_TOOL_LIMITS,
  PLUGIN_TOOL_NAME_PATTERN,
  normalizePluginToolResult,
  pluginToolError,
  pluginToolThrown,
  pluginToolQualifiedName,
  PLUGIN_SHARED_LIMITS,
  PLUGIN_APPROVAL_DEFAULT_TIMEOUT_SECONDS,
  PLUGIN_APPROVAL_LIMITS,
  PLUGIN_APPROVAL_MAX_TIMEOUT_SECONDS,
  PLUGIN_CAPABILITIES,
  PLUGIN_RECONCILE_BUDGET_MS,
  grantedPluginCapabilities,
  PLUGIN_SHUTDOWN_BUDGET_MS,
  SECRET_NAME_RE,
  SECRET_VALUE_MAX,
  applySettingsPatch,
  checkPluginSettings,
  compilePluginSettingsSchema,
  pluginSecretAllowed,
  sameSettingsValue,
  PluginRevokedError,
  blockedReason,
  liveDependencyState,
  openPluginLink,
  pluginLinkClosedReason,
  resolvePluginDependencies,
} from "@dispatch/shared";
import type { PluginContext, PluginReply, PluginRequest } from "./index.js";

export interface TestContextOptions {
  id?: string;
  /** The manifest's display name, where the host shows one (a tool's error results). Default: `id`. */
  name?: string;
  version?: string;
  /** Absolute path the plugin believes it lives at. Default `/plugins/<id>`. */
  dir?: string;
  /**
   * Which members to build. Default: every capability, so the fake never
   * hands a plugin less than its manifest will. Pass the manifest's list to
   * test the shape the host will actually deliver.
   */
  capabilities?: readonly PluginCapability[];
  /**
   * The manifest's `optionalCapabilities`, granted the way the host grants
   * them: a name this SDK's host knows is added to `capabilities`; any other
   * is ignored. Only meaningful alongside `capabilities` (the default already
   * grants everything). To test the plugin on a host WITHOUT one of them,
   * leave it out of both.
   */
  optionalCapabilities?: readonly string[];
  /** Initial `ctx.settings.get()`. */
  settings?: Record<string, unknown>;
  /**
   * The parsed `settings.schema.json`. Given, `ctx.settings.set` enforces it
   * exactly as the host does — a key the write changes into something the
   * schema refuses throws; keys it leaves alone are never judged.
   */
  settingsSchema?: unknown;
  /** Initial names → values for `ctx.secrets` — the store as the plugin finds it. */
  secrets?: Record<string, string>;
  /**
   * The manifest's `secrets:` list, `PREFIX*` entries included. Given, the
   * fake enforces it as the host does: an uncovered name reads as undefined,
   * is absent from `list()`, and THROWS on `set`/`delete`. Omitted, every
   * name is covered — convenient, but it cannot catch a key the manifest
   * forgot to declare.
   */
  manifestSecrets?: readonly string[];
  /**
   * `ctx.instance`. Given fields override {@link TEST_INSTANCE}. Pass a
   * `previousId` and `reminted` to test the copied-data-dir path. `null`
   * leaves the member absent, as an older host does.
   */
  instance?: Partial<PluginInstance> | null;
  /**
   * The store behind `ctx.shared`. Pass ONE `createTestSharedStore()` to two
   * contexts with different `instance.id`s to play stable and dev sharing a
   * config root. Default: a fresh store of this context's own.
   */
  sharedStore?: TestSharedStore;
  projects?: PluginProjectSummary[];
  chats?: PluginChatSummary[];
  /** Pre-seeded kv rows. */
  kv?: Record<string, unknown>;
  /** What `chats.ask` answers with. Default: an unanswered timeout, like a chat nobody is watching. */
  answerAsk?: (chatId: string, question: string) => string | undefined;
  /**
   * Play the human answering `ctx.approvals.request`. Return the decision, or
   * a whole result (to set `by`), or a promise of either — a promise that
   * never settles is a card nobody answers, which the request's `signal`
   * withdraws (`cancelled`). Default: `"timeout"`, like a card nobody is
   * watching — the safe answer for a plugin to be tested against.
   */
  approve?: (
    chatId: string,
    req: PluginApprovalRequest,
  ) =>
    | PluginApprovalDecision
    | Pick<PluginApprovalResult, "decision" | "by">
    | Promise<PluginApprovalDecision | Pick<PluginApprovalResult, "decision" | "by">>;
  /** What `chats.read` returns. Default: a one-line stub naming the chat and view. */
  readChat?: (chatId: string, view: string) => string;
  /** What `chats.state` returns. Default: idle, not dormant, nothing pending. */
  stateOf?: (chatId: string) => PluginChatState | null;
  /**
   * The plugins this one uses, as `ctx.dependencies` will find them:
   * `{ "remote-host": { machines: { 1: fakeApi } } }`. Given, the member
   * exists (as it does for a manifest that declares `dependencies`) and every
   * export listed is a declared `uses` — a `get` of anything else THROWS, as
   * on the host. `get` hands the API over through the host's own link
   * (shared `openPluginLink`), so revocation, inert callbacks and error
   * tagging behave as in production. A FUNCTION is the export's factory and
   * is called with the `PluginCaller` the host would pass; `null` declares an
   * export nobody serves (`get` → undefined, `state` → `missing` when nothing
   * of that plugin is served, `not-served` otherwise).
   */
  dependencies?: Record<string, Record<string, Record<number, object | ((caller: PluginCaller) => object) | null>>>;
  /** Which of `dependencies` are optional — only what `ctx.dependencies.state(id).optional` reports. */
  optionalDependencies?: readonly string[];
  /** The manifest's `provides`, `{ machines: [1] }`. Given, `ctx.provides` exists and `serve` is checked against it. */
  provides?: Record<string, readonly number[]>;
  /** What `ctx.provides.dependents()` returns. Default: nobody. */
  dependents?: PluginDependent[];
}

export interface TestRouteCall {
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TestRouteResult {
  status: number;
  headers: Record<string, string>;
  /** What the handler returned or `reply.send`-ed. */
  body: unknown;
}

export interface TestLogLine {
  level: "info" | "warn" | "error";
  message: string;
  err?: unknown;
}

export interface TestContext {
  /** Hand this to `activate`. */
  ctx: PluginContext;
  /** Fire a wire event into every `ctx.bus.on` / `subscribe` listener. */
  publish(evt: WsServerEvent): void;
  /** Everything the plugin `ctx.emit`-ed, in order. */
  emitted: Array<{ payload: unknown; chatId?: string }>;
  /** The kv table. Mutate it to simulate state from an earlier run. */
  kv: Map<string, unknown>;
  /** The global secret store as the plugin sees it — what `ctx.secrets.set/delete` wrote. Mutate it to simulate the owner saving one. */
  secrets: Map<string, string>;
  settings: {
    /**
     * Replace the settings and fire every `onChange` listener — the owner
     * saving from the Settings pane (or the other instance writing). Not
     * schema-checked: it simulates what is stored, not a write the plugin made.
     */
    set(next: Record<string, unknown>): void;
    get(): Record<string, unknown>;
  };
  routes: {
    /** Invoke a registered handler as the host's wildcard would. Throws when nothing matches. */
    call(method: string, path: string, init?: TestRouteCall): Promise<TestRouteResult>;
    /** `"GET /hello"`-style list of what was registered. */
    list(): string[];
  };
  log: TestLogLine[];
  /** `chats.send` calls, in order. */
  sent: Array<{ chatId: string; text: string; delivery?: "queue" | "interrupt"; sender?: string }>;
  /** `chats.ask` calls, in order. */
  asked: Array<{ chatId: string; question: string; timeoutSeconds?: number; sender?: string }>;
  /** `chats.reply` calls. */
  replied: Array<{ askId: string; answer: string }>;
  /** `attention.answer` calls. */
  answered: Array<{ itemId: string; answer: unknown }>;
  /**
   * Every `approvals.request` that the host would have put on a card, in
   * order, with how it ended once it has (`result` is absent while it waits).
   * A request the host would refuse (no title, an over-long field, a bad
   * timeout) rejects, as there, and is not recorded.
   */
  approvals: Array<{ chatId: string; request: PluginApprovalRequest; result?: PluginApprovalResult }>;
  /**
   * `ctx.tools`, from the agent's side. `register` checks a definition as the
   * host does (name, the 64-character agent-facing name, description) and
   * throws on the same mistakes.
   */
  tools: {
    /** Registered tool names, sorted. */
    list(): string[];
    /** One registered definition, as the agent's runtime would be handed it. */
    get(name: string): { name: string; qualifiedName: string; description: string; inputSchema: PluginToolInputSchema } | undefined;
    /**
     * Call a tool as an agent would. A string result comes back as one text
     * block and a throw as `isError: true` with its message, as on the host.
     * `call` defaults to chat "test-chat" and a signal that never aborts.
     */
    call(
      name: string,
      args?: Record<string, unknown>,
      call?: Partial<PluginToolCall>,
    ): Promise<PluginToolCallResult>;
  };
  /** The attention items `attention.list` reports. Push to simulate a pending question. */
  attention: AttentionItem[];
  /** `memory.remember` results, keyed by project then name. */
  memory: Map<string, Map<string, PluginMemoryInput>>;
  /** Processes `ctx.processes` believes exist. Start/stop flip `status`. */
  processes: Map<string, { id: string; status: string; ports?: number[]; url?: string }>;
  /**
   * What `ctx.runner` reports. Push to simulate this machine: `runnerProcesses`
   * is `list()`, `reservedPorts` is `reservedPorts()`. Starts with Dispatch's
   * own ports, as a real host's deny-list always does.
   */
  runnerProcesses: PluginRunnerProcess[];
  reservedPorts: PluginReservedPort[];
  /** OAuth: what `ctx.oauth.token(name)` returns. Set to simulate a connected provider. */
  oauthTokens: Map<string, string>;
  /** Every `ctx.providers.register` call, in order. */
  providers: Array<{ harness: Harness; descriptor: ProviderDescriptor }>;
  /** Backends `ctx.terminals.registerBackend` received, by id. */
  terminalBackends: Map<string, TerminalBackend>;
  /** Ports currently published through `ctx.terminals.publishPort` (withdrawn ones removed). */
  terminalPorts: TerminalPortForward[];
  /** The latest `ctx.terminals.setStatus` per backend id. Cleared by `unregisterBackend`. */
  terminalStatus: Map<string, TerminalBackendStatusInput>;
  /**
   * Every `ctx.terminals.updateBackend` per backend id, merged in call order.
   * The backend object in `terminalBackends` is left as registered — the host
   * never writes to it either.
   */
  terminalUpdates: Map<string, TerminalBackendUpdate>;
  /**
   * Play the HOST's side of a terminal backend — the calls core makes — so a
   * plugin's test can drive spawn and the lifecycle hooks without a server.
   * `spawn` fills `name`/`cwd`/`signal` with defaults; pass your own signal
   * to test that the backend gives up when it is aborted.
   */
  terminals: {
    spawn(
      backendId: string,
      info: Partial<TerminalSpawnInfo> & { chatId: string },
    ): Promise<TerminalBackendHandle>;
    chatIdle(chatId: string, projectId?: string): Promise<void>;
    /**
     * Rejects when a backend's `onChatDeleted` does — which on the host means
     * "recorded and retried later". Call it twice to check it is idempotent.
     */
    chatDeleted(chatId: string, projectId?: string): Promise<void>;
    /**
     * Call a backend's `beforeRun` as core would before writing `command`,
     * and report what core would do: `ran: false` with `refusal` when the
     * hook refused or threw (core never writes the command then). Fills
     * `terminal` ("main"), `cwd` ("/repo"), `background`, `signal` and a fresh
     * `runId` — pass your own to pair this call with an `afterRun`. No
     * `beforeRun` at all is `ran: true` — the command just runs.
     */
    beforeRun(
      backendId: string,
      info: Partial<TerminalRunInfo> & { chatId: string; command: string },
    ): Promise<{ ran: boolean; refusal?: string; notices: string[] }>;
    /**
     * Start a process through a backend's `spawnProcess`, as core's MCP relay
     * does, and talk to it the way the relay will: newline-delimited JSON-RPC.
     * Defaults: `purpose` "mcp", `name` "test", `cwd` "/repo", a fresh signal.
     * Use it to check your handle keeps the reconnect contract — whole lines,
     * `stalled` / `resumed` around a re-attach to the SAME process (no second
     * `initialize` needed), and `exit` once it is gone (docs/plugins.md,
     * "Hosting processes").
     */
    spawnProcess(
      backendId: string,
      info: Partial<TerminalProcessSpawnInfo> & { chatId: string },
    ): Promise<TestMcpProcess>;
    /**
     * Call a backend's `afterRun` as core would once it stops waiting on a
     * command. Defaults: `exitCode` 0, `outcome` "finished", `durationMs` 0.
     * Rejects when the hook throws — which core turns into a notice.
     */
    afterRun(
      backendId: string,
      info: Partial<TerminalAfterRunInfo> & { chatId: string; command: string },
    ): Promise<{ notices: string[] }>;
    /**
     * Put a run in flight, as a chat's shell taking a command anywhere would —
     * on one of your backends, another plugin's, or `local`. It shows in
     * `ctx.terminals.runs()` and fires `onRun` "started". Fills `runId`,
     * `terminal` ("main"), `backend` ("local"), `cwd` ("/repo"), `command`,
     * `background` and `startedAt`. The host's visibility rule applies: the
     * plugin sees `command` only for a backend it registered. Returns the run
     * as core holds it.
     */
    startRun(run: Partial<TerminalRunInFlight> & { chatId: string }): TerminalRunInFlight;
    /** End a run started with `startRun`: gone from `runs()`, `onRun` "ended". False when it wasn't in flight. */
    endRun(runId: string): boolean;
  };
  /**
   * Play the HOST's side of the cleanup lifecycle (docs/plugins.md → "Cleanup
   * lifecycle") against your module, with the host's budgets.
   *
   * `shutdown` calls `onShutdown` then `deactivate`, exactly as the host does
   * for `reason`, and reports whether the hook beat its budget — the thing to
   * assert on, because an overrun on the host is a plugin quietly skipped.
   * `reconcile` calls `reconcile` with the chats you say still exist.
   */
  lifecycle: {
    shutdown(
      mod: PluginModule,
      reason: PluginShutdownReason,
      opts?: { budgetMs?: number },
    ): Promise<{ overran: boolean; error?: unknown; elapsedMs: number }>;
    reconcile(
      mod: PluginModule,
      chats: PluginLiveChat[],
      opts?: { budgetMs?: number },
    ): Promise<{ overran: boolean; error?: unknown; elapsedMs: number }>;
  };
  /** How many listeners the bus currently holds — zero after a clean deactivate. */
  listenerCount(): number;
  /** What `ctx.provides.serve` was handed, by `name@major`. */
  served: ReadonlyMap<string, PluginExportFactory>;
  /**
   * Call this plugin's export `name@major` the way plugin `callerId` gets it:
   * from the factory it served, through the membrane, with a `PluginCaller`
   * built like the host's (`capabilities` default to none). The same object
   * per caller until that link closes. The first call SEALS the exports, as
   * the host does when `activate` resolves: `serve` throws from then on.
   * Throws when nothing serves it.
   */
  callAs<T = unknown>(
    callerId: string,
    name: string,
    major: number,
    caller?: { name?: string; version?: string; capabilities?: readonly PluginCapability[] },
  ): T;
  /**
   * Close every link `id` is in, the way the host does once a plugin is down:
   * the API's methods throw `PluginRevokedError`, everything else that
   * crossed goes inert, a call in flight rejects, `caller.signal` aborts. For
   * a dependency, `get` then returns undefined and `state` reads `disabled`;
   * for a caller of `callAs`, it is that consumer going away.
   */
  revoke(id: string): void;
  /**
   * Play dependency `id` going down while this plugin stays up: its `onLost`
   * listeners run (awaited), `get` stops handing it out, then {@link revoke}.
   * Rejects with the first error a listener threw — the host would log it
   * and carry on, which is easy to miss.
   */
  lose(id: string): Promise<void>;
}

interface Route {
  method: string;
  segments: string[];
  handler: (req: PluginRequest, reply: PluginReply) => unknown;
}

/** Match `/chats/:chatId` against `/chats/abc` → `{ chatId: "abc" }`, or null. */
function matchRoute(route: Route, path: string): Record<string, string> | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i]!;
    const part = parts[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return null;
  }
  return params;
}

/** The reply object a handler sees — the structural subset in {@link PluginReply}, recorded. */
function makeReply(): { reply: PluginReply; sent: () => { status: number; headers: Record<string, string>; body: unknown; explicit: boolean } } {
  let status = 200;
  const headers: Record<string, string> = {};
  let body: unknown;
  let explicit = false;
  const reply: PluginReply = {
    get statusCode() {
      return status;
    },
    code(s) {
      status = s;
      return reply;
    },
    header(name, value) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    type(mime) {
      headers["content-type"] = mime;
      return reply;
    },
    send(payload) {
      body = payload;
      explicit = true;
      return reply;
    },
  };
  return { reply, sent: () => ({ status, headers, body, explicit }) };
}

/** Run `fn` the way the host runs a lifecycle hook: a deadline, a signal that aborts at it, and a race. */
async function withHostBudget(
  budgetMs: number,
  fn: (deadline: number, signal: AbortSignal) => unknown,
): Promise<{ overran: boolean; error?: unknown; elapsedMs: number }> {
  const ac = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<"overran">((resolve) => {
    timer = setTimeout(() => {
      ac.abort(new Error(`budget of ${budgetMs}ms exceeded`));
      resolve("overran");
    }, budgetMs);
  });
  try {
    const won = await Promise.race([Promise.resolve().then(() => fn(started + budgetMs, ac.signal)), overrun]);
    return { overran: won === "overran", elapsedMs: Date.now() - started };
  } catch (error) {
    return { overran: false, error, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An in-memory stand-in for the config root's `ctx.shared` database: versioned
 * values and leased locks, keyed by plugin id like the real one. Share one
 * between two `createTestContext` calls to test what two instances do.
 * `now` is read for every lease decision, so a test can move time.
 */
export interface TestSharedStore {
  values: Map<string, { value: unknown; version: number; updatedAt: number; updatedBy?: string }>;
  locks: Map<string, { token: string; instanceId?: string; role?: string; acquiredAt: number; expiresAt: number }>;
  /** Each plugin's write counter — versions are never reused, as on the host. */
  seq: Map<string, number>;
  now: () => number;
}

export function createTestSharedStore(opts: { now?: () => number } = {}): TestSharedStore {
  return { values: new Map(), locks: new Map(), seq: new Map(), now: opts.now ?? (() => Date.now()) };
}

/** The default `ctx.instance`: a test, in nobody's data dir. */
export const TEST_INSTANCE: PluginInstance = Object.freeze({
  id: "test-instance",
  role: "other",
  dataDirFingerprint: "test-data-dir",
});

/** Build a fake context. See the module comment for what it is and is not. */
/** A process started through `t.terminals.spawnProcess`, with core's side of the line protocol. */
export interface TestMcpProcess {
  handle: TerminalProcessHandle;
  /**
   * Send a JSON-RPC request; resolves with the reply (`result` or `error`).
   * Rejects after `timeoutMs` (default 5 s), or when the handle exits first.
   */
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<{ result?: unknown; error?: { code?: number; message?: string } }>;
  notify(method: string, params?: unknown): void;
  /** Requests and notifications the PROCESS sent toward the client, in order. */
  fromProcess: Array<Record<string, unknown>>;
  /** Lines on stdout that were not JSON. Core drops these; a test can assert there are none. */
  garbage: string[];
  /** The contract events the handle emitted, in order. */
  events: Array<{ event: TestMcpProcessEvent; args: unknown[] }>;
  /** Resolves with the arguments of the next `event` not yet consumed by an earlier `next`. */
  next(event: Exclude<TestMcpProcessEvent, "error">): Promise<unknown[]>;
}

export type TestMcpProcessEvent = "stalled" | "resumed" | "exit" | "error";

/** Mirror of shared `defaultForwardRemoteUrl`. */
function testRemoteUrl(url: string, remotePort: number): string {
  const head = url.slice(0, 8).toLowerCase();
  const scheme = head.startsWith("https://") ? "https:" : head.startsWith("http://") ? "http:" : null;
  if (!scheme) return `http://localhost:${remotePort}`;
  const rest = url.slice(scheme.length + 2);
  let end = rest.length;
  for (const stop of ["/", "?", "#"]) {
    const at = rest.indexOf(stop);
    if (at !== -1 && at < end) end = at;
  }
  return `${scheme}//localhost:${remotePort}${rest.slice(end)}`;
}

/** Core's side of a `spawnProcess` handle: line framing, request ids, the contract events. */
function testMcpProcess(handle: TerminalProcessHandle): TestMcpProcess {
  let buf = "";
  let seq = 0;
  let exited = false;
  const waiting = new Map<string, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const fromProcess: Array<Record<string, unknown>> = [];
  const garbage: string[] = [];
  const events: TestMcpProcess["events"] = [];
  /** Per event, how far into `events` an earlier `next` has already consumed. */
  const consumed = new Map<string, number>();
  const nextWaiters: Array<{ event: string; resolve: (a: unknown[]) => void }> = [];
  handle.stdout.on("data", (chunk) => {
    buf += String(chunk);
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
        garbage.push(line);
        continue;
      }
      if (msg.method !== undefined) {
        fromProcess.push(msg);
        continue;
      }
      const w = waiting.get(String(msg.id));
      if (w) {
        waiting.delete(String(msg.id));
        w.resolve(msg);
      }
    }
  });
  const record =
    (event: TestMcpProcessEvent) =>
    (...args: unknown[]) => {
      events.push({ event, args });
      const w = nextWaiters.find((n) => n.event === event);
      if (w) {
        nextWaiters.splice(nextWaiters.indexOf(w), 1);
        consumed.set(event, events.length);
        w.resolve(args);
      }
      if (event === "exit") {
        exited = true;
        for (const [id, pending] of waiting) {
          waiting.delete(id);
          pending.reject(new Error("the process exited before replying"));
        }
      }
    };
  const on = handle.on as (event: string, listener: (...args: unknown[]) => void) => unknown;
  for (const e of ["stalled", "resumed", "exit", "error"] as const) on.call(handle, e, record(e));
  const write = (msg: unknown) => handle.stdin.write(JSON.stringify(msg) + "\n");
  return {
    handle,
    fromProcess,
    garbage,
    events,
    request: (method, params, opts = {}) =>
      new Promise((resolve, reject) => {
        if (exited) return reject(new Error("the process has exited"));
        const id = `test-${++seq}`;
        const ms = opts.timeoutMs ?? 5_000;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no reply to ${method} within ${ms} ms`));
        }, ms);
        waiting.set(id, {
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as { result?: unknown; error?: { code?: number; message?: string } });
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      }),
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    next: (event) => {
      const from = consumed.get(event) ?? 0;
      const at = events.findIndex((e, i) => i >= from && e.event === event);
      if (at !== -1) {
        consumed.set(event, at + 1);
        return Promise.resolve(events[at]!.args);
      }
      return new Promise((resolve) => nextWaiters.push({ event, resolve }));
    },
  };
}

/* --------------------------------------------------- plugin dependencies */

interface TestLink {
  provider: MembraneParty;
  caller: MembraneParty;
  membrane: PluginMembrane;
  api: unknown;
  abort: AbortController;
}

/**
 * The links between plugins, kept the way the host keeps them (server
 * `PluginService`): one per caller and export, opened on first use through
 * shared `openPluginLink`, closed when either side goes down.
 */
class TestLinkTable {
  private readonly exports = new Map<string, Map<string, PluginExportFactory>>();
  private readonly sealed = new Set<string>();
  private readonly down = new Set<string>();
  private readonly links = new Map<string, TestLink>();
  /** consumer → provider → listeners */
  private readonly lost = new Map<string, Map<string, Set<() => unknown>>>();

  served(provider: string): Map<string, PluginExportFactory> {
    let mine = this.exports.get(provider);
    if (!mine) this.exports.set(provider, (mine = new Map()));
    return mine;
  }
  serve(provider: string, name: string, major: number, factory: unknown): void {
    const use = `${name}@${major}`;
    if (typeof factory !== "function") throw new TypeError(`serve("${name}", ${major}) needs a factory function`);
    if (this.sealed.has(provider)) throw new Error(`serve() is accepted only while activate() runs — ${use} was not served`);
    const mine = this.served(provider);
    if (mine.has(use)) throw new Error(`${use} is already served`);
    mine.set(use, factory as PluginExportFactory);
  }
  seal(provider: string): void {
    this.sealed.add(provider);
  }
  isSealed(provider: string): boolean {
    return this.sealed.has(provider);
  }
  /** A provider whose `activate` threw: what it served before throwing is gone with it. */
  discard(provider: string): void {
    this.exports.delete(provider);
  }
  isDown(provider: string): boolean {
    return this.down.has(provider);
  }
  open(caller: PluginLinkCaller, provider: MembraneParty, use: string): unknown {
    if (this.down.has(provider.id)) return undefined;
    const factory = this.exports.get(provider.id)?.get(use);
    if (!factory) return undefined;
    const key = `${provider.id}\0${caller.id}\0${use}`;
    const open = this.links.get(key);
    if (open && !open.membrane.revoked) return open.api;
    const abort = new AbortController();
    const { api, membrane } = openPluginLink({ provider, caller, export: use, factory, signal: abort.signal });
    this.links.set(key, { provider, caller: { id: caller.id, name: caller.name }, membrane, api, abort });
    return api;
  }
  onLost(consumer: string, provider: string, fn: () => unknown): () => void {
    let byProvider = this.lost.get(consumer);
    if (!byProvider) this.lost.set(consumer, (byProvider = new Map()));
    let fns = byProvider.get(provider);
    if (!fns) byProvider.set(provider, (fns = new Set()));
    fns.add(fn);
    return () => {
      fns.delete(fn);
    };
  }
  /** `provider` is going down: stop handing it out, and tell every consumer still up that asked. */
  async withdraw(provider: string, isUp: (consumer: string) => boolean = () => true): Promise<unknown[]> {
    this.down.add(provider);
    const errors: unknown[] = [];
    for (const [consumer, byProvider] of this.lost) {
      if (consumer === provider || !isUp(consumer)) continue;
      const fns = [...(byProvider.get(provider) ?? [])];
      const results = await Promise.allSettled(fns.map((fn) => Promise.resolve().then(() => fn())));
      for (const r of results) if (r.status === "rejected") errors.push(r.reason);
    }
    return errors;
  }
  /** Close every link `id` is in, as consumer or provider. */
  close(id: string): void {
    this.lost.delete(id);
    for (const [key, link] of this.links) {
      if (link.provider.id !== id && link.caller.id !== id) continue;
      this.links.delete(key);
      const why = pluginLinkClosedReason(link.provider.id === id ? "provider" : "caller", link.provider, link.caller);
      link.membrane.revoke(why);
      link.abort.abort(new PluginRevokedError(link.provider.id, why));
    }
  }
  /** Back up (a test host starting a plugin again is not a thing; a fake dependency coming back is). */
  restore(provider: string): void {
    this.down.delete(provider);
  }
}

/** What {@link createTestHost} binds into a plugin's context in place of the single-plugin fakes. */
interface HostBinding {
  links: TestLinkTable;
  dependencies?: NonNullable<PluginContext["dependencies"]>;
  provides?: NonNullable<PluginContext["provides"]>;
}
const HOST_BINDINGS = new WeakMap<TestContextOptions, HostBinding>();

export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const id = opts.id ?? "test-plugin";
  const caps = new Set<PluginCapability>(
    opts.capabilities
      ? grantedPluginCapabilities({ capabilities: [...opts.capabilities], optionalCapabilities: [...(opts.optionalCapabilities ?? [])] })
      : PLUGIN_CAPABILITIES,
  );
  const has = (c: PluginCapability) => caps.has(c);

  const log: TestLogLine[] = [];
  const emitted: TestContext["emitted"] = [];
  const kv = new Map<string, unknown>(Object.entries(opts.kv ?? {}));
  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));
  let settings: Record<string, unknown> = { ...(opts.settings ?? {}) };
  const settingsListeners = new Set<(next: unknown) => void>();
  const settingsCheck = opts.settingsSchema === undefined ? undefined : compilePluginSettingsSchema(opts.settingsSchema);
  const listeners = new Set<(evt: WsServerEvent) => void>();
  const routes: Route[] = [];
  const sent: TestContext["sent"] = [];
  const asked: TestContext["asked"] = [];
  const replied: TestContext["replied"] = [];
  const answered: TestContext["answered"] = [];
  const approvalLog: TestContext["approvals"] = [];
  const registeredTools = new Map<string, PluginTool>();
  const attention: AttentionItem[] = [];
  const memory = new Map<string, Map<string, PluginMemoryInput>>();
  const processes = new Map<string, { id: string; status: string; ports?: number[]; url?: string }>();
  const runnerProcesses: PluginRunnerProcess[] = [];
  // A real host always reserves these (server `dispatchPorts`), so a plugin's
  // test sees the same floor it will meet in production.
  const reservedPorts: PluginReservedPort[] = [
    { port: 4318, owner: "dispatch", reason: "the installed Dispatch instance's default port" },
    { port: 4319, owner: "dispatch", reason: "the development Dispatch instance's default port" },
    { port: 24678, owner: "dispatch", reason: "a development Dispatch instance's live-reload socket" },
  ];
  const oauthTokens = new Map<string, string>();
  const providers: TestContext["providers"] = [];
  const terminalBackends = new Map<string, TerminalBackend>();
  const terminalPorts: TerminalPortForward[] = [];
  const terminalStatus = new Map<string, TerminalBackendStatusInput>();
  const terminalUpdates = new Map<string, TerminalBackendUpdate>();
  const projects = opts.projects ?? [];
  const chats = opts.chats ?? [];

  const ctx: PluginContext = {
    id,
    dir: opts.dir ?? `/plugins/${id}`,
    version: opts.version ?? "0.0.0",
    ...(opts.instance === null ? {} : { instance: { ...TEST_INSTANCE, ...opts.instance } }),
    log: {
      info: (message) => log.push({ level: "info", message }),
      warn: (message) => log.push({ level: "warn", message }),
      error: (message, err) => log.push({ level: "error", message, err }),
    },
    settings: {
      get: <T = Record<string, unknown>>() => settings as T,
      onChange: (fn) => {
        settingsListeners.add(fn);
        return () => settingsListeners.delete(fn);
      },
      // The host's rule: a top-level merge patch, the schema judged only on
      // the keys it changes, listeners told only when something changed.
      set: async (patch) => {
        const next = applySettingsPatch(settings, patch);
        const { refused } = checkPluginSettings(settingsCheck, settings, next);
        if (refused.length) throw new Error(`settings for "${id}" do not match its schema — ${refused.join("; ")}`);
        if (!sameSettingsValue(settings, next)) {
          settings = next;
          for (const fn of [...settingsListeners]) fn(settings);
        }
        return settings;
      },
    },
    projects: {
      list: async () => [...projects],
      get: async (projectId) => projects.find((p) => p.id === projectId),
    },
    emit: (payload, chatId) => {
      emitted.push(chatId === undefined ? { payload } : { payload, chatId });
    },
  };

  if (has("events")) {
    ctx.bus = {
      on: <T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void) => {
        const wrapped = (evt: WsServerEvent) => {
          if (evt.type === type) fn(evt as Extract<WsServerEvent, { type: T }>);
        };
        listeners.add(wrapped);
        return () => listeners.delete(wrapped);
      },
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  if (has("approvals")) {
    ctx.approvals = {
      // The host's refusals, so a plugin's error path is exercised here too.
      request: async (chatId, req) => {
        if (typeof chatId !== "string" || !chatId) throw new Error("approvals.request: chatId is required");
        const title = typeof req?.title === "string" ? req.title.trim() : "";
        if (!title) throw new Error("approvals.request: title is required");
        for (const [key, max] of Object.entries(PLUGIN_APPROVAL_LIMITS)) {
          const v = key === "title" ? title : (req as unknown as Record<string, unknown>)[key];
          if (v === undefined) continue;
          if (typeof v !== "string") throw new Error(`approvals.request: ${key} must be a string`);
          if (v.length > max) throw new Error(`approvals.request: ${key} is over ${max} characters`);
        }
        const timeoutSeconds = req.timeoutSeconds ?? PLUGIN_APPROVAL_DEFAULT_TIMEOUT_SECONDS;
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > PLUGIN_APPROVAL_MAX_TIMEOUT_SECONDS) {
          throw new Error(`approvals.request: timeoutSeconds must be above 0 and at most ${PLUGIN_APPROVAL_MAX_TIMEOUT_SECONDS}`);
        }
        if (req.signal?.aborted) return { decision: "cancelled", at: Date.now() };
        const entry: TestContext["approvals"][number] = { chatId, request: req };
        approvalLog.push(entry);
        const scripted = Promise.resolve(opts.approve ? opts.approve(chatId, req) : ("timeout" as const)).then(
          (a): PluginApprovalResult => {
            const r = typeof a === "string" ? { decision: a } : a;
            // As on the host: a name only on an answer a person gave.
            const named = r.decision === "approved" || r.decision === "denied";
            return { decision: r.decision, ...(named && r.by ? { by: r.by } : {}), at: Date.now() };
          },
        );
        const withdrawn = new Promise<PluginApprovalResult>((resolve) => {
          req.signal?.addEventListener("abort", () => resolve({ decision: "cancelled", at: Date.now() }), {
            once: true,
          });
        });
        entry.result = await Promise.race([scripted, withdrawn]);
        return entry.result;
      },
    };
  }

  if (has("tools")) {
    ctx.tools = {
      register: (tool) => {
        const t = tool as PluginTool;
        if (!t || typeof t !== "object") throw new Error("tools.register: a tool is an object");
        if (typeof t.name !== "string" || !PLUGIN_TOOL_NAME_PATTERN.test(t.name)) {
          throw new Error(`tools.register: name must match ${PLUGIN_TOOL_NAME_PATTERN} (lower snake case)`);
        }
        const qualified = pluginToolQualifiedName(id, t.name);
        if (qualified.length > PLUGIN_TOOL_LIMITS.qualifiedNameLength) {
          throw new Error(
            `tools.register: "${qualified}" is ${qualified.length} characters; the agent-facing name may be at most ${PLUGIN_TOOL_LIMITS.qualifiedNameLength}`,
          );
        }
        if (typeof t.description !== "string" || !t.description.trim()) {
          throw new Error(`tools.register: ${t.name} needs a description`);
        }
        if (t.description.length > PLUGIN_TOOL_LIMITS.descriptionLength) {
          throw new Error(`tools.register: ${t.name}'s description is over ${PLUGIN_TOOL_LIMITS.descriptionLength} characters`);
        }
        if (typeof t.handler !== "function") throw new Error(`tools.register: ${t.name} needs a handler`);
        if (t.inputSchema !== undefined && t.inputSchema?.type !== "object") {
          throw new Error(`tools.register: ${t.name}'s inputSchema must be a JSON Schema with type "object"`);
        }
        if (registeredTools.has(t.name)) throw new Error(`tools.register: "${t.name}" is already registered; unregister it first`);
        if (registeredTools.size >= PLUGIN_TOOL_LIMITS.toolsPerPlugin) {
          throw new Error(`tools.register: at most ${PLUGIN_TOOL_LIMITS.toolsPerPlugin} tools per plugin`);
        }
        registeredTools.set(t.name, t);
        return () => {
          if (registeredTools.get(t.name) === t) registeredTools.delete(t.name);
        };
      },
    };
  }

  if (has("shared")) {
    const store = opts.sharedStore ?? createTestSharedStore();
    const L = PLUGIN_SHARED_LIMITS;
    const me = opts.instance === null ? undefined : { ...TEST_INSTANCE, ...opts.instance };
    const k = (key: string) => {
      if (typeof key !== "string" || !key || key.length > L.keyLength) throw new Error(`shared: a key is a string of 1–${L.keyLength} characters`);
      return `${id}\u0000${key}`;
    };
    const ln = (name: string) => {
      if (typeof name !== "string" || !name || name.length > L.lockNameLength) {
        throw new Error(`shared: a lock name is a string of 1–${L.lockNameLength} characters`);
      }
      return `${id}\u0000${name}`;
    };
    const copy = (v: unknown) => {
      const json = JSON.stringify(v);
      if (json === undefined) throw new Error("shared: the value has no JSON form");
      if (json.length > L.valueBytes) throw new Error(`shared: the value is over ${L.valueBytes} bytes as JSON`);
      return JSON.parse(json) as unknown;
    };
    const write = (key: string, value: unknown): number => {
      // As on the host: one counter per plugin, so a key deleted and created
      // again never gets back a version a reader may still hold.
      const version = (store.seq.get(id) ?? 0) + 1;
      store.seq.set(id, version);
      store.values.set(key, { value: copy(value), version, updatedAt: store.now(), ...(me ? { updatedBy: me.id } : {}) });
      return version;
    };
    const ttlOf = (t: number | undefined) => {
      const ttl = t ?? L.defaultTtlMs;
      if (!Number.isFinite(ttl) || ttl < L.minTtlMs || ttl > L.maxTtlMs) throw new Error(`shared: ttlMs must be between ${L.minTtlMs} and ${L.maxTtlMs}`);
      return ttl;
    };
    ctx.shared = {
      get: async (key) => {
        const e = store.values.get(k(key));
        return (e ? copy(e.value) : undefined) as never;
      },
      entry: async (key) => {
        const e = store.values.get(k(key));
        return e ? ({ ...e, value: copy(e.value) } as never) : undefined;
      },
      set: async (key, value) => {
        const kk = k(key);
        if (value === undefined) {
          store.values.delete(kk);
          return 0;
        }
        return write(kk, value);
      },
      compareAndSet: async (key, expected, value) => {
        const kk = k(key);
        const cur = store.values.get(kk);
        if ((cur?.version ?? null) !== expected) return { ok: false, ...(cur ? { current: { ...cur, value: copy(cur.value) } } : {}) };
        if (value === undefined) {
          store.values.delete(kk);
          return { ok: true, version: 0 };
        }
        return { ok: true, version: write(kk, value) };
      },
      delete: async (key) => store.values.delete(k(key)),
      list: async (prefix = "") =>
        [...store.values.keys()]
          .filter((key) => key.startsWith(`${id}\u0000${prefix}`))
          .map((key) => key.slice(id.length + 1))
          .sort(),
      lock: async (name, o = {}) => {
        const key = ln(name);
        const ttl = ttlOf(o.ttlMs);
        const deadline = store.now() + (o.waitMs ?? 0);
        for (;;) {
          if (o.signal?.aborted) return undefined;
          const held = store.locks.get(key);
          if (!held || held.expiresAt <= store.now()) {
            const row = {
              token: `${Math.random()}`,
              ...(me ? { instanceId: me.id, role: me.role } : {}),
              acquiredAt: store.now(),
              expiresAt: store.now() + ttl,
            };
            store.locks.set(key, row);
            let lost = false;
            let released = false;
            const lease = {
              name,
              acquiredAt: row.acquiredAt,
              get expiresAt() {
                return row.expiresAt;
              },
              get lost() {
                return lost;
              },
              renew: async (ms?: number) => {
                const cur = store.locks.get(key);
                if (released || lost || cur !== row || row.expiresAt <= store.now()) {
                  if (!released && !lost) {
                    lost = true;
                    o.onLost?.();
                  }
                  return false;
                }
                row.expiresAt = store.now() + ttlOf(ms ?? ttl);
                return true;
              },
              release: async () => {
                if (released) return;
                released = true;
                if (store.locks.get(key) === row) store.locks.delete(key);
              },
            };
            return lease;
          }
          if (store.now() >= deadline) return undefined;
          // No real clock to wait on: a test moves `now` or releases the
          // holder between polls.
          await new Promise((r) => setTimeout(r, 5));
        }
      },
      holder: async (name) => {
        const held = store.locks.get(ln(name));
        if (!held || held.expiresAt <= store.now()) return undefined;
        return {
          ...(held.instanceId ? { instanceId: held.instanceId } : {}),
          ...(held.role ? { role: held.role as PluginInstance["role"] } : {}),
          mine: !!me && held.instanceId === me.id,
          acquiredAt: held.acquiredAt,
          expiresAt: held.expiresAt,
        };
      },
    };
  }

  if (has("routes")) {
    const add = (method: string) => (path: string, handler: Route["handler"]) => {
      routes.push({ method, segments: path.split("/").filter(Boolean), handler });
    };
    ctx.routes = (define) =>
      define({ get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") });
  }

  if (has("secrets")) {
    const covered = (name: string) => !opts.manifestSecrets || pluginSecretAllowed(opts.manifestSecrets, name);
    const s: NonNullable<PluginContext["secrets"]> = {
      get: async (name) => (covered(name) ? secrets.get(name) : undefined),
      list: async () => [...secrets.keys()].filter(covered).sort(),
    };
    if (has("secrets:write")) {
      // The host's refusals, word for word where it matters: a test that
      // passes here must not be one that throws on the real store.
      const writable = (name: string) => {
        if (!SECRET_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid secret name`);
        if (!covered(name)) throw new Error(`secret "${name}" is not listed under secrets: in plugin.yaml`);
      };
      s.set = async (name, value) => {
        writable(name);
        if (typeof value !== "string" || !value) throw new Error(`secret "${name}" needs a non-empty string value — use delete() to remove it`);
        if (value.length > SECRET_VALUE_MAX) throw new Error(`secret "${name}" is over ${SECRET_VALUE_MAX / 1024} KiB`);
        secrets.set(name, value);
      };
      s.delete = async (name) => {
        writable(name);
        return secrets.delete(name);
      };
    }
    ctx.secrets = s;
  }

  if (has("kv")) {
    ctx.kv = {
      get: async <T = unknown>(key: string) => kv.get(key) as T | undefined,
      set: async (key, value) => {
        // Mirrors the host: `undefined` has no JSON form, so a set to nothing is a delete.
        if (value === undefined) kv.delete(key);
        else kv.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      },
      delete: async (key) => {
        kv.delete(key);
      },
      list: async (prefix = "") => [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(),
    };
  }

  if (has("chats:read") || has("chats:write")) {
    ctx.chats = {};
    ctx.attention = {};
    if (has("chats:read")) {
      ctx.chats.list = async (q = {}) =>
        chats
          .filter((c) => (q.projectId ? c.projectId === q.projectId : true))
          .filter((c) => (q.archived ? true : !c.archived))
          .filter((c) => (q.status ? c.status === q.status : true))
          .filter((c) => (q.since ? c.updatedAt >= q.since : true))
          .slice(0, q.limit ?? 50);
      ctx.chats.find = async (q) =>
        chats.filter((c) => (q.query ? c.title.toLowerCase().includes(q.query.toLowerCase()) : true));
      ctx.chats.read = async (chatId, view = "digest") =>
        opts.readChat ? opts.readChat(chatId, view) : `[${view} of ${chatId}]`;
      ctx.chats.state = async (chatId) => {
        if (opts.stateOf) return opts.stateOf(chatId);
        const chat = chats.find((c) => c.id === chatId);
        if (!chat) return null;
        return {
          chatId,
          title: chat.title,
          projectId: chat.projectId,
          status: "idle",
          dormant: false,
          blockedOnHuman: false,
          updatedAt: chat.updatedAt,
          prs: chat.prs ?? [],
          heldMessages: 0,
        };
      };
      ctx.attention.list = async () => [...attention];
    }
    if (has("chats:write")) {
      ctx.chats.send = async (chatId, text, o = {}): Promise<PluginSendResult> => {
        sent.push({ chatId, text, ...(o.delivery ? { delivery: o.delivery } : {}), ...(o.sender ? { sender: o.sender } : {}) });
        return { ok: true };
      };
      ctx.chats.ask = async (chatId, question, o = {}): Promise<PluginAskResult> => {
        asked.push({
          chatId,
          question,
          ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
          ...(o.sender ? { sender: o.sender } : {}),
        });
        const answer = opts.answerAsk?.(chatId, question);
        const askId = `ask-${asked.length}`;
        return answer === undefined
          ? { ok: true, askId, answered: false, reason: "timeout" }
          : { ok: true, askId, answered: true, answer };
      };
      ctx.chats.reply = async (askId, answer) => {
        replied.push({ askId, answer });
        return { ok: true };
      };
      ctx.attention.answer = async (itemId, answer: { optionId?: string; answer?: string; notes?: string; answers?: QuestionAnswer[] } | { decline: true }) => {
        const item = attention.find((a) => a.id === itemId);
        if (!item) return { ok: false, message: `no attention item "${itemId}"` };
        if (item.kind !== "question") return { ok: false, message: `attention item "${itemId}" is a ${item.kind}, not a question` };
        answered.push({ itemId, answer });
        return { ok: true };
      };
    }
  }

  if (has("memory")) {
    ctx.memory = {
      recall: async (projectId, query) => {
        const rows = [...(memory.get(projectId)?.values() ?? [])].filter((m) =>
          query ? `${m.name} ${m.description} ${m.body}`.toLowerCase().includes(query.toLowerCase()) : true,
        );
        return rows.map((m) => `## ${m.name}\n${m.description}\n\n${m.body}`).join("\n\n---\n\n");
      },
      remember: async (projectId, m) => {
        if (!memory.has(projectId)) memory.set(projectId, new Map());
        memory.get(projectId)!.set(m.name, m);
      },
      forget: async (projectId, name) => {
        memory.get(projectId)?.delete(name);
      },
    };
  }

  if (has("process")) {
    ctx.processes = {
      start: async (pid) => {
        const p = processes.get(pid);
        if (!p) throw new Error(`no process "${pid}"`);
        p.status = "running";
      },
      stop: async (pid) => {
        const p = processes.get(pid);
        if (!p) throw new Error(`no process "${pid}"`);
        p.status = "stopped";
      },
      list: async () => [...processes.values()].map((p) => ({ ...p })),
    };
  }

  if (has("runner")) {
    ctx.runner = {
      list: async () => runnerProcesses.map((p) => ({ ...p, ports: [...p.ports] })),
      reservedPorts: async () => [...reservedPorts].sort((a, b) => a.port - b.port).map((p) => ({ ...p })),
    };
  }

  if (has("oauth")) {
    ctx.oauth = {
      connectUrl: async (name) => `https://example.invalid/oauth/authorize?client=${encodeURIComponent(name)}`,
      token: async (name) => oauthTokens.get(name),
      disconnect: async (name) => {
        oauthTokens.delete(name);
      },
    };
  }

  if (has("providers")) {
    ctx.providers = {
      // The host's two refusals, so a plugin's test sees them before a real
      // host does: a mismatched id, and an id already taken.
      register: (harness, descriptor) => {
        if (harness.kind !== descriptor.id) {
          throw new Error(`harness kind "${harness.kind}" does not match descriptor id "${descriptor.id}"`);
        }
        if (descriptor.id === "claude" || providers.some((p) => p.descriptor.id === descriptor.id)) {
          throw new Error(`provider "${descriptor.id}" is already registered`);
        }
        providers.push({ harness, descriptor });
      },
    };
  }

  if (has("terminals")) {
    ctx.terminals = {
      // The host's refusals, so a plugin's test sees them before a real host does.
      registerBackend: (backend) => {
        // Mirrors TERMINAL_BACKEND_ID_PATTERN (the SDK takes no values from
        // shared): a bare name, or one qualified by this plugin's own id.
        if (!/^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,47}$/.test(backend.id) || backend.id === "local") {
          throw new Error(`terminal backend id "${backend.id}" is invalid or reserved`);
        }
        const slash = backend.id.indexOf("/");
        if (slash > 0 && backend.id.slice(0, slash) !== id) {
          throw new Error(
            `terminal backend id "${backend.id}": a qualified id must start with the registering plugin's id ("${id}/…")`,
          );
        }
        if (terminalBackends.has(backend.id)) {
          throw new Error(`terminal backend "${backend.id}" is already registered`);
        }
        if (backend.fallback !== undefined && backend.fallback !== "local" && backend.fallback !== "refuse") {
          throw new Error(`terminal backend "${backend.id}": fallback must be "local" or "refuse"`);
        }
        terminalBackends.set(backend.id, backend);
      },
      publishPort: (backendId, port) => {
        if (!terminalBackends.has(backendId)) {
          throw new Error(`terminal backend "${backendId}" was not registered by plugin "${id}"`);
        }
        if (port.remoteUrl !== undefined && !/^https?:\/\//.test(String(port.remoteUrl))) {
          throw new Error("publishPort: remoteUrl must be an http(s) URL");
        }
        // As the host fills it: the forwarded url with host → localhost and
        // port → the remote one. Duplicated, because the SDK takes no values
        // from shared (`defaultForwardRemoteUrl` there).
        const forward: TerminalPortForward = {
          ...port,
          backend: backendId,
          remoteUrl: port.remoteUrl ?? testRemoteUrl(port.url, port.remotePort),
        };
        const at = terminalPorts.findIndex((p) => p.chatId === port.chatId && p.remotePort === port.remotePort);
        if (at >= 0) terminalPorts.splice(at, 1, forward);
        else terminalPorts.push(forward);
        return () => {
          const i = terminalPorts.indexOf(forward);
          if (i >= 0) terminalPorts.splice(i, 1);
        };
      },
      ports: (chatId) => terminalPorts.filter((p) => p.chatId === chatId),
      setStatus: (backendId, status) => {
        if (!terminalBackends.has(backendId)) {
          throw new Error(`terminal backend "${backendId}" was not registered by plugin "${id}"`);
        }
        if (!status || !["online", "offline", "degraded"].includes(status.state)) {
          throw new Error(`terminal backend "${backendId}": status.state must be "online", "offline" or "degraded"`);
        }
        terminalStatus.set(backendId, { ...status });
      },
      updateBackend: (backendId, update) => {
        if (!terminalBackends.has(backendId)) {
          throw new Error(`terminal backend "${backendId}" was not registered by plugin "${id}"`);
        }
        if ("label" in update && (typeof update.label !== "string" || !update.label.trim())) {
          throw new Error(`terminal backend "${backendId}": label must be a non-empty string`);
        }
        terminalUpdates.set(backendId, { ...terminalUpdates.get(backendId), ...update });
      },
      // Throws (not rejects) for a foreign id, as the host does.
      unregisterBackend: (backendId) => {
        const b = terminalBackends.get(backendId);
        if (!b) throw new Error(`terminal backend "${backendId}" was not registered by plugin "${id}"`);
        terminalBackends.delete(backendId);
        terminalStatus.delete(backendId);
        terminalUpdates.delete(backendId);
        for (const f of terminalPorts.filter((p) => p.backend === backendId)) {
          terminalPorts.splice(terminalPorts.indexOf(f), 1);
        }
        return Promise.resolve(b.dispose?.()).then(() => undefined);
      },
    };
  }

  // Runs in flight anywhere, as core would report them, and who is listening.
  const inFlight: TerminalRunInFlight[] = [];
  const runListeners = new Set<(e: TerminalRunEvent) => void>();
  // The host's rule: a run elsewhere is counted, but what it runs is not shown.
  const visibleRun = (run: TerminalRunInFlight): TerminalRunInFlight => {
    if (terminalBackends.has(run.backend)) return { ...run };
    const { command: _hidden, ...rest } = run;
    return rest;
  };
  const fireRun = (kind: TerminalRunEvent["kind"], run: TerminalRunInFlight): void => {
    const event: TerminalRunEvent = { kind, run: visibleRun(run), at: Date.now() };
    for (const fn of [...runListeners]) {
      try {
        fn(event);
      } catch {
        // As on the host: a listener's throw never reaches the run.
      }
    }
  };
  if (ctx.terminals) {
    ctx.terminals.runs = (filter = {}) =>
      inFlight
        .filter(
          (r) =>
            (filter.chatId === undefined || r.chatId === filter.chatId) &&
            (filter.projectId === undefined || r.projectId === filter.projectId) &&
            (filter.backend === undefined || r.backend === filter.backend),
        )
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(visibleRun);
    ctx.terminals.onRun = (fn) => {
      runListeners.add(fn);
      return () => runListeners.delete(fn);
    };
  }

  // A fresh `runId` per call, as core gives each run its own. A test pairing a
  // `beforeRun` with its `afterRun` passes the same `runId` to both.
  let runSeq = 0;
  const runDefaults = () => ({
    runId: `test-run-${++runSeq}`,
    terminal: "main",
    cwd: "/repo",
    background: false,
    signal: new AbortController().signal,
  });

  const backendOf = (backendId: string): TerminalBackend => {
    const b = terminalBackends.get(backendId);
    if (!b) throw new Error(`no terminal backend "${backendId}" registered — have: ${[...terminalBackends.keys()].join(", ") || "(none)"}`);
    return b;
  };

  // `ctx.dependencies` / `ctx.provides` — from createTestHost when this
  // context is one of its plugins, else the single-plugin fakes. Either way
  // only when declared, as the host builds them only for a manifest that
  // declares the key.
  const bound = HOST_BINDINGS.get(opts);
  const links = bound?.links ?? new TestLinkTable();
  if (bound) {
    if (bound.dependencies) ctx.dependencies = bound.dependencies;
    if (bound.provides) ctx.provides = bound.provides;
  } else {
    if (opts.dependencies) ctx.dependencies = fakeDependencies(opts, id, [...caps], links);
    if (opts.provides) ctx.provides = fakeProvides(opts, id, links);
  }

  return {
    ctx,
    publish: (evt) => {
      for (const fn of [...listeners]) fn(evt);
    },
    emitted,
    kv,
    secrets,
    settings: {
      set: (next) => {
        settings = { ...next };
        for (const fn of [...settingsListeners]) fn(settings);
      },
      get: () => settings,
    },
    routes: {
      call: async (method, path, init = {}) => {
        const [pathname, search] = path.split("?", 2);
        const upper = method.toUpperCase();
        for (const route of routes) {
          if (route.method !== upper) continue;
          const params = matchRoute(route, pathname ?? "/");
          if (!params) continue;
          const query: Record<string, string | string[]> = { ...(init.query ?? {}) };
          if (search) for (const [k, v] of new URLSearchParams(search)) query[k] = v;
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
          const req: PluginRequest = {
            method: upper,
            url: path,
            params: { ...params, ...(init.params ?? {}) },
            query,
            headers,
            body: init.body,
          };
          const { reply, sent: result } = makeReply();
          const returned = await route.handler(req, reply);
          const r = result();
          return { status: r.status, headers: r.headers, body: r.explicit ? r.body : returned };
        }
        throw new Error(`no ${upper} ${pathname} registered — have: ${routes.map((r) => `${r.method} /${r.segments.join("/")}`).join(", ") || "(nothing)"}`);
      },
      list: () => routes.map((r) => `${r.method} /${r.segments.join("/")}`),
    },
    log,
    sent,
    asked,
    replied,
    answered,
    approvals: approvalLog,
    tools: {
      list: () => [...registeredTools.keys()].sort(),
      get: (name) => {
        const t = registeredTools.get(name);
        if (!t) return undefined;
        return {
          name: t.name,
          qualifiedName: pluginToolQualifiedName(id, t.name),
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        };
      },
      call: async (name, args = {}, call = {}) => {
        const t = registeredTools.get(name);
        if (!t) return pluginToolError(`The tool ${name} is no longer available`);
        try {
          const out = await t.handler(args, {
            chatId: "test-chat",
            signal: new AbortController().signal,
            ...call,
          });
          // The HOST's normalizer and error text, from shared: a result the
          // host would cut or refuse is cut or refused here too.
          return normalizePluginToolResult(out, opts.name ?? id);
        } catch (err) {
          return pluginToolThrown(err, opts.name ?? id);
        }
      },
    },
    attention,
    memory,
    processes,
    runnerProcesses,
    reservedPorts,
    oauthTokens,
    providers,
    terminalBackends,
    terminalPorts,
    terminalStatus,
    terminalUpdates,
    terminals: {
      startRun: (run) => {
        const full: TerminalRunInFlight = {
          runId: `test-run-${++runSeq}`,
          terminal: "main",
          backend: "local",
          cwd: "/repo",
          command: "true",
          background: false,
          startedAt: Date.now(),
          ...run,
        };
        if (inFlight.some((r) => r.runId === full.runId)) throw new Error(`run "${full.runId}" is already in flight`);
        inFlight.push(full);
        fireRun("started", full);
        return full;
      },
      endRun: (runId) => {
        const i = inFlight.findIndex((r) => r.runId === runId);
        if (i < 0) return false;
        const [run] = inFlight.splice(i, 1);
        fireRun("ended", run!);
        return true;
      },
      spawn: (backendId, info) =>
        backendOf(backendId).spawn({
          name: "main",
          cwd: "/repo",
          signal: new AbortController().signal,
          ...info,
        }),
      chatIdle: async (chatId, projectId) => {
        for (const b of terminalBackends.values()) await b.onChatIdle?.({ chatId, projectId });
      },
      chatDeleted: async (chatId, projectId) => {
        for (const p of terminalPorts.filter((f) => f.chatId === chatId)) terminalPorts.splice(terminalPorts.indexOf(p), 1);
        for (const b of terminalBackends.values()) await b.onChatDeleted?.({ chatId, projectId });
      },
      spawnProcess: async (backendId, info) => {
        const b = backendOf(backendId);
        if (typeof b.spawnProcess !== "function") {
          throw new Error(`terminal backend "${backendId}" has no spawnProcess, so core never places a process on it`);
        }
        const handle = await b.spawnProcess({
          purpose: "mcp",
          name: "test",
          cwd: "/repo",
          signal: new AbortController().signal,
          ...info,
        });
        return testMcpProcess(handle);
      },
      beforeRun: async (backendId, info) => {
        const b = backendOf(backendId);
        if (!b.beforeRun) return { ran: true, notices: [] };
        let verdict: TerminalBeforeRunResult | void;
        try {
          verdict = await b.beforeRun({ ...runDefaults(), ...info });
        } catch (err) {
          return { ran: false, refusal: err instanceof Error ? err.message : String(err), notices: [] };
        }
        const notices = verdict?.notices ?? [];
        return typeof verdict?.refuse === "string"
          ? { ran: false, refusal: verdict.refuse, notices }
          : { ran: true, notices };
      },
      afterRun: async (backendId, info) => {
        const b = backendOf(backendId);
        const r: TerminalAfterRunResult | void = await b.afterRun?.({
          ...runDefaults(),
          exitCode: 0,
          durationMs: 0,
          outcome: "finished",
          ...info,
        });
        return { notices: r?.notices ?? [] };
      },
    },
    lifecycle: {
      shutdown: async (mod, reason, o = {}) => {
        const result = await withHostBudget(o.budgetMs ?? PLUGIN_SHUTDOWN_BUDGET_MS, (deadline, signal) =>
          mod.onShutdown?.({ reason, deadline, signal }),
        );
        await mod.deactivate?.();
        return result;
      },
      reconcile: (mod, liveChats, o = {}) =>
        withHostBudget(o.budgetMs ?? PLUGIN_RECONCILE_BUDGET_MS, (deadline, signal) =>
          mod.reconcile?.({ chats: liveChats, deadline, signal }),
        ),
    },
    listenerCount: () => listeners.size,
    served: links.served(id),
    callAs: <T = unknown>(
      callerId: string,
      name: string,
      major: number,
      who: { name?: string; version?: string; capabilities?: readonly PluginCapability[] } = {},
    ): T => {
      // The host lets a dependent in only once `activate` has resolved.
      links.seal(id);
      const use = `${name}@${major}`;
      const api = links.open(
        { id: callerId, name: who.name ?? callerId, version: who.version ?? "0.0.0", capabilities: [...(who.capabilities ?? [])] },
        { id, name: opts.name ?? id },
        use,
      );
      if (api === undefined) throw new Error(`"${id}" does not serve ${use}${links.isDown(id) ? " any more" : ""}`);
      return api as T;
    },
    revoke: (other) => {
      void links.withdraw(other, () => false);
      links.close(other);
    },
    lose: async (other) => {
      const errors = await links.withdraw(other, (consumer) => consumer === id);
      links.close(other);
      if (errors.length) throw errors[0];
    },
  };
}

/** The host's refusal for a dependency the manifest does not declare. Returns its declared `uses`. */
function declaredUses(self: string, declared: ReadonlyMap<string, readonly string[]>, other: string): readonly string[] {
  const uses = declared.get(other);
  if (!uses) throw new Error(`"${self}" does not declare a dependency on "${other}" in its plugin.yaml`);
  return uses;
}

/** The host's refusal for an export the manifest does not list under `uses`. */
function checkUse(self: string, uses: readonly string[], other: string, use: string): void {
  if (!uses.includes(use)) throw new Error(`"${self}" does not list ${use} under dependencies.${other}.uses in its plugin.yaml`);
}

/** `ctx.dependencies` for one plugin under test, over fake providers built from `opts.dependencies`. */
function fakeDependencies(
  opts: TestContextOptions,
  id: string,
  capabilities: PluginCapability[],
  links: TestLinkTable,
): NonNullable<PluginContext["dependencies"]> {
  const self: PluginLinkCaller = { id, name: opts.name ?? id, version: opts.version ?? "0.0.0", capabilities };
  const optional = new Set(opts.optionalDependencies ?? []);
  const declared = new Map<string, string[]>();
  for (const [other, byName] of Object.entries(opts.dependencies ?? {})) {
    const uses: string[] = [];
    for (const [name, byMajor] of Object.entries(byName)) {
      for (const [major, value] of Object.entries(byMajor)) {
        uses.push(`${name}@${major}`);
        if (value === null || value === undefined) continue;
        links.serve(other, name, Number(major), typeof value === "function" ? value : () => value);
      }
    }
    // A fake provider is already up: its `activate` is over, nothing more is served.
    links.seal(other);
    declared.set(other, uses);
  }
  return {
    get: <T = unknown>(other: string, name: string, major: number): T | undefined => {
      const use = `${name}@${major}`;
      checkUse(id, declaredUses(id, declared, other), other, use);
      return links.open(self, { id: other, name: other }, use) as T | undefined;
    },
    state: (other): PluginDependencyStatus => {
      const uses = [...declaredUses(id, declared, other)];
      const base = { id: other, uses, optional: optional.has(other) };
      if (links.isDown(other)) return { ...base, state: "disabled", detail: `${other} is switched off` };
      const missing = uses.filter((u) => !links.served(other).has(u));
      if (missing.length === uses.length) return { ...base, state: "missing", detail: `${other} is not installed` };
      if (missing.length) return { ...base, state: "not-served", detail: `${other} did not serve ${missing.join(", ")}` };
      return { ...base, state: "ok", detail: "" };
    },
    onLost: (other, fn) => {
      declaredUses(id, declared, other);
      if (typeof fn !== "function") throw new TypeError("onLost needs a function");
      return links.onLost(id, other, fn);
    },
  };
}

/** `ctx.provides` for one plugin under test: `serve` checked against `opts.provides`, collected in `t.served`. */
function fakeProvides(opts: TestContextOptions, id: string, links: TestLinkTable): NonNullable<PluginContext["provides"]> {
  const provided = opts.provides ?? {};
  return {
    serve: (name, major, factory) => {
      if (!provided[name]?.includes(major)) throw new Error(`"${id}" does not declare provides.${name}: [${major}] in its plugin.yaml`);
      links.serve(id, name, major, factory);
    },
    dependents: () => (opts.dependents ?? []).map((d) => ({ ...d, uses: [...d.uses] })),
  };
}

/* ------------------------------------------------------------ test host */

/** One plugin under {@link createTestHost}: its manifest's identity and keys, and its real module. */
export interface TestHostPlugin {
  manifest: {
    id: string;
    name?: string;
    version?: string;
    capabilities?: readonly PluginCapability[];
    dependencies?: Record<string, PluginDependencySpec>;
    provides?: Record<string, readonly number[]>;
    /** Default true. A plugin switched off is never activated, as on the host. */
    enabled?: boolean;
  };
  module: PluginModule;
  /** Everything else `createTestContext` takes, for this plugin's context. */
  options?: Omit<
    TestContextOptions,
    "id" | "name" | "version" | "capabilities" | "dependencies" | "optionalDependencies" | "provides" | "dependents"
  >;
}

export interface TestHost {
  /** The activation order the host's resolver chose: each plugin after what it uses, ties by id. */
  readonly order: readonly string[];
  /** Activate every plugin in `order`, as the host's boot does: blocked ones are skipped, a throw is an `error`. */
  start(): Promise<void>;
  /** A plugin's fake context — its `kv`, `routes`, `terminalBackends`… as `createTestContext` gives them. */
  context(id: string): TestContext;
  status(id: string): Extract<PluginStatus, "active" | "error" | "blocked" | "disabled">;
  /** Why it is `blocked` or `error`, in the host's words. */
  reason(id: string): string | undefined;
  /**
   * Switch `id` off as the host does: whatever REQUIRES it goes down first,
   * deepest first, as a `disable`, and ends `blocked`; optional dependents
   * hear `onLost` while it is still up; then it goes down, and only then are
   * its links closed.
   */
  disable(id: string): Promise<void>;
  /** A server stop: `onShutdown("stop")` consumers before providers, then `deactivate` in reverse order, closing links. */
  stop(): Promise<void>;
}

/**
 * Run several REAL plugin modules together, linked as the host links them
 * (docs/plugins.md → "Dependencies"): resolved with the host's own
 * `resolvePluginDependencies`, activated in its order, each `serve` sealed
 * when its `activate` resolves, every `get` through shared `openPluginLink`,
 * and the host's teardown order on `disable` and `stop`. For the contract
 * between a provider and its consumer — remote-host's `machines@1` and
 * proxmox-terminal's forwarder — rather than either alone.
 *
 * Each plugin gets a `createTestContext` of its own, so everything else (its
 * kv, routes, backends) is the single-plugin fake, inspectable through
 * `context(id)`.
 */
export function createTestHost(plugins: readonly TestHostPlugin[]): TestHost {
  const links = new TestLinkTable();
  const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
  type Status = ReturnType<TestHost["status"]>;
  const state = new Map<string, { status: Status; running: boolean; activating: boolean; reason?: string }>();
  for (const p of plugins) {
    state.set(p.manifest.id, { status: p.manifest.enabled === false ? "disabled" : "active", running: false, activating: false });
  }
  const resolution = resolvePluginDependencies(
    plugins.map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version ?? "0.0.0",
      valid: true,
      enabled: p.manifest.enabled !== false,
      ...(p.manifest.dependencies ? { dependencies: p.manifest.dependencies } : {}),
      ...(p.manifest.provides ? { provides: Object.fromEntries(Object.entries(p.manifest.provides).map(([k, v]) => [k, [...v]])) } : {}),
    })),
  );
  const nameOf = (id: string) => byId.get(id)?.manifest.name ?? id;
  const capabilitiesOf = (id: string): PluginCapability[] => [...(byId.get(id)?.manifest.capabilities ?? [])];
  const phaseOf = (id: string) => {
    const s = state.get(id)!;
    if (s.activating) return "activating" as const;
    if (s.running) return "active" as const;
    if (s.status === "error") return "error" as const;
    if (s.status === "blocked") return "blocked" as const;
    return "inactive" as const;
  };
  const live = (consumer: string): PluginDependencyStatus[] =>
    (resolution.dependencies.get(consumer) ?? []).map((d) => {
      const s = state.get(d.id);
      return liveDependencyState(
        d,
        s && { phase: phaseOf(d.id), enabled: s.status !== "disabled", ...(s.reason ? { error: s.reason } : {}) },
        links.isSealed(d.id) ? links.served(d.id) : undefined,
      );
    });

  const contexts = new Map<string, TestContext>();
  for (const p of plugins) {
    const id = p.manifest.id;
    const opts: TestContextOptions = {
      ...p.options,
      id,
      name: nameOf(id),
      version: p.manifest.version ?? "0.0.0",
      capabilities: capabilitiesOf(id),
    };
    const binding: HostBinding = { links };
    const declared = new Map(Object.entries(p.manifest.dependencies ?? {}).map(([k, v]) => [k, v.uses]));
    if (declared.size) {
      binding.dependencies = {
        get: <T = unknown>(other: string, name: string, major: number): T | undefined => {
          const use = `${name}@${major}`;
          checkUse(id, declaredUses(id, declared, other), other, use);
          const me = state.get(id)!;
          if (!me.running && !me.activating) return undefined;
          if (!state.get(other)?.running) return undefined;
          if (live(id).find((d) => d.id === other)?.state !== "ok") return undefined;
          return links.open({ id, name: nameOf(id), version: opts.version!, capabilities: capabilitiesOf(id) }, { id: other, name: nameOf(other) }, use) as
            | T
            | undefined;
        },
        state: (other) => {
          declaredUses(id, declared, other);
          const d = live(id).find((x) => x.id === other);
          return d && { ...d, uses: [...d.uses] };
        },
        onLost: (other, fn) => {
          declaredUses(id, declared, other);
          if (typeof fn !== "function") throw new TypeError("onLost needs a function");
          return links.onLost(id, other, fn);
        },
      };
    }
    const provided = p.manifest.provides ?? {};
    if (Object.keys(provided).length) {
      binding.provides = {
        serve: (name, major, factory) => {
          if (!provided[name]?.includes(major)) throw new Error(`"${id}" does not declare provides.${name}: [${major}] in its plugin.yaml`);
          if (!state.get(id)!.activating) throw new Error(`serve() is accepted only while activate() runs — ${name}@${major} was not served`);
          links.serve(id, name, major, factory);
        },
        dependents: () =>
          plugins
            .filter((q) => q.manifest.id !== id && q.manifest.dependencies && Object.hasOwn(q.manifest.dependencies, id))
            .map((q) => ({
              id: q.manifest.id,
              installed: true as const,
              status: state.get(q.manifest.id)!.status,
              uses: [...q.manifest.dependencies![id]!.uses],
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
      };
    }
    HOST_BINDINGS.set(opts, binding);
    contexts.set(id, createTestContext(opts));
  }

  const must = (id: string) => {
    const s = state.get(id);
    if (!s) throw new Error(`no plugin "${id}" in this test host — have: ${[...state.keys()].join(", ")}`);
    return s;
  };

  /** One plugin down, the host's way: onLost to whoever still runs, its hook, deactivate, then its links. */
  const down = async (id: string, reason?: PluginShutdownReason): Promise<void> => {
    const s = must(id);
    const mod = byId.get(id)!.module;
    if (s.running) await links.withdraw(id, (consumer) => state.get(consumer)?.running === true);
    if (reason && mod.onShutdown) {
      await mod.onShutdown({ reason, deadline: Date.now() + PLUGIN_SHUTDOWN_BUDGET_MS, signal: new AbortController().signal });
    }
    await mod.deactivate?.();
    links.close(id);
    s.running = false;
  };

  /** Everything that REQUIRES `id`, directly or through another, deepest first. */
  const requiredDependentsOf = (id: string): string[] => {
    const needs = new Set<string>();
    const walk = (provider: string) => {
      for (const p of plugins) {
        const spec = p.manifest.dependencies?.[provider];
        if (!spec || spec.optional || needs.has(p.manifest.id) || p.manifest.id === id) continue;
        needs.add(p.manifest.id);
        walk(p.manifest.id);
      }
    };
    walk(id);
    return [...resolution.order].reverse().filter((x) => needs.has(x));
  };

  return {
    order: resolution.order,
    context: (id) => {
      must(id);
      return contexts.get(id)!;
    },
    status: (id) => must(id).status,
    reason: (id) => must(id).reason,
    start: async () => {
      for (const id of resolution.order) {
        const s = state.get(id)!;
        if (s.status === "disabled" || s.running) continue;
        const early = resolution.blocked.get(id);
        const unmet = early
          ? undefined
          : live(id).find((d) => !d.optional && (d.state !== "ok" || !state.get(d.id)?.running));
        if (early || unmet) {
          s.status = "blocked";
          s.reason = early ?? blockedReason(unmet!.state === "ok" ? { ...unmet!, state: "failed", detail: `${unmet!.id} has not started` } : unmet!);
          continue;
        }
        s.activating = true;
        try {
          await byId.get(id)!.module.activate(contexts.get(id)!.ctx);
          links.seal(id);
          s.running = true;
          s.status = "active";
        } catch (err) {
          s.status = "error";
          s.reason = err instanceof Error ? err.message : String(err);
          links.discard(id);
          links.close(id);
        } finally {
          s.activating = false;
        }
      }
    },
    disable: async (id) => {
      const s = must(id);
      for (const dep of requiredDependentsOf(id)) {
        const d = state.get(dep)!;
        if (d.running) await down(dep, "disable");
        if (d.status !== "disabled") {
          d.status = "blocked";
          d.reason = byId.get(dep)!.manifest.dependencies?.[id]
            ? `needs ${id}, which was switched off`
            : `needs a plugin that needs ${id}, which was switched off`;
        }
      }
      if (s.running) await down(id, "disable");
      s.status = "disabled";
    },
    stop: async () => {
      const running = resolution.order.filter((id) => state.get(id)!.running);
      // Consumers' hooks before their providers', as the host's shutdown waves run them.
      const depth = new Map<string, number>();
      const depthOf = (id: string, seen = new Set<string>()): number => {
        if (depth.has(id)) return depth.get(id)!;
        if (seen.has(id)) return 0;
        seen.add(id);
        let d = 0;
        for (const c of running) if (byId.get(c)!.manifest.dependencies?.[id]) d = Math.max(d, depthOf(c, seen) + 1);
        depth.set(id, d);
        return d;
      };
      const waves: string[][] = [];
      for (const id of running) (waves[depthOf(id)] ??= []).push(id);
      const signal = new AbortController().signal;
      const deadline = Date.now() + PLUGIN_SHUTDOWN_BUDGET_MS;
      for (const wave of waves.filter(Boolean)) {
        // As the host: a wave's plugins stop handing out links when their turn
        // comes, not before — their consumers' hooks ran with them reachable.
        for (const id of wave) void links.withdraw(id, () => false);
        await Promise.all(wave.map((id) => byId.get(id)!.module.onShutdown?.({ reason: "stop", deadline, signal })));
      }
      for (const id of [...running].reverse()) await down(id);
    },
  };
}
