/**
 * The one-line recommendation that heads every review `post_review` submits.
 *
 * The GitHub verdict alone cannot carry this. A non-blocking reviewer always
 * posts `COMMENT`, and GitHub downgrades `REQUEST_CHANGES` to `COMMENT` on your
 * own PR, so "fine to merge" and "please look at this" reach the page looking
 * exactly the same. The human scanning a PR wanted to know which one it was
 * without reading the whole summary.
 *
 * The server writes the headline instead of asking the reviewer to type it.
 * A prompt rule is one the model forgets on the rounds that matter most.
 */

export const REVIEW_RECOMMENDATIONS = ["approve", "review", "changes"] as const;
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number];

const HEADLINES: Record<ReviewRecommendation, string> = {
  approve: "✅ Approval recommended",
  review: "⚠️ Review recommended",
  changes: "⛔ Changes recommended",
};

/**
 * The recommendation to use when the reviewer named none. This keeps older
 * prompts and hand calls working: a blocking verdict means changes, any finding
 * means a human should look, and a review with no findings means approve.
 */
export function inferRecommendation(
  event: "COMMENT" | "REQUEST_CHANGES",
  findings: number,
): ReviewRecommendation {
  if (event === "REQUEST_CHANGES") return "changes";
  return findings > 0 ? "review" : "approve";
}

/**
 * A headline the reviewer typed itself, e.g. from following an older brief.
 * This matches the headline WORDING, not just the emoji. A body that opens with
 * "⚠️ Could not run the suite" is a caveat, and treating it as a headline would
 * post the review with none.
 */
const OWN_HEADLINE = /^\s*(?:#+\s*)?(?:✅\s*Approval|⚠️?\s*Review|⛔\s*Changes)\s+recommended[^\n]*\n*/iu;

/**
 * Put the headline above `body`. A headline the reviewer already wrote is
 * REPLACED, not kept. Keeping it would give two headlines, or a ✅ at the top of
 * a review whose recommendation says ⛔.
 */
export function withRecommendationHeadline(
  body: string,
  recommendation: ReviewRecommendation,
): string {
  const rest = body.replace(OWN_HEADLINE, "");
  const head = `### ${HEADLINES[recommendation]}`;
  return rest ? `${head}\n\n${rest}` : head;
}
