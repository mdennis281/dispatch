import { describe, expect, it } from "vitest";
import {
  CLAUDE_COMPACT_HEADROOM,
  CLAUDE_COMPACT_WINDOW_MAX,
  CLAUDE_COMPACT_WINDOW_MIN,
  claudeCompactWindow,
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

describe("claudeCompactWindow", () => {
  it("is undefined with neither a threshold nor a window — the CLI's own", () => {
    expect(claudeCompactWindow(undefined, undefined)).toBeUndefined();
  });

  it("puts the CLI's trigger AT the threshold by adding its headroom", () => {
    expect(claudeCompactWindow(100_000, undefined)).toBe(100_000 + CLAUDE_COMPACT_HEADROOM);
    expect(claudeCompactWindow(495_000, undefined)).toBe(528_000);
  });

  it("clamps into the range the CLI accepts rather than letting it drop the value", () => {
    expect(claudeCompactWindow(20_000, undefined)).toBe(CLAUDE_COMPACT_WINDOW_MIN);
    expect(claudeCompactWindow(990_000, undefined)).toBe(CLAUDE_COMPACT_WINDOW_MAX);
  });

  it("ignores a Settings window the CLI would ignore, and honours a valid one", () => {
    // The old "Reserve window" placeholder — always silently dropped by the CLI.
    expect(claudeCompactWindow(undefined, 20_000)).toBeUndefined();
    expect(claudeCompactWindow(200_000, 20_000)).toBe(233_000);
    expect(claudeCompactWindow(undefined, 400_000)).toBe(400_000);
    // Both set: the tighter one wins.
    expect(claudeCompactWindow(495_000, 400_000)).toBe(400_000);
    expect(claudeCompactWindow(100_000, 400_000)).toBe(133_000);
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
    expect(compactedText({})).toBe("Context compacted.");
  });
});
