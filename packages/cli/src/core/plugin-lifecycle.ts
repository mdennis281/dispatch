/**
 * `dispatch plugin update` and `dispatch plugin remove --purge` — the CLI half
 * of #409, offline like every other `dispatch plugin` command.
 *
 * The decisions (which commit a ref resolves to, what counts as an
 * escalation) are the shared ones the server uses, so the terminal and
 * Settings → Plugins cannot disagree about whether an update exists. What
 * differs is the fetch — a shallow `git clone` of the target ref, the way
 * `dispatch plugin add` has always fetched — and the diff's depth: the CLI has
 * no source scanner, so it compares the manifest and the contribution files
 * and leaves "hooks used" to the pane.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_CAPABILITY_LINES,
  PluginMcpServersFileSchema,
  PluginProcessesFileSchema,
  diffPluginSurfaces,
  parseLsRemote,
  resolveUpdateTarget,
  type PluginGitSource,
  type PluginOrigin,
  type PluginRefKind,
  type PluginSurface,
  type PluginUpdateDiff,
} from "@dispatch/shared";
import { CmError } from "./manifest.js";
import {
  addPlugin,
  discoverPlugins,
  readPluginDir,
  readPluginEntries,
  runOutput,
  setPluginSource,
  shallowClone,
  updatePluginEntry,
  type DiscoveredPlugin,
} from "./plugins.js";

/** The network, as a seam — tests hand in canned `ls-remote` output and a fake clone. */
export interface GitDeps {
  lsRemote: (cloneUrl: string) => Promise<string>;
  clone: (url: string, scratch: string, ref?: string) => Promise<{ root: string; sha: string; branch?: string }>;
}

export const realGitDeps: GitDeps = {
  lsRemote: (cloneUrl) => {
    if (cloneUrl.startsWith("-")) throw new CmError(`not a git URL: ${cloneUrl}`);
    return runOutput("git", ["ls-remote", "--symref", "--", cloneUrl]);
  },
  clone: shallowClone,
};

/* ---------------------------------------------------------------- surface */

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => !n.startsWith(".")).map((n) => n.replace(/\.(md|ya?ml|json)$/i, "")).sort();
  } catch {
    return [];
  }
}

async function readYaml(path: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(path, "utf8")) ?? {};
  } catch {
    return undefined;
  }
}

/**
 * What a plugin directory declares, in the shape the shared diff compares —
 * the manifest plus its contribution files, no code scan (`hooks: []`).
 * Applied to both sides of an update, so it only has to be consistent with
 * itself.
 */
export async function pluginSurface(dir: string): Promise<PluginSurface> {
  const found = await readPluginDir(dir);
  const m = found.manifest;
  if (!m) throw new CmError(`${dir}: ${found.error}`);
  const c = m.contributes ?? {};
  const mcp = c.mcpServers ? PluginMcpServersFileSchema.safeParse(await readYaml(join(dir, c.mcpServers))) : undefined;
  const procs = c.processes ? PluginProcessesFileSchema.safeParse(await readYaml(join(dir, c.processes))) : undefined;
  return {
    version: m.version,
    capabilities: (m.capabilities ?? []).map((name) => ({ name, line: PLUGIN_CAPABILITY_LINES[name], used: null })),
    secrets: m.secrets ?? [],
    oauth: Object.entries(m.oauth?.clients ?? {}).map(([name, cl]) => {
      let provider = cl.authorizationUrl;
      try {
        provider = new URL(cl.authorizationUrl).host;
      } catch {
        /* the schema already required a URL */
      }
      return { name, provider, scopes: cl.scopes ?? [] };
    }),
    contributions: {
      modes: c.modes ? await listNames(join(dir, c.modes)) : [],
      skills: c.skills ? await listNames(join(dir, c.skills)) : [],
      instructions: c.instructions ? await listNames(join(dir, c.instructions)) : [],
      personas: c.personas ? await listNames(join(dir, c.personas)) : [],
      mcpServers: mcp?.success
        ? mcp.data.map((s) => {
            const t = s.transport as Record<string, unknown> & { type: string };
            return {
              name: s.name,
              transport: t.type,
              ...(typeof t.command === "string" ? { command: t.command } : {}),
              ...(Array.isArray(t.args) ? { args: t.args as string[] } : {}),
              ...(typeof t.url === "string" ? { url: t.url } : {}),
            };
          })
        : [],
      processes: procs?.success
        ? procs.data.map((p) => ({
            id: p.id,
            command: p.command,
            ...(p.args?.length ? { args: p.args } : {}),
            autostart: !!p.autostart,
            singleton: !!p.singleton,
          }))
        : [],
    },
    mismatches: { undeclared: [], unused: [] },
    hooks: [],
    entries: {
      ...(m.server ? { server: { path: m.server, present: existsSync(join(dir, m.server)) } } : {}),
      ...(m.client ? { client: { path: m.client, present: existsSync(join(dir, m.client)) } } : {}),
    },
  };
}

