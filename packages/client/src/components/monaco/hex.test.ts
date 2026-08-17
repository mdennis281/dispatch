import { describe, expect, it } from "vitest";
import { expandHex, isMonacoHex, normalizeHex, withAlphaHex } from "./hex.js";

describe("expandHex", () => {
  it("expands 3- and 4-digit shorthand", () => {
    expect(expandHex("#fff")).toBe("#ffffff");
    expect(expandHex("#0A9")).toBe("#00AA99");
    expect(expandHex("#000c")).toBe("#000000cc");
  });

  it("leaves already-long hex alone", () => {
    expect(expandHex("#3fb950")).toBe("#3fb950");
    expect(expandHex("#3fb95014")).toBe("#3fb95014");
  });
});

describe("normalizeHex", () => {
  it("falls back for values that are not hex colours", () => {
    expect(normalizeHex("")).toBe("#ff00ff");
    expect(normalizeHex("rgba(255,255,255,0.07)")).toBe("#ff00ff");
    expect(normalizeHex("  ")).toBe("#ff00ff");
  });

  it("trims the leading space getPropertyValue returns", () => {
    expect(normalizeHex(" #0a0c0f")).toBe("#0a0c0f");
  });
});

describe("withAlphaHex", () => {
  /**
   * The regression this file exists for: a production CSS minifier rewrites
   * `--p-wash: #ffffff` to `#fff`, and the old code appended the two alpha
   * digits straight onto it. `#fff14` is six characters — a length Monaco's
   * parser rejects, and `Color.fromHex` answers a rejection with OPAQUE RED.
   * Every wash-derived slot (both scrollbar sliders, the diff diagonal fill,
   * indent guides, the current-line highlight) turned bright red.
   */
  it("survives a minifier-shortened token", () => {
    const out = withAlphaHex(normalizeHex("#fff"), "14");
    expect(out).toBe("#ffffff14");
    expect(isMonacoHex(out)).toBe(true);
  });

  it("replaces, rather than appends to, an alpha the token already carries", () => {
    expect(withAlphaHex("#000000cc", "0d")).toBe("#0000000d");
  });

  it("always yields something Monaco can parse", () => {
    for (const raw of ["#fff", "#ffffff", "#0f172a", "#000c", "", "rgba(0,0,0,.5)"]) {
      expect(isMonacoHex(withAlphaHex(normalizeHex(raw), "b0"))).toBe(true);
    }
  });
});
