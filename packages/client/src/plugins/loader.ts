/**
 * Load every active plugin's client half.
 *
 * After boot — once the auth gate has let the app through — fetch
 * `GET /api/plugins`, and for each ACTIVE plugin with a client URL: install
 * the globals shim, `import()` the entry, call `activate(host)`. A plugin
 * that fails to import or throws from `activate` gets a toast naming it and
 * is skipped; the next plugin still loads and the app never notices. That
 * isolation is the whole contract — a plugin is code the repo cannot test.
 *
 * `/* @vite-ignore *\/` on the import: the URL is runtime data, and Vite
 * would otherwise try to resolve it at build time and warn about every
 * dynamic import it cannot analyse.
 *
 * The status filter matters: `GET /api/plugins` lists a client URL for any
 * manifest with a `client` entry, including one whose server half failed to
 * activate (`error`). Loading its client half would hand the user a control
 * whose every request 404s, so only `active` plugins load.
 */
import type { ClientPluginModule, PluginInfo } from "@dispatch/shared";
import type { createClientHost } from "./host.js";

/** The `activate` export, from the namespace, a default export, or a `plugin` export. Mirrors the server's `moduleOf`. */
export function clientModuleOf(ns: unknown): ClientPluginModule | undefined {
  const candidates = [ns, (ns as { default?: unknown })?.default, (ns as { plugin?: unknown })?.plugin];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as { activate?: unknown }).activate === "function") {
      return c as ClientPluginModule;
    }
  }
  return undefined;
}

export interface LoadDeps {
  list(): Promise<PluginInfo[]>;
  importModule(url: string): Promise<unknown>;
  /** Install the globals shim before the first import. Called at most once. */
  installDeps(): Promise<void>;
  toast(text: string, detail?: string): void;
  makeHost: typeof createClientHost;
}

/** The plugins that should load, in id order. Exported for the tests. */
export function loadable(plugins: PluginInfo[]): PluginInfo[] {
  return plugins
    .filter((p) => p.status === "active" && !!p.clientUrl)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The URL of a plugin's entry module — `clientUrl` IS the module (`/plugins/<id>/<file>`), per `PluginInfo`. */
export function entryUrl(p: PluginInfo): string {
  return p.clientUrl ?? "";
}

export async function loadClientPlugins(deps: LoadDeps): Promise<{ loaded: string[]; failed: string[] }> {
  const loaded: string[] = [];
  const failed: string[] = [];
  let plugins: PluginInfo[];
  try {
    plugins = loadable(await deps.list());
  } catch (err) {
    // No list, no plugins — a boot-time 401 or a server mid-restart. Quiet:
    // the connection screen is already saying what is wrong.
    console.warn("[dispatch] could not list plugins:", err);
    return { loaded, failed };
  }
  if (plugins.length === 0) return { loaded, failed };
  await deps.installDeps();
  for (const p of plugins) {
    try {
      const ns = await deps.importModule(entryUrl(p));
      const mod = clientModuleOf(ns);
      if (!mod) throw new Error("the client entry does not export activate()");
      await mod.activate(deps.makeHost(p.id));
      loaded.push(p.id);
    } catch (err) {
      failed.push(p.id);
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] plugin "${p.id}" failed to load:`, err);
      deps.toast(`Plugin "${p.name}" failed to load`, detail);
    }
  }
  return { loaded, failed };
}
