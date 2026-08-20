import { describe, it, expect } from "vitest";
import {
  axisDuration,
  durationTicks,
  formatDuration,
  formatParallelism,
  formatShare,
  parallelism,
  share,
} from "./duration.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The labels a duration axis would actually print for a given peak value. */
const axisTicksFor = (peak: number) => durationTicks(peak).map(axisDuration);

describe("formatDuration", () => {
  it("keeps milliseconds below a second, where they are the measurement", () => {
    expect(formatDuration(990)).toBe("990ms");
    expect(formatDuration(1)).toBe("1ms");
  });

  it("reads at every scale this page actually shows", () => {
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(42 * SECOND)).toBe("42s");
    expect(formatDuration(14 * MINUTE + 20 * SECOND)).toBe("14m 20s");
    expect(formatDuration(3 * HOUR + 12 * MINUTE)).toBe("3h 12m");
    expect(formatDuration(2 * DAY + 7 * HOUR)).toBe("2d 7h");
  });

  it("omits a zero second unit rather than printing '3h 0m'", () => {
    expect(formatDuration(3 * HOUR)).toBe("3h");
    expect(formatDuration(14 * MINUTE)).toBe("14m");
    expect(formatDuration(2 * DAY)).toBe("2d");
  });

  it("carries instead of printing a rounded-up unit at its own ceiling", () => {
    // 14m 59.7s rounds to 60 seconds — "14m 60s" is not a duration.
    expect(formatDuration(14 * MINUTE + 59_700)).toBe("15m");
    expect(formatDuration(3 * HOUR + 59 * MINUTE + 50 * SECOND)).toBe("4h");
    expect(formatDuration(2 * DAY + 23 * HOUR + 59 * MINUTE)).toBe("3d");
  });

  it("never renders NaN or a negative — an empty window is 0s, not a bug on screen", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("axisDuration", () => {
  it("gives one unit and no space, for a 44px gutter", () => {
    expect(axisDuration(990)).toBe("990ms");
    expect(axisDuration(14 * MINUTE)).toBe("14m");
    expect(axisDuration(3 * HOUR + 12 * MINUTE)).toBe("3.2h");
    expect(axisDuration(36 * HOUR)).toBe("1.5d");
  });

  it("labels the baseline bare — a unit on zero carries nothing", () => {
    expect(axisDuration(0)).toBe("0");
  });

  it("drops a trailing .0 instead of printing '3.0h'", () => {
    expect(axisDuration(3 * HOUR)).toBe("3h");
    expect(axisDuration(5 * SECOND)).toBe("5s");
  });
});

describe("parallelism", () => {
  it("is attributed over busy, to the digits that actually vary", () => {
    expect(formatParallelism(112, 100)).toBe("1.12x");
    expect(formatParallelism(105, 100)).toBe("1.05x");
  });

  it("refuses to divide by an empty window rather than rendering NaNx", () => {
    expect(parallelism(0, 0)).toBeNull();
    expect(formatParallelism(0, 0)).toBe("—");
    expect(formatParallelism(500, 0)).toBe("—");
  });
});

describe("share", () => {
  it("guards the empty window's 0/0", () => {
    expect(share(0, 0)).toBe(0);
    expect(share(25, 100)).toBe(25);
  });

  it("never prints a real duration's share as a bare 0%", () => {
    // 2m of tool time in a seven-hour window is small, not absent — and the
    // difference is the whole reason someone scans this column.
    expect(formatShare(2 * MINUTE, 7 * HOUR)).toBe("<1%");
    expect(formatShare(0, 7 * HOUR)).toBe("0%");
    expect(formatShare(0, 0)).toBe("0%");
    expect(formatShare(1, 2)).toBe("50%");
  });
});

describe("durationTicks", () => {
  it("puts every tick on a boundary a human recognises", () => {
    // The failure this exists for: Recharts' own decimal-nice ticks over a
    // ~4h window gave 0 / 58m / 1.9h / 2.9h / 3.9h — three units, none of them
    // a time anybody thinks in.
    expect(axisTicksFor(3 * HOUR + 50 * MINUTE)).toEqual(["0", "1h", "2h", "3h", "4h"]);
    expect(axisTicksFor(42 * MINUTE)).toEqual(["0", "10m", "20m", "30m", "40m", "50m"]);
    expect(axisTicksFor(8 * SECOND)).toEqual(["0", "2s", "4s", "6s", "8s"]);
  });

  it("always reaches past the peak, so the top gridline is the domain", () => {
    for (const peak of [1, 999, 61_000, 3 * HOUR + 1, 9 * DAY]) {
      const ticks = durationTicks(peak);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(peak);
    }
  });

  it("keeps the gridline count readable at every scale", () => {
    for (const peak of [900, 45_000, 20 * MINUTE, 5 * HOUR, 40 * DAY]) {
      const ticks = durationTicks(peak);
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(8);
    }
  });

  it("gives a peak below the smallest step a baseline and one tick, not a spray", () => {
    // Nothing on this page plots a 5ms ceiling, but the axis has to answer for
    // one — and "0 and 100ms" is the honest answer when there is no boundary in
    // between to label.
    expect(axisTicksFor(5)).toEqual(["0", "100ms"]);
  });

  it("degrades to a single baseline rather than looping on an empty window", () => {
    expect(durationTicks(0)).toEqual([0]);
    expect(durationTicks(-1)).toEqual([0]);
    expect(durationTicks(Number.NaN)).toEqual([0]);
  });
});
