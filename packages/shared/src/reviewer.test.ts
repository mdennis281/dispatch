import { describe, it, expect } from "vitest";
import { reviewerStatus, ReviewerCredentialSchema, prReviewAgentView } from "./reviewer.js";

describe("reviewerStatus — the one place the token is dropped", () => {
  it("never carries the token, whatever else it carries", () => {
    // This is the whole security property of the reviewer endpoints: the token
    // is write-only across the wire. If a field is ever added to the credential
    // and spread into the status by accident, this is what catches it.
    const status = reviewerStatus({
      login: "dispatch-reviewer",
      token: "github_pat_secret",
      addedAt: 10,
      verifiedAt: 20,
      verifiedLogin: "dispatch-reviewer",
    });
    expect(JSON.stringify(status)).not.toContain("github_pat_secret");
    expect(Object.keys(status).sort()).toEqual(
      ["addedAt", "configured", "login", "verifiedAt", "verifiedLogin"].sort(),
    );
  });

  it("reports an absent account as unconfigured rather than empty-ish", () => {
    expect(reviewerStatus(null)).toEqual({ configured: false });
    expect(reviewerStatus(undefined)).toEqual({ configured: false });
  });
});

describe("ReviewerCredentialSchema", () => {
  it("refuses a blank token — a stored empty secret reads as a corrupt file", () => {
    expect(
      ReviewerCredentialSchema.safeParse({ login: "x", token: "", addedAt: 1 }).success,
    ).toBe(false);
    expect(
      ReviewerCredentialSchema.safeParse({ login: "", token: "t", addedAt: 1 }).success,
    ).toBe(false);
  });
});

describe("prReviewAgentView — the reviewer's state on one PR", () => {
  it("says nothing at all when nobody has asked and nothing is in the way", () => {
    // The resting state of every PR in a project with no reviewer configured. A
    // chip here would be noise on every row and invisible on the one that matters.
    expect(prReviewAgentView(undefined)).toBeNull();
    expect(prReviewAgentView({ rounds: 0 })).toBeNull();
  });

  it("separates a review still running from one that finished", () => {
    // The bug this whole view exists for: `reviewedAt` is written at CLAIM time,
    // minutes before anything is posted and never cleared afterwards. Deriving
    // "in flight" from it alone marks every reviewed PR as permanently running.
    const claimed = { rounds: 1, reviewedAt: 1_000, maxRounds: 4, chatId: "c9" };
    expect(prReviewAgentView(claimed)).toMatchObject({
      phase: "running",
      round: 1,
      maxRounds: 4,
      chatId: "c9",
      at: 1_000,
    });
    expect(prReviewAgentView({ ...claimed, postedAt: 2_000, findings: 3 })).toMatchObject({
      phase: "reviewed",
      posted: true,
      findings: 3,
      at: 2_000,
    });
  });

  it("calls the last round spent, so the cap is not a silent stop", () => {
    const posted = { rounds: 4, reviewedAt: 1, postedAt: 2, maxRounds: 4 };
    expect(prReviewAgentView(posted)).toMatchObject({ phase: "spent", posted: true });
    // One under the cap is an ordinary result: another round can still follow.
    expect(prReviewAgentView({ ...posted, rounds: 3 })).toMatchObject({ phase: "reviewed" });
  });

  it("keeps the last round 'running' even at the cap, rather than guessing it died", () => {
    // A reviewer chat that died mid-run leaves exactly the row of one three
    // minutes into the diff. Calling the cap spent here would report a review
    // as finished on the strength of nothing at all; `running` links to the
    // chat, which is where the difference is actually visible.
    expect(prReviewAgentView({ rounds: 2, reviewedAt: 5, maxRounds: 2 })).toMatchObject({
      phase: "running",
      posted: false,
      round: 2,
    });
  });

  it("holds off on a cap it does not know", () => {
    // `maxRounds` is absent on rows written before it was recorded. Guessing a
    // denominator would turn "we don't know" into a claim that the reviewer is done.
    expect(prReviewAgentView({ rounds: 9, reviewedAt: 1, postedAt: 2 })).toMatchObject({
      phase: "reviewed",
      maxRounds: undefined,
    });
  });

  it("ranks a blocking problem above every other phase", () => {
    // The reviewer is disabled, not degraded — so "reviewed 2/4" would be a
    // report about a round that is never coming.
    expect(
      prReviewAgentView({
        rounds: 2,
        reviewedAt: 1,
        postedAt: 2,
        maxRounds: 4,
        problem: "no reviewer account is set up",
      }),
    ).toMatchObject({ phase: "blocked", problem: "no reviewer account is set up" });
  });

  it("ranks an outstanding request above the last finished round", () => {
    // A claim clears the request, so one being present means the row is waiting
    // on the next sweep rather than resting on its last verdict.
    expect(
      prReviewAgentView({ rounds: 1, reviewedAt: 1, postedAt: 2, requestedAt: 9, maxRounds: 4 }),
    ).toMatchObject({ phase: "queued", at: 9 });
  });
});
