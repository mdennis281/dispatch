/**
 * How a chat's folded child rows describe themselves while COLLAPSED.
 *
 * Extracted from the sidebar row so it can be tested without rendering one —
 * the same split `navState` uses next door.
 */
import { parsePrRecordKey } from "@dispatch/shared";
import type { Chat } from "@dispatch/shared";
import { isReviewerChat, reviewTargetKey } from "../../stores/chats.js";

/**
 * `4 reviews`, plus which pull requests they belong to.
 *
 * The bare count reads as a broken round cap, and it is not one: the cap is per
 * PULL REQUEST and this count is per CHAT, so a chat that opened two PRs shows
 * two capped runs added together. Seen on a chat sitting at `4 reviews` under a
 * cap of 2 — `#129 #129 #140 #140` once expanded, which is only visible after
 * the click this label exists to save.
 *
 * A reviewer whose PR cannot be named (a chat too old to carry `reviewOf`, whose
 * `purpose.label` no longer parses) is counted and left unattributed rather than
 * dropped: a breakdown that doesn't add up to the total is worse than one that
 * admits what it doesn't know.
 */
export function foldedReviewsLabel(reviews: readonly Chat[]): string {
  const total = `${reviews.length} review${reviews.length === 1 ? "" : "s"}`;
  const byPr = new Map<number, number>();
  let unattributed = 0;
  for (const r of reviews) {
    const key = reviewTargetKey(r);
    const number = key ? parsePrRecordKey(key)?.number : undefined;
    if (number == null) unattributed += 1;
    else byPr.set(number, (byPr.get(number) ?? 0) + 1);
  }
  // Nothing attributable: the plain count is the whole truth, and "— 3
  // unattributed" would be machinery talking about itself.
  if (byPr.size === 0) return total;
  // One PR is the ordinary case, and there the breakdown IS the total — saying
  // "2 reviews — 2 of #140" spends a clause repeating itself.
  if (byPr.size === 1 && unattributed === 0) return `${total} of #${[...byPr.keys()][0]}`;
  const parts = [...byPr.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, n]) => `${n} of #${number}`);
  if (unattributed) parts.push(`${unattributed} unattributed`);
  return `${total} — ${parts.join(", ")}`;
}

/**
 * The same sentence for a branch whose children are not all reviewers.
 *
 * A reviewer-only branch is handed STRAIGHT to {@link foldedReviewsLabel}, so
 * the string a review row has always produced is the string it still produces —
 * PR nesting shipped first and its wording was tuned against real data, and
 * "2 reviews of #140" becoming "2 children — …" would be this change quietly
 * rewriting a feature it was only supposed to sit beside.
 *
 * Spawned chats have nothing to break down by. There is no `#140` for them and
 * no equivalent — a spawned chat's identity is its title, which is on the row
 * itself the moment you expand — so they count and stop there.
 */
export function foldedChildrenLabel(children: readonly Chat[]): string {
  const reviews = children.filter(isReviewerChat);
  const spawned = children.length - reviews.length;
  if (spawned === 0) return foldedReviewsLabel(reviews);
  const chats = `${spawned} chat${spawned === 1 ? "" : "s"}`;
  return reviews.length === 0 ? chats : `${foldedReviewsLabel(reviews)} and ${chats}`;
}
