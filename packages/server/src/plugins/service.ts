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
  type PluginInfo,
  type PluginLog,
  type PluginModule,
  type PluginStatus,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { recordFault } from "../crash-log.js";
import {
  buildPluginContext,
  newOwnedResources,
  type OwnedResources,
  type PluginContextDeps,
  type ServerPluginRouteHandler,
} from "./context.js";
import { discoverPlugins, pluginsRoot, type DiscoveredPlugin } from "./manifest.js";
import { pluginOAuthManifestView, type PluginOAuthManifestView } from "./oauth.js";

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
}

export interface PluginServiceOptions {
  /** The config root — plugins live under `<configDir>/plugins/`. */
  configDir: string;
  store: Store;
  /** Everything the context adapts over, minus what the service supplies itself. */
  context: Omit<PluginContextDeps, "log" | "settings" | "store">;
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

export class PluginService {
  private readonly records = new Map<string, PluginRecord>();
  private readonly configDir: string;
  private readonly store: Store;
  private readonly ctxDeps: PluginServiceOptions["context"];
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
      this.records.set(found.id, {
        ...found,
        enabled,
        phase: eligible ? "pending" : "inactive",
        needsRestart: false,
        settings: entry?.settings ?? {},
      });
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
    if (!manifest.server) {
      // Contributions-only or client-only: nothing to run on this side.
      rec.phase = "active";
      return;
    }
    const owned = newOwnedResources();
    rec.owned = owned;
    const log = this.loggerFor(rec.id);
    try {
      const url = pathToFileURL(resolve(rec.dir, manifest.server)).href;
      const ns = await withBudget(this.importModule(url), this.activateBudgetMs, "import");
      const mod = moduleOf(ns);
      if (!mod) throw new Error(`${manifest.server} does not export activate()`);
      rec.module = mod;
      const ctx = buildPluginContext(
        manifest,
        rec.dir,
        { ...this.ctxDeps, store: this.store, log, settings: () => rec.settings },
        owned,
      );
      await withBudget(Promise.resolve(mod.activate(ctx)), this.activateBudgetMs, "activate()");
      if (this.disposed) {
        // The host went away while this one was coming up. `dispose()` does not
        // wait for an activate in flight (a hung one would hold the shutdown
        // for its whole budget), so the late arrival tears itself down here.
        this.teardown(rec);
        rec.phase = "inactive";
        return;
      }
      rec.phase = "active";
      log.info(`active (v${manifest.version})`);
    } catch (err) {
      rec.phase = "error";
      rec.activationError = describe(err);
      this.fault(`plugin "${rec.id}" failed to activate`, err);
      // Whatever it registered before throwing is as dead as the plugin.
      this.teardown(rec);
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
    rec.phase = "inactive";
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
    };
  }

  list(): PluginInfo[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => this.info(r));
  }

  get(id: string): PluginInfo | undefined {
    const rec = this.records.get(id);
    return rec && this.info(rec);
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