/* ------------------------------------------------------------------ check */

export interface CliUpdateCheck {
  id: string;
  origin: PluginOrigin;
  status: "available" | "up-to-date" | "pinned" | "unsupported" | "error";
  message?: string;
  current?: { ref: string; refKind: PluginRefKind; sha: string; version?: string };
  target?: { ref: string; sha: string; version?: string };
  diff?: PluginUpdateDiff;
  /** False when the target cannot replace this plugin (invalid, incompatible, a different id). */
  installable?: boolean;
}

interface Staged {
  scratch: string;
  dir: string;
}

function originOf(p: DiscoveredPlugin, source: PluginGitSource | { type: "local" } | undefined): PluginOrigin {
  // Built-ins live in the app payload, which this CLI never discovers.
  if (p.linked) return "linked";
  if (source?.type === "git") return "url";
  if (source?.type === "local") return "local";
  return "unknown";
}

const UNSUPPORTED: Partial<Record<PluginOrigin, string>> = {
  builtin: "built-in — it updates with Dispatch",
  linked: "linked to a working directory — update it there",
  local: "copied from a local path — there is no remote to check",
  unknown: "source unknown — install it again from its git URL to get updates",
};

async function checkOne(
  configDir: string,
  plugin: DiscoveredPlugin,
  source: PluginGitSource | undefined,
  origin: PluginOrigin,
  deps: GitDeps,
  keep: boolean,
): Promise<{ check: CliUpdateCheck; staged?: Staged }> {
  const id = plugin.id;
  if (!source) return { check: { id, origin, status: "unsupported", message: UNSUPPORTED[origin] } };
  const current = {
    ref: source.ref,
    refKind: source.refKind,
    sha: source.sha,
    ...(plugin.manifest?.version ? { version: plugin.manifest.version } : {}),
  };
  const base = { id, origin, current };
  if (source.refKind === "sha") return { check: { ...base, status: "pinned", message: `pinned to ${source.sha.slice(0, 7)}` } };
  let target;
  try {
    target = resolveUpdateTarget(source, parseLsRemote(await deps.lsRemote(source.cloneUrl)));
  } catch (err) {
    return { check: { ...base, status: "error", message: err instanceof Error ? err.message : String(err) } };
  }
  if (target.status === "gone") return { check: { ...base, status: "error", message: target.message } };
  if (target.status === "pinned") return { check: { ...base, status: "pinned" } };
  if (target.status === "up-to-date") {
    return { check: { ...base, status: "up-to-date", ...(target.note ? { message: target.note } : {}) } };
  }
  const scratch = await mkdtemp(join(tmpdir(), "cm-plugin-update-"));
  try {
    const clone = await deps.clone(source.cloneUrl, scratch, target.ref);
    // A branch can move between ls-remote and clone; what was CLONED is what
    // gets diffed and installed, so that is the target from here on. A tag
    // that resolves differently the second time is not trusted at all.
    if (clone.sha !== target.sha && source.refKind === "tag") {
      throw new CmError(`tag ${target.ref} resolved to ${target.sha.slice(0, 7)} but cloned ${clone.sha.slice(0, 7)}`);
    }
    const dir = source.subdir ? join(clone.root, ...source.subdir.split("/")) : clone.root;
    const next = await readPluginDir(dir);
    const refusal = !next.manifest
      ? `the plugin at ${clone.sha.slice(0, 7)} is invalid: ${next.error}`
      : next.manifest.id !== id
        ? `the plugin at ${clone.sha.slice(0, 7)} is "${next.manifest.id}", not "${id}"`
        : next.incompatible
          ? `the plugin at ${clone.sha.slice(0, 7)} is incompatible: ${next.error}`
          : undefined;
    const check: CliUpdateCheck = {
      ...base,
      status: "available",
      target: { ref: target.ref, sha: clone.sha, ...(next.manifest?.version ? { version: next.manifest.version } : {}) },
      installable: !refusal,
      ...(refusal || target.note ? { message: [target.note, refusal].filter(Boolean).join("; ") } : {}),
    };
    if (!refusal) check.diff = diffPluginSurfaces(await pluginSurface(plugin.dir), await pluginSurface(dir));
    if (keep && !refusal) return { check, staged: { scratch, dir } };
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    return { check };
  } catch (err) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    return { check: { ...base, status: "error", message: err instanceof Error ? err.message : String(err) } };
  }
}

