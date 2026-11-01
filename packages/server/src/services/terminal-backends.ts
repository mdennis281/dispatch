/**
 * TerminalBackendRegistry — the plugin-supplied places a chat's managed shells
 * can run, which one a chat uses, and the ports they forward back (#414).
 *
 * Core knows nothing about containers. A backend is registered by a plugin
 * declaring the `terminals` capability (`ctx.terminals.registerBackend`), and
 * TerminalService asks this registry, per shell it opens, where that shell
 * belongs. Everything a backend owns beyond "give me a shell" — provisioning,
 * syncing code, stopping on idle — is the plugin's.
 *
 * Selection is `resolveTerminalBackend` (shared): the chat's pin, else the
 * project's `defaults.terminalBackend`, else local. A pin to a backend that is
 * not registered is still the chat's choice, so it comes back `missing` and
 * TerminalService falls back to local AND SAYS SO; quietly reading it as local
 * would let an agent believe its tests ran somewhere they did not.
 *
 * The AGENT can also choose, per terminal (`terminal({ location })`), among
 * the locations `resolveTerminalLocations` allows — app `terminalLocations`,
 * overridden by project.yaml `defaults.terminalLocations`. The rule above is
 * then only the DEFAULT: the location a terminal gets when the agent names
 * none. A named one is fixed for that shell's life (TerminalService refuses a
 * different one), so one chat can hold a build on a container next to a quick
 * local shell. With the list unset — the default — there is no choice at all.
 *
 * With nothing registered, `size` is 0, TerminalService never asks, no event
 * is published and no prompt section is written: the install behaves exactly
 * as it did before this file existed.
 *
 * A backend's `fallback` policy is REMEMBERED per id ({@link TerminalBackendMemory},
 * the `terminal_backend` table), because the case it matters most for is the
 * one with nothing registered to ask: a chat pinned to a Mac whose plugin was
 * just switched off must not get a PowerShell on this host. An id this
 * instance has never seen registered has no policy to remember and reads as
 * the default, `local`.
 *
 * A registered backend also carries a STATUS its plugin reports
 * (`ctx.terminals.setStatus`): an `offline` one is not offered anywhere, and a
 * shell asked of it fails at once under its policy rather than after a two-
 * minute spawn timeout. Label and agent note can change in place
 * (`updateBackend`) — re-registering to rename a machine would have ended
 * every shell running on it.
 */
