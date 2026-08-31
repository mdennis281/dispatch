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
 * That second property only holds if the patterns come back OUT again, which is
 * why {@link unexcludePathsFromGit} exists and teardown calls it. An append-only
 * block would outlive the dir it described, and the next thing to appear at that
 * path is precisely the user's own override of a bundled skill — silently
 * unstageable, with nothing on screen to explain why.
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
 *
 * Skill dir names are user-authored (`readSkillsDir` takes `entry.name` off disk
 * verbatim), and exclude entries are GLOBS — so a dir named `foo[1]` would reach
 * git as a character class, hiding a sibling `foo1` the user owns while leaving
 * `foo[1]` itself on screen. Both halves wrong at once, hence the escaping.
 */
function toPattern(root: string, absPath: string): string | null {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const literal = rel.split(sep).join("/").replace(/[\\*?[\]]/g, (c) => `\\${c}`);
  return `/${literal}/`;
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

/**
 * Drop exclude patterns for `absPaths` again — the teardown half of
 * {@link excludePathsFromGit}, called when the dirs they describe are removed.
 *
 * Only lines inside OUR managed block are touched. A user who had excluded the
 * same path by hand keeps their line: `excludePathsFromGit` never added it to
 * the block, so there is nothing of ours there to take away.
 *
 * The repo is found by walking up from each path, which still works after the
 * dir itself is gone. Never throws.
 */
export async function unexcludePathsFromGit(absPaths: string[]): Promise<void> {
  if (!absPaths.length) return;
  // Group by repo: one PR's worth of skill dirs is normally one repo, but a
  // teardown could span more, and each has its own exclude file.
  const byExcludeFile = new Map<string, { root: string; paths: string[] }>();
  for (const path of absPaths) {
    const layout = findGitLayout(path);
    if (!layout) continue;
    const file = join(layout.commonDir, "info", "exclude");
    const entry = byExcludeFile.get(file) ?? { root: layout.root, paths: [] };
    entry.paths.push(path);
    byExcludeFile.set(file, entry);
  }

  for (const [file, { root, paths }] of byExcludeFile) {
    try {
      const current = await readFile(file, "utf8");
      const drop = new Set(
        paths.map((p) => toPattern(root, p)).filter((p): p is string => p !== null),
      );
      if (!drop.size) continue;
      const next = removeFromBlock(current, drop);
      if (next !== current) await writeFile(file, next, "utf8");
    } catch {
      /* no exclude file, or unwritable — nothing to undo */
    }
  }
}

/** Locate the managed block's delimiters, or null when it isn't there. */
function findBlock(rows: string[]): { begin: number; end: number } | null {
  const begin = rows.findIndex((l) => l.trim() === BEGIN);
  if (begin < 0) return null;
  const end = rows.findIndex((l, i) => i > begin && l.trim() === END);
  return end > begin ? { begin, end } : null;
}

/** Remove `drop` lines from the managed block, deleting the block once empty. */
function removeFromBlock(current: string, drop: Set<string>): string {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const rows = current.split(/\r?\n/);
  const block = findBlock(rows);
  if (!block) return current;

  const kept = rows.slice(block.begin + 1, block.end).filter((l) => !drop.has(l.trim()));
  const rest = kept.some((l) => l.trim() !== "");
  // An empty block is litter in a file the user may read; take the whole thing.
  const replacement = rest ? [rows[block.begin], ...kept, rows[block.end]] : [];
  rows.splice(block.begin, block.end - block.begin + 1, ...replacement);
  if (!rest) while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.length ? rows.join(eol) + (rest ? "" : eol) : "";
}

/** Insert `lines` into the managed block, creating the block if it's absent. */
function spliceBlock(current: string, lines: string[]): string {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const rows = current.length ? current.split(/\r?\n/) : [];
  const block = findBlock(rows);

  if (block) {
    rows.splice(block.end, 0, ...lines);
    return rows.join(eol);
  }

  // No block (or a half-written one we won't try to repair) — append a new one.
  while (rows.length && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.length) rows.push("");
  rows.push(BEGIN, ...lines, END, "");
  return rows.join(eol);
}
