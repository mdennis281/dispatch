/**
 * How a chat's folded child rows describe themselves while COLLAPSED.
 *
 * Extracted from the sidebar row so it can be tested without rendering one —
 * the same split `navState` uses next door.
 */
import { parsePrRecordKey } from "@dispatch/shared";
import type { Chat } from "@dispatch/shared";
import { reviewTargetKey } from "../../stores/chats.js";

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
  const byPr = prCounts(reviews);
  // Nothing attributable: the plain count is the whole truth, and "— 3
  // unattributed" would be machinery talking about itself.
  if (byPr.size === 0) return total;
  // One PR is the ordinary case, and there the breakdown IS the total — saying
  // "2 reviews — 2 of #140" spends a clause repeating itself.
  if (byPr.size === 1 && countUnattributed(reviews) === 0) {
    return `${total} of #${[...byPr.keys()][0]}`;
  }
  return `${total} — ${reviewBreakdown(reviews)}`;
}

/** How many reviews target each PR number. Reviews with no nameable PR are excluded. */
function prCounts(reviews: readonly Chat[]): Map<number, number> {
  const byPr = new Map<number, number>();
  for (const r of reviews) {
    const key = reviewTargetKey(r);
    const number = key ? parsePrRecordKey(key)?.number : undefined;
    if (number != null) byPr.set(number, (byPr.get(number) ?? 0) + 1);
  }
  return byPr;
}

const countUnattributed = (reviews: readonly Chat[]): number =>
  reviews.filter((r) => {
    const key = reviewTargetKey(r);
    return (key ? parsePrRecordKey(key)?.number : undefined) == null;
  }).length;

/**
 * `2 of #148, 2 of #150, 1 unattributed` — the per-PR half, without a total.
 *
 * A reviewer whose PR cannot be named is counted and left unattributed rather
 * than dropped: a breakdown that doesn't add up to the total is worse than one
 * that admits what it doesn't know.
 */
function reviewBreakdown(reviews: readonly Chat[]): string | null {
  const byPr = prCounts(reviews);
  if (byPr.size === 0) return null;
  const parts = [...byPr.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, n]) => `${n} of #${number}`);
  const unattributed = countUnattributed(reviews);
  if (unattributed) parts.push(`${unattributed} unattributed`);
  return parts.join(", ");
}

/** Is this chat one of its parent's REVIEWERS, rather than a chat it spawned? */
function isReviewer(chat: Chat): boolean {
  return chat.purpose?.kind === "pr:review" || chat.reviewOf !== undefined;
}

/**
 * The same label, for a branch whose children are no longer all reviewers.
 *
 * `spawn_chat` children file under their parent exactly as reviewers do, so the
 * folded row now stands in for a mixed list. An all-reviewer branch is still
 * the common case and still reads exactly as it did — {@link foldedReviewsLabel}
 * is delegated to untouched — because "3 chats — 3 reviews of #140" spends two
 * words to say what "3 reviews of #140" already said.
 *
 * Only a mixed or all-spawned branch gets the generic noun, and it names the
 * split rather than hiding it: the whole point of the folded label is to answer
 * "what is under here" without the click.
 */
export function foldedChildrenLabel(children: readonly Chat[]): string {
  const reviews = children.filter(isReviewer);
  const spawned = children.length - reviews.length;
  if (spawned === 0) return foldedReviewsLabel(reviews);
  const total = `${children.length} chat${children.length === 1 ? "" : "s"}`;
  const spawnedPart = `${spawned} spawned`;
  if (reviews.length === 0) return `${total} — ${spawnedPart}`;
  // PARENTHESISED, not delegated whole. `foldedReviewsLabel` already spends an
  // em-dash on its own breakdown, and nesting that inside this one produced
  // "9 chats - 6 reviews - 2 of #148, 2 of #150, 3 spawned": two dashes at the
  // same level, with the reader left to work out that the last clause belongs to
  // the outer one. Seen on a real branch before it was written this way.
  const reviewPart = `${reviews.length} review${reviews.length === 1 ? "" : "s"}`;
  const breakdown = reviewBreakdown(reviews);
  return `${total} — ${reviewPart}${breakdown ? ` (${breakdown})` : ""}, ${spawnedPart}`;
}
