import { describe, expect, it } from "vitest";
import {
  codexCompactNote,
  compactCommand,
  normalizeCompactFocus,
  perModelThreshold,
} from "./compact.js";

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
    // Settings hold the picker alias; the live session reports the wire id.
    expect(perModelThreshold(table, "claude-opus-4-8")).toBeUndefined();
    expect(perModelThreshold({ "claude-opus-4-8[1m]": 1 }, "claude-opus-4-8")).toBe(1);
    expect(perModelThreshold({ "claude-opus-4-8": 2 }, "claude-opus-4-8[1m]")).toBe(2);
  });

  it("is undefined for a model with no row — compact at its own max", () => {
    expect(perModelThreshold(table, "sonnet")).toBeUndefined();
    expect(perModelThreshold({}, "opus[1m]")).toBeUndefined();
  });
});
