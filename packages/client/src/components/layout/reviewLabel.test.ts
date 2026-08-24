import { describe, it, expect } from "vitest";
import type { Chat } from "@dispatch/shared";
import { foldedChildrenLabel, foldedReviewsLabel } from "./reviewLabel.js";

/** A reviewer chat pointed at one PR, the way `launchAgentTask` records it. */
function reviewer(id: string, reviewOf?: string, label?: string): Chat {
  return {
    id,
    projectId: "p1",
    title: "review",
    createdAt: 0,
    updatedAt: 0,
    ...(reviewOf ? { reviewOf } : {}),
    ...(label ? { purpose: { kind: "pr:review" as const, label } } : {}),
  } as Chat;
}

describe("foldedReviewsLabel — what the collapsed reviewer rows say", () => {
  it("names the PRs when a chat's reviews span more than one", () => {
    // The finding this exists for: 4 reviewers under a cap of 2 reads as the cap
    // being broken. It isn't — the cap is per PR, this count is per chat, and
    // the chat opened two PRs. The label has to make that legible without the
    // click that expands the rows.
    const label = foldedReviewsLabel([
      reviewer("r1", "o/r#129"),
      reviewer("r2", "o/r#129"),
      reviewer("r3", "o/r#140"),
      reviewer("r4", "o/r#140"),
    ]);
    expect(label).toBe("4 reviews — 2 of #129, 2 of #140");
  });

  it("does not repeat itself when every review is of the same PR", () => {
    expect(foldedReviewsLabel([reviewer("r1", "o/r#140"), reviewer("r2", "o/r#140")])).toBe(
      "2 reviews of #140",
    );
    expect(foldedReviewsLabel([reviewer("r1", "o/r#140")])).toBe("1 review of #140");
  });

  it("orders by PR number rather than by the order the chats arrived", () => {
    expect(
      foldedReviewsLabel([reviewer("r1", "o/r#140"), reviewer("r2", "o/r#9")]),
    ).toBe("2 reviews — 1 of #9, 1 of #140");
  });

  it("reads the legacy purpose label for reviewers spawned before `reviewOf`", () => {
    expect(foldedReviewsLabel([reviewer("r1", undefined, "Reviewing PR #7 in o/r")])).toBe(
      "1 review of #7",
    );
  });

  it("counts a reviewer it cannot attribute rather than dropping it", () => {
    // A breakdown that doesn't add up to the total is worse than one that admits
    // what it doesn't know.
    expect(foldedReviewsLabel([reviewer("r1", "o/r#12"), reviewer("r2")])).toBe(
      "2 reviews — 1 of #12, 1 unattributed",
    );
    // Nothing attributable at all: the plain count IS the whole truth, and
    // "— 2 unattributed" would be machinery talking about itself.
    expect(foldedReviewsLabel([reviewer("r1"), reviewer("r2")])).toBe("2 reviews");
  });

  it("handles the empty case the row never renders", () => {
    expect(foldedReviewsLabel([])).toBe("0 reviews");
  });
});

describe("foldedChildrenLabel — the same sentence once spawned chats can be folded too", () => {
  /** A chat another chat spawned: no PR, nothing to break down by. */
  const spawn = (id: string): Chat =>
    ({
      id,
      projectId: "p1",
      title: "Sleeper 1 — 10s nap",
      createdAt: 0,
      updatedAt: 0,
      parentChatId: "parent",
      purpose: { kind: "spawned" as const },
    }) as Chat;

  it("leaves a reviewer-only branch's wording exactly as it was", () => {
    // PR nesting shipped first and this wording was tuned against real data.
    // Rewording it here would be this change altering a feature it only sits
    // beside — which is the one thing it was asked not to do.
    expect(foldedChildrenLabel([reviewer("r1", "o/r#140"), reviewer("r2", "o/r#140")])).toBe(
      "2 reviews of #140",
    );
    expect(
      foldedChildrenLabel([reviewer("r1", "o/r#129"), reviewer("r2", "o/r#140")]),
    ).toBe("2 reviews — 1 of #129, 1 of #140");
    expect(foldedChildrenLabel([])).toBe("0 reviews");
  });

  it("counts spawned chats and stops there", () => {
    // There is no `#140` for a spawned chat and no equivalent — its identity is
    // its title, which the expanded row already shows.
    expect(foldedChildrenLabel([spawn("s1")])).toBe("1 chat");
    expect(foldedChildrenLabel([spawn("s1"), spawn("s2"), spawn("s3")])).toBe("3 chats");
  });

  it("names both halves when a branch holds each kind", () => {
    expect(
      foldedChildrenLabel([reviewer("r1", "o/r#140"), spawn("s1"), spawn("s2")]),
    ).toBe("1 review of #140 and 2 chats");
  });

  it("still calls an unattributable reviewer a review, not a chat", () => {
    // It is a reviewer that cannot say WHAT it reviewed. Splitting on the PR key
    // would file it with the spawned chats and report "1 chat" — a wrong answer
    // stated confidently, where "1 unattributed" admits what it doesn't know.
    const unnamed = reviewer("r2", undefined, "Reviewing a pull request");
    expect(foldedChildrenLabel([reviewer("r1", "o/r#12"), unnamed])).toBe(
      "2 reviews — 1 of #12, 1 unattributed",
    );
  });
});
