/**
 * Plugin install core — what `dispatch plugin …` does, as functions the server can
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
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_API_VERSION,
  PLUGIN_COLLECTION_FILE,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR_NAME,
  PluginManifestSchema,
  listCollection,
  normaliseCollectionPath,
  pluginRangeAccepts,
  type PluginManifest,
  type PluginSettingsEntry,
  type PluginSource,
  grantedPluginCapabilities,
  optionalPluginCapabilities,
  ignoredOptionalCapabilitiesNote,
  pluginDependencyLine,
  pluginProvidesLine,
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
  /** The directory is a junction/symlink (`dispatch plugin link`). */
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
  return discoverPluginsAt(pluginsRoot(configDir));
}

/**
 * Every plugin directory directly under `root`. Split from
 * {@link discoverPlugins} so the host can read its BUILT-IN plugins — which
 * ship in the app payload, not under the config dir — with the same validation
 * an installed plugin gets.
 */
export async function discoverPluginsAt(root: string): Promise<DiscoveredPlugin[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: DiscoveredPlugin[] = [];
  for (const name of names.sort()) {
    // `.<id>.<pid>.tmp` / `.old` are an install mid-swap (see `swapInto`). A
    // boot that lands in that window must not list them as a second, invalid
    // copy of the plugin whose manifest id does not match its directory.
    if (name.startsWith(".")) continue;
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
  /** What the `check` passed to `addPlugin` had to say without refusing. */
  warnings?: string[];
  /** `copied` for `add`, `linked` for `link`, `replaced` when `--force` overwrote. */
  outcome: "copied" | "linked" | "replaced";
  /** Where it landed. */
  dir: string;
  /**
   * What the CALLER should record as `AppSettings.plugins[id].source`. Not
   * written here: the server installs through this function from a scratch
   * extraction and records the git URL it fetched from instead, through its
   * own settings store.
   */
  source?: PluginSource;
}

/**
 * Run a command; resolve with its stdout.
 *
 * Git keeps the owner's credential helpers and prompts here — unlike the
 * server's fetch, which turns them off because nobody is at its terminal. A
 * CLI user installing from a private repo authenticates exactly as they would
 * for `git clone`.
 */
export function runOutput(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => reject(new CmError(`could not run ${cmd}: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolvePromise(out) : reject(new CmError(`${cmd} ${args[0]} failed (exit ${code}): ${err.trim()}`)),
    );
  });
}

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  await runOutput(cmd, args, cwd);
}

/**
 * Shallow-clone `url` (at `ref` when given — a branch or a tag) into
 * `<scratch>/src` and say which commit landed and which branch that was.
 * `--` ends option parsing, so a URL shaped like `--upload-pack=…` is one git
 * fails on rather than an option git obeys; the explicit `-` refusal is
 * belt-and-braces for the same thing.
 */
export async function shallowClone(
  url: string,
  scratch: string,
  ref?: string,
): Promise<{ root: string; sha: string; branch?: string }> {
  if (url.startsWith("-")) throw new CmError(`not a git URL: ${url}`);
  if (ref?.startsWith("-")) throw new CmError(`not a ref: ${ref}`);
  const root = join(scratch, "src");
  await run("git", ["clone", "--depth", "1", "--quiet", ...(ref && ref !== "HEAD" ? ["--branch", ref] : []), "--", url, root]);
  const sha = (await runOutput("git", ["-C", root, "rev-parse", "HEAD"])).trim();
  // Empty on a detached HEAD — which is what cloning a TAG gives.
  const branch = (await runOutput("git", ["-C", root, "symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  return { root, sha, ...(branch ? { branch } : {}) };
}

/**
 * `https://user:token@host/r.git` → `https://host/r.git`. Anything that is not
 * a parseable URL (`git@host:o/r.git`, a local `*.git` path) carries no
 * secret in that position and is returned as-is.
 */
export function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
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

/** One plugin of a collection, as `dispatch plugin add` lists it. */
export interface CollectionMember {
  /** Relative to the collection root — what `--plugin` takes. */
  path: string;
  id?: string;
  version?: string;
  name?: string;
  /**
   * The member's manifest when it validates — what `add` plans dependencies
   * from (provider first, `--with-deps`) before installing anything.
   */
  manifest?: PluginManifest;
}

/**
 * The plugins in `root` by the same rules the server's Inspect uses
 * (`listCollection` in @dispatch/shared): `dispatch-plugins.yaml` when there
 * is one, else every directory holding a `plugin.yaml`, outermost first.
 */
export async function collectionIn(root: string): Promise<{ members: CollectionMember[]; errors: string[] }> {
  let manifest: unknown;
  const errors: string[] = [];
  try {
    manifest = parseYaml(await readFile(join(root, PLUGIN_COLLECTION_FILE), "utf8")) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${PLUGIN_COLLECTION_FILE}: ${describe(err)}`);
  }
  const found: string[] = [];
  // Depth-bounded: a collection is a directory of plugin directories, not a
  // whole monorepo to crawl.
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (existsSync(join(dir, PLUGIN_MANIFEST_FILE))) found.push(rel);
    if (depth >= 4) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk(root, "", 0);
  const listing = listCollection(manifest, found);
  const members: CollectionMember[] = [];
  for (const path of listing.members) {
    const m: CollectionMember = { path };
    try {
      const y = parseYaml(await readFile(join(root, ...path.split("/").filter(Boolean), PLUGIN_MANIFEST_FILE), "utf8")) as Record<string, unknown>;
      if (typeof y?.id === "string") m.id = y.id;
      if (typeof y?.version === "string") m.version = y.version;
      if (typeof y?.name === "string") m.name = y.name;
      const parsed = PluginManifestSchema.safeParse(y);
      if (parsed.success) m.manifest = parsed.data;
    } catch {
      /* listed, but no readable plugin.yaml — the install of it will say why */
    }
    members.push(m);
  }
  return { members, errors: [...errors, ...listing.manifestErrors] };
}

function memberLines(members: CollectionMember[]): string {
  return members
    .map((m) => `  ${m.path || "."}${m.id ? `  (${m.id}${m.version ? ` v${m.version}` : ""})` : ""}`)
    .join("\n");
}

/**
 * The plugin directory to install out of a materialised `root`. Without
 * `member` that is the root's own plugin; a root with none but plugins below
 * it is a COLLECTION, refused with its members listed, because picking one
 * for the owner would install code they never named. `member` is a path relative to the
 * root, or a member's plugin id.
 */
async function pickPluginDir(root: string, member: string | undefined, what: string): Promise<string | null> {
  if (member === undefined) {
    const dir = await manifestDirIn(root);
    if (dir) return dir;
    const { members } = await collectionIn(root);
    if (!members.length) return null;
    throw new CmError(
      `${what} holds ${members.length} plugin${members.length === 1 ? "" : "s"} — pick with --plugin <path|id> (repeatable) or --all:\n${memberLines(members)}`,
    );
  }
  const n = normaliseCollectionPath(member);
  if (!("error" in n)) {
    const dir = join(root, ...n.path.split("/").filter(Boolean));
    if (existsSync(join(dir, PLUGIN_MANIFEST_FILE))) return dir;
  }
  const { members } = await collectionIn(root);
  const byId = members.find((m) => m.id === member);
  if (byId) return join(root, ...byId.path.split("/").filter(Boolean));
  throw new CmError(
    `no plugin "${member}" in ${what}` + (members.length ? ` — it holds:\n${memberLines(members)}` : ""),
  );
}

/**
 * Bring `source` — a directory, a `.tgz`/`.tar.gz`, or a git URL — onto disk
 * and say where its root is, plus how to record a plugin taken from inside it.
 * The caller owns cleanup of `scratch`.
 */
async function sourceRoot(
  source: string,
): Promise<{ root: string; scratch?: string; what: string; record: (pluginDir: string) => PluginSource }> {
  const installedAt = Date.now();
  if (looksLikeGitUrl(source)) {
    const scratch = await mkdtemp(join(tmpdir(), "cm-plugin-"));
    try {
      const clone = await shallowClone(source, scratch);
      return {
        root: clone.root,
        scratch,
        what: source,
        // The default branch, followed: `dispatch plugin update` checks its tip.
        record: (dir) => ({
          type: "git",
          // Never a token: the record is served by `GET /api/plugins` and shown
          // on the row. A private repo then authenticates through the owner's
          // credential helper on update, as it would for any `git fetch`.
          url: withoutCredentials(source),
          cloneUrl: withoutCredentials(source),
          ref: clone.branch ?? "HEAD",
          refKind: "branch",
          subdir: relative(clone.root, dir).split(sep).join("/"),
          sha: clone.sha,
          installedAt,
        }),
      };
    } catch (err) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  const abs = resolve(source);
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new CmError(`no such file or directory: ${abs}`);
  }
  if (st.isDirectory()) {
    return { root: abs, what: abs, record: () => ({ type: "local", path: abs, installedAt }) };
  }
  if (/\.(tgz|tar\.gz|tar)$/i.test(abs)) {
    const scratch = await mkdtemp(join(tmpdir(), "cm-plugin-"));
    // `tar` ships with Windows 10+, macOS and every Linux; it is the one
    // archive tool that needs no dependency here.
    await run("tar", ["-xf", abs, "-C", scratch]);
    return { root: scratch, scratch, what: basename(abs), record: () => ({ type: "local", path: abs, installedAt }) };
  }
  throw new CmError(`${abs} is neither a directory, a .tgz/.tar.gz, nor a git URL`);
}

/**
 * Materialise `source` into a scratch dir and return the plugin directory
 * inside it — `member` picks one out of a collection. The caller owns cleanup
 * of `scratch`.
 */
async function materialise(
  source: string,
  member?: string,
): Promise<{ pluginDir: string; scratch?: string; source: PluginSource }> {
  const got = await sourceRoot(source);
  try {
    const dir = await pickPluginDir(got.root, member, got.what);
    if (!dir) {
      throw new CmError(
        looksLikeGitUrl(source)
          ? `no ${PLUGIN_MANIFEST_FILE} at the root of ${source}`
          : got.scratch
            ? `no ${PLUGIN_MANIFEST_FILE} inside ${got.what}`
            : `no ${PLUGIN_MANIFEST_FILE} in ${got.what}`,
      );
    }
    return { pluginDir: dir, ...(got.scratch ? { scratch: got.scratch } : {}), source: got.record(dir) };
  } catch (err) {
    if (got.scratch) await rm(got.scratch, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** `dispatch plugin add <collection> --all`: every member of the collection at `source`. */
export async function listCollectionMembers(source: string): Promise<CollectionMember[]> {
  const got = await sourceRoot(source);
  try {
    return (await collectionIn(got.root)).members;
  } finally {
    if (got.scratch) await rm(got.scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * sha256 over a plugin directory's files: sorted relative paths, each with
 * the sha256 of its bytes. Skips exactly what an install leaves behind
 * (`.git`, `node_modules`, at any depth) and follows no links, so the
 * extracted source, the installed copy and a later fetch of an unchanged
 * directory all hash the same. Recorded as `PluginGitSource.contentHash`.
 */
export async function hashPluginTree(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), childRel);
      else if (e.isFile()) files.push(childRel);
    }
  };
  await walk(dir, "");
  // Code-unit order, not localeCompare: the hash must not depend on the
  // machine's locale.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const outer = createHash("sha256");
  for (const rel of files) {
    const inner = createHash("sha256").update(await readFile(join(dir, ...rel.split("/")))).digest("hex");
    outer.update(`${rel}\0${inner}\n`);
  }
  return outer.digest("hex");
}

/** Validate a candidate or throw a {@link CmError} naming what is wrong. */
async function validated(pluginDir: string): Promise<DiscoveredPlugin> {
  const found = await readPluginDir(pluginDir);
  if (!found.manifest) throw new CmError(`${pluginDir}: ${found.error}`);
  if (found.incompatible) throw new CmError(`${found.manifest.id}: ${found.error}`);
  return found;
}

/**
 * Whether something already occupies `<root>/<id>`, refusing without `force`.
 * It removes nothing: the old entry stays in place until its replacement is
 * fully on disk (`swapInto`), so a refused or failed replace leaves the
 * installed plugin — and every plugin that depends on it — exactly as it was.
 */
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
  return true;
}

/**
 * Move a fully-written `staged` entry into `<root>/<id>`: the old entry is
 * renamed aside first and deleted only once the new one is in, and put back
 * if that fails. Two renames in one directory, so there is no moment a reader
 * finds neither copy — a provider is never briefly missing under the plugins
 * that use it.
 */
async function swapInto(root: string, id: string, staged: string, replacing: boolean): Promise<void> {
  const target = join(root, id);
  if (!replacing) {
    await rename(staged, target);
    return;
  }
  const aside = join(root, `.${id}.${process.pid}.old`);
  if (await exists(aside)) await removeEntry(aside);
  await rename(target, aside);
  try {
    await rename(staged, target);
  } catch (err) {
    await rename(aside, target).catch(() => {});
    throw err;
  }
  // A link is unlinked, never followed: the old entry may be a `link`ed
  // working directory, which a recursive delete would empty.
  await removeEntry(aside).catch(() => {});
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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
 * `dispatch plugin add`: copy a validated plugin into `<configDir>/plugins/<id>`.
 * Validated in the SOURCE first, so nothing invalid is ever on disk under the
 * root — a half-installed plugin would otherwise show as `invalid` in Settings
 * with no clue that the install itself was the problem.
 */
export async function addPlugin(
  configDir: string,
  source: string,
  opts: {
    force?: boolean;
    /** One plugin of a collection: its path in it, or its id. */
    plugin?: string;
    /**
     * Judge the validated manifest before anything is copied — throw to
     * refuse, return lines to warn. The CLI passes its dependency check
     * (`core/plugin-deps.ts`); the server judges before it gets here.
     */
    check?: (manifest: PluginManifest) => Promise<string[] | void> | string[] | void;
  } = {},
): Promise<InstallResult> {
  const { pluginDir, scratch, source: recorded } = await materialise(source, opts.plugin);
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
    const warnings = (await opts.check?.(found.manifest!)) ?? [];
    const target = join(root, id);
    // Copy to a sibling tmp dir and swap it in, so an interrupted copy never
    // leaves a half-plugin the loader would list as broken — nor, on a
    // replace, no plugin at all.
    const tmp = join(root, `.${id}.${process.pid}.tmp`);
    await rm(tmp, { recursive: true, force: true });
    // `.git` is history, not the plugin. `node_modules` is the author's build
    // environment: a scaffold links `@dispatch/plugin-sdk` into it, and with
    // `dereference: true` that symlink would be FOLLOWED — copying the SDK, its
    // workspace siblings and their dependencies into the config root. The
    // built `server/index.js` is self-contained by construction (the SDK's
    // preset inlines everything but Node's builtins), so nothing in
    // node_modules is needed at runtime.
    try {
      await cp(pluginDir, tmp, {
        recursive: true,
        dereference: true,
        filter: (p) => basename(p) !== ".git" && basename(p) !== "node_modules",
      });
      await swapInto(root, id, tmp, replaced);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    const plugin = await readPluginDir(target, id);
    // Hashed from the INSTALLED copy: that is what a later check compares a
    // fetched commit against, whatever the source looked like.
    const source: PluginSource =
      recorded.type === "git" ? { ...recorded, contentHash: await hashPluginTree(target) } : recorded;
    return { plugin, outcome: replaced ? "replaced" : "copied", dir: target, source, ...(warnings.length ? { warnings } : {}) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `dispatch plugin link`: point `<configDir>/plugins/<id>` at a working directory.
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
  const tmp = join(root, `.${id}.${process.pid}.tmp`);
  if (await exists(tmp)) await removeEntry(tmp);
  await symlink(abs, tmp, process.platform === "win32" ? "junction" : "dir");
  try {
    await swapInto(root, id, tmp, replaced);
  } catch (err) {
    await removeEntry(tmp).catch(() => {});
    throw err;
  }
  const plugin = await readPluginDir(target, id);
  return { plugin, outcome: replaced ? "replaced" : "linked", dir: target };
}

/** `dispatch plugin remove`: delete the directory, or unlink it if it was linked. */
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
  await updatePluginEntry(configDir, id, (entry) => ({ ...entry, enabled }));
}

/**
 * Read-modify-write ONE `AppSettings.plugins[id]` entry in config.json,
 * atomically (tmp + rename). `fn` returning `undefined` deletes the entry.
 * Nothing else in the file is interpreted, so a config.json written by a
 * newer server round-trips.
 */
export async function updatePluginEntry(
  configDir: string,
  id: string,
  fn: (entry: PluginSettingsEntry | undefined) => PluginSettingsEntry | undefined,
): Promise<void> {
  const file = join(configDir, "config.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if (existsSync(file)) throw new CmError(`could not read ${file}: ${describe(err)}`);
  }
  const plugins = { ...((current.plugins as Record<string, PluginSettingsEntry> | undefined) ?? {}) };
  const next = fn(plugins[id]);
  if (next === undefined) delete plugins[id];
  else plugins[id] = next;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...current, plugins }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * Record (or, with `undefined`, forget) where a plugin came from. Host-owned
 * config, never the plugin directory — see `PluginSourceSchema`.
 */
export async function setPluginSource(configDir: string, id: string, source: PluginSource | undefined): Promise<void> {
  await updatePluginEntry(configDir, id, (entry) => {
    const { source: _old, ...rest } = entry ?? {};
    if (source) return { ...rest, source };
    return Object.keys(rest).length ? rest : undefined;
  });
}

/** Every `AppSettings.plugins` entry as stored. */
export async function readPluginEntries(configDir: string): Promise<Record<string, PluginSettingsEntry>> {
  try {
    const raw = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as {
      plugins?: Record<string, PluginSettingsEntry>;
    };
    return raw.plugins ?? {};
  } catch {
    return {};
  }
}

/** The stored toggle for every plugin — absent means enabled. */
export async function readPluginToggles(configDir: string): Promise<Record<string, boolean>> {
  const entries = await readPluginEntries(configDir);
  return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry?.enabled ?? true]));
}

/** The consent summary `add` prints: what the plugin declared it will touch. */
export function consentLines(m: PluginManifest): string[] {
  const lines: string[] = [];
  lines.push(`${m.name} v${m.version} (${m.id})${m.description ? ` — ${m.description}` : ""}`);
  lines.push(`  runs: ${[m.server && "server code (in-process)", m.client && "client code (in your browser)"].filter(Boolean).join(", ") || "nothing (contributions only)"}`);
  if (m.capabilities?.length) lines.push(`  capabilities: ${m.capabilities.join(", ")}`);
  const optional = optionalPluginCapabilities(m);
  if (optional.granted.length) lines.push(`  optional capabilities (granted): ${optional.granted.join(", ")}`);
  const ignoredNote = ignoredOptionalCapabilitiesNote(optional.ignored);
  if (ignoredNote) lines.push(`  note: ${ignoredNote}`);
  if (m.secrets?.length) {
    const verb = grantedPluginCapabilities(m).includes("secrets:write") ? "read and write" : "read";
    lines.push(`  secrets it may ${verb}: ${m.secrets.join(", ")}${m.secrets.some((s) => s.endsWith("*")) ? " (* = any name with that prefix)" : ""}`);
  }
  const contributes = Object.keys(m.contributes ?? {});
  if (contributes.length) lines.push(`  contributes: ${contributes.join(", ")}`);
  if (m.oauth?.clients) lines.push(`  oauth clients: ${Object.keys(m.oauth.clients).join(", ")}`);
  // The same sentences the app's consent card shows, so the two grants read
  // alike: using another plugin hands it data, which is a trust decision.
  for (const [id, spec] of Object.entries(m.dependencies ?? {})) {
    lines.push(`  ${pluginDependencyLine({ id, uses: spec.uses, ...(spec.optional ? { optional: true } : {}) })}`);
  }
  const provides = pluginProvidesLine(m.provides);
  if (provides) lines.push(`  ${provides}`);
  return lines;
}
