/**
 * Plugin install core — what `cm plugin …` does, as functions the server can
 * reuse (it imports discovery from here so the loader and the CLI cannot
 * disagree about what a plugin directory is).
 *
 * Everything is filesystem-only: no console, no `process.exit`. Expected
 * failures throw {@link CmError}; the command layer renders them.
 *
 * Plugins live in `<configDir>/plugins/<id>/`. The config root is the one
 * directory both Dispatch instances share and no upgrade replaces, so a plugin
 * installed once is seen by both and survives every publish
 * (docs/plugins.md → "Decisions already made").
 */
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR_NAME,
  PluginManifestSchema,
  pluginRangeAccepts,
  type PluginManifest,
  type PluginSettingsEntry,
} from "@dispatch/shared";
import { CmError } from "./manifest.js";

/* ------------------------------------------------------------- discovery */

/** One discovered directory, before enablement or activation is considered. */
export interface DiscoveredPlugin {
  /** The directory NAME — the id the host files the plugin under. */
  id: string;
  /** Absolute path of the plugin directory. */
  dir: string;
  manifest?: PluginManifest;
  /** Why `manifest` is absent, or why it cannot run on this host. */
  error?: string;
  /** The manifest parsed but its `dispatch` range excludes this host. */
  incompatible?: boolean;
  /** The parsed `settings` JSON Schema, when the manifest names one and it reads. */
  settingsSchema?: unknown;
  /** The directory is a junction/symlink (`cm plugin link`). */
  linked?: boolean;
}

