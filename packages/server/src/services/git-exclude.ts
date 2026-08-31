/**
 * git-exclude — keep the files Dispatch has to write into a user's repo out of
 * the user's git status.
 *
 * `materializeSkills` has no choice but to write into the session cwd's
 * `.claude/skills/` — the Agent SDK discovers skills nowhere else. That means
 * Dispatch manufactures untracked files inside a repo somebody is looking at.
 * In THIS repo nobody noticed, because `.gitignore` has listed `.claude` since
 * the beginning; in a project that doesn't, every turn made a handful of files
 * appear in the source-control pane, indistinguishable from the user's own work.
 *
 * Two deliberate choices here:
 *
 * - `.git/info/exclude`, NOT `.gitignore`. The exclude file is per-clone and is
 *   itself untracked, so writing to it can never show up in the user's next
 *   commit. Editing `.gitignore` would mean Dispatch silently authoring a line
 *   into a file the user does commit.
 * - One narrow pattern per skill dir we actually materialize, rather than a
 *   blanket `/.claude/skills/`. A skill the USER later authors under that
 *   directory still shows up in status, which a blanket rule would have hidden.
 *
 * Neither affects files git already tracks: exclude patterns are consulted only
 * for untracked paths, so a repo that COMMITS `.claude/skills/foo` keeps seeing
 * its own changes to it.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";

/** Delimiters for the block we own inside `info/exclude`. */
const BEGIN = "# BEGIN Dispatch — materialized agent skills (managed, safe to delete)";
const END = "# END Dispatch";

/** Where a repo's exclude file lives, and what its patterns are relative to. */
export interface GitLayout {
  /** The worktree root — the dir holding `.git`. Patterns anchor here. */
  root: string;
  /** The COMMON git dir, which is where `info/` actually lives. */
  commonDir: string;
}

/**
 * Resolve {@link GitLayout} for a directory by walking up to its `.git`, using
 * only the filesystem — this runs on the session launch path, where spawning a
 * `git rev-parse` per turn would be pure latency for a question fs can answer.
 *
 * Returns null when there's no repo above `startDir` (a chat can be pointed at a
 * plain directory, which is not an error — there is just nothing to hide from).
 */
export function findGitLayout(startDir: string): GitLayout | null {
  let dir = resolve(startDir);
  for (;;) {
    const dotGit = join(dir, ".git");
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(dotGit);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      /* no `.git` at this level — keep walking up */
    }
    if (isDir) return { root: dir, commonDir: dotGit };
    if (isFile) {
      // A LINKED WORKTREE. `.git` is a file holding `gitdir: <path>`, and that
      // path is the worktree's PRIVATE git dir — which is not where the exclude
      // file lives. Git reads `info/exclude` from the common dir (`info/` is on
      // git's common list), named by the `commondir` file beside the private
      // one. Resolve that, or we'd write an exclude file git never reads.
      const gitDir = readGitdirPointer(dotGit, dir);
      return gitDir ? { root: dir, commonDir: readCommonDir(gitDir) } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read `gitdir: <path>` out of a linked worktree's `.git` file. */
function readGitdirPointer(dotGitFile: string, worktreeRoot: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitFile, "utf8"));
    if (!m) return null;
    const target = m[1].trim();
    return isAbsolute(target) ? target : resolve(worktreeRoot, target);
  } catch {
    return null;
  }
}

/** Resolve a private git dir's `commondir` pointer; absent → it IS the common dir. */
function readCommonDir(gitDir: string): string {
  try {
    const target = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (!target) return gitDir;
    return isAbsolute(target) ? target : resolve(gitDir, target);
  } catch {
    return gitDir;
  }
}

/**
 * Turn an absolute path into a worktree-anchored exclude pattern, or null if it
 * falls outside the worktree (nothing there is ours to hide).
 */
function toPattern(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return `/${rel.split(sep).join("/")}/`;
}

/**
 * Add exclude patterns for `absPaths` to the repo containing `cwd`. Idempotent —
 * a pattern already present anywhere in the file is not written again, and a
 * call with nothing new to say does not touch the file at all.
 *
 * The managed block is MERGED into, never rewritten: `info/exclude` is shared by
 * every worktree of a repo, and two sessions on different worktrees (or on
 * different harnesses, so `.claude` vs `.agents`) would otherwise take turns
 * deleting each other's lines. Union-append is bounded in practice because skill
 * dir names are stable.
 *
 * Best-effort: a read-only or exotic repo layout means the files stay visible,
 * which is untidy, never broken. Never throws.
 */
export async function excludePathsFromGit(cwd: string, absPaths: string[]): Promise<void> {
  if (!absPaths.length) return;
  try {
    const layout = findGitLayout(cwd);
    if (!layout) return;

    const wanted = absPaths
      .map((p) => toPattern(layout.root, p))
      .filter((p): p is string => p !== null);
    if (!wanted.length) return;

    const excludePath = join(layout.commonDir, "info", "exclude");
    let current = "";
    try {
      current = await readFile(excludePath, "utf8");
    } catch {
      /* no exclude file yet (or unreadable) — we'll write a fresh one */
    }

    // Compare against every line in the file, not just our block: a user who
    // already excluded one of these by hand must not get a duplicate.
    const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = wanted.filter((p) => !present.has(p));
    if (!missing.length) return;

    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, spliceBlock(current, missing), "utf8");
  } catch {
    /* best-effort: never let tidying git status block a turn from starting */
  }
}

/** Insert `lines` into the managed block, creating the block if it's absent. */
function spliceBlock(current: string, lines: string[]): string {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const rows = current.length ? current.split(/\r?\n/) : [];
  const begin = rows.findIndex((l) => l.trim() === BEGIN);
  const end = begin >= 0 ? rows.findIndex((l, i) => i > begin && l.trim() === END) : -1;

  if (begin >= 0 && end > begin) {
    rows.splice(end, 0, ...lines);
    return rows.join(eol);
  }

  // No block (or a half-written one we won't try to repair) — append a new one.
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.length) rows.push("");
  rows.push(BEGIN, ...lines, END, "");
  return rows.join(eol);
}
