import { describe, expect, it } from "vitest";
import { inferRecommendation, withRecommendationHeadline } from "./review-headline.js";

describe("review recommendation headline", () => {
  it("heads the summary with the emoji line the human scans for", () => {
    expect(withRecommendationHeadline("Nothing blocking.", "approve")).toBe(
      "### ✅ Approval recommended\n\nNothing blocking.",
    );
    expect(withRecommendationHeadline("Two findings.", "review")).toMatch(/^### ⚠️ Review recommended\n\n/);
    expect(withRecommendationHeadline("One blocker.", "changes")).toMatch(/^### ⛔ Changes recommended\n\n/);
  });

  it("stands alone when every finding is inline and the body is empty", () => {
    expect(withRecommendationHeadline("", "review")).toBe("### ⚠️ Review recommended");
  });

  // A reviewer on an older brief writes its own headline; stacking a second
  // one on top reads like two reviewers disagreeing.
  it("does not double up on a body that already carries a headline", () => {
    for (const body of ["⛔ Changes recommended\n\nx", "## ✅ Approval recommended", "⚠ Review recommended"]) {
      expect(withRecommendationHeadline(body, "approve")).toBe(body);
    }
  });

  it("infers a recommendation for a call that named none", () => {
    expect(inferRecommendation("REQUEST_CHANGES", 2)).toBe("changes");
    expect(inferRecommendation("COMMENT", 1)).toBe("review");
    expect(inferRecommendation("COMMENT", 0)).toBe("approve");
  });
});
