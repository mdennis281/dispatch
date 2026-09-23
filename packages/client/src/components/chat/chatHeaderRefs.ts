/**
 * What the chat header knows about a chat's worktrees and pull requests.
 *
 * Split out of `ChatView` because it is the one part of that component that is
 * pure and worth asserting: the ordering rules (which worktree is "primary")
 * and the reconciliation between what the CHAT recorded and what the live
 * catalogs still hold are exactly where this has been wrong before — a chat
 * with one worktree used to render its branch AND a "+1" counting that same
 * branch a second time.
 */
import type { Chat, PRInfo, PRRef, WorktreeInfo } from "@dispatch/shared";
import { samePath, worktreeMatchesChat } from "../panels/panelBus.js";
import type { ChatWorktreeRef } from "./ChatHeaderBadges.js";

/**
 * The branch a worktree path implies, for a worktree the catalog no longer has.
 *
 * A guess — the directory leaf with its first `-` read back as the `/` that
 * `worktree create` flattened — and the only thing available once the worktree
 * is gone, since its real branch name lived in the catalog row that went with
 * it. Wrong only for a branch whose first segment genuinely contains a dash.
 */
export function branchFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const leaf = path.split(/[\\/]/).pop() ?? path;
  return leaf.replace(/^[a-z]+-/, (m) => `${m.slice(0, -1)}/`);
}

/**
 * Every worktree this chat has ever owned, primary first.
 *
 * "Primary" is the first LIVE worktree whose branch hasn't merged, so a merged
 * primary auto-promotes the next live one to the header chip; when every live
 * worktree has merged, the first still leads. Removed worktrees never lead —
 * the chip is meant to say where the work is now, and a directory that no
 * longer exists is not an answer — but they stay in the list, because the
 * roster's whole job is that the record survives the cleanup.
 */
export function chatWorktreeRefs(
  chat: Chat,
  live: WorktreeInfo[],
  isMerged: (branch: string) => boolean,
): ChatWorktreeRef[] {
  const mine = live.filter((w) => worktreeMatchesChat(w, chat));
  const primary = mine.find((w) => !isMerged(w.branch)) ?? mine[0];
  const ordered = primary ? [primary, ...mine.filter((w) => w.path !== primary.path)] : mine;
  const removed = chat.worktrees.filter((p) => !mine.some((w) => samePath(w.path, p)));
  return [
    ...ordered.map((w) => ({
      branch: w.branch,
      path: w.path,
      live: true,
      merged: isMerged(w.branch),
    })),
    ...removed.map((p) => {
      const branch = branchFromPath(p) ?? p;
      return { branch, path: p, live: false, merged: isMerged(branch) };
    }),
  ];
}

/**
 * Every PR this chat has opened, most recently touched first (the order the
 * server keeps `Chat.prs` in), with each one's state refreshed from the live PR
 * catalog.
 *
 * The refresh matters: `Chat.prs[].state` is written when the ref is attached
 * and again whenever `create_pr`/an update re-attaches it, so a PR that merged
 * while the chat sat idle keeps whatever it was last written as. The catalog is
 * the thing that is actually tracked, so where it has an opinion it wins.
 */
export function chatPrRefs(chat: Chat, live: PRInfo[]): PRRef[] {
  return chat.prs.map((pr) => {
    // On `repo#number` when both sides name a repo, never on the number alone:
    // PR numbers restart at 1 per repository, and a chat CAN ship to more than
    // one (`create_pr` resolves the repo from the cwd it was called in). Two
    // rows numbered #3 would both take the first #3 in the catalog, and one of
    // them would silently wear the other's state and title. Falls back to the
    // number when either side has no repo — a `PRRef`'s and a `PRInfo`'s are
    // both optional, and a missing one shouldn't cost the refresh entirely.
    const tracked =
      live.find((p) => p.number === pr.number && p.repo && pr.repo && p.repo === pr.repo) ??
      live.find((p) => p.number === pr.number && (!p.repo || !pr.repo));
    return tracked ? { ...pr, state: tracked.state, title: pr.title ?? tracked.title } : pr;
  });
}
