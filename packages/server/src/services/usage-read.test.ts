import { describe, expect, it } from "vitest";
import type { ResolvedSubscription } from "@dispatch/shared";
import { snapshotOfLimits } from "./usage-read.js";

const sub = { id: "codex-main", provider: "codex" } as ResolvedSubscription;

describe("snapshotOfLimits — reset credits", () => {
  // The limit history recorded Codex's reset credits for months while the
  // usage card, where someone would decide to spend one, never received them.
  it("carries the provider's reset-credit count to the card", () => {
    const snap = snapshotOfLimits(sub, { primary: { usedPercent: 40 }, resetCredits: 2 }, 1);
    expect(snap.resetCredits).toBe(2);
  });

  it("keeps a genuine zero — out of credits is information", () => {
    const snap = snapshotOfLimits(sub, { primary: { usedPercent: 40 }, resetCredits: 0 }, 1);
    expect(snap.resetCredits).toBe(0);
  });

  // Claude has no such thing; an absent count must not render as "0 left".
  it("omits the field when the provider reports no credits", () => {
    const snap = snapshotOfLimits(sub, { primary: { usedPercent: 40 } }, 1);
    expect("resetCredits" in snap).toBe(false);
  });
});
