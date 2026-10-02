/**
 * The homepage's two derived lists — worktrees and pull requests — as pure
 * functions over what the client stores already hold.
 *
 * NOTHING HERE FETCHES, and that is the point of the module existing at all.
 * Both lists are already resident and already LIVE: every chat in the install
 * is in `stores/chats` and follows `chat-update`, every tracked PR is in
 * `stores/prs` and follows `pr-record-update`. Adding them to `GET /api/home`
 * would have bought a second copy of facts the page is already subscribed to —
 * one that goes stale behind a TTL and cannot show a worktree appearing while
 * you look at it. So the server side of this rework is unchanged, and the rows
 * below are a fold over memory.
 *
 * Pure (and tested) rather than inlined into the components because the
 * interesting part of both is the JOIN, not the markup: a live worktree path
 * has no branch on it, and a PR's row has to survive the chat that opened it
 * being deleted.
 */
import type { Chat, PrRecord } from "@dispatch/shared";
import { worktreeKey } from "@dispatch/shared";

/* ------------------------------------------------------------- worktrees */

/** One live worktree, with the branch and the chat it belongs to. */
export interface HomeWorktreeRow {
  /** `worktreeKey(path)` — identity across git's and `join()`'s spellings. */
  key: string;
  path: string;
  /** The branch git gave it, or "" when no history record names one. */
  branch: string;
  chatId: string;
  chatTitle: string;
  projectId: string;
  /** When this tree was first seen as the chat's. Falls back to the chat's own. */
  createdAt: number;
}

/**
 * Every worktree that exists RIGHT NOW, newest first.
 *
 * Read off `Chat.worktrees` — the set the detector rewrites to the live truth
 * on every reconcile — and joined to `Chat.worktreeHistory` for the branch,
 * because the live array is paths only. That join is the whole reason the
 * history field exists: the flattened directory leaf (`feat-a-b`) cannot be
 * read back to `feat/a-b` vs `feat/a/b` without guessing, and guessing is what
 * the record replaced (see `shared/worktree-history.ts`).
 *
 * LIVE ONLY, deliberately. The history is append-only and keeps a record long
 * after the reaper takes the directory, which is right for attributing an
 * orphaned PR and wrong for a list whose heading says "worktrees" — on a
 * months-old install that list is hundreds of directories that are not there.
 *
 * Deduped on the key: two chats can both claim a path (one cut it, another was
 * pointed at it), and a list that shows the directory twice reads as two trees.
 * The newer claim wins, since that is the one a reconcile wrote most recently.
 */
export function worktreeRows(chats: readonly Chat[]): HomeWorktreeRow[] {
  const byKey = new Map<string, HomeWorktreeRow>();
  for (const chat of chats) {
    if (chat.archived) continue;
    const history = new Map(
      (chat.worktreeHistory ?? []).map((r) => [worktreeKey(r.path), r]),
    );
    for (const path of chat.worktrees) {
      const key = worktreeKey(path);
      const record = history.get(key);
      const row: HomeWorktreeRow = {
        key,
        path,
        branch: record?.branch ?? "",
        chatId: chat.id,
        chatTitle: chat.title,
        projectId: chat.projectId,
        createdAt: record?.createdAt ?? chat.createdAt,
      };
      const held = byKey.get(key);
      if (!held || row.createdAt > held.createdAt) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------------- prs */

/**
 * The PR roster for the homepage: everything still OPEN first, then what
 * settled most recently.
 *
 * Open-first rather than one recency run because the two halves are different
 * questions. An open PR is work in flight — it is the reason to look at this
 * list — and a merge that landed an hour ago would otherwise push a PR that has
 * been waiting on a review since yesterday below the fold. Within each half,
 * most-recently-changed first.
 *
 * Draft PRs are open and stay with the open ones: a draft is still a change
 * somebody is pushing to, and the row says `draft` in its own words.
 *
 * Unattributed rows are KEPT (a `PrRecord` with no `chatId` — a human's PR, or
 * one whose chat was deleted). Dropping them would make the list quietly
 * narrower than the registry it claims to show, and it is also where the
 * interesting failure lives: a PR Dispatch opened whose chat is gone is exactly
 * the row you want to see, not the one to hide.
 */
export function prRows(prs: readonly PrRecord[], limit: number): PrRecord[] {
  const rank = (p: PrRecord) => (p.state === "open" ? 0 : 1);
  return [...prs]
    .sort((a, b) => rank(a) - rank(b) || b.lastChangedAt - a.lastChangedAt)
    .slice(0, limit);
}
