/**
 * The server-side plugin API — what a plugin's `activate(ctx)` receives.
 *
 * Types, plus the lifecycle budgets as constants. This file is what
 * `@dispatch/plugin-sdk` re-exports to plugin authors, so it must stay free of
 * server imports: no Fastify, no Store, no services. Everything the context hands out is expressed in the shared
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
import type { Harness, HostAbortSignal } from "./harness.js";
import type { ProviderDescriptor } from "./providers.js";
import type { PluginApprovalDecision } from "./plugin-approval.js";
import type {
  TerminalBackend,
  TerminalBackendStatusInput,
  TerminalBackendUpdate,
  TerminalPortForward,
  TerminalPortForwardInput,
  TerminalRunEvent,
  TerminalRunFilter,
  TerminalRunInFlight,
} from "./terminal-backend.js";

export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  /**
   * Called after {@link onShutdown} (when the plugin has one), on every way a
   * running plugin goes down. Release in-process resources here; anything
   * that outlives the process belongs in `onShutdown` and `reconcile`.
   */
  deactivate?(): Promise<void> | void;
  /**
   * The plugin is about to go down, and why — the one chance to clean up
   * whatever it made OUTSIDE this process (containers, remote sessions,
   * tunnels). See docs/plugins.md → "Cleanup lifecycle".
   *
   * Every active plugin's hook runs IN PARALLEL on a shared budget of
   * {@link PLUGIN_SHUTDOWN_BUDGET_MS}; past it `signal` aborts, the host logs
   * the plugin as overrunning, and teardown carries on without it. A Restart
   * waits on this, so INITIATE slow remote work (send the stop, don't poll for
   * it) and return. Idempotent: it may be the second call for the same state.
   *
   * It NEVER runs on a crash, a hard kill or a power cut. Correctness must not
   * depend on it — {@link reconcile} is the guarantee; this is the courtesy.
   */
  onShutdown?(e: PluginShutdownEvent): Promise<void> | void;
  /**
   * Settle what the plugin made against what still exists. Called after every
   * successful `activate` — boot, and the first boot after a re-enable — and
   * NOT awaited by boot: it runs on its own budget of
   * {@link PLUGIN_RECONCILE_BUDGET_MS}, after which `signal` aborts.
   *
   * `chats` is every chat that exists in this instance (archived included).
   * Anything the plugin holds for a chat NOT in the list is an orphan from a
   * delete it never heard about (it was off, the process died, the hook
   * failed) and should go. Idempotent and bounded, like every hook here.
   */
  reconcile?(e: PluginReconcileEvent): Promise<void> | void;
}

/** Why a plugin is going down. */
export type PluginShutdownReason =
  /** Settings → System → Restart: this process exits and a new one starts in seconds. */
  | "restart"
  /** The server is stopping (Stop, Ctrl-C, the desktop shell closing) with no restart promised. */
  | "stop"
  /** The owner switched the plugin off. Keep what you made; it will be wanted again when it is switched back on. */
  | "disable"
  /** The plugin is being uninstalled. Destroy everything it made — nothing will ever reconcile it again. */
  | "uninstall";

export interface PluginShutdownEvent {
  reason: PluginShutdownReason;
  /** Epoch ms after which the host stops waiting. Same instant `signal` aborts. */
  deadline: number;
  /** Aborted at `deadline`. Pass it to `fetch` and friends so overrunning work stops instead of leaking. */
  signal: HostAbortSignal;
}

/** One chat that still exists, as {@link PluginReconcileEvent} lists it. */
export interface PluginLiveChat {
  id: string;
  projectId: string;
  archived?: boolean;
  /**
   * Where this chat's terminals go by default — its pin, else its project's
   * `defaults.terminalBackend` — when that is not `local`. Per-terminal picks
   * (`terminal({ location })`) are not persisted, so a backend that must know
   * every chat it served keeps its own record (`ctx.kv`).
   */
  terminalBackend?: string;
}

export interface PluginReconcileEvent {
  /** Every chat in this instance. A chat absent from here was deleted. */
  chats: PluginLiveChat[];
  /** Epoch ms after which the host stops waiting. */
  deadline: number;
  /** Aborted at `deadline`, and if the plugin goes down first. */
  signal: HostAbortSignal;
}

/**
 * Total budget for every plugin's {@link PluginModule.onShutdown}, run in
 * parallel. Short on purpose: Settings → System → Restart waits for it.
 */
export const PLUGIN_SHUTDOWN_BUDGET_MS = 5_000;
/** Budget for one {@link PluginModule.reconcile}. Nothing waits for it but the plugin itself. */
export const PLUGIN_RECONCILE_BUDGET_MS = 120_000;

