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

  it("carries a problem alongside a round that actually happened, rather than hiding it", () => {
    // This used to rank `blocked` above everything, on the reasoning that the
    // reviewer is disabled so any other phase describes a round that is never
    // coming. That reasoning does not survive `resolveReviewer`'s newer
    // complaint — the reviewer being absent from `pr.reviewers` leaves it able
    // to run, it just never starts by itself — and it was never true of a round
    // that had already POSTED. A round with a `postedAt` happened; reporting it
    // as `blocked, posted: false` denied review evidence that exists.
    expect(
      prReviewAgentView({
        rounds: 2,
        reviewedAt: 1,
        postedAt: 2,
        maxRounds: 4,
        problem: "no reviewer account is set up",
      }),
    ).toMatchObject({
      phase: "reviewed",
      posted: true,
      problem: "no reviewer account is set up",
    });
  });

  it("lets a live round outrank a standing complaint — the phase `spentReviewRounds` reads", () => {
    // The regression this guards is PR #147's with a different cause. A project
    // whose reviewer is missing from `pr.reviewers` has `problem` mirrored onto
    // EVERY open row by `notePolicy`, but a round requested by hand still runs.
    // Short-circuiting on the problem made `running` unreachable there, and
    // `spentReviewRounds` derives `inFlight` from exactly that phase — so
    // `watch_pr` would announce that nothing is coming over a reviewer mid-diff,
    // and `request_review`'s in-flight guard would let `extraRounds` put a
    // second reviewer on the same diff.
    const problem = "`workflow.pr.reviewers` does not list that account";
    expect(prReviewAgentView({ rounds: 1, reviewedAt: 9, maxRounds: 2, problem })).toMatchObject({
      phase: "running",
      problem,
    });
    expect(prReviewAgentView({ rounds: 0, requestedAt: 7, maxRounds: 2, problem })).toMatchObject({
      phase: "queued",
      problem,
    });
    // With nothing in flight it IS the whole answer, and still says so.
    expect(prReviewAgentView({ rounds: 0, maxRounds: 2, problem })).toMatchObject({
      phase: "blocked",
      problem,
    });
  });

  it("blocks on a refused review request, not just an unresolvable identity", () => {
    // GitHub refusing to queue the reviewer is total in `dedicated` mode: that
    // queue entry is the only trigger there is, so the PR reads as if no
    // reviewer were configured at all until this says otherwise.
    expect(
      prReviewAgentView({
        rounds: 0,
        requestError: "Reviews may only be requested from collaborators",
      }),
    ).toMatchObject({
      phase: "blocked",
      problem: "Reviews may only be requested from collaborators",
    });
  });

  it("names the cause over the symptom when both are recorded", () => {
    // An identity that does not resolve is WHY no request was attempted, so
    // reporting GitHub's refusal of some older attempt would mislead.
    expect(
      prReviewAgentView({
        rounds: 0,
        problem: "no reviewer account is set up",
        requestError: "Reviews may only be requested from collaborators",
      }),
    ).toMatchObject({ phase: "blocked", problem: "no reviewer account is set up" });
  });

  it("reports a spent cap on every phase, not just the one it is named after", () => {
    // `roundsSpent` is the mechanical fact — `claimReviewAgent` refuses on
    // exactly this comparison — and it has to survive the phase ranking above
    // it. A final round that was claimed and never posted reads as `running`
    // forever, and that is precisely the row `watch_pr` used to block on for
    // half an hour waiting for a round that could not be claimed.
    expect(prReviewAgentView({ rounds: 2, reviewedAt: 5, maxRounds: 2 })).toMatchObject({
      phase: "running",
      roundsSpent: true,
    });
    expect(prReviewAgentView({ rounds: 2, reviewedAt: 1, postedAt: 2, maxRounds: 2 })).toMatchObject(
      { phase: "spent", roundsSpent: true },
    );
    // An outstanding request at the cap is the trap in the loop it fixes: the
    // request is real, and nothing will ever serve it.
    expect(
      prReviewAgentView({ rounds: 2, reviewedAt: 1, postedAt: 2, requestedAt: 9, maxRounds: 2 }),
    ).toMatchObject({ phase: "queued", roundsSpent: true });
    // Under the cap, and an unknown cap, both mean another round can follow.
    expect(prReviewAgentView({ rounds: 1, reviewedAt: 5, maxRounds: 2 })?.roundsSpent).toBe(false);
    expect(prReviewAgentView({ rounds: 9, reviewedAt: 1, postedAt: 2 })?.roundsSpent).toBe(false);
  });

  it("ranks an outstanding request above the last finished round", () => {
    // A claim clears the request, so one being present means the row is waiting
    // on the next sweep rather than resting on its last verdict.
    expect(
      prReviewAgentView({ rounds: 1, reviewedAt: 1, postedAt: 2, requestedAt: 9, maxRounds: 4 }),
    ).toMatchObject({ phase: "queued", at: 9 });
  });

  // PR #147, exactly. A `request_review` fired two minutes into a running round
  // armed `requestedAt` at the SAME head the round had already claimed. That
  // request can never be served — `claimReviewAgent` dedups on `reviewedSha` —
  // but it flipped this row to `queued`, and `spentReviewRounds` reads
  // `phase === "running"` to decide whether a review may still arrive. So
  // `watch_pr` announced "every round is spent, nothing is coming, go merge"
  // over a review that posted three minutes later with an open finding.
  it("does not let a request armed at the RUNNING round's own head mask it", () => {
    expect(
      prReviewAgentView({
        rounds: 2,
        reviewedSha: "sha-1",
        reviewedAt: 10,
        requestedSha: "sha-1",
        requestedAt: 20,
        maxRounds: 2,
      }),
    ).toMatchObject({ phase: "running", at: 10, roundsSpent: true });
  });

  it("still ranks a request at a NEW head above the round that read the old one", () => {
    // The genuine re-arm: a push moved the head, so this request really can be
    // served and the row really is waiting on the next sweep.
    expect(
      prReviewAgentView({
        rounds: 1,
        reviewedSha: "sha-1",
        reviewedAt: 10,
        requestedSha: "sha-2",
        requestedAt: 20,
        maxRounds: 4,
      }),
    ).toMatchObject({ phase: "queued", at: 20 });
  });

  // `extraRounds` is `request_review`'s per-PR override. It is a separate field
  // because `maxRounds` is rewritten from project config by `notePolicy` on every
  // sweep pass, so a raise parked there is erased within ~90 seconds.
  it("counts a per-PR extraRounds grant toward the cap it reports and enforces", () => {
    expect(
      prReviewAgentView({ rounds: 2, reviewedAt: 1, postedAt: 2, maxRounds: 2 }),
    ).toMatchObject({ roundsSpent: true, maxRounds: 2 });
    // Same row, one round granted: no longer spent, and the denominator every
    // surface shows is the EFFECTIVE cap — "2 of 3", not the nonsense "2 of 2
    // but keep going".
    expect(
      prReviewAgentView({ rounds: 2, reviewedAt: 1, postedAt: 2, maxRounds: 2, extraRounds: 1 }),
    ).toMatchObject({ roundsSpent: false, maxRounds: 3 });
  });

  it("reads a request over a FINISHED round at that head as queued, not hidden", () => {
    // The masking rule is scoped to a round still in flight. Once one has
    // posted, a request at that head is a real pending request — the row's head
    // is up to 90s stale, so a genuine post-push re-request routinely lands
    // there and IS served once the poll catches up. Hiding it would report a
    // round that is coming as one that isn't.
    expect(
      prReviewAgentView({
        rounds: 1,
        reviewedSha: "sha-1",
        reviewedAt: 10,
        postedAt: 30,
        requestedSha: "sha-1",
        requestedAt: 40,
        maxRounds: 4,
      }),
    ).toMatchObject({ phase: "queued", at: 40 });
  });
});
