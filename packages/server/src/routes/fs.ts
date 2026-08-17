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
  FsMutationSchema,
  FsSelectKindSchema,
  type Project,
} from "@dispatch/shared";
import { enclosingRepoRoot, fwd, FsPathError } from "../services/fs-explorer.js";

// Both of these started life here, beside the probe that first needed them, and
// moved into the explorer service once the browser needed them too — a service
// cannot import from `routes/`. Re-exported because `routes/projects.ts` and the
// existing tests import them from this module.
export { enclosingRepoRoot, fwd };

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

/** `?showHidden=true` / `?showHidden=1` — query strings have no booleans. */
const flag = (v: string | undefined): boolean => v === "true" || v === "1";

/**
 * A failed read, as a status code.
 *
 * 400 for a path the caller got wrong (relative, empty) and 404 for one that's
 * simply not there or not readable. Both are normal things for a browser to hit
 * — a stale bookmark, someone else's home directory — and neither is a 500. But
 * they are different problems: collapsing a client bug into "not found" sends
 * whoever is debugging it looking for a missing file.
 */
const readError = (err: unknown): { code: number; error: string } => ({
  code: err instanceof FsPathError ? 400 : 404,
  error: err instanceof Error ? err.message : String(err),
});

/** `?ext=png,jpg` or `?ext=.PNG` → `["png","jpg"]`. */
const extList = (v: string | undefined): string[] | undefined => {
  const parts = (v ?? "")
    .split(",")
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : undefined;
};

export function registerFsRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { fsExplorer, worktrees } = app.services;

  /**
   * Everywhere worth starting from.
   *
   * `home`/`projectsRoot`/`sep` are the original three fields, still here
   * because the new-project form reads them; `platform` and `roots` are
   * additive. Keeping the old keys means this endpoint didn't need a version.
   */
  app.get("/api/fs/roots", async () => {
    const home = homedir();
    const projects = await store.listProjects().catch(() => [] as Project[]);
    // Worktrees are best-effort: they cost a `git worktree list` per project,
    // and a picker that fails to open because one repo is mid-rebase would be a
    // bad trade for a few extra shortcuts.
    const trees = await worktrees
      .listAll(projects)
      .catch(() => [] as Array<{ path: string; branch?: string; projectId?: string }>);
    const nameOf = new Map(projects.map((p) => [p.id, p.name]));
    return {
      home: fwd(home),
      projectsRoot: inferProjectsRoot(projects, home),
      sep: pathSep,
      // The client needs this to compute breadcrumbs and parents without a
      // round trip, and it is the SERVER's platform — the browser's is
      // irrelevant to a disk it can't see.
      platform: fsExplorer.pathPlatform,
      roots: await fsExplorer.roots({
        projects: projects
          .filter((p) => p.repoPath)
          .map((p) => ({ id: p.id, name: p.name, repoPath: p.repoPath })),
        worktrees: trees.map((w) => ({
          path: w.path,
          branch: w.branch,
          projectName: w.projectId ? nameOf.get(w.projectId) : undefined,
        })),
      }),
    };
  });

  app.get<{ Querystring: { path?: string } }>("/api/fs/probe", async (req, reply) => {
    const path = (req.query.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "path required" });
    return probePath(path);
  });

  app.get<{ Querystring: { path?: string; limit?: string } }>(
    "/api/fs/list",
    async (req, reply) => {
      const path = (req.query.path ?? "").trim();
      if (!path) return reply.code(400).send({ error: "path required" });
      try {
        const limit = Number(req.query.limit);
        return await fsExplorer.list(path, {
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        });
      } catch (err) {
        const { code, error } = readError(err);
        return reply.code(code).send({ error });
      }
    },
  );

  app.get<{ Querystring: { path?: string } }>("/api/fs/details", async (req, reply) => {
    const path = (req.query.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "path required" });
    try {
      return await fsExplorer.details(path);
    } catch (err) {
      const { code, error } = readError(err);
      return reply.code(code).send({ error });
    }
  });

  app.get<{
    Querystring: {
      root?: string;
      q?: string;
      limit?: string;
      select?: string;
      ext?: string;
      showHidden?: string;
      includeIgnored?: string;
    };
  }>("/api/fs/search", async (req, reply) => {
    const root = (req.query.root ?? "").trim();
    if (!root) return reply.code(400).send({ error: "root required" });
    const select = FsSelectKindSchema.safeParse(req.query.select);
    const limit = Number(req.query.limit);
    try {
      const results = await fsExplorer.search(root, req.query.q ?? "", {
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        includeIgnored: flag(req.query.includeIgnored),
        filter: {
          select: select.success ? select.data : "any",
          extensions: extList(req.query.ext),
          showHidden: flag(req.query.showHidden),
        },
      });
      return { root, results };
    } catch (err) {
      const { code, error } = readError(err);
      return reply.code(code).send({ error });
    }
  });

  /**
   * Every write, behind one route.
   *
   * A discriminated union rather than six endpoints because these all share the
   * same result shape (partial success, per-path errors) and the same guards,
   * and because the UI dispatches them from one place — an undo stack that had
   * to know which URL each operation lived at would be six times the wiring for
   * no extra clarity.
   */
  app.post("/api/fs/mutate", async (req, reply) => {
    const parsed = FsMutationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid mutation" });
    }
    const result = await fsExplorer.mutate(parsed.data);
    // 200 even for a failed mutation: the body carries per-path errors, and a
    // non-2xx would collapse "two of five files were locked" into "the request
    // failed", which is exactly the distinction the caller needs.
    return result;
  });
}
