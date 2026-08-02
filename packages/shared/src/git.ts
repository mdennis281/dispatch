/**
 * Git working-copy domain types — the wire shapes behind the Source Control UI
 * (`/api/git/*`). Everything here describes ONE repo directory, which may be the
 * project checkout OR any of its worktrees; the caller picks by passing
 * `repoPath`.
 *
 * Zod is the source of truth (same house rule as ./domain.ts): the server parses
 * its git output into these schemas, the client imports the inferred types.
 */
import * as z from "zod";

/* ------------------------------------------------------------------ status */

/** How a single path changed, normalized off the porcelain XY status codes. */
export const GitChangeStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "untracked",
  "conflicted",
  "unknown",
]);
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>;

/**
 * One changed path on ONE side of the index. A file edited both in the index and
 * in the working tree (porcelain `MM`) yields TWO entries — one staged, one not —
 * because they are separately stageable and separately diffable.
 */
export const GitFileChangeSchema = z.object({
  /** Current path, forward-slashed, repo-relative. */
  path: z.string(),
  /** Source path for a rename/copy. */
  oldPath: z.string().optional(),
  status: GitChangeStatusSchema,
  /** True when this entry is the index-vs-HEAD side (i.e. already staged). */
  staged: z.boolean(),
  /** Raw two-letter porcelain XY code, kept for tooltips. */
  code: z.string().optional(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

/** Working-copy state of one repo directory: HEAD, upstream gap, and changes. */
export const GitStatusSchema = z.object({
  repoPath: z.string(),
  /** Checked-out branch; omitted when HEAD is detached. */
  branch: z.string().optional(),
  /** HEAD commit sha. */
  head: z.string().optional(),
  detached: z.boolean(),
  /** Tracking branch (e.g. `origin/main`), when set. */
  upstream: z.string().optional(),
  /** Commits ahead of / behind `upstream` (0 when there is none). */
  ahead: z.number().int(),
  behind: z.number().int(),
  staged: z.array(GitFileChangeSchema),
  unstaged: z.array(GitFileChangeSchema),
  untracked: z.array(GitFileChangeSchema),
  /** Unmerged paths — these block a commit until resolved. */
  conflicted: z.array(GitFileChangeSchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

/* ---------------------------------------------------------------- branches */

/** A local or remote-tracking branch for the branch switcher. */
export const GitBranchSchema = z.object({
  /** Short name (`main`) for local, `origin/main` for remote-tracking. */
  name: z.string(),
  isCurrent: z.boolean(),
  isRemote: z.boolean(),
  upstream: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  /** Committer date of the tip, epoch ms — drives the recency sort. */
  lastCommitAt: z.number().int().optional(),
  /** Tip commit subject. */
  subject: z.string().optional(),
  /** Tip sha (short). */
  head: z.string().optional(),
  /**
   * Absolute path of a worktree that already has this branch checked out. Git
   * refuses a second checkout of the same branch, so the UI disables the switch.
   */
  worktreePath: z.string().optional(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

/* ----------------------------------------------------------------- commits */

/** One commit in the history list. */
export const GitCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  body: z.string().optional(),
  author: z.string(),
  authorEmail: z.string().optional(),
  /** Committer date, epoch ms. */
  at: z.number().int(),
  /** Decorations (branch/tag names) pointing at this commit. */
  refs: z.array(z.string()),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

/** A file touched by a commit (or carried in a stash). */
export const GitCommitFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: GitChangeStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
});
export type GitCommitFile = z.infer<typeof GitCommitFileSchema>;

/* ----------------------------------------------------------------- stashes */

/** One entry of `git stash list`. */
export const GitStashSchema = z.object({
  /** Position in the stash stack — `stash@{index}`. */
  index: z.number().int(),
  /** The full ref (`stash@{0}`), so the client never rebuilds it by hand. */
  ref: z.string(),
  message: z.string(),
  /** Branch the stash was taken on, when git recorded one. */
  branch: z.string().optional(),
  at: z.number().int().optional(),
});
export type GitStash = z.infer<typeof GitStashSchema>;

/* -------------------------------------------------------------------- revs */

/**
 * Which snapshot of a path to read. `WORKTREE` is the file on disk, `INDEX` is
 * the staged blob (`git show :path`), anything else is a git rev (`HEAD`,
 * `abc1234`, `stash@{0}^1`, …). `EMPTY` is a client-side sentinel for "no such
 * side" (the left of an untracked file) and never reaches the server.
 */
export const GIT_REV_WORKTREE = "WORKTREE";
export const GIT_REV_INDEX = "INDEX";
export const GIT_REV_EMPTY = "EMPTY";

/** Outcome of a mutating git action, with the git output for the toast. */
export const GitActionResultSchema = z.object({
  ok: z.boolean(),
  /** Human-readable summary (git stdout/stderr, trimmed). */
  message: z.string().optional(),
});
export type GitActionResult = z.infer<typeof GitActionResultSchema>;