/** `ctx.shared`'s database, in the CONFIG root (beside config.json and secrets.json). */
export const PLUGIN_SHARED_DB_FILENAME = "plugin-shared.db";
/** `ctx.shared` limits: a key, a lock name, a value's JSON, and a lease. */
export const PLUGIN_SHARED_LIMITS = {
  keyLength: 256,
  lockNameLength: 128,
  valueBytes: 1024 * 1024,
  minTtlMs: 1_000,
  defaultTtlMs: 30_000,
  maxTtlMs: 3_600_000,
  maxWaitMs: 600_000,
} as const;

/** One `ctx.shared` value with what a compare-and-set needs. */
export interface PluginSharedEntry<T = unknown> {
  value: T;
  /**
   * Changes on every write and is NEVER reused for this plugin — not even by a
   * key deleted and created again — so a `compareAndSet` against a version you
   * read can only pass if nobody wrote that key since. Increasing, but not by
   * 1 per key: other keys' writes advance it too. What `compareAndSet` compares.
   */
  version: number;
  /** Epoch ms of the last write. */
  updatedAt: number;
  /** `ctx.instance.id` of the instance that wrote it, when known. */
  updatedBy?: string;
}

export interface PluginSharedLockOptions {
  /** Lease length. Default 30 s, 1 s – 1 h. A lease not renewed in time is free for anyone. */
  ttlMs?: number;
  /** How long to keep trying while someone else holds it. Default 0: try once. At most 10 min. */
  waitMs?: number;
  /** Renew the lease every third of `ttlMs` until released. Default true. */
  autoRenew?: boolean;
  /** Called once if the lease is lost — a renewal found it expired or taken. */
  onLost?: () => void;
  /** Stop waiting. Does not release a lock already held. */
  signal?: HostAbortSignal;
}

/** A lease on a `ctx.shared` lock. */
export interface PluginSharedLock {
  readonly name: string;
  readonly acquiredAt: number;
  /** When the lease runs out unless renewed. Moves on each renewal. */
  readonly expiresAt: number;
  /** True once a renewal found the lease expired or taken: stop acting as the holder. */
  readonly lost: boolean;
  /** Extend the lease. False when it was already lost. */
  renew(ttlMs?: number): Promise<boolean>;
  /** Give it back. Safe to call twice. */
  release(): Promise<void>;
}

