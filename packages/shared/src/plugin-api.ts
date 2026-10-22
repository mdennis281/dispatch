/**
 * The server-side plugin API — what a plugin's `activate(ctx)` receives.
 *
 * PURE TYPES. This file is what `@dispatch/plugin-sdk` re-exports to plugin
 * authors, so it must stay free of server imports: no Fastify, no Store, no
 * services. Everything the context hands out is expressed in the shared
 * domain vocabulary, and the server implements it in `packages/server/src/plugins/`.
 *
 * Versioning: the shape is additive within {@link PLUGIN_API_VERSION}. Removing
 * a member or changing its meaning bumps the major; adding one does not.
 *
 * See docs/plugins.md → "Server API".
 */
import type { ChatStatus } from "./common.js";
import type { AttentionItem } from "./messages.js";
import type { MemoryType } from "./domain.js";
import type { QuestionAnswer, WsServerEvent, WsServerEventType } from "./wire.js";

export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/** A chat as `ctx.chats.list` / `find` report it. */
export interface PluginChatSummary {
  id: string;
  title: string;
  projectId: string;
  projectName?: string;
  status?: string;
  archived?: boolean;
  harness?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  /** Worktrees the chat holds, when any. */
  worktrees?: string[];
  /** PR numbers the chat owns, when any. */
  prs?: number[];
  /** `find` only: the transcript rows that matched, with snippets. */
  hits?: Array<{ id?: string; ts?: number; kind: string; label?: string; snippet: string }>;
}

export interface PluginChatListQuery {
  projectId?: string;
  status?: ChatStatus;
  /** Only chats active at/after this time (epoch ms). */
  since?: number;
  /** Include archived chats (default false). */
  archived?: boolean;
  limit?: number;
}

export interface PluginChatFindQuery {
  /** Free text matched against transcript content (and always titles). */
  query?: string;
  /** Project id, or a case-insensitive substring of a project name. */
  project?: string;
  status?: string;
  archived?: boolean;
  since?: number;
  before?: number;
  /** Restrict content matching to these row kinds. Default: user + assistant. */
  kinds?: string[];
  limit?: number;
  hitsPerChat?: number;
}

export type PluginChatView = "digest" | "messages" | "grep";

export interface PluginChatReadOptions {
  /** Required for `grep`. */
  query?: string;
  kinds?: string[];
  limit?: number;
  /** Page backwards from this row id (exclusive). */
  beforeId?: string;
  /** Page forwards from this row id (exclusive). */
  afterId?: string;
  /** Keep verbatim payloads instead of clipping them. */
  full?: boolean;
}

/** The live state of a chat — what `chat_state` reports to an agent. */
export interface PluginChatState {
  chatId: string;
  title?: string;
  projectId: string;
  status: ChatStatus;
  /** No subprocess is up; a send will wake it. */
  dormant: boolean;
  /** A permission card or question is open in front of the human. */
  blockedOnHuman: boolean;
  lastUserMessageAt?: number;
  updatedAt: number;
  prs: number[];
  contextPercent?: number;
  /** Messages parked until the chat's current turn ends. */
  heldMessages: number;
}

export interface PluginSendOptions {
  /**
   * `queue` (default) waits for the chat's current turn to end; `interrupt`
   * injects into the live turn. Neither dismisses a question card the human
   * has open — that hold is unconditional.
   */
  delivery?: "queue" | "interrupt";
  /** Who the row says it came from. Defaults to the plugin id. */
  sender?: string;
}

export interface PluginSendResult {
  ok: boolean;
  /** Why a send was refused, when `ok` is false. */
  refusal?: string;
  message?: string;
  /** Parked behind a turn in flight (or an open card) rather than delivered now. */
  held?: boolean;
  /** The target had no subprocess and one was started for this message. */
  woke?: boolean;
}

export interface PluginAskResult extends PluginSendResult {
  askId?: string;
  answered: boolean;
  answer?: string;
  /** `timeout` or `cancelled`, when `answered` is false. */
  reason?: string;
}

export interface PluginProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  worktreeRoot?: string;
  defaultBranch?: string;
}

export interface PluginMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * A handler in a plugin's route table. `Req` / `Reply` are Fastify's request
 * and reply at runtime; they are parameters here because this file cannot
 * import Fastify. The server narrows them, and the SDK re-exports the
 * narrowed alias so plugin authors see the real types.
 */
export type PluginRouteHandler<Req = unknown, Reply = unknown> = (req: Req, reply: Reply) => unknown;

/**
 * What `ctx.routes` hands out. Paths are relative to `/api/plugins/<id>/` and
 * take `:param` segments (find-my-way syntax — it IS Fastify's router).
 *
 * A TABLE, not Fastify registrations: Fastify can neither add nor remove a
 * route on a listening instance, and plugins activate after listen and
 * deactivate on a toggle. The host registers one wildcard per prefix at build
 * time and consults this table per request.
 */
