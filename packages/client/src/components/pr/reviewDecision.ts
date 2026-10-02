/**
 * What GitHub's review decision MEANS, for every surface that reports it.
 *
 * Here for the same reason `checks.ts` is: two lists that disagree about
 * whether a pull request is approved are worse than either answer alone. The
 * mapping is small, but it is the mapping that has to be identical — the
 * tone especially, since "changes requested" reading red in one place and
 * amber in another is a difference a reader will try to interpret.
 *
 * `null`/absent is the case worth stating. GitHub reports no decision both for
 * a PR nobody has been asked to look at and for one whose reviewers have all
 * commented without voting, and on an OPEN pull request either of those is
 * still "waiting". On a merged or closed one it is nothing at all, which is why
 * `open` is a parameter rather than something the caller filters for.
 */
import type { ReviewDecision } from "@dispatch/shared";

export interface ReviewVerdict {
  /**
   * Narrowed to the four this actually returns, rather than the full chip
   * palette. That is what lets a caller rendering a DOT read the same mapping a
   * caller rendering a CHIP does — `Tone` carries members `DotTone` has no
   * equivalent for, so a wider type here would force one of the two to invent
   * its own colours, which is the drift this module exists to stop.
   */
  tone: "success" | "danger" | "warn" | "muted";
  label: string;
}

export function reviewVerdict(
  decision: ReviewDecision | null | undefined,
  open: boolean,
): ReviewVerdict | null {
  switch (decision) {
    case "approved":
      return { tone: "success", label: "approved" };
    case "changes_requested":
      return { tone: "danger", label: "changes requested" };
    case "review_required":
      return { tone: "warn", label: "review required" };
    default:
      return open ? { tone: "muted", label: "awaiting review" } : null;
  }
}
