import { describe, it, expect } from "vitest";
import {
  parseTitleMarks,
  stripTitleMarks,
  hasTitleMarks,
  titlePrefixOf,
  withTitlePrefix,
} from "./titles.js";

describe("parseTitleMarks", () => {
  it("returns one plain segment for a title with no marks", () => {
    expect(parseTitleMarks("Fix the flaky test")).toEqual([
      { text: "Fix the flaky test", accent: false },
    ]);
  });

  it("splits a leading marked prefix from the rest", () => {
    expect(parseTitleMarks("**MCP server**: testing creating an mcp chat")).toEqual([
      { text: "MCP server", accent: true },
      { text: ": testing creating an mcp chat", accent: false },
    ]);
  });

  it("handles a mark in the middle and at the end", () => {
    expect(parseTitleMarks("bump **zod** to **4**")).toEqual([
      { text: "bump ", accent: false },
      { text: "zod", accent: true },
      { text: " to ", accent: false },
      { text: "4", accent: true },
    ]);
  });

  it("never emits empty segments", () => {
    for (const seg of parseTitleMarks("**a**b**c**")) expect(seg.text).not.toBe("");
  });

  it("leaves an unclosed mark as literal text", () => {
    // A rename box is a text input; half-typed emphasis must not vanish.
    expect(parseTitleMarks("**half done")).toEqual([{ text: "**half done", accent: false }]);
  });

  it("returns nothing for an empty title", () => {
    expect(parseTitleMarks("")).toEqual([]);
  });
});

describe("stripTitleMarks", () => {
  it("removes the markers and keeps the words", () => {
    expect(stripTitleMarks("**sweep**: 12 files on main")).toBe("sweep: 12 files on main");
  });

  it("is a no-op on an unmarked title", () => {
    expect(stripTitleMarks("Fix the flaky test")).toBe("Fix the flaky test");
  });

  it("round-trips with parse", () => {
    const title = "**agent**: sql migration reviewer";
    expect(parseTitleMarks(title).map((s) => s.text).join("")).toBe(stripTitleMarks(title));
  });
});

describe("hasTitleMarks", () => {
  it("is stateless across calls", () => {
    // Guards the /g regex's lastIndex — a stateful check alternates true/false.
    expect(hasTitleMarks("**a**: b")).toBe(true);
    expect(hasTitleMarks("**a**: b")).toBe(true);
    expect(hasTitleMarks("plain")).toBe(false);
  });
});

describe("titlePrefixOf", () => {
  it("reads a leading marked prefix", () => {
    expect(titlePrefixOf("**MCP server**: testing")).toBe("MCP server");
  });

  it("ignores emphasis that isn't a leading prefix", () => {
    expect(titlePrefixOf("bump **zod** to 4")).toBeNull();
    expect(titlePrefixOf("**not a prefix** without a colon")).toBeNull();
  });

  it("returns null for an unmarked title", () => {
    expect(titlePrefixOf("Fix the flaky test")).toBeNull();
  });
});

describe("withTitlePrefix", () => {
  it("composes the canonical shape", () => {
    expect(withTitlePrefix("sweep", "12 files on main")).toBe("**sweep**: 12 files on main");
  });

  it("drops to just the prefix when there's no subject", () => {
    expect(withTitlePrefix("commit sweep", "")).toBe("**commit sweep**");
  });

  it("never nests marks when re-applied to an already-prefixed title", () => {
    const once = withTitlePrefix("sweep", "12 files");
    expect(withTitlePrefix("sweep", once)).toBe("**sweep**: sweep: 12 files");
    expect(titlePrefixOf(withTitlePrefix("sweep", once))).toBe("sweep");
  });

  it("falls back to the bare subject when the prefix is empty", () => {
    expect(withTitlePrefix("", "12 files")).toBe("12 files");
  });
});
