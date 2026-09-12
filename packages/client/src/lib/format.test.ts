import { describe, expect, it } from "vitest";
import { countdown, dur } from "./format.js";

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

describe("countdown", () => {
  const now = 1_700_000_000_000;

  it("counts in seconds, where `untilShort` only ever says <1m", () => {
    // The whole reason it exists: the reconnect backoff is capped at 10s, so
    // every value the connection card hands it used to render as "<1m" while a
    // 1Hz ticker re-rendered that constant.
    expect(countdown(now + 3_000, now)).toBe("3s");
    expect(countdown(now + 10_000, now)).toBe("10s");
    expect(countdown(now + 59_400, now)).toBe("59s");
  });

  it("says `now` rather than 0s, and never goes negative", () => {
    expect(countdown(now + 400, now)).toBe("now");
    expect(countdown(now, now)).toBe("now");
    expect(countdown(now - 5_000, now)).toBe("now");
  });

  it("hands anything past a minute back to untilShort", () => {
    expect(countdown(now + 90_000, now)).toBe("1m");
    expect(countdown(now + 3_600_000, now)).toBe("1h");
  });
});
