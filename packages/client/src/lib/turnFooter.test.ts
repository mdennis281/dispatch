import { describe, expect, it } from "vitest";
import type { ResultRow } from "@dispatch/shared";
import { turnFooter } from "./turnFooter.js";

const row = (over: Partial<ResultRow>): ResultRow => ({
  kind: "result",
  id: "r1",
  chatId: "c1",
  ts: 1_700_000_000_000,
  subtype: "success",
  isError: false,
  ...over,
});

describe("turnFooter", () => {
  it("reports loop steps and a readable duration, not turns and raw seconds", () => {
    const { parts } = turnFooter(row({ numTurns: 409, durationMs: 9_225_000 }));
    expect(parts).toEqual(["409 steps", "2h 33m"]);
  });

  it("puts the turn's own cost on the row and the session total in the note", () => {
    const { parts, note } = turnFooter(row({ numTurns: 1, turnCostUsd: 2.14, costUsd: 60.72 }));
    expect(parts).toEqual(["1 step", "$2.14"]);
    expect(note).toBe("This turn cost $2.14 · $60.72 for the chat so far, at API rates");
  });

  it("labels a running total \"total\" only when no per-turn cost was recorded", () => {
    const legacy = turnFooter(row({ numTurns: 1, costUsd: 60.72 }));
    expect(legacy.parts).toContain("$60.72 total");
    expect(legacy.note).toMatch(/wasn't recorded$/);
  });

  it("treats a free turn as a known zero, not as a missing measurement", () => {
    // `turnCostUsd: 0` is a MEASURED zero. Falling back to the legacy branch
    // would print the chat's running total as "$60.72 total" on a row that is
    // not legacy, contradicting its own note.
    const { parts, note } = turnFooter(row({ numTurns: 1, turnCostUsd: 0, costUsd: 60.72 }));
    expect(parts).toEqual(["1 step"]);
    expect(parts.join(" ")).not.toContain("total");
    expect(note).toBe("This turn cost $0.000 · $60.72 for the chat so far, at API rates");
  });
});
