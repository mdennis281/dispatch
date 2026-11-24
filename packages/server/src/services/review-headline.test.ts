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
  it("replaces a headline the reviewer wrote rather than stacking or trusting it", () => {
    expect(withRecommendationHeadline("⛔ Changes recommended\n\nx", "changes")).toBe(
      "### ⛔ Changes recommended\n\nx",
    );
    // The typed headline disagrees with the recommendation; the parameter wins.
    expect(withRecommendationHeadline("## ✅ Approval recommended\n\nx", "review")).toBe(
      "### ⚠️ Review recommended\n\nx",
    );
    expect(withRecommendationHeadline("⚠ Review recommended", "review")).toBe("### ⚠️ Review recommended");
  });

  // Reviewers flag what they couldn't check, and a ⚠️ is the natural way to
  // start that sentence. It is a caveat, not a headline.
  it("still adds the headline when the body merely opens with one of the emoji", () => {
    const body = "⚠️ Could not run the test suite; two findings inline.";
    expect(withRecommendationHeadline(body, "review")).toBe(`### ⚠️ Review recommended\n\n${body}`);
    expect(withRecommendationHeadline("✅ Tests pass, but see threads", "changes")).toMatch(
      /^### ⛔ Changes recommended\n\n✅ Tests pass/,
    );
  });

  it("infers a recommendation for a call that named none", () => {
    expect(inferRecommendation("REQUEST_CHANGES", 2)).toBe("changes");
    expect(inferRecommendation("COMMENT", 1)).toBe("review");
    expect(inferRecommendation("COMMENT", 0)).toBe("approve");
  });
});