import {
  LOCAL_TERMINAL_BACKEND,
  TERMINAL_BACKEND_FALLBACKS,
  TERMINAL_BACKEND_ID_PATTERN,
  TERMINAL_BACKEND_STATES,
  TERMINAL_CHAT_HOOK_TIMEOUT_MS,
  resolveTerminalBackend,
  resolveTerminalLocations,
  type TerminalBackend,
  type TerminalBackendFallback,
  type TerminalBackendInfo,
  type TerminalBackendStatus,
  type TerminalBackendStatusInput,
  type TerminalBackendUpdate,
  type TerminalChatEvent,
  type TerminalLocationChoices,
  type TerminalLocationOption,
  type TerminalPortForward,
  type TerminalPortForwardInput,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { CleanupKey, CleanupOutcome } from "../plugins/cleanup.js";
import type { StateDb } from "../store/db.js";
import type { TerminalBackendResolution, TerminalBackendSource } from "./terminal.js";

export interface TerminalBackendRegistryOptions {
  bus: EventBus;
  /**
   * The chat's own pin and project, or null when there is no such chat.
   * `worktreePath` is the worktree it works in, when it has one.
   */
  chat: (
    chatId: string,
  ) => Promise<{ terminalBackend?: string; projectId?: string; worktreePath?: string } | null>;
  /** The project's `defaults.terminalBackend` (from the loaded config, never the row). */
  projectDefault: (projectId: string) => string | undefined;
  /**
   * The allowed per-terminal locations, both layers: app `terminalLocations`
   * and the project's `defaults.terminalLocations`. Absent ⇒ no choice anywhere.
   */
  allowedLocations?: (
    projectId: string | undefined,
  ) => Promise<{ project?: string[]; app?: string[] }> | { project?: string[]; app?: string[] };
  /** The project's primary checkout. */
  repoPath?: (projectId: string) => Promise<string | undefined>;
  /** The branch checked out in a directory, for a backend's spawn info. */
  branchOf?: (dir: string) => Promise<string | undefined>;
  /**
   * Resolves once installed plugins have finished activating. A chat pinned to
   * a backend whose plugin simply has not activated YET (boot runs plugin
   * activation after the port opens) must wait for it rather than be told the
   * backend is not installed and handed a local shell.
   */
  settled?: () => Promise<void>;
  /**
   * Where a failed `onChatDeleted` is recorded for retry (the plugin cleanup
   * queue). Absent = failures are only logged, as before.
   */
  cleanups?: {
    failed(key: CleanupKey, error: string, projectId?: string): void;
    succeeded(key: CleanupKey): void;
  };
  /**
   * Where what each registered backend declared is kept once its plugin is
   * gone. Absent = this registry's lifetime only (tests).
   */
  memory?: TerminalBackendMemory;
  /** Override of {@link TERMINAL_CHAT_HOOK_TIMEOUT_MS}, for tests. */
  hookTimeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
  now?: () => number;
}

/** What the registry knows about a backend it has seen registered — kept after the plugin goes. */
export interface KnownTerminalBackend {
  id: string;
  label: string;
  pluginId?: string;
  fallback: TerminalBackendFallback;
  /** When it was last registered. */
  seenAt: number;
}

/** Durable {@link KnownTerminalBackend}s. Synchronous, because the state database is. */
export interface TerminalBackendMemory {
  remember(b: KnownTerminalBackend): void;
  recall(id: string): KnownTerminalBackend | undefined;
}

/** {@link TerminalBackendMemory} over the instance's `terminal_backend` table. */
export function stateDbBackendMemory(db: StateDb): TerminalBackendMemory {
  return {
    remember: (b) => {
      db.prepare(
        "INSERT INTO terminal_backend (id, label, plugin, fallback, seen_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET label = excluded.label, plugin = excluded.plugin, " +
          "fallback = excluded.fallback, seen_at = excluded.seen_at",
      ).run(b.id, b.label, b.pluginId ?? null, b.fallback, b.seenAt);
    },
    recall: (id) => {
      const r = db.prepare("SELECT * FROM terminal_backend WHERE id = ?").get(id) as
        | { id: string; label: string; plugin: string | null; fallback: string; seen_at: number }
        | undefined;
      if (!r) return undefined;
      return {
        id: r.id,
        label: r.label,
        ...(r.plugin ? { pluginId: r.plugin } : {}),
        // A value this build does not know is read as the safer one.
        fallback: r.fallback === "local" ? "local" : "refuse",
        seenAt: r.seen_at,
      };
    },
  };
}

interface Entry {
  backend: TerminalBackend;
  /** The plugin that registered it. */
  owner?: string;
  /** The label in force: the registration's, until `update` changes it. */
  label: string;
  /**
   * Set once `update` replaced the agent note (`fn` undefined = removed). The
   * plugin's own object is never written to: a class-based backend's methods
   * live on its prototype, and a copy or a write would lose or shadow them.
   */
  agentNote?: { fn: TerminalBackend["agentNote"] };
  /** Absent until its plugin reports one — read as online. */
  status?: TerminalBackendStatus;
}

/** Called with a backend id as it is unregistered — TerminalService ends its shells. */
type DetachListener = (backendId: string) => void;

/** Called when a registered backend's label or status changes — TerminalService relabels and cuts. */
type ChangeListener = (backendId: string, change: { label: string; status?: TerminalBackendStatus }) => void;

/** How long a status detail may be: it is one line in a picker and a refusal. */
const STATUS_DETAIL_MAX = 200;

/** "4m", "2h", "3d" — how long ago, for a refusal naming when a host was last seen. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** What the agent note and refusals call the built-in location. */
const LOCAL_LABEL = "this machine (the Dispatch host)";

/** The agent-note line for a backend that never falls back to a local shell. */
const refuseNote = (label: string) =>
  `When ${label} cannot start a shell, the command FAILS — it is never run on the Dispatch host ` +
  `instead. Retry it, or tell the user ${label} is unavailable; do not re-run it through Bash.`;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TerminalBackendRegistry implements TerminalBackendSource {
  private readonly entries = new Map<string, Entry>();
  /**
   * Chats pinned to a NON-local backend, kept synchronously so TerminalService
   * can decide without a disk read whether a shell needs resolving at all.
   *
   * With zero backends registered — exactly the state of a chat pinned to the
   * one backend plugin there is, while that plugin is off, uninstalled or not
   * yet activated — `size` alone said "nothing to resolve" and the pinned chat
   * got a plain local shell with no warning (review on #415). Seeded from the
   * store at boot, kept current from `chat-update` / `chat-deleted`.
   */
  private readonly pins = new Map<string, string>();
  /**
   * `${chatId}\u0000${backend}\u0000${remotePort}` → forward. The backend is in
   * the key because a chat can now hold shells on TWO backends, and each may
   * forward its own :3000 — keyed by chat + port alone, the second publish
   * silently replaced the first.
   */
  private readonly forwards = new Map<string, TerminalPortForward>();
  private readonly detachListeners = new Set<DetachListener>();
  private readonly changeListeners = new Set<ChangeListener>();
  /** Read-through cache of {@link TerminalBackendMemory} — and the whole memory when none is given. */
  private readonly known = new Map<string, KnownTerminalBackend | null>();

  constructor(private readonly opts: TerminalBackendRegistryOptions) {
    opts.bus.on("chat-update", (e) => this.notePin(e.chat.id, e.chat.terminalBackend));
    opts.bus.on("chat-deleted", (e) => this.pins.delete(e.chatId));
  }

  /** Record (or clear) one chat's pin. */
  notePin(chatId: string, pin: string | undefined): void {
    if (pin && pin !== LOCAL_TERMINAL_BACKEND) this.pins.set(chatId, pin);
    else this.pins.delete(chatId);
  }

  /** Load every chat's pin — once, at boot, before any shell can open. */
  seed(chats: Iterable<{ id: string; terminalBackend?: string }>): void {
    for (const c of chats) this.notePin(c.id, c.terminalBackend);
  }

  /**
   * Whether a shell for this chat must go through {@link resolve}: some backend
   * is registered, or the chat or its project names one that is not. False only
   * when the answer is certainly a plain local shell — every shell on an install
   * where no backend plugin was ever used.
   */
  wantsResolve(ident: { chatId: string; projectId?: string }): boolean {
    if (this.entries.size > 0 || this.pins.has(ident.chatId)) return true;
    if (!ident.projectId) return false;
    const project = this.opts.projectDefault(ident.projectId);
    return Boolean(project && project !== LOCAL_TERMINAL_BACKEND);
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): TerminalBackendInfo[] {
    return [...this.entries.values()].map(({ backend, owner, label, status }) => ({
      id: backend.id,
      label,
      shell: backend.shell,
      ...(owner ? { pluginId: owner } : {}),
      fallback: backend.fallback ?? "local",
      ...(status ? { status } : {}),
    }));
  }

  /** Subscribe to unregistrations. Returns the unsubscribe. */
  onDetach(fn: DetachListener): () => void {
    this.detachListeners.add(fn);
    return () => this.detachListeners.delete(fn);
  }

  /** Subscribe to label and status changes of registered backends. Returns the unsubscribe. */
  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private changed(entry: Entry): void {
    for (const fn of this.changeListeners) {
      try {
        fn(entry.backend.id, { label: entry.label, ...(entry.status ? { status: entry.status } : {}) });
      } catch (err) {
        this.opts.log?.(`terminal backend "${entry.backend.id}": change listener failed`, err);
      }
    }
    this.broadcast();
  }

  /**
   * Record whether a backend can take a shell. `since` moves only when the
   * STATE changes, so "offline since 14:02" survives a plugin that re-reports
   * the same state with a fresher detail. A report that changes nothing
   * broadcasts nothing — a heartbeat that only advances `lastSeenAt` is kept
   * (and served by `list()`) without waking every client.
   */
  setStatus(id: string, input: TerminalBackendStatusInput): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`terminal backend "${id}" is not registered`);
    if (!input || typeof input !== "object" || !TERMINAL_BACKEND_STATES.includes(input.state)) {
      throw new Error(
        `terminal backend "${id}": status.state must be ${TERMINAL_BACKEND_STATES.map((st) => `"${st}"`).join(", ")}`,
      );
    }
    if (input.detail !== undefined && typeof input.detail !== "string") {
      throw new Error(`terminal backend "${id}": status.detail must be a string`);
    }
    if (input.lastSeenAt !== undefined && !Number.isFinite(input.lastSeenAt)) {
      throw new Error(`terminal backend "${id}": status.lastSeenAt must be epoch milliseconds`);
    }
    const prev = entry.status;
    const detail = input.detail?.replace(/\s+/g, " ").trim().slice(0, STATUS_DETAIL_MAX) || undefined;
    const next: TerminalBackendStatus = {
      state: input.state,
      ...(detail ? { detail } : {}),
      ...(input.lastSeenAt !== undefined ? { lastSeenAt: Math.round(input.lastSeenAt) } : {}),
      since: prev && prev.state === input.state ? prev.since : (this.opts.now ?? Date.now)(),
    };
    entry.status = next;
    if (prev && prev.state === next.state && prev.detail === next.detail) return;
    this.changed(entry);
  }

  /**
   * Change a registered backend's label or agent note in place. Its shells are
   * left alone — TerminalService only relabels their rows — and the new label
   * is remembered for when the plugin is gone.
   */
  update(id: string, patch: TerminalBackendUpdate): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`terminal backend "${id}" is not registered`);
    if (!patch || typeof patch !== "object") throw new Error(`updateBackend("${id}") needs an object`);
    const has = (k: keyof TerminalBackendUpdate) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has("label") && (typeof patch.label !== "string" || !patch.label.trim())) {
      throw new Error(`terminal backend "${id}": label must be a non-empty string`);
    }
    if (has("agentNote") && patch.agentNote !== undefined && typeof patch.agentNote !== "function") {
      throw new Error(`terminal backend "${id}": agentNote must be a function`);
    }
    if (has("agentNote")) entry.agentNote = { fn: patch.agentNote };
    if (has("label") && patch.label !== entry.label) {
      entry.label = patch.label!;
      this.rememberBackend(entry);
      this.changed(entry);
    }
  }

  /**
   * Add a backend. Throws on an invalid shape, on `local`, and on an id that is
   * already taken — the second plugin to claim an id must not silently capture
   * the chats pinned to the first.
   */
  register(backend: TerminalBackend, owner?: string): void {
    if (!backend || typeof backend !== "object") throw new Error("registerBackend needs a backend object");
    const { id } = backend;
    if (typeof id !== "string" || !TERMINAL_BACKEND_ID_PATTERN.test(id)) {
      throw new Error(`terminal backend id "${String(id)}" must match ${TERMINAL_BACKEND_ID_PATTERN}`);
    }
    if (id === LOCAL_TERMINAL_BACKEND) throw new Error(`"${LOCAL_TERMINAL_BACKEND}" is reserved for the built-in local shell`);
    if (this.entries.has(id)) {
      const by = this.entries.get(id)?.owner;
      throw new Error(`terminal backend "${id}" is already registered${by ? ` by plugin "${by}"` : ""}`);
    }
    if (backend.shell !== "bash" && backend.shell !== "powershell") {
      throw new Error(`terminal backend "${id}": shell must be "bash" or "powershell"`);
    }
    if (typeof backend.spawn !== "function") throw new Error(`terminal backend "${id}": spawn must be a function`);
    if (typeof backend.label !== "string" || !backend.label.trim()) {
      throw new Error(`terminal backend "${id}": label is required`);
    }
    if (backend.fallback !== undefined && !TERMINAL_BACKEND_FALLBACKS.includes(backend.fallback)) {
      throw new Error(
        `terminal backend "${id}": fallback must be ${TERMINAL_BACKEND_FALLBACKS.map((f) => `"${f}"`).join(" or ")}`,
      );
    }
    const entry: Entry = { backend, owner, label: backend.label };
    this.entries.set(id, entry);
    this.rememberBackend(entry);
    this.broadcast();
  }

  /**
   * Record what this backend declared, for when it is no longer registered.
   * Never throws: a state database that cannot be written must not stop a
   * plugin from activating — the cache still holds it for this process.
   */
  private rememberBackend({ backend, owner, label }: Entry): void {
    const known: KnownTerminalBackend = {
      id: backend.id,
      label,
      ...(owner ? { pluginId: owner } : {}),
      fallback: backend.fallback ?? "local",
      seenAt: (this.opts.now ?? Date.now)(),
    };
    this.known.set(backend.id, known);
    try {
      this.opts.memory?.remember(known);
    } catch (err) {
      this.opts.log?.(`terminal backend "${backend.id}": could not remember its fallback policy`, err);
    }
  }

  /** What this instance last knew about a backend id, registered now or not. */
  recall(id: string): KnownTerminalBackend | undefined {
    if (!this.known.has(id)) {
      let hit: KnownTerminalBackend | undefined;
      try {
        hit = this.opts.memory?.recall(id);
      } catch (err) {
        this.opts.log?.(`terminal backend "${id}": could not read what was remembered about it`, err);
        // Not cached: the next shell asks again rather than settling on a guess.
        return undefined;
      }
      this.known.set(id, hit ?? null);
    }
    return this.known.get(id) ?? undefined;
  }

  /**
   * The policy for an id: the registered backend's own, else what it declared
   * when it was last registered here, else the default.
   */
  fallbackOf(id: string): TerminalBackendFallback {
    const entry = this.entries.get(id);
    if (entry) return entry.backend.fallback ?? "local";
    return this.recall(id)?.fallback ?? "local";
  }

  /**
   * Remove a backend: end its shells, withdraw its ports, dispose it. Safe to
   * call for an id that is not registered. Never rejects — it runs on the
   * plugin teardown path, where a throw would strand the rest of the cleanup.
   */
  async unregister(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const fn of this.detachListeners) {
      try {
        fn(id);
      } catch (err) {
        this.opts.log?.(`terminal backend "${id}": detach listener failed`, err);
      }
    }
    for (const [key, f] of this.forwards) if (f.backend === id) this.forwards.delete(key);
    this.broadcast();
    try {
      await entry.backend.dispose?.();
    } catch (err) {
      this.opts.log?.(`terminal backend "${id}" failed to dispose`, err);
    }
  }

  /**
   * The selection for one shell, plus everything TerminalService hands the
   * backend. `location` is the agent's per-terminal pick — already checked
   * against the allowed list by the caller ({@link checkLocation}); it beats the
   * chat pin, and without it the chat → project → local rule decides.
   */
  async resolve(
    ident: { chatId: string; projectId?: string },
    location?: string,
  ): Promise<TerminalBackendResolution> {
    const chat = await this.opts.chat(ident.chatId);
    const projectId = ident.projectId ?? chat?.projectId;
    const choice = resolveTerminalBackend({
      terminal: location,
      chat: chat?.terminalBackend,
      project: projectId ? this.opts.projectDefault(projectId) : undefined,
    });
    if (choice.id === LOCAL_TERMINAL_BACKEND) return { requested: choice.id };
    if (!this.entries.has(choice.id)) await this.opts.settled?.().catch(() => {});
    const entry = this.entries.get(choice.id);
    if (!entry) {
      const known = this.recall(choice.id);
      return {
        requested: choice.id,
        missing: true,
        fallback: this.fallbackOf(choice.id),
        ...(known ? { label: known.label } : {}),
      };
    }
    // Offline: fail now, under the backend's policy, instead of calling a
    // spawn that can only hang until `spawnTimeoutMs` — two minutes by default.
    const offline = this.offlineReason(entry);
    if (offline) {
      return { requested: choice.id, offline, fallback: this.fallbackOf(choice.id), label: entry.label };
    }
    const repoPath = projectId ? await this.opts.repoPath?.(projectId).catch(() => undefined) : undefined;
    // Read only for a shell actually headed to a backend: a local shell has no
    // use for either, and the branch costs a git spawn.
    const worktreePath = chat?.worktreePath || undefined;
    const root = worktreePath ?? repoPath;
    const branch = root ? await this.opts.branchOf?.(root).catch(() => undefined) : undefined;
    return {
      requested: choice.id,
      backend: entry.backend,
      fallback: this.fallbackOf(choice.id),
      label: entry.label,
      ...(repoPath ? { repoPath } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(branch ? { branch } : {}),
      note: this.noteFor(entry, { chatId: ident.chatId, projectId }),
    };
  }

  /** Why a registered backend cannot take a shell now, or undefined when it can. */
  private offlineReason(entry: Entry): string | undefined {
    const st = entry.status;
    if (st?.state !== "offline") return undefined;
    const seen = st.lastSeenAt ? `, last seen ${ago((this.opts.now ?? Date.now)() - st.lastSeenAt)} ago` : "";
    return `${entry.label} is offline${st.detail ? ` (${st.detail})` : ""}${seen}`;
  }

  /**
   * Where this chat's agent may send a NEW terminal: its default (the chat →
   * project → local rule) plus every allowed id that can run right now. An
   * allowed id whose plugin is off is listed under `unavailable` rather than
   * offered — picking it could only fall back. Choice is `enabled` only with
   * two or more real options, so an unset list (the default) offers nothing.
   */
  async locations(ident: { chatId: string; projectId?: string }): Promise<TerminalLocationChoices> {
    const chat = await this.opts.chat(ident.chatId).catch(() => null);
    const projectId = ident.projectId ?? chat?.projectId;
    const def = resolveTerminalBackend({
      chat: chat?.terminalBackend,
      project: projectId ? this.opts.projectDefault(projectId) : undefined,
    });
    let layers: { project?: string[]; app?: string[] } = {};
    try {
      layers = (await this.opts.allowedLocations?.(projectId)) ?? {};
    } catch (err) {
      this.opts.log?.("could not read the allowed terminal locations", err);
    }
    const allowed = resolveTerminalLocations(layers).effective;
    // Only wait on plugin activation when the list names a backend that is not
    // here yet — a chat with no choice must not stall its prompt on a slow plugin.
    if (allowed.some((id) => id !== LOCAL_TERMINAL_BACKEND && !this.entries.has(id))) {
      await this.opts.settled?.().catch(() => {});
    }
    const options: TerminalLocationOption[] = [];
    const unavailable: string[] = [];
    const reasons: Record<string, string> = {};
    for (const id of new Set([def.id, ...allowed])) {
      const label = this.labelOf(id);
      if (label === undefined) {
        if (id !== def.id) {
          unavailable.push(id);
          reasons[id] = "its plugin is switched off or not installed";
        }
        continue;
      }
      const entry = this.entries.get(id);
      // An offline DEFAULT is listed too: a terminal sent there would fail, and
      // the agent should hear that before it tries, not after.
      const offline = entry && this.offlineReason(entry);
      if (offline) {
        unavailable.push(id);
        reasons[id] = offline;
        continue;
      }
      const degraded = entry?.status?.state === "degraded" ? (entry.status.detail ?? "degraded") : undefined;
      options.push({ id, label, isDefault: id === def.id, ...(degraded ? { degraded } : {}) });
    }
    return {
      defaultId: def.id,
      options,
      unavailable,
      ...(unavailable.length ? { reasons } : {}),
      enabled: options.length > 1,
    };
  }

  /**
   * Validate an agent's `location`. Refuses an id that is not allowed, or that
   * is allowed but not registered, naming what IS allowed — the agent's next
   * move is picking one of those, not guessing.
   */
  async checkLocation(
    ident: { chatId: string; projectId?: string },
    location: string,
  ): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
    const choices = await this.locations(ident);
    const hit = choices.options.find((o) => o.id === location);
    if (hit) return { ok: true, label: hit.label };
    const list = choices.options.map((o) => `\`${o.id}\``).join(", ") || `\`${choices.defaultId}\``;
    const why = choices.unavailable.includes(location)
      ? `"${location}" is allowed but not available right now — ${
          choices.reasons?.[location] ?? "its plugin is switched off or not installed"
        }`
      : `"${location}" is not an allowed terminal location for this chat`;
    return {
      ok: false,
      error: `${why}. Allowed: ${list}. Omit \`location\` for the default (\`${choices.defaultId}\`).`,
    };
  }

  /** What a location is called — undefined for a backend that is not registered. */
  labelOf(id: string): string | undefined {
    if (id === LOCAL_TERMINAL_BACKEND) return LOCAL_LABEL;
    return this.entries.get(id)?.label;
  }

  /**
   * The agent-facing note: where this chat's terminals run, or — when it may
   * choose — every place it may choose and what each one means. Undefined for
   * a plain local chat with no choice (nothing to say) and for a missing
   * backend with no choice (the fallback notice covers that one). Used by the
   * session prompt.
   *
   * Before per-terminal choice this appeared only for a chat whose shells all
   * resolved to a backend; a chat that could put ONE terminal on a container
   * was never told the container existed.
   */
  async agentNote(chatId: string): Promise<string | undefined> {
    if (this.entries.size === 0) return undefined;
    try {
      const choices = await this.locations({ chatId });
      if (choices.enabled) return await this.choiceNote(chatId, choices);
      const res = await this.resolve({ chatId });
      return res.note;
    } catch {
      return undefined;
    }
  }

  /** The note for a chat whose agent picks each terminal's location. */
  private async choiceNote(chatId: string, choices: TerminalLocationChoices): Promise<string> {
    const chat = await this.opts.chat(chatId).catch(() => null);
    const info = { chatId, projectId: chat?.projectId };
    const rows = choices.options.map((o) => {
      const head =
        `- \`${o.id}\` — ${o.label}${o.isDefault ? " (the default)" : ""}.` +
        (o.degraded ? ` Degraded right now: ${o.degraded}.` : "");
      if (o.id === LOCAL_TERMINAL_BACKEND) {
        return `${head} The same machine as your Bash/PowerShell tool and your files.`;
      }
      const entry = this.entries.get(o.id);
      const lines = [
        ...(this.fallbackOf(o.id) === "refuse" ? [refuseNote(o.label)] : []),
        ...(entry ? [this.backendExtra(entry, info)] : []),
      ].filter((l): l is string => Boolean(l));
      return lines.length ? `${head}\n  ${lines.join("\n").replace(/\n/g, "\n  ")}` : head;
    });
    const defaultLabel = this.labelOf(choices.defaultId) ?? choices.defaultId;
    return [
      `You choose where each managed terminal (\`mcp__dispatch-workspace__terminal\`) runs: pass ` +
        `\`location\` the FIRST time you use a terminal name. It is fixed for that terminal's life — ` +
        `to run somewhere else, use another name. Without \`location\` a new terminal runs on ` +
        `${defaultLabel} (\`${choices.defaultId}\`). Every result says where it ran.`,
      "",
      "Locations:",
      ...rows,
      ...(choices.unavailable.length
        ? [
            `(Allowed but unavailable right now: ${choices.unavailable
              .map((id) => `\`${id}\`${choices.reasons?.[id] ? ` — ${choices.reasons[id]}` : ""}`)
              .join("; ")}.)`,
          ]
        : []),
      "",
      `Only the terminal moves. Your own Bash/PowerShell tool, file reads and edits, and git always ` +
        `stay on the Dispatch host — keep git local. A build or test meant for a remote location must ` +
        `go through the terminal tool; run through Bash it runs here instead. A server started remotely ` +
        `listens over there: use the forwarded local URL the terminal results list ("Forwarded ports"), ` +
        `not localhost:<port>.`,
    ].join("\n");
  }

  /** A backend's own lines for the agent, contained if it throws. */
  private backendExtra(entry: Entry, info: { chatId: string; projectId?: string }): string | undefined {
    const { backend } = entry;
    // An `update`d note replaces the registration's; called with the backend
    // as `this` either way, so a class method can still reach its own state.
    const fn = entry.agentNote ? entry.agentNote.fn : backend.agentNote;
    try {
      return fn?.call(backend, info)?.trim() || undefined;
    } catch (err) {
      this.opts.log?.(`terminal backend "${backend.id}": agentNote threw`, err);
      return undefined;
    }
  }

  /**
   * What every backend's note starts with. Generic on purpose: the backend
   * appends what only it knows (how code reaches it, what is not shared).
   */
  private noteFor(entry: Entry, info: { chatId: string; projectId?: string }): string {
    const { backend, label } = entry;
    const extra = this.backendExtra(entry, info);
    return [
      `This chat's managed terminals (\`mcp__dispatch-workspace__terminal\` and the Terminals panel) run on ` +
        `${label}, NOT on the Dispatch host. Everything else you do stays local: your own ` +
        `Bash/PowerShell tool, file reads and edits, and git.`,
      `- Run builds, tests, installs and dev servers through the terminal tool. Running them with Bash ` +
        `would run them on the host instead, against a different environment.`,
      `- Keep git local — commit, branch and push from Bash as usual.`,
      `- A server the terminal starts listens over there. Use the forwarded local URL the terminal ` +
        `results list ("Forwarded ports"), not localhost:<port>.`,
      ...(backend.fallback === "refuse" ? [`- ${refuseNote(label)}`] : []),
      ...(extra ? [extra] : []),
    ].join("\n");
  }

  /* ------------------------------------------------------------- lifecycle */

  /** The chat's session was retired by the idle sweep. */
  chatIdle(e: TerminalChatEvent): void {
    this.fanOut("onChatIdle", e);
  }

  /**
   * The chat was deleted (its shells are already killed). Drops its ports and
   * calls every backend's `onChatDeleted`.
   *
   * The returned promise settles when every hook has (or timed out); the
   * delete itself does not wait for it — a hypervisor that takes a minute must
   * not hold the request open. What it buys is the OUTCOME: a hook that
   * rejects or times out is recorded in the cleanup queue and retried until
   * it succeeds, because the alternative was a container destroyed by nobody.
   */
  chatDeleted(e: TerminalChatEvent): Promise<void> {
    let dropped = false;
    for (const [key, f] of this.forwards) {
      if (f.chatId === e.chatId) {
        this.forwards.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.broadcast();
    return Promise.all([...this.entries.values()].map((entry) => this.deliverChatDeleted(entry, e))).then(() => undefined);
  }

  private keyFor(entry: Entry, chatId: string): CleanupKey {
    // A backend registered outside a plugin (tests) is keyed by its own id.
    return { plugin: entry.owner ?? entry.backend.id, target: entry.backend.id, hook: "onChatDeleted", chatId };
  }

  private async deliverChatDeleted(entry: Entry, e: TerminalChatEvent): Promise<void> {
    const { backend } = entry;
    if (typeof backend.onChatDeleted !== "function") return;
    const key = this.keyFor(entry, e.chatId);
    const call = Promise.resolve().then(() => backend.onChatDeleted!(e));
    try {
      await this.bounded(call, "onChatDeleted");
      this.opts.cleanups?.succeeded(key);
    } catch (err) {
      this.opts.log?.(`terminal backend "${backend.id}": onChatDeleted failed for chat ${e.chatId} — will retry`, err);
      this.opts.cleanups?.failed(key, describe(err), e.projectId);
      // A hook that was merely SLOW still counts: when it lands, the retry it
      // caused is withdrawn rather than repeating a destroy that already ran.
      call.then(
        () => this.opts.cleanups?.succeeded(key),
        () => {},
      );
    }
  }

  /**
   * Run one recorded `onChatDeleted` again — the cleanup queue's executor.
   * `unavailable` when the backend is not registered (its plugin is off): the
   * row waits for the next activation rather than burning an attempt.
   */
  async runChatDeleted(backendId: string, e: TerminalChatEvent): Promise<CleanupOutcome> {
    const entry = this.entries.get(backendId);
    if (!entry) return { ok: false, unavailable: true };
    const fn = entry.backend.onChatDeleted;
    if (typeof fn !== "function") return { ok: true };
    try {
      await this.bounded(Promise.resolve().then(() => fn.call(entry.backend, e)), "onChatDeleted");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /**
   * A chat's DEFAULT location when it is a backend (pin, else project
   * default) — what a plugin's `reconcile` is told about each live chat.
   */
  defaultBackendOf(chat: { terminalBackend?: string; projectId?: string }): string | undefined {
    const { id } = resolveTerminalBackend({
      chat: chat.terminalBackend,
      project: chat.projectId ? this.opts.projectDefault(chat.projectId) : undefined,
    });
    return id === LOCAL_TERMINAL_BACKEND ? undefined : id;
  }

  /** Lifecycle hooks are awaited, but not unboundedly: one hung plugin must not pile up promises forever. */
  private bounded(p: Promise<unknown>, hook: string): Promise<void> {
    const ms = this.opts.hookTimeoutMs ?? TERMINAL_CHAT_HOOK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${hook} did not settle in ${ms / 1000}s`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout])
      .then(() => undefined)
      .finally(() => clearTimeout(timer));
  }

  private fanOut(hook: "onChatIdle", e: TerminalChatEvent): void {
    for (const { backend } of this.entries.values()) {
      const fn = backend[hook];
      if (typeof fn !== "function") continue;
      void this.bounded(Promise.resolve().then(() => fn.call(backend, e)), hook).catch((err: unknown) =>
        this.opts.log?.(`terminal backend "${backend.id}": ${hook} failed`, err),
      );
    }
  }

  /* ----------------------------------------------------------------- ports */

  /**
   * Record a forwarded port. Only a registered backend may publish, and the
   * returned withdraw only removes THIS entry — a later publish of the same
   * chat + remote port (a forward re-established after a reconnect) is not
   * undone by the stale handle of the old one.
   */
  publishPort(backendId: string, input: TerminalPortForwardInput): () => void {
    if (!this.entries.has(backendId)) {
      throw new Error(`terminal backend "${backendId}" is not registered`);
    }
    if (!input || typeof input.chatId !== "string" || !Number.isInteger(input.remotePort) || input.remotePort <= 0) {
      throw new Error("publishPort needs { chatId, remotePort, url }");
    }
    if (typeof input.url !== "string" || !/^https?:\/\//.test(input.url)) {
      throw new Error("publishPort: url must be an http(s) URL");
    }
    const forward: TerminalPortForward = {
      chatId: input.chatId,
      backend: backendId,
      remotePort: input.remotePort,
      url: input.url,
      ...(input.label ? { label: input.label } : {}),
    };
    const key = `${input.chatId}\u0000${backendId}\u0000${input.remotePort}`;
    this.forwards.set(key, forward);
    this.broadcast();
    return () => {
      if (this.forwards.get(key) !== forward) return;
      this.forwards.delete(key);
      this.broadcast();
    };
  }

  /** Forwarded ports — one chat's, or all of them. Ordered by remote port. */
  ports(chatId?: string): TerminalPortForward[] {
    return [...this.forwards.values()]
      .filter((f) => chatId === undefined || f.chatId === chatId)
      .sort((a, b) => a.remotePort - b.remotePort);
  }

  private broadcast(): void {
    this.opts.bus.publish({ type: "terminal-backends", backends: this.list(), ports: this.ports() });
  }

  /** Unregister everything (server teardown). */
  async dispose(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.unregister(id);
  }
}
