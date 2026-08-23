import { describe, it, expect } from "vitest";
import type { Chat } from "@dispatch/shared";
import { foldedReviewsLabel, foldedChildrenLabel } from "./reviewLabel.js";

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

describe("foldedChildrenLabel — a branch whose children aren't all reviewers", () => {
  const spawned = (id: string): Chat => ({
    ...reviewer(id),
    reviewOf: undefined,
    purpose: { kind: "spawned", label: "Spawned by chat p" },
  });

  it("reads exactly as before when every child is a reviewer", () => {
    // The common case must not gain a word. "3 chats — 3 reviews of #140" spends
    // two of them saying what "3 reviews of #140" already said.
    const all = [reviewer("r1", "o/r#140"), reviewer("r2", "o/r#140")];
    expect(foldedChildrenLabel(all)).toBe(foldedReviewsLabel(all));
    expect(foldedChildrenLabel(all)).toBe("2 reviews of #140");
  });

  it("uses the generic noun once a spawned chat is in the list", () => {
    expect(foldedChildrenLabel([reviewer("r1", "o/r#140"), spawned("s1")])).toBe(
      "2 chats — 1 review (1 of #140), 1 spawned",
    );
  });

  it("parenthesises the per-PR breakdown instead of nesting a second dash", () => {
    // "9 chats — 6 reviews — 2 of #148, 2 of #150, 3 spawned" put two dashes at
    // the same level and left the reader to work out which clause owned the last
    // one. Seen on a real branch.
    const children = [
      reviewer("a", "o/r#148"),
      reviewer("b", "o/r#148"),
      reviewer("c", "o/r#150"),
      spawned("s1"),
    ];
    expect(foldedChildrenLabel(children)).toBe(
      "4 chats — 3 reviews (2 of #148, 1 of #150), 1 spawned",
    );
  });

  it("drops the review clause entirely when nothing is a reviewer", () => {
    expect(foldedChildrenLabel([spawned("s1"), spawned("s2")])).toBe("2 chats — 2 spawned");
    expect(foldedChildrenLabel([spawned("s1")])).toBe("1 chat — 1 spawned");
  });
});
