/**
 * Worktree history — the record that a chat MADE a worktree, kept after the
 * directory is gone.
 *
 * `Chat.worktrees[]` is not that record. The detector rewrites it to exactly
 * the LIVE worktrees a chat owns on every reconcile (`worktree-detector.ts`),
 * which is right for "where is this chat working" and useless for "what did
 * this chat produce": the reaper removes a tree the moment its branch lands, and
 * the chat's only trace of it goes with it. Measured on a real instance in
 * 2026-09: 721 of the 770 chats that had opened a PR held NO worktree path at
 * all, so every one of those PRs was an orphan with nothing to hang off.
 *
 * So the history is append-only and separate. A record is added the first time
 * a path is seen as this chat's, and stamped `removedAt` when it stops being —
 * never deleted, because the point is that the record survives the cleanup.
 */
import { z } from "zod";

/** One worktree this chat owned, live or long since reaped. */
export const ChatWorktreeRecordSchema = z.object({
  path: z.string(),
  /**
   * The branch as git spelled it while the tree existed. The whole reason to
   * keep this rather than re-derive it from the directory name: the flattened
   * leaf (`feat-a-b`) cannot be read back to `feat/a-b` vs `feat/a/b` without
   * guessing, and the client WAS guessing.
   */
  branch: z.string(),
  createdAt: z.number().int(),
  /** When it stopped being this chat's live worktree. Unset while it is. */
  removedAt: z.number().int().optional(),
});
export type ChatWorktreeRecord = z.infer<typeof ChatWorktreeRecordSchema>;

/**
 * Path identity across the two spellings that reach this: git's (usually
 * forward-slashed) and a stored `join()`'s (native separators). Case-folded
 * because the instances that produce these are Windows, and a `C:` that
 * disagrees with a `c:` would file one tree as two.
 */
export function worktreeKey(path: string): string {
  const slashed = path.replace(/\\/g, "/").toLowerCase();
  // Trailing separators are trimmed with a scan rather than `/\/+$/`: that
  // pattern backtracks polynomially on a path of many trailing slashes, which
  // CodeQL flags because these paths come in off the wire.
  let end = slashed.length;
  while (end > 0 && slashed[end - 1] === "/") end--;
  return slashed.slice(0, end);
}

/**
 * Fold the chat's CURRENT live worktrees into its history.
 *
 * The one writer both callers share, because they arrive at the same fact from
 * opposite directions: `attachToChat` adds one path it just created, while the
 * detector hands over the whole reconciled set. Passing the full live set means
 * a record that fell out of it is stamped removed in the same pass — the reaper
 * does not have to remember to say so.
 *
 * `live` is authoritative for what is live, never for what existed: a path
 * missing from it marks a record removed, and never drops one.
 */
export function mergeWorktreeHistory(
  history: ChatWorktreeRecord[],
  live: { path: string; branch: string }[],
  now: number,
): ChatWorktreeRecord[] {
  const liveByKey = new Map(live.map((w) => [worktreeKey(w.path), w]));
  const seen = new Set<string>();
  const merged = history.map((rec) => {
    const key = worktreeKey(rec.path);
    seen.add(key);
    const still = liveByKey.get(key);
    if (still) {
      // Re-cutting a branch at a path that was reaped revives the record rather
      // than appending a second one for the same directory — and `branch` is
      // refreshed, because a `git branch -m` while the tree stood makes the
      // stored name the stale one.
      const { removedAt: _dropped, ...alive } = rec;
      return { ...alive, branch: still.branch || rec.branch };
    }
    return rec.removedAt === undefined ? { ...rec, removedAt: now } : rec;
  });
  for (const w of live) {
    if (seen.has(worktreeKey(w.path))) continue;
    // No branch, no record. A nameless row would be worse than none: the whole
    // value of the history is naming a branch after its directory is gone, and
    // an empty one would render a blank row nothing could be hung off.
    if (!w.branch) continue;
    merged.push({ path: w.path, branch: w.branch, createdAt: now });
  }
  return merged;
}
