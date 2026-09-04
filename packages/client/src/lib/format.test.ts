import { describe, expect, it } from "vitest";
import { dur } from "./format.js";

describe("dur", () => {
  it("keeps sub-second and sub-minute spans as they were", () => {
    expect(dur(undefined)).toBeNull();
    expect(dur(0)).toBe("0ms");
    expect(dur(840)).toBe("840ms");
    expect(dur(1200)).toBe("1.2s");
    expect(dur(45_000)).toBe("45s");
  });

  it("steps up to minutes and hours instead of piling on seconds", () => {
    // The turn footer showed `9225s` for a two-and-a-half-hour turn.
    expect(dur(9_225_000)).toBe("2h 33m");
    expect(dur(134_000)).toBe("2m 14s");
    expect(dur(120_000)).toBe("2m");
    expect(dur(3_600_000)).toBe("1h");
  });

  it("rolls a rounded 60 up rather than printing it", () => {
    expect(dur(59_600)).toBe("1m");
    expect(dur(3_599_600)).toBe("1h");
  });
});
