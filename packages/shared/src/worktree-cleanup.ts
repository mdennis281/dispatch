/**
 * Worktree cleanup — the vocabulary for "is this tree still holding anything?"
 *
 * Agents create worktrees and almost never remove them. On this repo that had
 * reached 91 trees, 87 of them on a branch whose PR had already merged, each
 * carrying its own `node_modules`. Nothing was wrong with any single one; they
 * just accumulated, because removal was a thing a human had to remember.
 *
 * The shape below is what both halves of the fix agree on: the reaper sweep and
 * the Source Control cleanup panel ask the same question and read the same
 * answer, so what a human approves in the panel is exactly what the sweep would
 * have done unattended.
 *
 * The design rule: a worktree is removed only when EVERY blocker is absent. A
 * blocker is never inferred optimistically — "nobody could tell" always reads as
 * blocked (see `unmerged` and `unreadable`), because the cost of keeping a tree
 * one turn too long is disk, and the cost of removing one too early is somebody's
 * uncommitted afternoon.
 */
import { z } from "zod";

/**
 * Why a worktree is NOT safe to remove. Absence of all of these is the only
 * thing that authorizes a removal.
 *
 * Ordered by how they're evaluated, which is also cheapest-first: everything
 * above `dirty` is answered from state already in memory or from one batched
 * git call, and `dirty` is the single probe that has to enter the tree itself.
 */
export const ReapBlockerSchema = z.enum([
  /** The project's primary checkout. Never a disposable tree. */
  "primary",
  /** A checkout of the trunk itself (e.g. a `main` worktree). */
  "default-branch",
  /** `git worktree lock` — an explicit, human "keep this". */
  "locked",
  /**
   * The branch's work is not on the trunk — OR nobody could tell. Those are the
   * same answer here on purpose: `WorktreeInfo.merged` is a tri-state, and an
   * `undefined` means no trunk ref resolved and no PR record existed. Treating
   * that as "merged" would delete work on the strength of a failed lookup.
   */
  "unmerged",
  /** Uncommitted or untracked changes in the working tree. */
  "dirty",
  /** Commits the remote never received. */
  "unpushed",
  /** The owning chat is mid-turn; its cwd may be this directory. */
  "chat-live",
  /** A tracked shell is sitting in this directory. */
  "terminal-live",
  /** A subApp process is running out of this directory. */
  "runner-live",
  /** Created too recently to judge — inside the grace window. */
  "too-new",
  /** Already gone from disk (git metadata is stale; `prune` handles it). */
  "missing",
  /** A git call failed or timed out, so cleanliness is unknown. */
  "unreadable",
]);
export type ReapBlocker = z.infer<typeof ReapBlockerSchema>;

/** Human copy for each blocker, for the cleanup panel's "why not" column. */
export const REAP_BLOCKER_LABEL: Record<ReapBlocker, string> = {
  primary: "Project checkout",
  "default-branch": "On the trunk",
  locked: "Locked",
  unmerged: "Not merged",
  dirty: "Uncommitted changes",
  unpushed: "Unpushed commits",
  "chat-live": "Chat is running",
  "terminal-live": "Shell open here",
  "runner-live": "App running here",
  "too-new": "Just created",
  missing: "Gone from disk",
  unreadable: "Couldn't read",
};

/** One worktree, judged. */
export const ReapCandidateSchema = z.object({
  path: z.string(),
  branch: z.string(),
  projectId: z.string().optional(),
  /** Chat that owns it, when the registry recorded one. */
  chatId: z.string().optional(),
  /** Empty = safe to remove. Anything here means leave it alone. */
  blockers: z.array(ReapBlockerSchema),
  /**
   * Whether the cleanliness probe has run yet. The panel lists candidates from
   * the cheap gates immediately and fills this in per row as the probes land,
   * because a probe costs ~35s per tree on Windows and a modal that blocks on
   * 91 of them is not a modal anyone will wait for.
   */
  probed: z.boolean(),
  /**
   * Whether the local branch can also go. True only for a tree whose work
   * demonstrably landed — `git worktree remove` leaves the branch behind, and
   * 87 removals would otherwise leave 87 dead branches.
   */
  branchDeletable: z.boolean(),
  /** The PR that landed this branch, when one is recorded. */
  prNumber: z.number().int().optional(),
  /** Last time anything was seen touching it (drives the grace window). */
  lastSeenAt: z.number().int().optional(),
});
export type ReapCandidate = z.infer<typeof ReapCandidateSchema>;

/** The full judgement over a set of worktrees. */
export const ReapPlanSchema = z.object({
  candidates: z.array(ReapCandidateSchema),
  /**
   * True when the scan stopped before probing everything (budget or cap). The
   * panel says so rather than presenting a partial list as complete — a
   * silently truncated cleanup reads as "these are all the stale trees", which
   * is the one thing it must never imply.
   */
  truncated: z.boolean(),
  /** How many trees were probed this pass (diagnostics + progress). */
  probed: z.number().int(),
});
export type ReapPlan = z.infer<typeof ReapPlanSchema>;

/** What one removal actually did. */
export const ReapOutcomeSchema = z.object({
  path: z.string(),
  branch: z.string(),
  removed: z.boolean(),
  /** True when the local branch was deleted alongside the tree. */
  branchDeleted: z.boolean().optional(),
  /** Present when `removed` is false. */
  error: z.string().optional(),
  /** Present when the removal was refused by a gate rather than by git. */
  blockers: z.array(ReapBlockerSchema).optional(),
});
export type ReapOutcome = z.infer<typeof ReapOutcomeSchema>;

export const ReapResultSchema = z.object({
  outcomes: z.array(ReapOutcomeSchema),
  removed: z.number().int(),
  failed: z.number().int(),
});
export type ReapResult = z.infer<typeof ReapResultSchema>;

/** True when nothing stands in the way of removing this tree. */
export function isReapable(c: ReapCandidate): boolean {
  return c.blockers.length === 0;
}