/** Who holds a `ctx.shared` lock. */
export interface PluginSharedLockHolder {
  /** `ctx.instance.id` of the holding instance, when known. */
  instanceId?: string;
  role?: PluginInstance["role"];
  /** The holder is this instance. (Possibly another `lock` call of this plugin's.) */
  mine: boolean;
  acquiredAt: number;
  expiresAt: number;
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
 * What `ctx.approvals.request` puts in front of the human. Everything here is
 * shown verbatim; nothing is shown that is not here. The card names the
 * plugin from its manifest, so `title` need not.
 */
export interface PluginApprovalRequest {
  /** One line: what is being approved. "Run a command as root". At most 200 chars. */
  title: string;
  /** Why, or what happens next. Plain text, at most 4000 chars. */
  detail?: string;
  /** The exact command, already shell-quoted. Shown in full; the human cannot edit it. At most 8000 chars. */
  command?: string;
  /** Where `command` runs. */
  cwd?: string;
  /** Which machine, as the plugin labels it ("CVX Mac"). */
  machine?: string;
  /**
   * Seconds to wait for an answer before resolving `timeout`. Default 300,
   * at most 3600. The clock does not pause while the app is closed.
   */
  timeoutSeconds?: number;
  /** Aborting withdraws the card and resolves `cancelled`. */
  signal?: HostAbortSignal;
}

/**
 * How an approval ended. Anything but `approved` is a no: `timeout` and
 * `cancelled` are a no that nobody said.
 */
export interface PluginApprovalResult {
  decision: PluginApprovalDecision;
  /**
   * Who answered, as their account names them, when a person did and the app
   * has sign-in on. Absent for `timeout`/`cancelled`, and for any answer on an
   * install without sign-in (whoever reaches it IS the owner).
   */
  by?: string;
  /** Epoch ms the decision was made. */
  at: number;
}

/** Why an instance's id was re-minted. See {@link PluginInstance.reminted}. */
export type PluginInstanceRemintReason = "copied" | "moved" | "hostname";

/**
 * Which Dispatch instance a plugin is running in: `ctx.instance` and
 * `host.instance`. Stable and dev run side by side on one machine and share
 * `config/`, so they share settings and secrets, but each has its own data
 * dir. A plugin that leaves work OUTSIDE Dispatch (sessions on a remote
 * machine, files in a shared directory) namespaces it by `id`. That way one
 * instance's cleanup never reaps the other's work.
 */
export interface PluginInstance {
  /**
   * Opaque. It stays the same for a data dir across restarts, and no two data
   * dirs share it. It is kept in `<dataDir>/instance.json` together with a
   * description of the directory it was minted for: the machine, the path and
   * the file id. Finding that file in a directory it doesn't describe means the
   * data dir was copied (dev seeded from stable), moved to another volume, or
   * carried to a machine with a different name. The host then mints a new id
   * and keeps the old one as {@link previousId}. So two live instances never
   * share an id, even when dev's data started as a copy of stable's.
   */
  readonly id: string;
  /**
   * `stable` is the installed deployment, serving its own data dir. `dev` is a
   * source checkout's `pnpm dev` server. `other` is anything else: a throwaway
   * instance, a test, or a payload launched against another root. Use it as a
   * label for display or policy, never as a namespace, because two `dev`
   * instances can run at once.
   */
  readonly role: "stable" | "dev" | "other";
  /**
   * A hash of the physical data dir: machine, path, volume and file id. Opaque,
   * so compare it only for equality. It changes whenever the directory is
   * copied, moved, restored or renamed, or the machine is renamed. `id` survives
   * some of those: a rename on the same volume, or a restore in place. Store it
   * beside work you leave elsewhere to tell "my id, in a different directory"
   * apart from "my id, where I left it".
   */
  readonly dataDirFingerprint: string;
  /**
   * The id this data dir carried before it was last re-minted. Work namespaced
   * under it may be abandoned (the data dir moved, or the machine was renamed),
   * or it may still be in use: when this data dir is a COPY, `previousId` is
   * the id of the original, which may still be running. Offer it to the owner
   * to adopt or clean up, after checking it is not live. Never adopt it
   * automatically.
   */
  readonly previousId?: string;
  /**
   * When and why the id was last re-minted (`at` is ISO 8601). Absent while the
   * data dir still carries the id it was first given. `copied`: the directory
   * the id was minted for still holds it. `moved`: that directory no longer
   * holds it. `hostname`: the record names another machine.
   */
  readonly reminted?: { readonly at: string; readonly reason: PluginInstanceRemintReason };
}

/* ------------------------------------------------------------ ctx.runner (E10/E26) */

/** Who a running process belongs to. */
export type PluginRunnerOwner =
  /** A project's sub-app (`run_subapp`, the Ports & processes panel). */
  | { kind: "sub-app"; projectId?: string; chatId?: string; subAppId: string; branch?: string }
  /** A plugin's managed process (`contributes.processes`). */
  | { kind: "plugin"; pluginId: string; processId: string };

/** One process Dispatch runs on this machine that holds local ports, as `ctx.runner.list()` reports it. */
export interface PluginRunnerProcess {
  id: string;
  owner: PluginRunnerOwner;
  status: "starting" | "running" | "stopping";
  /** The local ports it holds (allocated, so not necessarily the declared ones). */
  ports: number[];
  url?: string;
  /** A singleton the OTHER Dispatch instance spawned; this one only found it on its port. */
  adopted?: boolean;
}

/**
 * A local port a plugin must neither bind nor expose to another machine,
 * whether or not anything holds it right now. As `ctx.runner.reservedPorts()`
 * reports it.
 */
export interface PluginReservedPort {
  port: number;
  /** `dispatch` for Dispatch's own ports; `plugin:<id>` for a port a plugin declares or holds. */
  owner: string;
  /** One line for a log or a refusal: "the installed (stable) Dispatch instance". */
  reason: string;
}

/** `ctx.runner` (capability `runner`). */
export interface PluginRunnerView {
  /** Processes running now — sub-apps of every project, and every plugin's processes. Stopped ones are left out. */
  list(): Promise<PluginRunnerProcess[]>;
  /**
   * The deny-list, sorted by port, one entry per port:
   * - Dispatch's own: this instance's port, the installed instance's actual
   *   port, both instances' default ports (4318, 4319) and the dev server's
   *   live-reload socket. Reserved even while the instance is down: a forward
   *   parked on 4319 stops `pnpm dev` from starting — or, on Windows, lets it
   *   bind the same port and answer half the requests.
   * - Every installed plugin's declared process ports, and the ports its
   *   processes hold now.
   *
   * Never forward ONTO one of these, and never reverse-forward one to another
   * machine: a Dispatch port reachable from a remote shell is an API that
   * creates chats and runs commands here.
   */
  reservedPorts(): Promise<PluginReservedPort[]>;
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
  /**
   * Which instance this is. Namespace work left outside Dispatch by
   * `instance.id`. Needs no capability. Optional only because hosts before it
   * lack it; every current host has it.
   */
  readonly instance?: PluginInstance;

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
    /**
     * Fires whenever the stored settings change, whoever changed them: the
     * Settings pane, this plugin (`set` here or `host.settings.set` in its
     * browser half), or the OTHER instance, noticed on disk within a few
     * seconds. A listener that calls `set` must not do so unconditionally.
     */
    onChange(fn: (next: unknown) => void): () => void;
    /**
     * Write some keys: each key in `patch` replaces the stored value wholesale
     * (arrays and objects are not merged into); `null` or `undefined` removes
     * the key. The blob lives in `<configDir>/config.json`, so both instances
     * see it and a plugin update keeps it. Validated against the manifest's
     * `settings` schema: a key this write changes into something the schema
     * refuses throws, and nothing is stored. Resolves to the stored settings.
     * Optional only because hosts before it lack it; every current host has it.
     */
    set?(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  };

