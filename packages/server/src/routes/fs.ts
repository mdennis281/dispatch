/**
 * REST for "is this path any good?" — the two questions the new-project form has
 * to ask the disk before it can let you press a button.
 *
 *   GET /api/fs/roots        → { home, projectsRoot, sep }
 *   GET /api/fs/probe?path=  → { path, exists, isDirectory, isGit, empty }
 *
 * A browser page cannot see a filesystem. It can't tell you that the directory
 * you typed already holds a git repo, or that it doesn't exist yet, or where you
 * usually keep your projects — and a setup form that can't say any of that makes
 * you find out by pressing Create and reading an error. So the server answers.
 *
 * Read-only and deliberately shallow: this reports on a path, it never creates
 * one. Directory creation belongs to project create (`initRepo`), where it's the
 * consequence of a decision the human explicitly made, not of a keystroke in a
 * text field.
 */
import { homedir } from "node:os";
import { join, resolve, sep as pathSep, dirname, isAbsolute } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { FastifyInstance } from "fastify";
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  MANIFEST_FILE,
  type Project,
} from "@dispatch/shared";

/** How much of an existing manifest is worth shipping to a preview pane. */
const MANIFEST_PREVIEW_LIMIT = 64_000;

/** What a probed path turned out to be. Every field is "as of right now". */
export interface PathProbe {
  /** The path as resolved (absolute, forward-slashed for the UI). */
  path: string;
  /** True when the caller's text was already absolute (see `absolute` below). */
  absolute: boolean;
  exists: boolean;
  isDirectory: boolean;
  /** A git repo — resolved by walking UP, so a nested path reports its enclosing repo. */
  isGit: boolean;
  /** The enclosing repo's top level, when `isGit`. Equals `path` for a checkout root. */
  repoRoot: string | null;
  /** No code here yet: empty, or holding only `.git`/`.dispatch`. */
  empty: boolean;
  /** The immediate parent exists — i.e. only THIS directory has to be created. */
  parentExists: boolean;
  /** The nearest existing ancestor — null when even the drive/root is missing. */
  existingParent: string | null;
  /**
   * The repo's already-committed `.dispatch/project.yaml`, verbatim, when it has
   * one. Its presence changes what creating a project here MEANS: the manifest
   * is the source of truth and overrides the stored record on every config load,
   * so a form that let you fill those fields in would be collecting answers it
   * was about to throw away. The text comes back so the UI can show the file
   * that will actually be in force instead of a preview of one that won't.
   */
  dispatchConfig: string | null;
  /**
   * The `name:` and `worktreeRoot:` out of that manifest. Parsed here rather
   * than left to the UI because these are what the project will actually HAVE —
   * the loader merges the manifest over the stored record — so a read-only field
   * showing the form's value beside a file that says something else would be
   * lying about which one wins.
   */
  dispatchName: string | null;
  dispatchWorktreeRoot: string | null;
}

/** Forward slashes everywhere the UI shows a path, on every platform. */
export const fwd = (p: string): string => p.replace(/\\/g, "/");

