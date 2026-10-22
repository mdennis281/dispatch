/**
 * PluginService — the plugin host's lifecycle: discover, resolve enablement,
 * activate, run, deactivate. See docs/plugins.md → "Lifecycle".
 *
 * Three decisions here are the ones a later change is most likely to undo by
 * accident, so they get their reasons up front:
 *
 *   ACTIVATION RUNS FROM `warm()`, AFTER LISTEN, AND NOTHING AWAITS IT. A
 *   plugin's `activate` is arbitrary code with a 30 s budget. Awaiting it
 *   before the port opened would hold the health check shut long enough for
 *   `install.mjs` to roll a healthy update back — the exact failure that split
 *   `start()` from `warm()` in the first place. So the port is open before the
 *   first plugin runs, `warm()` fires `activateAll` and moves on, and a hung
 *   `activate` delays only the plugins queued behind it — not the runner
 *   reconcile, and not a shutdown (`dispose` does not join it either).
 *
 *   A THROWING PLUGIN IS A ROW, NOT A CRASH. Every failure path marks the plugin
 *   `error` with its message, files it through the crash log, and moves on.
 *   Boot never fails because of a plugin; the Settings pane is where the owner
 *   finds out.
 *
 *   ROUTES ARE A TABLE. Fastify can neither add nor remove a route on a
 *   listening instance, and plugins activate after listen and deactivate on a
 *   toggle. So `buildApp` registers one wildcard per prefix and the handler
 *   consults the plugin's own find-my-way table (`OwnedResources.routes`),
 *   which deactivate empties. See `routes/plugins.ts` for the wildcard.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PLUGIN_API_VERSION,
  type ModeConfig,
  type PluginInfo,
  type PluginLog,
  type PluginModule,
  type PluginStatus,
  type SkillConfig,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { recordFault } from "../crash-log.js";
import type { InstructionFile, PluginContributionSource } from "../services/authored-config.js";
import {
  buildPluginContext,
  newOwnedResources,
  type OwnedResources,
  type PluginContextDeps,
  type ServerPluginRouteHandler,
} from "./context.js";
import { discoverPlugins, pluginsRoot, type DiscoveredPlugin } from "./manifest.js";
import { pluginOAuthManifestView, type PluginOAuthManifestView } from "./oauth.js";
import {
  EMPTY_CONTRIBUTIONS,
  readPluginContributions,
  type PluginContributions,
  type PluginMcpDeclaration,
} from "./contributions.js";
import { PluginProcessHost, type PluginProcessRunner } from "./processes.js";

/** Spec budget for one `activate` (docs/plugins.md → "Lifecycle"). */
export const ACTIVATE_BUDGET_MS = 30_000;
/** Shorter on the way down: a deactivate that hangs must not hold a shutdown. */
export const DEACTIVATE_BUDGET_MS = 10_000;

/** Where a plugin is in its life, as the host tracks it. */
type Phase =
  /** Valid and enabled, not yet activated this process (boot, or toggled on). */
  | "pending"
  | "activating"
  | "active"
  | "error"
  /** Deactivated, or never eligible (disabled / invalid / incompatible). */
  | "inactive";

interface PluginRecord extends DiscoveredPlugin {
  enabled: boolean;
  phase: Phase;
  /** The `activate` failure, when `phase` is `error`. */
  activationError?: string;
  /** Toggled on in this process: the pane says "restart to apply". */
  needsRestart: boolean;
  settings: Record<string, unknown>;
  module?: PluginModule;
  owned?: OwnedResources;
  /** Snapshot of the plugin's static contributions, read once at `load()`. */
  contributions: PluginContributions;
}

export interface PluginServiceOptions {
  /** The config root — plugins live under `<configDir>/plugins/`. */
  configDir: string;
  store: Store;
  /** Everything the context adapts over, minus what the service supplies itself. */
  context: Omit<PluginContextDeps, "log" | "settings" | "store" | "processes">;
  /**
   * The sub-app runner, which plugin processes run through. Optional so the
   * host still comes up without one (tests, a stripped container); then
   * `contributes.processes` is declared but nothing starts, and `ctx.processes`
   * is absent.
   */
  runner?: PluginProcessRunner;
  /** Port probe for singleton adoption — injected by tests. */
  portFree?: (port: number) => Promise<boolean>;
  activateBudgetMs?: number;
  deactivateBudgetMs?: number;
  /** Injected for tests so a module can be faked without a file on disk. */
  importModule?: (url: string) => Promise<unknown>;
  fault?: (kind: string, err: unknown) => void;
  log?: (line: string) => void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Await `p` for at most `ms`; a timeout rejects with a message naming the budget. */
function withBudget<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** `activate` from a module namespace, a default export, or a `plugin` export — whichever the author reached for. */
function moduleOf(ns: unknown): PluginModule | undefined {
  const candidates = [ns, (ns as { default?: unknown })?.default, (ns as { plugin?: unknown })?.plugin];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as { activate?: unknown }).activate === "function") {
      return c as PluginModule;
    }
  }
  return undefined;
}

