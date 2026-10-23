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
  PluginAskResult,
  PluginCapability,
  PluginChatState,
  PluginChatSummary,
  PluginMemoryInput,
  PluginProjectSummary,
  PluginSendResult,
  ProviderDescriptor,
  QuestionAnswer,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalPortForward,
  TerminalSpawnInfo,
  WsServerEvent,
  WsServerEventType,
} from "@dispatch/shared";
import { PLUGIN_CAPABILITIES } from "@dispatch/shared";
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
  /** Names → values for `ctx.secrets`. Unlisted names read as undefined, as on the host. */
  secrets?: Record<string, string>;
  projects?: PluginProjectSummary[];
  chats?: PluginChatSummary[];
  /** Pre-seeded kv rows. */
  kv?: Record<string, unknown>;
  /** What `chats.ask` answers with. Default: an unanswered timeout, like a chat nobody is watching. */
  answerAsk?: (chatId: string, question: string) => string | undefined;
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
  settings: {
    /** Replace the settings and fire every `onChange` listener — what `PUT /api/plugins/:id/settings` does. */
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
    chatDeleted(chatId: string, projectId?: string): Promise<void>;
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

/** Build a fake context. See the module comment for what it is and is not. */
export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const id = opts.id ?? "test-plugin";
  const caps = new Set<PluginCapability>(opts.capabilities ?? PLUGIN_CAPABILITIES);
  const has = (c: PluginCapability) => caps.has(c);

  const log: TestLogLine[] = [];
  const emitted: TestContext["emitted"] = [];
  const kv = new Map<string, unknown>(Object.entries(opts.kv ?? {}));
  let settings: Record<string, unknown> = { ...(opts.settings ?? {}) };
  const settingsListeners = new Set<(next: unknown) => void>();
  const listeners = new Set<(evt: WsServerEvent) => void>();
  const routes: Route[] = [];
  const sent: TestContext["sent"] = [];
  const asked: TestContext["asked"] = [];
  const replied: TestContext["replied"] = [];
  const answered: TestContext["answered"] = [];
  const attention: AttentionItem[] = [];
  const memory = new Map<string, Map<string, PluginMemoryInput>>();
  const processes = new Map<string, { id: string; status: string; ports?: number[]; url?: string }>();
  const oauthTokens = new Map<string, string>();
  const providers: TestContext["providers"] = [];
  const terminalBackends = new Map<string, TerminalBackend>();
  const terminalPorts: TerminalPortForward[] = [];
  const projects = opts.projects ?? [];
  const chats = opts.chats ?? [];

  const ctx: PluginContext = {
    id,
    dir: opts.dir ?? `/plugins/${id}`,
    version: opts.version ?? "0.0.0",
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

  if (has("routes")) {
    const add = (method: string) => (path: string, handler: Route["handler"]) => {
      routes.push({ method, segments: path.split("/").filter(Boolean), handler });
    };
    ctx.routes = (define) =>
      define({ get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") });
  }

  if (has("secrets")) {
    const values = opts.secrets ?? {};
    ctx.secrets = {
      get: async (name) => values[name],
      list: async () => Object.keys(values).filter((n) => values[n] !== undefined),
    };
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
        if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(backend.id) || backend.id === "local") {
          throw new Error(`terminal backend id "${backend.id}" is invalid or reserved`);
        }
        if (terminalBackends.has(backend.id)) {
          throw new Error(`terminal backend "${backend.id}" is already registered`);
        }
        terminalBackends.set(backend.id, backend);
      },
      publishPort: (backendId, port) => {
        if (!terminalBackends.has(backendId)) {
          throw new Error(`terminal backend "${backendId}" was not registered by plugin "${id}"`);
        }
        const forward: TerminalPortForward = { ...port, backend: backendId };
        const at = terminalPorts.findIndex((p) => p.chatId === port.chatId && p.remotePort === port.remotePort);
        if (at >= 0) terminalPorts.splice(at, 1, forward);
        else terminalPorts.push(forward);
        return () => {
          const i = terminalPorts.indexOf(forward);
          if (i >= 0) terminalPorts.splice(i, 1);
        };
      },
      ports: (chatId) => terminalPorts.filter((p) => p.chatId === chatId),
    };
  }

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
    attention,
    memory,
    processes,
    oauthTokens,
    providers,
    terminalBackends,
    terminalPorts,
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
    },
    listenerCount: () => listeners.size,
  };
}