/** Walk up until something exists (or the root runs out). */
function nearestExisting(path: string): string | null {
  let cur = resolve(path);
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/**
 * The top level of the git repo containing `path`, or null.
 *
 * Walks UP rather than checking for `.git` in one directory, because "is this
 * already tracked?" is a question about the whole ancestry: `apps/new-service`
 * inside a monorepo is already in a repo, and `git init`-ing it there would
 * produce a nested one whose worktrees and diffs describe an empty tree while
 * the real code lives in the outer checkout.
 */
export function enclosingRepoRoot(path: string): string | null {
  let cur = resolve(path);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** A committed manifest, verbatim, plus the fields the form has to mirror. */
interface DiscoveredManifest {
  text: string;
  name: string | null;
  worktreeRoot: string | null;
}

/** The committed `.dispatch/project.yaml` under `repoRoot`, or null. */
async function readDispatchManifest(repoRoot: string): Promise<DiscoveredManifest | null> {
  for (const dirName of [CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME]) {
    const file = join(repoRoot, dirName, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue; // not this one — try the legacy dir, then give up
    }
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    let name: string | null = null;
    let worktreeRoot: string | null = null;
    try {
      const data = parseYaml(raw) as { name?: unknown; worktreeRoot?: unknown } | null;
      name = str(data?.name);
      worktreeRoot = str(data?.worktreeRoot);
    } catch {
      // Unparseable YAML is the config loader's problem to report, not this
      // probe's — the text still previews fine, so only the fields are lost.
    }
    const text =
      raw.length > MANIFEST_PREVIEW_LIMIT
        ? `${raw.slice(0, MANIFEST_PREVIEW_LIMIT)}\n# … truncated for preview`
        : raw;
    return { text, name, worktreeRoot };
  }
  return null;
}

/** Probe a path: what's there, if anything. Never throws, never writes. */
export async function probePath(raw: string): Promise<PathProbe> {
  const trimmed = raw.trim();
  const abs = resolve(trimmed);
  const out: PathProbe = {
    path: fwd(abs),
    // A relative path resolves against the SERVER's cwd, which is never what
    // someone typing a project directory meant. Reported so the form can say so
    // rather than silently creating a repo inside the Dispatch install.
    absolute: isAbsolute(trimmed),
    exists: false,
    isDirectory: false,
    isGit: false,
    repoRoot: null,
    empty: false,
    parentExists: existsSync(dirname(abs)),
    existingParent: null,
    dispatchConfig: null,
    dispatchName: null,
    dispatchWorktreeRoot: null,
  };
  /** Record the enclosing repo (and its committed config) on `out`, if any. */
  const noteRepo = async (from: string) => {
    const root = enclosingRepoRoot(from);
    if (!root) return;
    out.isGit = true;
    out.repoRoot = fwd(root);
    const manifest = await readDispatchManifest(root);
    if (manifest) {
      out.dispatchConfig = manifest.text;
      out.dispatchName = manifest.name;
      out.dispatchWorktreeRoot = manifest.worktreeRoot;
    }
  };
  try {
    const st = await stat(abs);
    out.exists = true;
    out.isDirectory = st.isDirectory();
  } catch {
    const parent = nearestExisting(abs);
    out.existingParent = parent ? fwd(parent) : null;
    // A path that doesn't exist can still be inside a repo — that's the nested
    // `git init` case, and it's worth knowing BEFORE the directory is made.
    await noteRepo(abs);
    return out;
  }
  out.existingParent = fwd(abs);
  if (!out.isDirectory) return out;

  await noteRepo(abs);
  try {
    const entries = await readdir(abs);
    // `.git` and `.dispatch` don't count as content — a directory holding only
    // those is one this app just made, and the human is still starting fresh.
    out.empty = entries.every(
      (e) => e === ".git" || e === CONFIG_DIR_NAME || e === LEGACY_CONFIG_DIR_NAME,
    );
  } catch {
    /* unreadable — leave `empty` false rather than guessing */
  }
  return out;
}

/**
 * Where this human keeps their projects.
 *
 * The honest answer is "wherever the existing ones are": if every project sits
 * under `C:/Users/me/projects`, that's the root, and the form can offer a path
 * the moment you type a name. Only when there's nothing to learn from does it
 * fall back to a convention (`~/projects` if it exists, else `~`).
 */
export function inferProjectsRoot(projects: Project[], home: string): string {
  const counts = new Map<string, number>();
  for (const p of projects) {
    if (!p.repoPath) continue;
    const parent = dirname(resolve(p.repoPath));
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [parent, n] of counts) {
    // Ties go to the first-seen parent, which is stable across calls because
    // project order is stable — a root that flips between reloads would move
    // the path out from under someone mid-type.
    if (n > bestCount) {
      best = parent;
      bestCount = n;
    }
  }
  if (best) return fwd(best);
  const conventional = join(home, "projects");
  return fwd(existsSync(conventional) ? conventional : home);
}

export function registerFsRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get("/api/fs/roots", async () => {
    const home = homedir();
    const projects = await store.listProjects().catch(() => [] as Project[]);
    return {
      home: fwd(home),
      projectsRoot: inferProjectsRoot(projects, home),
      sep: pathSep,
    };
  });

  app.get<{ Querystring: { path?: string } }>("/api/fs/probe", async (req, reply) => {
    const path = (req.query.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "path required" });
    return probePath(path);
  });
}
