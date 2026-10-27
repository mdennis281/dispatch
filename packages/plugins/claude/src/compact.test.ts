import { describe, expect, it } from "vitest";
import {
  CLAUDE_COMPACT_HEADROOM,
  CLAUDE_COMPACT_WINDOW_MAX,
  CLAUDE_COMPACT_WINDOW_MIN,
  claudeCompactWindow,
} from "./compact.js";

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
