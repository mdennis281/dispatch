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
 * What it does NOT do: enforce the 30 s activate budget, run two plugins at
 * once, or persist anything. Those are the host's job and its test suite's.
 * Verify against a real instance before shipping (docs/plugins.md → "Testing").
 */
import type {
  AttentionItem,
  Harness,
  PluginApprovalDecision,
  PluginApprovalRequest,
  PluginApprovalResult,
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
  TerminalRunInfo,
  TerminalSpawnInfo,
  WsServerEvent,
  WsServerEventType,
} from "@dispatch/shared";
import {
  PLUGIN_APPROVAL_DEFAULT_TIMEOUT_SECONDS,
  PLUGIN_APPROVAL_LIMITS,
  PLUGIN_APPROVAL_MAX_TIMEOUT_SECONDS,
  PLUGIN_CAPABILITIES,
  PLUGIN_RECONCILE_BUDGET_MS,
  PLUGIN_SHUTDOWN_BUDGET_MS,
  SECRET_NAME_RE,
  SECRET_VALUE_MAX,
  applySettingsPatch,
  checkPluginSettings,
  compilePluginSettingsSchema,
  pluginSecretAllowed,
  sameSettingsValue,
} from "@dispatch/shared";
import type { PluginContext, PluginReply, PluginRequest } from "./index.js";

export interface TestContextOptions {
  id?: string;
  version?: string;
  /** Absolute path the plugin believes it lives at. Default `/plugins/<id>`. */
  dir?: string;
  /**
   * Which members to build. Default: every capability, so the fake never
   * hands a plugin less than its manifest will. Pass the manifest's list to
   * test the shape the host will actually deliver.
   */
  capabilities?: readonly PluginCapability[];
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
  /** The attention items `attention.list` reports. Push to simulate a pending question. */
  attention: AttentionItem[];
  /** `memory.remember` results, keyed by project then name. */
  memory: Map<string, Map<string, PluginMemoryInput>>;
  /** Processes `ctx.processes` believes exist. Start/stop flip `status`. */
  processes: Map<string, { id: string; status: string; ports?: number[]; url?: string }>;
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

export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const id = opts.id ?? "test-plugin";
  const caps = new Set<PluginCapability>(opts.capabilities ?? PLUGIN_CAPABILITIES);
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
  const attention: AttentionItem[] = [];
  const memory = new Map<string, Map<string, PluginMemoryInput>>();
  const processes = new Map<string, { id: string; status: string; ports?: number[]; url?: string }>();
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
    attention,
    memory,
    processes,
    oauthTokens,
    providers,
    terminalBackends,
    terminalPorts,
    terminalStatus,
    terminalUpdates,
    terminals: {
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
  };
}
