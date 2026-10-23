/**
 * Inspect a plugin at a git URL, install exactly what was inspected, and —
 * once installed — check its recorded source for updates and apply one.
 * See docs/plugins.md → "Inspecting a plugin before installing it" and
 * "Updating and uninstalling".
 *
 * Install is the SAME `addPlugin` `dispatch plugin add` runs — validate in the
 * source, claim the slot, copy to a sibling tmp dir without `.git` /
 * `node_modules`, rename into place. The only thing that differs is how the
 * source directory came to exist: here it is the confined extraction of the
 * pinned sha, never a `git clone` of a branch tip that may have moved since
 * the owner read the report. Update is that same path again, pinned to the
 * commit Check showed.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PLUGIN_ID_PATTERN,
  diffPluginSurfaces,
  resolveUpdateTarget,
  type PluginGitSource,
  type PluginInfo,
  type PluginInspection,
  type PluginUpdateCheck,
  type PluginUpdateResult,
  type UpdateTarget,
} from "@dispatch/shared";
import { CmError, addPlugin } from "@dispatch/cli/core";
import { pluginsRoot, readPluginDir } from "../manifest.js";
import {
  DEFAULT_FETCH_LIMITS,
  fetchPlugin,
  listRefs,
  realFetchDeps,
  type FetchDeps,
  type FetchLimits,
  type FetchedPlugin,
} from "./fetch.js";
import { inspectPluginDir, type InstalledLookup } from "./inspect.js";
import { PluginInspectError, parsePluginUrl } from "./url.js";

export { PluginInspectError } from "./url.js";
export { DEFAULT_FETCH_LIMITS, type FetchDeps, type FetchLimits } from "./fetch.js";

export interface PluginInspectorOptions {
  configDir: string;
  /** The host's view of a plugin — status, the restart flag, origin and recorded source — when one is loaded. */
  hostInfo: (id: string) => PluginInfo | undefined;
  /** Tell the host a directory changed under it, so the pane can say "restart to load it". */
  noteInstalled: (id: string) => Promise<PluginInfo | undefined>;
  /**
   * Write `AppSettings.plugins[id].source` — host-owned config, never the
   * plugin directory. Called after the files are in place and BEFORE
   * `noteInstalled`, so the row that comes back already carries it.
   */
  recordSource: (id: string, source: PluginGitSource) => Promise<void>;
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
    try {
      return await this.installFetched(f, url, { replace });
    } finally {
      await rm(f.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The one install path, shared by Install and Update: report, refuse,
   * `addPlugin`, record the source, tell the host. `expectId` is Update's
   * guard against a repository whose plugin at the new commit has a
   * different id — that would install a second plugin, not update this one.
   */
  private async installFetched(
    f: FetchedPlugin,
    url: string,
    opts: { replace: boolean; expectId?: string },
  ): Promise<PluginInstallOutcome> {
    const report = await this.report(f, url);
    if (!report.installable || !report.id) {
      throw new PluginInspectError(`not installable: ${report.refusal ?? "the manifest has no id"}`, 409);
    }
    const id = report.id;
    if (opts.expectId && id !== opts.expectId) {
      throw new PluginInspectError(
        `the plugin at ${f.sha.slice(0, 7)} is "${id}", not "${opts.expectId}" — refusing to update one plugin into another`,
        409,
      );
    }
    if (this.installing.has(id)) throw new PluginInspectError(`"${id}" is already being installed`, 409);
    this.installing.add(id);
    try {
      if (report.installed && !opts.replace) {
        throw new PluginInspectError(
          `"${id}" is already installed (v${report.installed.version ?? "?"}) — confirm the update to replace it`,
          409,
        );
      }
      if (this.opts.hostInfo(id)?.origin === "builtin") {
        throw new PluginInspectError(`"${id}" is built into Dispatch and updates with it`, 409);
      }
      let result;
      try {
        result = await addPlugin(this.opts.configDir, f.dir, { force: opts.replace });
      } catch (err) {
        if (err instanceof CmError) throw new PluginInspectError(err.message, 409);
        throw err;
      }
      await this.opts.recordSource(id, {
        type: "git",
        url,
        cloneUrl: f.parsed.cloneUrl,
        ref: f.ref,
        refKind: f.refKind,
        subdir: f.subdir,
        sha: f.sha,
        installedAt: Date.now(),
      });
      const plugin = await this.opts.noteInstalled(id);
      return {
        id,
        outcome: result.outcome === "replaced" ? "replaced" : "copied",
        sha: f.sha,
        needsRestart: true,
        ...(plugin ? { plugin } : {}),
      };
    } finally {
      this.installing.delete(id);
    }
  }

  /* ------------------------------------------------------------ updates */

  /** The recorded git source, or the sentence saying why there is nothing to check. */
  private gitSource(id: string): { info: PluginInfo; source?: PluginGitSource; reason?: string } {
    const info = this.opts.hostInfo(id);
    if (!info) throw new PluginInspectError(`no plugin "${id}"`, 404);
    const reason =
      info.origin === "builtin"
        ? "Built-in — it updates with Dispatch."
        : info.origin === "linked"
          ? "Linked to a working directory — update it there and restart."
          : info.origin === "local"
            ? `Copied from ${info.source?.type === "local" ? info.source.path : "a local path"} — there is no remote to check. Add it again to update it.`
            : info.source?.type !== "git"
              ? "Source unknown — installed by hand or before Dispatch recorded where plugins come from. Install it again from its URL to get updates."
              : undefined;
    return reason ? { info, reason } : { info, source: info.source as PluginGitSource };
  }

  private async resolveTarget(source: PluginGitSource): Promise<UpdateTarget> {
    const limits = this.opts.limits ?? DEFAULT_FETCH_LIMITS;
    const remote = await listRefs(
      parsePluginUrl(source.url),
      this.opts.fetchDeps ?? realFetchDeps,
      AbortSignal.timeout(limits.timeoutMs),
    );
    return resolveUpdateTarget(source, remote);
  }

  private fetchTarget(source: PluginGitSource, ref: string, sha: string): Promise<FetchedPlugin> {
    // `url` stays what the owner first gave; the ref and subdir travel in
    // `target`, so a /tree/v1.0.0/… URL updated to v1.1.0 fetches v1.1.0.
    return fetchPlugin(source.url, {
      target: { ref, refKind: source.refKind, sha, subdir: source.subdir },
      limits: this.opts.limits,
      deps: this.opts.fetchDeps,
    });
  }

  /**
   * Manual only — nothing polls. Resolves the recorded ref against the remote
   * and, when it points somewhere new, fetches and reports on THAT commit and
   * diffs it against the installed copy (scanned in place, so "hooks used"
   * compares like with like). A network failure is a row result (`error`),
   * not a 5xx: Check all must keep going past one unreachable repository.
   */
  async checkUpdate(id: string): Promise<PluginUpdateCheck> {
    const checkedAt = Date.now();
    const { info, source, reason } = this.gitSource(id);
    if (!source) return { id, status: "unsupported", origin: info.origin, message: reason, checkedAt };
    const current = {
      ref: source.ref,
      refKind: source.refKind,
      sha: source.sha,
      ...(info.version ? { version: info.version } : {}),
    };
    const base = { id, origin: info.origin, current, checkedAt };
    if (source.refKind === "sha") {
      return { ...base, status: "pinned", message: `Pinned to commit ${source.sha.slice(0, 7)} — nothing newer to follow.` };
    }
    let t: UpdateTarget;
    try {
      t = await this.resolveTarget(source);
    } catch (err) {
      if (err instanceof PluginInspectError) return { ...base, status: "error", message: err.message };
      throw err;
    }
    if (t.status === "gone") return { ...base, status: "error", message: t.message };
    if (t.status === "pinned") return { ...base, status: "pinned" };
    if (t.status === "up-to-date") return { ...base, status: "up-to-date", ...(t.note ? { message: t.note } : {}) };
    let f: FetchedPlugin;
    try {
      f = await this.fetchTarget(source, t.ref, t.sha);
    } catch (err) {
      if (err instanceof PluginInspectError) {
        return { ...base, status: "error", target: { ref: t.ref, sha: t.sha }, message: err.message };
      }
      throw err;
    }
    try {
      const inspection = await this.report(f, source.url);
      const installed = await inspectPluginDir(info.dir, {
        source: {
          url: source.url,
          host: f.parsed.host,
          repo: f.parsed.repo,
          cloneUrl: source.cloneUrl,
          ref: source.ref,
          sha: source.sha,
          subdir: source.subdir,
        },
        fetched: { files: 0, bytes: 0, skipped: [] },
      });
      const notes = [
        t.note,
        inspection.id && inspection.id !== id
          ? `the plugin at this commit is "${inspection.id}", not "${id}" — it cannot update this one`
          : undefined,
        !inspection.installable ? `cannot update: ${inspection.refusal}` : undefined,
      ].filter(Boolean);
      return {
        ...base,
        status: "available",
        target: { ref: t.ref, sha: t.sha, ...(inspection.version ? { version: inspection.version } : {}) },
        diff: diffPluginSurfaces(installed, inspection),
        inspection,
        ...(notes.length ? { message: notes.join("; ") } : {}),
      };
    } finally {
      await rm(f.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Install the commit Check showed, through the same path as Install, pinned
   * to `sha`. The ref is resolved AGAIN first and a mismatch is refused: the
   * owner consented to the diff of one commit, and a push since then would
   * otherwise land code nobody looked at.
   *
   * Settings, the enabled flag, kv, secrets and OAuth grants are all keyed by
   * the plugin id OUTSIDE its directory, so replacing the directory keeps
   * every one of them — nothing here has to carry them across.
   */
  async update(id: string, sha: string): Promise<PluginUpdateResult> {
    const { source, reason } = this.gitSource(id);
    if (!source) throw new PluginInspectError(reason!, 409);
    if (source.refKind === "sha") throw new PluginInspectError(`"${id}" is pinned to ${source.sha.slice(0, 7)}`, 409);
    const t = await this.resolveTarget(source);
    if (t.status === "gone") throw new PluginInspectError(t.message, 409);
    if (t.status !== "available") throw new PluginInspectError(`"${id}" is already up to date`, 409);
    if (t.sha !== sha) {
      throw new PluginInspectError(
        `${t.ref} has moved to ${t.sha.slice(0, 7)} since you checked (${sha.slice(0, 7)}) — check again to review what changed`,
        409,
      );
    }
    const f = await this.fetchTarget(source, t.ref, sha);
    try {
      const res = await this.installFetched(f, source.url, { replace: true, expectId: id });
      return {
        id,
        fromSha: source.sha,
        sha: res.sha,
        ref: f.ref,
        needsRestart: true,
        ...(res.plugin ? { plugin: res.plugin } : {}),
      };
    } finally {
      await rm(f.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}