  /**
   * `secrets` — only the names the manifest lists under `secrets:`, where an
   * entry ending in `*` covers every name with that prefix. Values live in the
   * GLOBAL store (`<configDir>/secrets.json`, encrypted), so both instances on
   * the machine see them and a plugin update leaves them alone.
   */
  secrets?: {
    get(name: string): Promise<string | undefined>;
    /** The covered names that currently have a value, sorted. */
    list(): Promise<string[]>;
    /**
     * `secrets:write` — store `value` under `name`, replacing any value it had.
     * Throws when the manifest does not cover `name`, the name is not a valid
     * secret name, or `value` is empty or over 64 KiB. Resolves after every MCP
     * server and sub-app that references `${secret:name}` has been refreshed,
     * as a save from the Secrets pane does.
     */
    set?(name: string, value: string): Promise<void>;
    /** `secrets:write` — remove `name`. True when there was a value. Same refusals and refresh as `set`. */
    delete?(name: string): Promise<boolean>;
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

  /**
   * `approvals` — ask the human to approve ONE action, on the same card,
   * Attention Queue entry and push notification a tool-call permission gets,
   * labelled with this plugin's name. Resolves when they answer, after
   * `timeoutSeconds` (default 5 min) with `timeout`, or with `cancelled` when
   * `signal` aborts, the chat's session ends, or this plugin goes down.
   *
   * Only the owner, signed in to the app, can answer it — not
   * `ctx.attention.answer`, not an integration or OAuth token, not another
   * plugin. Approve-once or deny: there is no "always allow". Every outcome
   * writes a notice into the chat's transcript and a row to the instance's
   * approval audit table.
   *
   * REJECTS (rather than resolving a decision) when no card could be shown:
   * an unknown chat, a chat with no live session to ask through, or a request
   * with no title or an over-long field. Treat a rejection as a no.
   */
  approvals?: {
    request(chatId: string, req: PluginApprovalRequest): Promise<PluginApprovalResult>;
  };

  /**
   * `shared` — data and locks in the CONFIG root, so every Dispatch instance
   * on the machine (stable and dev) sees the same ones and a plugin update
   * keeps them. Per plugin: a plugin cannot reach another's keys or locks.
   * Use it to coordinate work outside Dispatch that both instances could do —
   * one agent per remote machine, one upgrade at a time. `ctx.kv` is the
   * per-instance store; use that for anything else.
   *
   * A lock is a LEASE (default 30 s, auto-renewed while held), recorded with
   * the holder's `instance.id`, so an instance that dies without releasing
   * frees it when the lease runs out. Release what you take; deactivation
   * releases whatever is still held.
   */
  shared?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    /** The value with its version, for a `compareAndSet`. */
    entry<T = unknown>(key: string): Promise<PluginSharedEntry<T> | undefined>;
    /** Write unconditionally (`undefined` deletes). Resolves to the new version (0 for a delete). */
    set(key: string, value: unknown): Promise<number>;
    /**
     * Write only if the entry is still at `expectedVersion` — `null` for "only
     * if it does not exist". `value` undefined deletes. Atomic across both
     * instances. On a lost race resolves `{ ok: false, current }`.
     */
    compareAndSet(
      key: string,
      expectedVersion: number | null,
      value: unknown,
    ): Promise<{ ok: true; version: number } | { ok: false; current?: PluginSharedEntry }>;
    /** True when there was a value. */
    delete(key: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
    /**
     * Take the lock `name`, waiting up to `waitMs` while another holder has it.
     * Resolves the lease, or `undefined` when it could not be had in time.
     * Not re-entrant: a second `lock` of a name this plugin already holds
     * waits like anyone else's.
     */
    lock(name: string, opts?: PluginSharedLockOptions): Promise<PluginSharedLock | undefined>;
    /** Who holds `name` now, if anyone. */
    holder(name: string): Promise<PluginSharedLockHolder | undefined>;
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
   * `runner` — read-only: which LOCAL ports the processes Dispatch runs hold,
   * and which ports are not a plugin's to take (docs/plugins.md → "Local
   * ports"). For a plugin that binds or exposes ports on this machine: a
   * terminal backend choosing where to forward a remote listener, or deciding
   * whether a reverse forward would hand another machine a Dispatch port.
   */
  runner?: PluginRunnerView;
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
  /**
   * `providers` — register an agent runtime chats can run on. `descriptor` is
   * what every surface labels, picks and accounts it by, and its `id` must
   * equal `harness.kind`. Throws when the id is already taken, so a plugin
   * cannot shadow `claude` (the fallback) or another plugin's provider.
   * Deactivation unregisters it and calls `harness.dispose()` — which may end
   * sessions in flight — and a chat pinned to it then falls back to Claude.
   */
  providers?: {
    register(harness: Harness, descriptor: ProviderDescriptor): void;
  };
  /**
   * `terminals` — supply somewhere else for a chat's managed shells to run
   * (docs/plugins.md → "Terminal backends"). `registerBackend` throws when the
   * id is `local` or already taken. Deactivation unregisters every backend
   * the plugin registered, ends the shells still running on them (each says
   * so in its transcript; the next command comes up on whatever the chat now
   * resolves to), withdraws its published ports, and calls `dispose()`.
   */
  terminals?: {
    registerBackend(backend: TerminalBackend): void;
    /**
     * Announce a remote listener the backend has made reachable locally, so
     * the agent's terminal results, the Terminals panel and anything driving a
     * browser can find it. Returns the withdraw function; publishing the same
     * chat + remote port again replaces the earlier entry.
     */
    publishPort(backendId: string, port: TerminalPortForwardInput): () => void;
    /** Ports currently published for a chat, by any backend. */
    ports(chatId: string): TerminalPortForward[];
    /**
     * Report whether one of this plugin's backends can take a shell. `offline`
     * takes it out of every picker and the agent's choices, makes a shell asked
     * of it fail AT ONCE under its `fallback` policy, and cuts short a spawn
     * already waiting on it. Shells already running on it are NOT touched —
     * their transport reports its own trouble (`stalled`, `exit`). Throws for a
     * backend this plugin did not register.
     */
    setStatus(backendId: string, status: TerminalBackendStatusInput): void;
    /**
     * Change a backend's label or agent note in place. Unlike unregistering and
     * registering again, the shells running on it are left alone; their panel
     * rows take the new label. Throws for a backend this plugin did not register.
     */
    updateBackend(backendId: string, update: TerminalBackendUpdate): void;
    /**
     * Remove ONE backend, as deactivation does for all of them: its shells end
     * (each says why), its ports are withdrawn and its `dispose()` is called.
     * Chats pinned to it then fall back or are refused, per its `fallback`.
     * The id may be registered again afterwards. Throws for a backend this
     * plugin did not register.
     */
    unregisterBackend(backendId: string): Promise<void>;
    /**
     * Every command a chat's managed shell is running right now, on ANY
     * location — this plugin's backends, other plugins', and `local` — oldest
     * first. For a lock that must span shells the backend does not serve: a
     * checkout's foreground lock, say, which a local `pnpm install` in the same
     * worktree has to respect too. `command` is filled in only for runs on this
     * plugin's own backends. Synchronous: it reads core's live state.
     * Optional only because hosts before it lack it.
     */
    runs?(filter?: TerminalRunFilter): TerminalRunInFlight[];
    /**
     * Hear each run start and end, anywhere — `ended` the moment the shell is
     * free again (after `afterRun`, after a backgrounded command really exits,
     * or when the shell dies or is closed). Same visibility rule as `runs`.
     * Returns the unsubscribe; deactivation unsubscribes for you. A listener
     * that throws is ignored. Optional only because hosts before it lack it.
     */
    onRun?(fn: (event: TerminalRunEvent) => void): () => void;
  };
}