export class PluginService implements PluginContributionSource {
  private readonly records = new Map<string, PluginRecord>();
  private readonly configDir: string;
  private readonly store: Store;
  private readonly ctxDeps: PluginServiceOptions["context"];
  /** Present when the container handed over a runner; see {@link PluginServiceOptions.runner}. */
  private readonly processHost: PluginProcessHost | undefined;
  private readonly activateBudgetMs: number;
  private readonly deactivateBudgetMs: number;
  private readonly importModule: (url: string) => Promise<unknown>;
  private readonly fault: (kind: string, err: unknown) => void;
  private readonly log: (line: string) => void;
  private loaded = false;
  /** Memoised `activateAll`, so a second call joins the first instead of re-running it. */
  private activating: Promise<void> | undefined;
  private disposed = false;

  constructor(opts: PluginServiceOptions) {
    this.configDir = opts.configDir;
    this.store = opts.store;
    this.ctxDeps = opts.context;
    this.activateBudgetMs = opts.activateBudgetMs ?? ACTIVATE_BUDGET_MS;
    this.deactivateBudgetMs = opts.deactivateBudgetMs ?? DEACTIVATE_BUDGET_MS;
    this.importModule = opts.importModule ?? ((url) => import(url));
    this.fault = opts.fault ?? recordFault;
    // eslint-disable-next-line no-console
    this.log = opts.log ?? ((line) => console.log(line));
    this.processHost = opts.runner
      ? new PluginProcessHost({ runner: opts.runner, portFree: opts.portFree, log: this.log })
      : undefined;
  }

  /** `<configDir>/plugins` — what "open folder" and the CLI both point at. */
  get root(): string {
    return pluginsRoot(this.configDir);
  }

  /**
   * Discover + resolve enablement. Bounded (a readdir and a YAML parse per
   * plugin), so it belongs in `start()`; nothing a plugin wrote runs here.
   */
  async load(): Promise<void> {
    const settings = await this.store.getSettings().catch(() => ({}) as { plugins?: undefined });
    const map = settings.plugins ?? {};
    this.records.clear();
    for (const found of await discoverPlugins(this.configDir)) {
      const entry = map[found.id];
      const enabled = entry?.enabled ?? true;
      const eligible = !!found.manifest && !found.incompatible && enabled;
      // Contributions are read for every VALID plugin, enabled or not: a
      // disabled plugin's MCP servers still appear in the catalog (switched
      // off, with the reason) so the layered toggles have something to point
      // at. Everything else a disabled plugin contributes is filtered out at
      // the query methods below.
      const contributions =
        found.manifest && !found.incompatible
          ? await readPluginContributions(found.id, found.dir, found.manifest).catch(() => EMPTY_CONTRIBUTIONS)
          : EMPTY_CONTRIBUTIONS;
      this.records.set(found.id, {
        ...found,
        enabled,
        phase: eligible ? "pending" : "inactive",
        needsRestart: false,
        settings: entry?.settings ?? {},
        contributions,
      });
      if (contributions.processes.length) {
        this.processHost?.register(found.id, found.dir, contributions.processes);
      }
    }
    this.loaded = true;
  }