export interface PluginRouter<Req = unknown, Reply = unknown> {
  get(path: string, handler: PluginRouteHandler<Req, Reply>): void;
  post(path: string, handler: PluginRouteHandler<Req, Reply>): void;
  put(path: string, handler: PluginRouteHandler<Req, Reply>): void;
  delete(path: string, handler: PluginRouteHandler<Req, Reply>): void;
}

/**
 * The context. Members gated by a capability (see docs/plugins.md →
 * "Capabilities") are OPTIONAL here because they are genuinely absent from the
 * object a plugin receives when its manifest does not declare the capability.
 * A plugin that declared it can assert the member is present.
 */
export interface PluginContext<Req = unknown, Reply = unknown> {
  readonly id: string;
  /** Absolute path of the plugin directory. */
  readonly dir: string;
  /** The plugin's own version, from its manifest. */
  readonly version: string;
  readonly log: PluginLog;

  /** `events` */
  bus?: {
    on<T extends WsServerEventType>(
      type: T,
      fn: (evt: Extract<WsServerEvent, { type: T }>) => void,
    ): () => void;
    subscribe(fn: (evt: WsServerEvent) => void): () => void;
  };

  /**
   * `routes` — add handlers under `/api/plugins/<id>/`. Call during `activate`.
   * Gated by the global auth hook like everything under `/api/`; the prefix
   * answers 503 until activation finishes and 404 once the plugin is off.
   */
  routes?(define: (r: PluginRouter<Req, Reply>) => void): void;

  settings: {
    /** `AppSettings.plugins[id].settings`, or `{}`. Synchronous: it is cached. */
    get<T = Record<string, unknown>>(): T;
    onChange(fn: (next: unknown) => void): () => void;
  };

  /** `secrets` — only the names the manifest lists under `secrets:`. */
  secrets?: {
    get(name: string): Promise<string | undefined>;
    /** The listed names that currently have a value. */
    list(): Promise<string[]>;
  };

  /** `kv` — a per-plugin key/value table in the instance's state database. */
  kv?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };

  /** `chats:read` for list/find/read/state; `chats:write` for send/ask/reply. */
  chats?: {
    list?(q?: PluginChatListQuery): Promise<PluginChatSummary[]>;
    find?(q: PluginChatFindQuery): Promise<PluginChatSummary[]>;
    /** A rendered, agent-readable text of the chat — the same text `chat_read` returns. */
    read?(chatId: string, view?: PluginChatView, opts?: PluginChatReadOptions): Promise<string>;
    state?(chatId: string): Promise<PluginChatState | null>;
    send?(chatId: string, text: string, opts?: PluginSendOptions): Promise<PluginSendResult>;
    ask?(
      chatId: string,
      question: string,
      opts?: { timeoutSeconds?: number; sender?: string },
    ): Promise<PluginAskResult>;
    /** Answer an ask that is pending on a chat, on that chat's behalf. */
    reply?(askId: string, answer: string): Promise<{ ok: boolean; message?: string }>;
  };

  /** `chats:read` for list; `chats:write` for answer. */
  attention?: {
    list?(): Promise<AttentionItem[]>;
    /**
     * Answer a `question` item — the same path the app's answer button takes —
     * or decline it. Permission items are not answerable here: granting a tool
     * call is the human's decision, not an integration's.
     */
    answer?(
      itemId: string,
      answer: { optionId?: string; answer?: string; notes?: string; answers?: QuestionAnswer[] } | { decline: true },
    ): Promise<{ ok: boolean; message?: string }>;
  };

  /** `memory` */
  memory?: {
    /** The project's memory index, plus the best matches for `query` when given. */
    recall(projectId: string, query?: string): Promise<string>;
    remember(projectId: string, m: PluginMemoryInput): Promise<void>;
    forget(projectId: string, name: string): Promise<void>;
  };

  projects: {
    list(): Promise<PluginProjectSummary[]>;
    get(id: string): Promise<PluginProjectSummary | undefined>;
  };

  /**
   * Publish a `plugin-event` to every connected client. The plugin's client
   * half receives it through `host.events.onPlugin` (workstream E); what goes
   * in `payload` is the plugin's own contract with itself.
   */
  emit(payload: unknown, chatId?: string): void;

  /* Workstream D */
  processes?: {
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    list(): Promise<Array<{ id: string; status: string; ports?: number[]; url?: string }>>;
  };
  /**
   * `oauth` — the host-run client flow for the manifest's `oauth.clients`.
   * `connectUrl` mints a single-use state and returns the provider URL to send
   * the owner to; `token` returns a live access token, refreshing it first
   * when it is within a minute of expiry, or `undefined` when the owner has
   * not connected; `disconnect` forgets the stored tokens. The values are
   * never exposed to the SPA — only the plugin's server half sees them.
   */
  oauth?: {
    connectUrl(name: string): Promise<string>;
    token(name: string): Promise<string | undefined>;
    disconnect(name: string): Promise<void>;
  };
}
