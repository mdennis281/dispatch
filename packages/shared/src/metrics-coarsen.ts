/**
 * Coarsening a bucket width for DISPLAY, before anything is requested.
 *
 * `resolveBucket` (metrics.ts) already coarsens past {@link METRIC_MAX_BUCKETS}
 * — but that cap is a correctness bound for the server's gap-fill, not a
 * readable one. A thousand buckets is still a thousand bands, and a stacked bar
 * chart draws one rect per series per band: Hourly × 30 days × Top 8 + Other
 * was ~6,500 Recharts rects, all re-rendered on every tooltip hover. Growth
 * had no cap at all, and Daily × All time on a repo with a bogus 1970 commit
 * date built ~370k bars.
 *
 * So the client picks the width it will SHOW, here, and sends that. The server
 * then never computes the fine series at all, and the page says what it did —
 * "Showing weekly — daily would be 1,825 bars" — because a chart that quietly
 * shows less than was asked for reads as "that's all there was".
 *
 * Its own module rather than a few more lines in metrics.ts so it does not
 * collide with the server-side metrics work happening alongside it.
 */
import { METRIC_BUCKET_MS, type MetricBucket } from "./metrics.js";

/** A concrete bucket width — never "auto". */
export type MetricBucketWidth = "hour" | "day" | "week" | "month";

/**
 * Past roughly this many buckets a chart is a texture, not a reading — and the
 * render cost scales with buckets × series, so this is also the budget that
 * keeps a hover responsive. Matches the ~180 `resolveBucket`'s auto choice
 * already aims for, with a little slack so a full week of hours (169) fits.
 */
export const METRIC_DISPLAY_BUCKETS = 200;

/** Widths, finest first — the order coarsening steps through. */
const WIDTHS: readonly MetricBucketWidth[] = ["hour", "day", "week", "month"];

/** How a width reads in a sentence: "showing weekly". */
export const METRIC_BUCKET_ADJECTIVE: Record<MetricBucketWidth, string> = {
  hour: "hourly",
  day: "daily",
  week: "weekly",
  month: "monthly",
};

/**
 * About how many buckets of `width` the window `[from, to)` spans.
 *
 * Approximate on purpose (a month is 30 days) — it answers "does this fit" and
 * "roughly how many would it have been", and the note rounds for a human
 * anyway. Counted from the WINDOW, not from the data: the data can start later
 * than the window, but the server gap-fills between the first and last row, so
 * the window is the honest upper bound.
 */
export function approxBucketCount(width: MetricBucketWidth, from: number, to: number): number {
  const ms = width === "month" ? 30 * METRIC_BUCKET_MS.day : METRIC_BUCKET_MS[width];
  // `round`, not `ceil`: callers pass `to = now + 1` so the window includes
  // this millisecond, and `ceil` turned that one ms into a whole extra bucket
  // — "hourly would be 722 bars" for a 30-day window.
  return Math.round(Math.max(0, to - from) / ms) + 1;
}

/** What the coarsening did, for the note under the chart. */
export interface BucketCoarsening {
  /** The width actually requested and drawn. */
  shown: MetricBucketWidth;
  /** The width the reader picked. */
  wanted: MetricBucketWidth;
  /** About how many buckets `wanted` would have drawn. */
  wantedBuckets: number;
}

/**
 * Step `width` up (hour → day → week → month) until the window fits under
 * `cap` buckets. Month is the floor: if even months overflow (a 20-year
 * window), months are what you get, and nothing is reported as coarsened
 * because there was nothing coarser to step to.
 */
export function coarsenWidth(
  width: MetricBucketWidth,
  from: number,
  to: number,
  cap: number = METRIC_DISPLAY_BUCKETS,
): { width: MetricBucketWidth; coarsened: BucketCoarsening | null } {
  const start = WIDTHS.indexOf(width);
  for (let i = start; i < WIDTHS.length; i++) {
    const w = WIDTHS[i]!;
    if (approxBucketCount(w, from, to) <= cap || i === WIDTHS.length - 1) {
      return {
        width: w,
        coarsened:
          w === width
            ? null
            : { shown: w, wanted: width, wantedBuckets: approxBucketCount(width, from, to) },
      };
    }
  }
  return { width, coarsened: null };
}

/**
 * The bucket to SEND for a picked bucket and window.
 *
 * "auto" passes through untouched: the server's auto already chooses by
 * readability (≤ ~180 buckets), and sending a concrete width instead would
 * change what "auto" means for every other caller of the API.
 */
export function coarsenBucket(
  bucket: MetricBucket,
  from: number,
  to: number,
  cap: number = METRIC_DISPLAY_BUCKETS,
): { bucket: MetricBucket; coarsened: BucketCoarsening | null } {
  if (bucket === "auto") return { bucket, coarsened: null };
  const { width, coarsened } = coarsenWidth(bucket, from, to, cap);
  return { bucket: width, coarsened };
}
