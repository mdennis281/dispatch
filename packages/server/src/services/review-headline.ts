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
 * Put the headline above `body`. Does nothing when the body already starts with
 * one of the headline emoji: a reviewer that followed an older instruction and
 * wrote its own headline would otherwise get two.
 */
export function withRecommendationHeadline(
  body: string,
  recommendation: ReviewRecommendation,
): string {
  const trimmed = body.trimStart().replace(/^#+\s*/, "");
  if (/^(✅|⚠️?|⛔)/u.test(trimmed)) return body;
  const head = `### ${HEADLINES[recommendation]}`;
  return body ? `${head}\n\n${body}` : head;
}