  /**
   * Activate every pending plugin, in id order, each on its own budget. Called
   * from `warm()`; memoised so `dispose()` can wait on it.
   */
  activateAll(): Promise<void> {
    if (!this.activating) {
      this.activating = (async () => {
        for (const rec of [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          if (this.disposed) return;
          if (rec.phase === "pending") await this.activateOne(rec);
        }
      })();
    }
    return this.activating;
  }

  private async activateOne(rec: PluginRecord): Promise<void> {
    const manifest = rec.manifest!;
    rec.phase = "activating";
    rec.activationError = undefined;
    const log = this.loggerFor(rec.id);
    if (!manifest.server) {
      // Contributions-only or client-only: nothing to run on this side —
      // except the processes it declared, which start on activation whether
      // or not there is a module to call.
      rec.phase = "active";
      await this.autostartProcesses(rec, log);
      return;
    }
    const owned = newOwnedResources();
    rec.owned = owned;
    try {
      const url = pathToFileURL(resolve(rec.dir, manifest.server)).href;
      const ns = await withBudget(this.importModule(url), this.activateBudgetMs, "import");
      const mod = moduleOf(ns);
      if (!mod) throw new Error(`${manifest.server} does not export activate()`);
      rec.module = mod;
      const ctx = buildPluginContext(
        manifest,
        rec.dir,
        {
          ...this.ctxDeps,
          store: this.store,
          log,
          settings: () => rec.settings,
          processes: this.processHost?.for(rec.id),
        },
        owned,
      );
      // Autostart BEFORE `activate` runs, so a module that talks to its own
      // process from `activate` (health-check it, read its port from
      // `ctx.processes.list()`) finds it already up.
      await this.autostartProcesses(rec, log);
      await withBudget(Promise.resolve(mod.activate(ctx)), this.activateBudgetMs, "activate()");
      if (this.disposed) {
        // The host went away while this one was coming up. `dispose()` does not
        // wait for an activate in flight (a hung one would hold the shutdown
        // for its whole budget), so the late arrival tears itself down here.
        this.teardown(rec);
        await this.stopProcesses(rec);
        rec.phase = "inactive";
        return;
      }
      rec.phase = "active";
      log.info(`active (v${manifest.version})`);
    } catch (err) {
      rec.phase = "error";
      rec.activationError = describe(err);
      this.fault(`plugin "${rec.id}" failed to activate`, err);
      // Whatever it registered before throwing is as dead as the plugin —
      // its processes included.
      this.teardown(rec);
      await this.stopProcesses(rec);
    }
  }

  private async deactivateOne(rec: PluginRecord): Promise<void> {
    if (rec.phase === "active" && rec.module?.deactivate) {
      try {
        await withBudget(Promise.resolve(rec.module.deactivate()), this.deactivateBudgetMs, "deactivate()");
      } catch (err) {
        // Reported, never fatal: the host tears down everything it owns next,
        // which is the half of deactivation the plugin cannot opt out of.
        this.fault(`plugin "${rec.id}" failed to deactivate`, err);
      }
    }
    this.teardown(rec);
    await this.stopProcesses(rec);
    rec.phase = "inactive";
  }

  /** Start the plugin's `autostart` processes; a failure is a row warning, never an activation failure. */
  private async autostartProcesses(rec: PluginRecord, log: PluginLog): Promise<void> {
    if (!this.processHost || !rec.contributions.processes.length) return;
    await this.processHost.autostart(rec.id, (id, err) => {
      log.error(`process "${id}" failed to start: ${describe(err)}`, err);
    });
  }

  /** Stop every process the plugin has running. Best-effort, like the rest of teardown. */
  private async stopProcesses(rec: PluginRecord): Promise<void> {
    if (!this.processHost || !rec.contributions.processes.length) return;
    await this.processHost.stopAll(rec.id).catch((err: unknown) => {
      this.fault(`plugin "${rec.id}" processes failed to stop`, err);
    });
  }

  /** Drop everything the plugin registered. Idempotent. */
  private teardown(rec: PluginRecord): void {
    const owned = rec.owned;
    if (!owned) return;
    for (const off of owned.offs.splice(0)) {
      try {
        off();
      } catch {
        /* an unsubscribe that throws has nothing left to undo */
      }
    }
    owned.routes.reset();
    owned.settingsListeners.clear();
    rec.module = undefined;
  }

  /**
   * Deactivate every active plugin, reverse id order.
   *
   * Does NOT wait for an activation still in flight: that is third-party code
   * on a 30 s budget, and a shutdown held for it is exactly what the
   * activate-after-listen design was meant to spare the host. The loop in
   * `activateAll` stops at the next plugin, and the one in flight sees
   * `disposed` when it returns and tears itself down (see `activateOne`).
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const recs = [...this.records.values()].sort((a, b) => b.id.localeCompare(a.id));
    for (const rec of recs) {
      if (rec.phase === "active" || rec.phase === "error") await this.deactivateOne(rec);
    }
  }

  /* ------------------------------------------------------------- queries */

  private statusOf(rec: PluginRecord): PluginStatus {
    if (!rec.manifest) return "invalid";
    if (rec.incompatible) return "incompatible";
    if (!rec.enabled) return "disabled";
    if (rec.phase === "error") return "error";
    if (rec.phase === "active") return "active";
    // `pending` at boot is a window of milliseconds; `pending` after a toggle
    // is the restart-required state, and `needsRestart` says which.
    return rec.needsRestart ? "disabled" : "active";
  }

  /**
   * The declared `oauth.clients` of an enabled, valid plugin — what the OAuth
   * client flow resolves a Connect click or a `ctx.oauth` call against.
   * Undefined for a plugin that is off, broken, or declares no `oauth`
   * capability, so a token can be neither minted nor read for one.
   */
  oauthView(id: string): PluginOAuthManifestView | undefined {
    const rec = this.records.get(id);
    if (!rec?.manifest || !rec.enabled || rec.incompatible) return undefined;
    return pluginOAuthManifestView(rec.manifest);
  }

  info(rec: PluginRecord): PluginInfo {
    const m = rec.manifest;
    const error = rec.phase === "error" ? rec.activationError : rec.error;
    const oauthView = m ? pluginOAuthManifestView(m) : undefined;
    const oauth = oauthView && this.ctxDeps.pluginOAuth ? this.ctxDeps.pluginOAuth.status(rec.id, oauthView) : undefined;
    return {
      id: rec.id,
      name: m?.name ?? rec.id,
      ...(m?.version ? { version: m.version } : {}),
      ...(m?.description ? { description: m.description } : {}),
      dir: rec.dir,
      status: this.statusOf(rec),
      ...(error ? { error } : {}),
      enabled: rec.enabled,
      ...(rec.needsRestart ? { needsRestart: true } : {}),
      capabilities: m?.capabilities ?? [],
      hasServer: !!m?.server,
      ...(m?.client ? { clientUrl: `/plugins/${rec.id}/` } : {}),
      ...(rec.settingsSchema !== undefined ? { settingsSchema: rec.settingsSchema } : {}),
      settings: rec.settings,
      ...(m?.secrets ? { secrets: m.secrets } : {}),
      ...(oauth?.length ? { oauth } : {}),
      ...(rec.contributions.warnings.length ? { warnings: rec.contributions.warnings } : {}),
    };
  }

  list(): PluginInfo[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => this.info(r));
  }

