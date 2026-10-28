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
 */
import {
  LOCAL_TERMINAL_BACKEND,
  TERMINAL_BACKEND_ID_PATTERN,
  resolveTerminalBackend,
  resolveTerminalLocations,
  type TerminalBackend,
  type TerminalBackendInfo,
  type TerminalChatEvent,
  type TerminalLocationChoices,
  type TerminalLocationOption,
  type TerminalPortForward,
  type TerminalPortForwardInput,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { TerminalBackendResolution, TerminalBackendSource } from "./terminal.js";

export interface TerminalBackendRegistryOptions {
  bus: EventBus;
  /** The chat's own pin and project, or null when there is no such chat. */
  chat: (chatId: string) => Promise<{ terminalBackend?: string; projectId?: string } | null>;
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
  /**
   * Resolves once installed plugins have finished activating. A chat pinned to
   * a backend whose plugin simply has not activated YET (boot runs plugin
   * activation after the port opens) must wait for it rather than be told the
   * backend is not installed and handed a local shell.
   */
  settled?: () => Promise<void>;
  log?: (message: string, err?: unknown) => void;
}

interface Entry {
  backend: TerminalBackend;
  /** The plugin that registered it. */
  owner?: string;
}

/** Called with a backend id as it is unregistered — TerminalService ends its shells. */
type DetachListener = (backendId: string) => void;

/** What the agent note and refusals call the built-in location. */
const LOCAL_LABEL = "this machine (the Dispatch host)";

/** Lifecycle hooks are fire-and-forget, but not unbounded: one hung plugin must not pile up promises forever. */
const HOOK_TIMEOUT_MS = 60_000;

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
    return [...this.entries.values()].map(({ backend, owner }) => ({
      id: backend.id,
      label: backend.label,
      shell: backend.shell,
      ...(owner ? { pluginId: owner } : {}),
    }));
  }

  /** Subscribe to unregistrations. Returns the unsubscribe. */
  onDetach(fn: DetachListener): () => void {
    this.detachListeners.add(fn);
    return () => this.detachListeners.delete(fn);
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
    this.entries.set(id, { backend, owner });
    this.broadcast();
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
    if (!entry) return { requested: choice.id, missing: true };
    const repoPath = projectId ? await this.opts.repoPath?.(projectId).catch(() => undefined) : undefined;
    return {
      requested: choice.id,
      backend: entry.backend,
      ...(repoPath ? { repoPath } : {}),
      note: this.noteFor(entry.backend, { chatId: ident.chatId, projectId }),
    };
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
    for (const id of new Set([def.id, ...allowed])) {
      const label = this.labelOf(id);
      if (label === undefined) {
        if (id !== def.id) unavailable.push(id);
        continue;
      }
      options.push({ id, label, isDefault: id === def.id });
    }
    return { defaultId: def.id, options, unavailable, enabled: options.length > 1 };
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
      ? `"${location}" is allowed but not available right now — its plugin is switched off or not installed`
      : `"${location}" is not an allowed terminal location for this chat`;
    return {
      ok: false,
      error: `${why}. Allowed: ${list}. Omit \`location\` for the default (\`${choices.defaultId}\`).`,
    };
  }

  /** What a location is called — undefined for a backend that is not registered. */
  labelOf(id: string): string | undefined {
    if (id === LOCAL_TERMINAL_BACKEND) return LOCAL_LABEL;
    return this.entries.get(id)?.backend.label;
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
      const head = `- \`${o.id}\` — ${o.label}${o.isDefault ? " (the default)" : ""}.`;
      if (o.id === LOCAL_TERMINAL_BACKEND) {
        return `${head} The same machine as your Bash/PowerShell tool and your files.`;
      }
      const entry = this.entries.get(o.id);
      const extra = entry ? this.backendExtra(entry.backend, info) : undefined;
      return extra ? `${head}\n  ${extra.replace(/\n/g, "\n  ")}` : head;
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
        ? [`(Allowed but unavailable right now: ${choices.unavailable.map((id) => `\`${id}\``).join(", ")}.)`]
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
  private backendExtra(
    backend: TerminalBackend,
    info: { chatId: string; projectId?: string },
  ): string | undefined {
    try {
      return backend.agentNote?.(info)?.trim() || undefined;
    } catch (err) {
      this.opts.log?.(`terminal backend "${backend.id}": agentNote threw`, err);
      return undefined;
    }
  }

  /**
   * What every backend's note starts with. Generic on purpose: the backend
   * appends what only it knows (how code reaches it, what is not shared).
   */
  private noteFor(backend: TerminalBackend, info: { chatId: string; projectId?: string }): string {
    const extra = this.backendExtra(backend, info);
    return [
      `This chat's managed terminals (\`mcp__dispatch-workspace__terminal\` and the Terminals panel) run on ` +
        `${backend.label}, NOT on the Dispatch host. Everything else you do stays local: your own ` +
        `Bash/PowerShell tool, file reads and edits, and git.`,
      `- Run builds, tests, installs and dev servers through the terminal tool. Running them with Bash ` +
        `would run them on the host instead, against a different environment.`,
      `- Keep git local — commit, branch and push from Bash as usual.`,
      `- A server the terminal starts listens over there. Use the forwarded local URL the terminal ` +
        `results list ("Forwarded ports"), not localhost:<port>.`,
      ...(extra ? [extra] : []),
    ].join("\n");
  }

  /* ------------------------------------------------------------- lifecycle */

  /** The chat's session was retired by the idle sweep. */
  chatIdle(e: TerminalChatEvent): void {
    this.fanOut("onChatIdle", e);
  }

  /** The chat was deleted (its shells are already killed). Also drops its ports. */
  chatDeleted(e: TerminalChatEvent): void {
    let dropped = false;
    for (const [key, f] of this.forwards) {
      if (f.chatId === e.chatId) {
        this.forwards.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.broadcast();
    this.fanOut("onChatDeleted", e);
  }

  private fanOut(hook: "onChatIdle" | "onChatDeleted", e: TerminalChatEvent): void {
    for (const { backend } of this.entries.values()) {
      const fn = backend[hook];
      if (typeof fn !== "function") continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${hook} did not settle in ${HOOK_TIMEOUT_MS / 1000}s`)), HOOK_TIMEOUT_MS);
        timer.unref?.();
      });
      void Promise.race([Promise.resolve().then(() => fn.call(backend, e)), timeout])
        .catch((err: unknown) => this.opts.log?.(`terminal backend "${backend.id}": ${hook} failed`, err))
        .finally(() => clearTimeout(timer));
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
