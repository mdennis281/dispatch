/**
 * What the homepage's ONE list carries besides the chat itself — the worktree a
 * chat is standing in and the pull request it opened — as pure functions over
 * what the client stores already hold.
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
 * interesting part of all of it is the JOIN, not the markup: a live worktree
 * path has no branch on it, a PR has to survive the chat that opened it being
 * deleted, and a PR's whole state has to fold into one word and one colour.
 */
import type { Chat, PrRecord } from "@dispatch/shared";
import { worktreeKey } from "@dispatch/shared";
import type { DotTone } from "../ui/StatusDot.js";
import { summarizeChecks } from "../pr/checks.js";

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
 * The pull requests each chat opened, newest-and-most-live first.
 *
 * Keyed off `PrRecord.chatId` — the registry's own attribution — rather than
 * `Chat.prs`, which holds the same edge from the other side. One direction has
 * to win or the two can disagree, and the registry's is the one that survives a
 * chat being rewritten: it is also what `buildChatTree` already follows to file
 * a reviewer under the chat that opened the change it is reading.
 *
 * Open first, because a row has space for ONE mark and an open PR is the one
 * still worth a glance; within each half, most recently changed.
 */
export function prsByChat(prs: readonly PrRecord[]): Map<string, PrRecord[]> {
  const by = new Map<string, PrRecord[]>();
  for (const pr of prs) {
    if (!pr.chatId) continue;
    const list = by.get(pr.chatId);
    if (list) list.push(pr);
    else by.set(pr.chatId, [pr]);
  }
  const rank = (p: PrRecord) => (p.state === "open" ? 0 : 1);
  for (const list of by.values()) {
    list.sort((a, b) => rank(a) - rank(b) || b.lastChangedAt - a.lastChangedAt);
  }
  return by;
}

/** The live worktrees each chat owns, newest first. See {@link worktreeRows}. */
export function worktreesByChat(rows: readonly HomeWorktreeRow[]): Map<string, HomeWorktreeRow[]> {
  const by = new Map<string, HomeWorktreeRow[]>();
  for (const row of rows) {
    const list = by.get(row.chatId);
    if (list) list.push(row);
    else by.set(row.chatId, [row]);
  }
  return by;
}

/**
 * The pull requests that belong to NO chat on this page — open first.
 *
 * Two populations end up here and they want the same treatment. A PR Dispatch
 * never opened (dependabot's, a human's, anything pushed from a terminal) has no
 * `chatId` at all. A PR whose chat has since been deleted has one that resolves
 * to nothing. Either way there is no row on this page that could carry it, and
 * the homepage's whole premise after this rework is that a worktree and a pull
 * request BELONG to a chat and ride on its row.
 *
 * They are not dropped, because the list would then be quietly narrower than
 * the registry it counts in its own header — and an open PR nobody in Dispatch
 * is driving is exactly the one worth noticing. They get the same treatment as
 * the never-started chats: one muted line at the foot of the list, which opens.
 *
 * `known` is the chat ids actually on the page, so the "deleted chat" case is
 * decided by what can be RENDERED rather than by whether a field is set.
 */
export function orphanPrs(
  prs: readonly PrRecord[],
  known: ReadonlySet<string>,
): PrRecord[] {
  const rank = (p: PrRecord) => (p.state === "open" ? 0 : 1);
  return prs
    .filter((pr) => !pr.chatId || !known.has(pr.chatId))
    .sort((a, b) => rank(a) - rank(b) || b.lastChangedAt - a.lastChangedAt);
}

/**
 * A pull request folded into the ONE mark a chat row has room for: a tone and a
 * word.
 *
 * The order of the tests is the order of what stops a merge. A draft is not
 * waiting on anything; a hold was parked deliberately; failing CI and requested
 * changes are both work somebody has to do, and of those the human one is the
 * one that stalls — so it wins. Everything else on an open PR is just "open".
 *
 * Settled PRs keep a tone and lose the detail: a merged PR's last check run is
 * a fact about history, and this is a four-character column.
 */
export function prMark(pr: PrRecord): { tone: DotTone; label: string } {
  if (pr.state === "merged") return { tone: "success", label: "merged" };
  if (pr.state === "closed") return { tone: "muted", label: "closed" };
  if (pr.isDraft) return { tone: "muted", label: "draft" };
  if (pr.hold) return { tone: "warn", label: "on hold" };
  if (pr.reviewDecision === "changes_requested") {
    return { tone: "warn", label: "changes requested" };
  }
  const checks = summarizeChecks(pr.checks);
  if (checks.failed > 0) return { tone: "danger", label: "CI failing" };
  if (checks.pending > 0) return { tone: "info", label: "CI running" };
  if (pr.reviewDecision === "approved") return { tone: "success", label: "approved" };
  return { tone: "accent", label: "open" };
}
