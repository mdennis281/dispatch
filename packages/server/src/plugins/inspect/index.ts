/**
 * Inspect a plugin at a git URL, and install exactly what was inspected.
 * See docs/plugins.md → "Inspecting a plugin before installing it".
 *
 * Install is the SAME `addPlugin` `dispatch plugin add` runs — validate in the
 * source, claim the slot, copy to a sibling tmp dir without `.git` /
 * `node_modules`, rename into place. The only thing that differs is how the
 * source directory came to exist: here it is the confined extraction of the
 * pinned sha, never a `git clone` of a branch tip that may have moved since
 * the owner read the report.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_ID_PATTERN, type PluginInfo, type PluginInspection } from "@dispatch/shared";
import { CmError, addPlugin } from "@dispatch/cli/core";
import { pluginsRoot, readPluginDir } from "../manifest.js";
import { fetchPlugin, type FetchDeps, type FetchLimits, type FetchedPlugin } from "./fetch.js";
import { inspectPluginDir, type InstalledLookup } from "./inspect.js";
import { PluginInspectError } from "./url.js";

export { PluginInspectError } from "./url.js";
export { DEFAULT_FETCH_LIMITS, type FetchDeps, type FetchLimits } from "./fetch.js";

export interface PluginInspectorOptions {
  configDir: string;
  /** The host's view of a plugin — status and the restart flag — when one is loaded. */
  hostInfo: (id: string) => PluginInfo | undefined;
  /** Tell the host a directory changed under it, so the pane can say "restart to load it". */
  noteInstalled: (id: string) => Promise<PluginInfo | undefined>;
  fetchDeps?: FetchDeps;
  limits?: FetchLimits;
}

export interface PluginInstallOutcome {
  id: string;
  outcome: "copied" | "replaced";
  sha: string;
  needsRestart: true;
  plugin?: PluginInfo;
}

export class PluginInspector {
  /** One install per plugin id at a time — two clicks must not race the slot claim. */
  private readonly installing = new Set<string>();

  constructor(private readonly opts: PluginInspectorOptions) {}

  private async installed(id: string): Promise<InstalledLookup | undefined> {
    // `id` may come from a manifest that FAILED validation — i.e. straight
    // from a stranger's plugin.yaml. `id: ../../x` would otherwise probe an
    // arbitrary server path and report whether it exists and its version.
    if (!PLUGIN_ID_PATTERN.test(id)) return undefined;
    const dir = join(pluginsRoot(this.opts.configDir), id);
    try {
      await lstat(dir);
    } catch {
      return undefined;
    }
    const found = await readPluginDir(dir, id);
    const host = this.opts.hostInfo(id);
    return {
      ...(found.manifest?.version ? { version: found.manifest.version } : {}),
      ...(host ? { status: host.status } : {}),
      ...(host?.needsRestart ? { needsRestart: true } : {}),
      ...(found.linked ? { linked: true } : {}),
    };
  }

  private report(f: FetchedPlugin, url: string): Promise<PluginInspection> {
    return inspectPluginDir(f.dir, {
      source: {
        url,
        host: f.parsed.host,
        repo: f.parsed.repo,
        cloneUrl: f.parsed.cloneUrl,
        ref: f.ref,
        sha: f.sha,
        subdir: f.subdir,
        ...(f.browseUrl ? { browseUrl: f.browseUrl } : {}),
      },
      fetched: { files: f.extract.files, bytes: f.extract.bytes, skipped: f.extract.skipped },
      installed: (id) => this.installed(id),
      builtin: (id) => this.opts.hostInfo(id)?.builtin === true,
    });
  }

  async inspect(url: string): Promise<PluginInspection> {
    const f = await fetchPlugin(url, { limits: this.opts.limits, deps: this.opts.fetchDeps });
    try {
      return await this.report(f, url);
    } finally {
      await rm(f.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Fetch `sha` again, re-run the SAME report on it, refuse unless it is
   * installable, then hand the extracted directory to `addPlugin`. Stateless
   * on purpose: nothing from the earlier inspect is trusted, so a client that
   * posts a sha it never inspected gets exactly the checks an inspect would
   * have shown it.
   */
  async install(url: string, sha: string, replace: boolean): Promise<PluginInstallOutcome> {
    const f = await fetchPlugin(url, { pinSha: sha, limits: this.opts.limits, deps: this.opts.fetchDeps });
    let locked: string | undefined;
    try {
      const report = await this.report(f, url);
      if (!report.installable || !report.id) {
        throw new PluginInspectError(`not installable: ${report.refusal ?? "the manifest has no id"}`, 409);
      }
      const id = report.id;
      if (this.installing.has(id)) throw new PluginInspectError(`"${id}" is already being installed`, 409);
      this.installing.add(id);
      locked = id;
      if (report.installed && !replace) {
        throw new PluginInspectError(
          `"${id}" is already installed (v${report.installed.version ?? "?"}) — confirm the update to replace it`,
          409,
        );
      }
      let result;
      try {
        result = await addPlugin(this.opts.configDir, f.dir, { force: replace });
      } catch (err) {
        if (err instanceof CmError) throw new PluginInspectError(err.message, 409);
        throw err;
      }
      const plugin = await this.opts.noteInstalled(id);
      return {
        id,
        outcome: result.outcome === "replaced" ? "replaced" : "copied",
        sha: f.sha,
        needsRestart: true,
        ...(plugin ? { plugin } : {}),
      };
    } finally {
      if (locked) this.installing.delete(locked);
      await rm(f.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