async function targets(configDir: string, id?: string) {
  const [plugins, entries] = await Promise.all([discoverPlugins(configDir), readPluginEntries(configDir)]);
  const picked = id ? plugins.filter((p) => p.id === id) : plugins;
  if (id && !picked.length) throw new CmError(`No plugin "${id}" in ${configDir}.`);
  return picked.map((p) => {
    const source = entries[p.id]?.source;
    const origin = originOf(p, source);
    return { plugin: p, origin, source: origin === "url" && source?.type === "git" ? source : undefined };
  });
}

/** `dispatch plugin update --check [<id>]`: one result per plugin, nothing installed. */
export async function checkPluginUpdates(
  configDir: string,
  opts: { id?: string; deps?: GitDeps } = {},
): Promise<CliUpdateCheck[]> {
  const out: CliUpdateCheck[] = [];
  for (const t of await targets(configDir, opts.id)) {
    out.push((await checkOne(configDir, t.plugin, t.source, t.origin, opts.deps ?? realGitDeps, false)).check);
  }
  return out;
}

export interface CliUpdateOutcome extends CliUpdateCheck {
  /** Installed by this run. */
  updated?: boolean;
}

/**
 * `dispatch plugin update [<id>]`: check, and install every available update
 * through `addPlugin` — the same validate / claim / copy / rename as `add`.
 * An update that ESCALATES (new capabilities, secrets, OAuth clients, MCP
 * servers, processes…) is not installed without `acceptEscalations`: on a
 * fresh install the owner reads the consent lines first, and an update must
 * not be the way round that.
 *
 * Only the directory is replaced. Settings, the toggle, kv, secrets and OAuth
 * tokens are keyed by the id outside it, so they carry over untouched.
 */
