import { describe, expect, it } from "vitest";
import {
  METRIC_DISPLAY_BUCKETS,
  approxBucketCount,
  coarsenBucket,
  coarsenWidth,
} from "./metrics-coarsen.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 6);

describe("coarsenBucket", () => {
  it("leaves a pick that fits alone — a full week of hours is 169 buckets", () => {
    expect(coarsenBucket("hour", NOW - 7 * DAY, NOW)).toEqual({ bucket: "hour", coarsened: null });
  });

  it("steps hourly over 30 days up to daily, and says how many hours it would have been", () => {
    const r = coarsenBucket("hour", NOW - 30 * DAY, NOW);
    expect(r.bucket).toBe("day");
    expect(r.coarsened).toEqual({ shown: "day", wanted: "hour", wantedBuckets: 721 });
  });

  it("skips widths that still overflow: daily over five years lands on monthly", () => {
    const r = coarsenBucket("day", NOW - 5 * 365 * DAY, NOW);
    // 1,826 days and 261 weeks both overflow 200; 61 months fits.
    expect(r.bucket).toBe("month");
    expect(r.coarsened?.wanted).toBe("day");
    expect(r.coarsened?.wantedBuckets).toBe(1826);
  });

  it("passes auto through — the server's auto already picks a readable width", () => {
    expect(coarsenBucket("auto", 0, NOW)).toEqual({ bucket: "auto", coarsened: null });
  });

  it("stops at monthly and reports nothing when even months overflow", () => {
    expect(coarsenBucket("month", NOW - 30 * 365 * DAY, NOW)).toEqual({
      bucket: "month",
      coarsened: null,
    });
  });

  it("never returns a width past the cap unless it is monthly", () => {
    for (const span of [DAY, 7 * DAY, 30 * DAY, 90 * DAY, 365 * DAY, 3 * 365 * DAY]) {
      for (const pick of ["hour", "day", "week"] as const) {
        const { width } = coarsenWidth(pick, NOW - span, NOW);
        if (width !== "month") {
          expect(approxBucketCount(width, NOW - span, NOW)).toBeLessThanOrEqual(
            METRIC_DISPLAY_BUCKETS,
          );
        }
      }
    }
  });

  it("honours a custom cap", () => {
    expect(coarsenWidth("day", NOW - 30 * DAY, NOW, 10).width).toBe("week");
  });
});
