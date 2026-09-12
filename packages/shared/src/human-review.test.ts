import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_ANSWERS,
  QUESTION_NOTES_SEPARATOR,
  parseHumanReviewAnswer,
  readHumanReview,
} from "./human-review.js";

describe("parseHumanReviewAnswer", () => {
  it("reads each verdict label back, with and without a comment", () => {
    expect(parseHumanReviewAnswer(HUMAN_REVIEW_ANSWERS.approve)).toEqual({ verdict: "approve" });
    expect(
      parseHumanReviewAnswer(`${HUMAN_REVIEW_ANSWERS.stop}${QUESTION_NOTES_SEPARATOR}wrong approach`),
    ).toEqual({ verdict: "stop", comment: "wrong approach" });
  });

  it("keeps a comment that itself contains the separator whole", () => {
    const comment = `split${QUESTION_NOTES_SEPARATOR}here`;
    expect(
      parseHumanReviewAnswer(`${HUMAN_REVIEW_ANSWERS.iterate}${QUESTION_NOTES_SEPARATOR}${comment}`),
    ).toEqual({ verdict: "iterate", comment });
  });

  it("reads free-form prose as iterate — typing words is not pressing Approve", () => {
    expect(parseHumanReviewAnswer("looks mostly fine but fix the header")).toEqual({
      verdict: "iterate",
      comment: "looks mostly fine but fix the header",
    });
  });

  it("returns null when there is no answer at all", () => {
    expect(parseHumanReviewAnswer(undefined)).toBeNull();
    expect(parseHumanReviewAnswer("   ")).toBeNull();
  });
});

describe("readHumanReview", () => {
  const review = { title: "T", summary: "S", screenshots: [], previewUrl: "http://localhost:5173" };

  it("returns the payload of a review card and null for a plain question", () => {
    expect(readHumanReview({ questions: [], review })).toEqual(review);
    expect(readHumanReview({ questions: [] })).toBeNull();
  });

  it("rejects a non-http link, which would otherwise land in an href", () => {
    expect(readHumanReview({ review: { ...review, previewUrl: "javascript:alert(1)" } })).toBeNull();
  });
});