export async function updatePlugins(
  configDir: string,
  opts: { id?: string; deps?: GitDeps; acceptEscalations?: boolean } = {},
): Promise<CliUpdateOutcome[]> {
  const out: CliUpdateOutcome[] = [];
  for (const t of await targets(configDir, opts.id)) {
    const { check, staged } = await checkOne(configDir, t.plugin, t.source, t.origin, opts.deps ?? realGitDeps, true);
    if (!staged) {
      out.push(check);
      continue;
    }
    try {
      if (check.diff?.escalations.length && !opts.acceptEscalations) {
        out.push({ ...check, message: "asks for more than the installed version — re-run with --yes to accept" });
        continue;
      }
      await addPlugin(configDir, staged.dir, { force: true });
      // addPlugin saw a local directory (the clone); what is recorded is the
      // git source, advanced to the commit that was installed.
      await setPluginSource(configDir, t.plugin.id, {
        ...t.source!,
        ref: check.target!.ref,
        sha: check.target!.sha,
        installedAt: Date.now(),
      });
      out.push({ ...check, updated: true });
    } finally {
      await rm(staged.scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  return out;
}

/* ------------------------------------------------------------------ purge */

export interface PurgeResult {
  settings: boolean;
  /** Global secrets deleted. */
  secrets: string[];
  /** Listed by another installed plugin too, so kept. */
  sharedSecrets: string[];
  /** This instance's rows, when its data dir was known. */
  kvKeys?: number;
  oauth?: string[];
  /** Why the per-instance rows were not touched. */
  stateSkipped?: string;
}

/**
 * Everything keyed by the plugin id OUTSIDE its directory: the config entry,
 * the global secrets its manifest listed (unless another plugin lists them
 * too), and — given a data dir — that instance's kv rows and OAuth tokens.
 * Run after the directory is gone; `manifestSecrets` is read before.
 */
export async function purgePluginData(
  configDir: string,
  id: string,
  opts: { manifestSecrets: string[]; dataDir?: string },
): Promise<PurgeResult> {
  const entries = await readPluginEntries(configDir);
  const settings = !!entries[id];
  await updatePluginEntry(configDir, id, () => undefined);

  const others = new Set(
    (await discoverPlugins(configDir)).filter((p) => p.id !== id).flatMap((p) => p.manifest?.secrets ?? []),
  );
  const sharedSecrets = opts.manifestSecrets.filter((n) => others.has(n));
  const doomed = new Set(opts.manifestSecrets.filter((n) => !others.has(n)));
  const secrets: string[] = [];
  const file = join(configDir, "secrets.json");
  if (doomed.size && existsSync(file)) {
    // Names are stored in clear beside each encrypted value, so a delete
    // needs no key. Same tmp + rename the server's store writes with; the
    // server re-checks the file's mtime on every read and picks this up.
    const doc = JSON.parse(await readFile(file, "utf8")) as { version: number; entries: Array<{ name: string; scope: string }> };
    const kept = doc.entries.filter((e) => {
      const drop = e.scope === "global" && doomed.has(e.name);
      if (drop) secrets.push(e.name);
      return !drop;
    });
    if (secrets.length) {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ ...doc, entries: kept }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    }
  }

  const result: PurgeResult = { settings, secrets, sharedSecrets };
  const db = opts.dataDir ? join(opts.dataDir, "state.db") : undefined;
  if (!db || !existsSync(db)) {
    result.stateSkipped = opts.dataDir
      ? `no state.db in ${opts.dataDir}`
      : "kv and OAuth tokens are per instance — pass --data-dir (or set DISPATCH_DATA_DIR) to purge them too";
    return result;
  }
  // `node:sqlite` is what the server opens the same file with; WAL lets this
  // run beside a live server, whose writes serialize with these.
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(db);
  try {
    conn.exec("PRAGMA busy_timeout = 5000");
    result.kvKeys = Number((conn.prepare("SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin = ?").get(id) as { n: number }).n);
    result.oauth = (conn.prepare("SELECT name FROM plugin_oauth_token WHERE plugin = ?").all(id) as Array<{ name: string }>).map(
      (r) => r.name,
    );
    conn.prepare("DELETE FROM plugin_kv WHERE plugin = ?").run(id);
    conn.prepare("DELETE FROM plugin_oauth_token WHERE plugin = ?").run(id);
  } finally {
    conn.close();
  }
  return result;
}
