import { describe, expect, it } from "vitest";
import {
  codexCompactNote,
  compactCommand,
  compactedEvent,
  compactedText,
  normalizeCompactFocus,
  perModelThreshold,
} from "./harness-compact.js";

describe("compactCommand", () => {
  it("is the bare slash command without a focus", () => {
    expect(compactCommand()).toBe("/compact");
    expect(compactCommand("   ")).toBe("/compact");
  });

  it("folds a multi-line focus onto the command line", () => {
    // A newline in the argument would read as a second user line to the SDK.
    expect(compactCommand(" keep the PR\n number ")).toBe("/compact keep the PR number");
  });
});

describe("normalizeCompactFocus", () => {
  it("returns undefined for empty input so callers can fall through to the default", () => {
    expect(normalizeCompactFocus(undefined)).toBeUndefined();
    expect(normalizeCompactFocus("")).toBeUndefined();
    expect(normalizeCompactFocus(" \n ")).toBeUndefined();
  });

  it("keeps a list's line structure — only the wire edges flatten", () => {
    expect(normalizeCompactFocus(" Keep:\n- PR #249\n- the failing test\n")).toBe(
      "Keep:\n- PR #249\n- the failing test",
    );
  });
});

describe("codexCompactNote", () => {
  it("frames the focus as guidance to the summary, not a task", () => {
    const note = codexCompactNote("the failing test");
    expect(note).toContain("the failing test");
    expect(note).toMatch(/not a new request/);
  });

  it("folds a multi-line focus into the one-line note", () => {
    expect(codexCompactNote("- PR #249\n- the failing test")).toContain(
      "preserves: - PR #249 - the failing test.",
    );
  });
});

describe("perModelThreshold", () => {
  const table = { "opus[1m]": 400_000, "gpt-6-astra": 150_000 };

  it("matches the picker id exactly", () => {
    expect(perModelThreshold(table, "gpt-6-astra")).toBe(150_000);
  });

  it("matches across a context-window suffix, the way findModel does", () => {
    expect(perModelThreshold({ "claude-opus-4-8[1m]": 1 }, "claude-opus-4-8")).toBe(1);
    expect(perModelThreshold({ "claude-opus-4-8": 2 }, "claude-opus-4-8[1m]")).toBe(2);
  });

  it("falls back to the family alias for a wire id the picker only offers as an alias", () => {
    // spawn_chat pins "claude-fable-5-1"; the catalogue lists it only as "fable".
    expect(perModelThreshold({ fable: 485_000 }, "claude-fable-5-1")).toBe(485_000);
    expect(perModelThreshold(table, "claude-opus-5-5[1m]")).toBe(400_000);
    // A row of its own still wins over the family.
    expect(perModelThreshold({ fable: 1, "claude-fable-5-1": 2 }, "claude-fable-5-1")).toBe(2);
    // Only a whole family name matches — "opus" is not "opusx".
    expect(perModelThreshold({ opusx: 1 }, "claude-opus-5-5")).toBeUndefined();
  });

  it("is undefined for a model with no row — compact at its own max", () => {
    expect(perModelThreshold(table, "sonnet")).toBeUndefined();
    expect(perModelThreshold({}, "opus[1m]")).toBeUndefined();
  });
});

describe("compactedEvent / compactedText", () => {
  it("reads the SDK's snake_case boundary metadata", () => {
    expect(compactedEvent({ trigger: "auto", pre_tokens: 99_776, post_tokens: 7_702 })).toEqual({
      type: "compacted",
      trigger: "auto",
      preTokens: 99_776,
      postTokens: 7_702,
    });
  });

  it("leaves out what is missing or malformed instead of guessing", () => {
    expect(compactedEvent(undefined)).toEqual({ type: "compacted" });
    expect(compactedEvent({ trigger: "weird", pre_tokens: "1", post_tokens: -5 })).toEqual({
      type: "compacted",
    });
  });

  it("says which trigger and how far it went", () => {
    expect(compactedText({ trigger: "auto", preTokens: 99_776, postTokens: 7_702 })).toBe(
      "Context auto-compacted · 100k → 8k tokens",
    );
    expect(compactedText({ trigger: "manual" })).toBe("Context compacted.");
    // Codex reports no sizes; the host supplies only the reading it started from.
    expect(compactedText({ preTokens: 56_628 })).toBe("Context compacted at 57k tokens");
    expect(compactedText({})).toBe("Context compacted.");
  });
});
