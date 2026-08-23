/**
 * The two resting markers a sidebar chat row wears to the LEFT of its title:
 * one for the child chats folded under it, one for the OS processes its branch
 * is holding.
 *
 * They carry no digits. Stacked in a ~14px gutter, two counts sit close enough
 * together to read as a single number — the same collision the old right-gutter
 * pair fought with corner badges, and in half the space there is no offset that
 * wins it. So the glyph carries the STATE in its colour and the count moves to
 * the tooltip, where it has room to say what it is actually counting.
 *
 * Pure, and split out of the row, so the colour rules can be tested without
 * rendering a sidebar — the same split `reviewLabel` and `navState` use.
 *
 * Class names are spelled out as literals rather than built from a token name:
 * Tailwind scans source for LITERAL candidates, so a `text-${tint}` template
 * compiles to no CSS and the failure mode is an invisible glyph. Same reason
 * `StatusDot`'s tone table is written out longhand.
 */
import type { Chat } from "@dispatch/shared";
import { foldedReviewsLabel } from "./reviewLabel.js";

/** A branch's process census, as `branchProcessCount` returns it. */
export interface BranchProcs {
  /** The session subprocess and every MCP server under it. */
  session: number;
  /** Background shells this branch started — dev servers, watchers. */
  shells: number;
}

/**
 * Colour for the child-chats glyph.
 *
 * Three states the row is asked for — nothing (faint), children at rest
 * (ordinary text), a child mid-turn (the brand accent) — plus `warn`, which
 * survives from the badge this replaced. A child stopped on a question is the
 * one fact the collapsed row cannot afford to swallow: the parent's own
 * attention dot says nothing about its children, so without this the only
 * signal that somebody is waiting on you is behind a click.
 */
export function childChatTint(reviews: readonly Chat[], needsInput: boolean): string {
  if (needsInput) return "text-warn";
  if (reviews.some((r) => r.status === "running")) return "text-accent";
  return reviews.length > 0 ? "text-secondary" : "text-faint";
}

/** What the child-chats glyph says on hover, count included. */
export function childChatTitle(reviews: readonly Chat[], needsInput: boolean): string {
  if (reviews.length === 0) return "No child chats";
  const running = reviews.filter((r) => r.status === "running").length;
  const note = needsInput
    ? "needs an answer"
    : running > 0
      ? `${running} running`
      : "none running";
  return `${foldedReviewsLabel(reviews)} — ${note}`;
}

/**
 * Colour for the terminal glyph, which stands for BOTH kinds of process.
 *
 * They used to be two glyphs side by side, and the pair spent 40px of gutter to
 * say something one glyph can say in a colour: blue for the session processes
 * the app reclaims on its own, green for the background shells nothing reclaims
 * for you, and violet when the row is holding both. Violet is the mix, not a
 * third meaning — it is the same "and" the two-icon version drew by sitting
 * next to each other.
 */
export function processTint({ session, shells }: BranchProcs): string {
  if (session > 0 && shells > 0) return "text-accent-2";
  if (session > 0) return "text-info";
  if (shells > 0) return "text-success";
  return "text-faint";
}

/** What the terminal glyph says on hover — the counts the glyph no longer prints. */
export function processTitle({ session, shells }: BranchProcs): string {
  const parts: string[] = [];
  if (shells > 0) parts.push(`${shells} background shell${shells === 1 ? "" : "s"}`);
  if (session > 0) parts.push(`${session} session process${session === 1 ? "" : "es"}`);
  return parts.length > 0 ? parts.join(", ") : "No processes";
}