  get(id: string): PluginInfo | undefined {
    const rec = this.records.get(id);
    return rec && this.info(rec);
  }

  /* -------------------------------------------------------- contributions */

  /**
   * Plugins whose contributions are IN EFFECT: valid, compatible and enabled.
   * Activation phase is deliberately not consulted — a plugin whose server
   * module threw still has valid skills, and a contributions-only plugin has
   * no module to activate. Id order, which is also activation order, so a
   * name two plugins both claim is resolved the same way everywhere.
   */
  private contributing(): PluginRecord[] {
    return [...this.records.values()]
      .filter((r) => r.manifest && !r.incompatible && r.enabled)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Contributed skills, each with the plugin it came from. */
  skills(): Array<{ pluginId: string; skill: SkillConfig }> {
    return this.contributing().flatMap((r) => r.contributions.skills.map((skill) => ({ pluginId: r.id, skill })));
  }

  /** Contributed instructions — injected between shipped and global. */
  instructions(): Array<{ pluginId: string; file: InstructionFile }> {
    return this.contributing().flatMap((r) => r.contributions.instructions.map((file) => ({ pluginId: r.id, file })));
  }

  /** Contributed personas. */
  personas(): Array<{ pluginId: string; file: InstructionFile }> {
    return this.contributing().flatMap((r) => r.contributions.personas.map((file) => ({ pluginId: r.id, file })));
  }

  /** Contributed modes, scope `plugin`, each stamped with its `pluginId`. */
  modes(): ModeConfig[] {
    const seen = new Set<string>();
    const out: ModeConfig[] = [];
    for (const r of this.contributing()) {
      for (const m of r.contributions.modes) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }

  /**
   * Every declared MCP server from every VALID plugin — disabled ones too,
   * with `byDefault: false` — so the catalog can list what a toggle could turn
   * on. Selection for a session happens in `selectPluginMcpServers`.
   */
  mcpServers(): PluginMcpDeclaration[] {
    const out: PluginMcpDeclaration[] = [];
    for (const r of [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!r.manifest || r.incompatible) continue;
      for (const decl of r.contributions.mcpServers) {
        out.push({
          ...decl,
          byDefault: r.enabled,
          defaultReason: r.enabled
            ? `declared by plugin "${r.id}"`
            : `off — plugin "${r.id}" is switched off in Settings → Plugins`,
        });
      }
    }
    return out;
  }

  /** The host API major, for the pane's "built for" text. */
  get apiVersion(): number {
    return PLUGIN_API_VERSION;
  }

  /* ----------------------------------------------------------- mutations */

  /**
   * Flip the toggle. Off deactivates now; on only records the wish — hot
   * reload is out of scope, and a plugin whose module was already imported
   * once in this process cannot be re-imported fresh anyway.
   */
  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const rec = this.records.get(id);
    if (!rec) throw new PluginNotFound(id);
    await this.store.updateSettings((current) => ({
      ...current,
      plugins: { ...current.plugins, [id]: { ...current.plugins?.[id], enabled } },
    }));
    rec.enabled = enabled;
    if (!enabled) {
      if (rec.phase === "active" || rec.phase === "error" || rec.phase === "pending") {
        await this.deactivateOne(rec);
      }
      rec.needsRestart = false;
    } else if (rec.manifest && !rec.incompatible && rec.phase !== "active") {
      rec.needsRestart = true;
    }
    return this.info(rec);
  }

  /** Replace the plugin's settings and tell its `onChange` listeners. */
  async setSettings(id: string, settings: Record<string, unknown>): Promise<PluginInfo> {
    const rec = this.records.get(id);
    if (!rec) throw new PluginNotFound(id);
    await this.store.updateSettings((current) => ({
      ...current,
      plugins: { ...current.plugins, [id]: { ...current.plugins?.[id], settings } },
    }));
    rec.settings = settings;
    for (const fn of rec.owned?.settingsListeners ?? []) {
      try {
        fn(settings);
      } catch (err) {
        this.fault(`plugin "${id}" settings listener threw`, err);
      }
    }
    return this.info(rec);
  }

  /* ------------------------------------------------------------- routing */

  /**
   * Serve one request under `/api/plugins/<id>/…` from the plugin's table.
   * The wildcard in `routes/plugins.ts` is the only caller.
   */
  async handle(id: string, rest: string, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const rec = this.records.get(id);
    if (!rec || !rec.enabled || !rec.manifest || rec.incompatible) {
      return reply.code(404).send({ error: `no plugin "${id}" is enabled` });
    }
    if (rec.phase === "pending" || rec.phase === "activating") {
      // Still coming up: the client should retry, not conclude the route is gone.
      return reply.code(503).header("retry-after", "2").send({ error: `plugin "${id}" is activating` });
    }
    if (rec.phase !== "active" || !rec.owned) {
      return reply.code(404).send({ error: `plugin "${id}" is not active` });
    }
    const path = `/${rest.replace(/^\/+/, "")}`;
    const hit = rec.owned.routes.find(req.method as Parameters<OwnedResources["routes"]["find"]>[0], path);
    if (!hit) return reply.code(404).send({ error: `no ${req.method} ${path} in plugin "${id}"` });
    // The table's params replace the wildcard's (`{ id, "*": … }`): a plugin
    // handler wrote `:chatId`, and that is what it should read back.
    (req as { params: unknown }).params = hit.params;
    const handler = (hit.store as { handler: ServerPluginRouteHandler }).handler;
    return handler(req, reply);
  }

  /* ------------------------------------------------------------ internals */

  private loggerFor(id: string): PluginLog {
    const prefix = `[plugin:${id}]`;
    return {
      info: (m) => this.log(`${prefix} ${m}`),
      warn: (m) => this.log(`${prefix} warning: ${m}`),
      error: (m, err) => this.fault(`${prefix} ${m}`, err ?? new Error(m)),
    };
  }

  /** Whether `load()` has run — the routes refuse to answer before it. */
  get isLoaded(): boolean {
    return this.loaded;
  }
}

export class PluginNotFound extends Error {
  constructor(id: string) {
    super(`no plugin "${id}"`);
    this.name = "PluginNotFound";
  }
}