/** `<configDir>/plugins`. */
export function pluginsRoot(configDir: string): string {
  return join(configDir, PLUGINS_DIR_NAME);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validate one plugin directory. `add` runs this on the candidate BEFORE
 * copying, so a broken manifest never reaches the root; the server runs it on
 * every directory it finds there.
 */
export async function readPluginDir(dir: string, expectedId?: string): Promise<DiscoveredPlugin> {
  const abs = resolve(dir);
  const id = expectedId ?? basename(abs);
  const out: DiscoveredPlugin = { id, dir: abs };
  try {
    out.linked = (await lstat(abs)).isSymbolicLink();
  } catch {
    /* reported below as an unreadable manifest */
  }
  let raw: string;
  try {
    raw = await readFile(join(abs, PLUGIN_MANIFEST_FILE), "utf8");
  } catch (err) {
    out.error = `cannot read ${PLUGIN_MANIFEST_FILE}: ${describe(err)}`;
    return out;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    out.error = `${PLUGIN_MANIFEST_FILE} is not valid YAML: ${describe(err)}`;
    return out;
  }
  const parsed = PluginManifestSchema.safeParse(doc);
  if (!parsed.success) {
    out.error = `${PLUGIN_MANIFEST_FILE}: ${parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")}`;
    return out;
  }
  const manifest = parsed.data;
  // The directory name IS the id everywhere the host files things — settings
  // key, route prefix, kv rows. A manifest claiming a different id would have
  // its state keyed two ways, so the mismatch is invalid rather than tolerated.
  if (expectedId && manifest.id !== expectedId) {
    out.error = `manifest id "${manifest.id}" does not match its directory "${expectedId}"`;
    return out;
  }
  out.manifest = manifest;
  if (!pluginRangeAccepts(manifest.dispatch, PLUGIN_API_VERSION)) {
    out.incompatible = true;
    out.error = `built for Dispatch plugin API ${JSON.stringify(manifest.dispatch)}; this host is ${PLUGIN_API_VERSION}`;
  }
  if (manifest.settings) {
    try {
      out.settingsSchema = JSON.parse(await readFile(join(abs, manifest.settings), "utf8"));
    } catch (err) {
      // A bad settings schema costs the plugin its form, not its activation —
      // a plugin that runs without settings is strictly more useful than one
      // refused over a stray comma in a file the host only renders.
      out.error = `settings schema ${manifest.settings} could not be read: ${describe(err)}`;
    }
  }
  return out;
}

/**
 * Every plugin directory under the root, sorted by id. A directory without a
 * manifest is skipped silently — the root may hold a README, a `.git`, or a
 * half-extracted download — but one WITH a manifest that fails is listed, so
 * the owner sees why in Settings instead of wondering where it went.
 */
export async function discoverPlugins(configDir: string): Promise<DiscoveredPlugin[]> {
  const root = pluginsRoot(configDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: DiscoveredPlugin[] = [];
  for (const name of names.sort()) {
    const dir = join(root, name);
    // `stat`, not `readdir`'s dirent: a linked plugin is a junction or
    // symlink, which `withFileTypes` reports as neither file nor directory on
    // Windows.
    let isDir = false;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    let hasManifest = false;
    try {
      hasManifest = (await stat(join(dir, PLUGIN_MANIFEST_FILE))).isFile();
    } catch {
      /* no manifest → not a plugin dir */
    }
    if (!hasManifest) continue;
    found.push(await readPluginDir(dir, name));
  }
  return found;
}

/* --------------------------------------------------------------- install */

/** What `add` and `link` report: the validated plugin and what it asked for. */
export interface InstallResult {
  plugin: DiscoveredPlugin;
  /** `copied` for `add`, `linked` for `link`, `replaced` when `--force` overwrote. */
  outcome: "copied" | "linked" | "replaced";
  /** Where it landed. */
  dir: string;
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], shell: false });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => reject(new CmError(`could not run ${cmd}: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new CmError(`${cmd} ${args[0]} failed (exit ${code}): ${err.trim()}`)),
    );
  });
}

/** Is `source` something `git clone` should handle rather than the filesystem? */
export function looksLikeGitUrl(source: string): boolean {
  return /^(https?|ssh|git):\/\//.test(source) || /^git@[^:]+:/.test(source) || source.endsWith(".git");
}

/**
 * Find the directory holding `plugin.yaml` inside a materialised source: the
 * root itself, or — for a tarball or clone that wraps its content in one
 * directory — the single child. Anything else is "no manifest found".
 */
async function manifestDirIn(root: string): Promise<string | null> {
  if (existsSync(join(root, PLUGIN_MANIFEST_FILE))) return root;
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  );
  if (entries.length === 1 && existsSync(join(root, entries[0]!.name, PLUGIN_MANIFEST_FILE))) {
    return join(root, entries[0]!.name);
  }
  return null;
}

/**
 * Materialise `source` — a directory, a `.tgz`/`.tar.gz`, or a git URL — into
 * a scratch dir and return the plugin directory inside it. The caller owns
 * cleanup of `scratch`.
 */
async function materialise(source: string): Promise<{ pluginDir: string; scratch?: string }> {
  if (looksLikeGitUrl(source)) {
    // `--` ends option parsing, so a source shaped like `--upload-pack=…` is a
    // URL git fails on rather than an option git obeys. The explicit refusal
    // is belt-and-braces for the same thing — a URL never starts with `-`.
    if (source.startsWith("-")) throw new CmError(`not a git URL: ${source}`);
    const scratch = await mkdtemp(join(tmpdir(), "cm-plugin-"));
    await run("git", ["clone", "--depth", "1", "--quiet", "--", source, join(scratch, "src")]);
    const dir = await manifestDirIn(join(scratch, "src"));
    if (!dir) throw new CmError(`no ${PLUGIN_MANIFEST_FILE} at the root of ${source}`);
    return { pluginDir: dir, scratch };
  }
  const abs = resolve(source);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new CmError(`no such file or directory: ${abs}`);
  }
  if (st.isDirectory()) {
    const dir = await manifestDirIn(abs);
    if (!dir) throw new CmError(`no ${PLUGIN_MANIFEST_FILE} in ${abs}`);
    return { pluginDir: dir };
  }
  if (/\.(tgz|tar\.gz|tar)$/i.test(abs)) {
    const scratch = await mkdtemp(join(tmpdir(), "cm-plugin-"));
    // `tar` ships with Windows 10+, macOS and every Linux; it is the one
    // archive tool that needs no dependency here.
    await run("tar", ["-xf", abs, "-C", scratch]);
    const dir = await manifestDirIn(scratch);
    if (!dir) throw new CmError(`no ${PLUGIN_MANIFEST_FILE} inside ${basename(abs)}`);
    return { pluginDir: dir, scratch };
  }
  throw new CmError(`${abs} is neither a directory, a .tgz/.tar.gz, nor a git URL`);
}

/** Validate a candidate or throw a {@link CmError} naming what is wrong. */
async function validated(pluginDir: string): Promise<DiscoveredPlugin> {
  const found = await readPluginDir(pluginDir);
  if (!found.manifest) throw new CmError(`${pluginDir}: ${found.error}`);
  if (found.incompatible) throw new CmError(`${found.manifest.id}: ${found.error}`);
  return found;
}

/** Whether something already occupies `<root>/<id>`, and what to do about it. */
async function claimSlot(root: string, id: string, force: boolean): Promise<boolean> {
  const target = join(root, id);
  let present = false;
  try {
    await lstat(target);
    present = true;
  } catch {
    /* free */
  }
  if (!present) return false;
  if (!force) {
    throw new CmError(`a plugin "${id}" is already installed at ${target} — re-run with --force to replace it`);
  }
  await removeEntry(target);
  return true;
}

/** Remove a plugin entry: a link is unlinked (its target untouched); a directory is deleted. */
async function removeEntry(target: string): Promise<void> {
  const st = await lstat(target);
  if (st.isSymbolicLink()) {
    // A Windows junction unlinks like a file in Node; a POSIX symlink too.
    try {
      await unlink(target);
    } catch {
      await rm(target, { recursive: false, force: true });
    }
    return;
  }
  await rm(target, { recursive: true, force: true });
}

/**
 * `cm plugin add`: copy a validated plugin into `<configDir>/plugins/<id>`.
 * Validated in the SOURCE first, so nothing invalid is ever on disk under the
 * root — a half-installed plugin would otherwise show as `invalid` in Settings
 * with no clue that the install itself was the problem.
 */
export async function addPlugin(
  configDir: string,
  source: string,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const { pluginDir, scratch } = await materialise(source);
  try {
    const found = await validated(pluginDir);
    const root = pluginsRoot(configDir);
    await mkdir(root, { recursive: true });
    // The MANIFEST id, never `found.id`: that is the source directory's name,
    // which is `src` for a clone, a random temp name for a tarball, and
    // whatever the author called their checkout. Claiming by that name would
    // skip the "already installed" check and let `--force` delete the wrong
    // plugin.
    const id = found.manifest!.id;
    const replaced = await claimSlot(root, id, !!opts.force);
    const target = join(root, id);
    // Copy to a sibling tmp dir and rename, so an interrupted copy never
    // leaves a half-plugin the loader would list as broken.
    const tmp = join(root, `.${id}.${process.pid}.tmp`);
    await rm(tmp, { recursive: true, force: true });
    // `.git` is history, not the plugin. `node_modules` is the author's build
    // environment: a scaffold links `@dispatch/plugin-sdk` into it, and with
    // `dereference: true` that symlink would be FOLLOWED — copying the SDK, its
    // workspace siblings and their dependencies into the config root. The
    // built `server/index.js` is self-contained by construction (the SDK's
    // preset inlines everything but Node's builtins), so nothing in
    // node_modules is needed at runtime.
    await cp(pluginDir, tmp, {
      recursive: true,
      dereference: true,
      filter: (p) => basename(p) !== ".git" && basename(p) !== "node_modules",
    });
    await rename(tmp, target);
    const plugin = await readPluginDir(target, id);
    return { plugin, outcome: replaced ? "replaced" : "copied", dir: target };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `cm plugin link`: point `<configDir>/plugins/<id>` at a working directory.
 * A junction on Windows (no privilege needed, unlike a symlink) and a symlink
 * elsewhere. Edits in the working dir are live on the next restart.
 */
export async function linkPlugin(
  configDir: string,
  source: string,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const abs = resolve(source);
  if (!existsSync(join(abs, PLUGIN_MANIFEST_FILE))) throw new CmError(`no ${PLUGIN_MANIFEST_FILE} in ${abs}`);
  const found = await validated(abs);
  const root = pluginsRoot(configDir);
  await mkdir(root, { recursive: true });
  // Manifest id, not the checkout's directory name — see `addPlugin`.
  const id = found.manifest!.id;
  const replaced = await claimSlot(root, id, !!opts.force);
  const target = join(root, id);
  await symlink(abs, target, process.platform === "win32" ? "junction" : "dir");
  const plugin = await readPluginDir(target, id);
  return { plugin, outcome: replaced ? "replaced" : "linked", dir: target };
}

/** `cm plugin remove`: delete the directory, or unlink it if it was linked. */
export async function removePlugin(configDir: string, id: string): Promise<{ removed: boolean; dir: string }> {
  const target = join(pluginsRoot(configDir), id);
  try {
    await lstat(target);
  } catch {
    return { removed: false, dir: target };
  }
  await removeEntry(target);
  return { removed: true, dir: target };
}

/* -------------------------------------------------------------- settings */

/**
 * Flip `AppSettings.plugins[id].enabled` in `<configDir>/config.json`.
 *
 * A read-modify-write of the whole file, atomic via tmp + rename, touching
 * only the one key. The server re-reads settings per request so the toggle is
 * visible at once; activation still needs a restart. Nothing else in the file
 * is interpreted — a config.json written by a newer server round-trips.
 */
export async function setPluginEnabled(configDir: string, id: string, enabled: boolean): Promise<void> {
  const file = join(configDir, "config.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if (existsSync(file)) throw new CmError(`could not read ${file}: ${describe(err)}`);
  }
  const plugins = { ...((current.plugins as Record<string, PluginSettingsEntry> | undefined) ?? {}) };
  plugins[id] = { ...plugins[id], enabled };
  const next = { ...current, plugins };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** The stored toggle for every plugin — absent means enabled. */
export async function readPluginToggles(configDir: string): Promise<Record<string, boolean>> {
  try {
    const raw = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as {
      plugins?: Record<string, PluginSettingsEntry>;
    };
    return Object.fromEntries(
      Object.entries(raw.plugins ?? {}).map(([id, entry]) => [id, entry?.enabled ?? true]),
    );
  } catch {
    return {};
  }
}

/** The consent summary `add` prints: what the plugin declared it will touch. */
export function consentLines(m: PluginManifest): string[] {
  const lines: string[] = [];
  lines.push(`${m.name} v${m.version} (${m.id})${m.description ? ` — ${m.description}` : ""}`);
  lines.push(`  runs: ${[m.server && "server code (in-process)", m.client && "client code (in your browser)"].filter(Boolean).join(", ") || "nothing (contributions only)"}`);
  if (m.capabilities?.length) lines.push(`  capabilities: ${m.capabilities.join(", ")}`);
  if (m.secrets?.length) lines.push(`  secrets it may read: ${m.secrets.join(", ")}`);
  const contributes = Object.keys(m.contributes ?? {});
  if (contributes.length) lines.push(`  contributes: ${contributes.join(", ")}`);
  if (m.oauth?.clients) lines.push(`  oauth clients: ${Object.keys(m.oauth.clients).join(", ")}`);
  return lines;
}
