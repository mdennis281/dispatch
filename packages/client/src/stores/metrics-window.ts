/**
 * Turning a range preset + a bucket pick into what a metrics request sends.
 *
 * Shared by the Usage, Runtime and Tokens stores, which used to each carry a
 * private `windowFor` — and all three sent `{}` for "All time". The usage and
 * span services read a missing `from` as "the last 30 days", so "All time" on
 * those two pages was quietly a month. (Tokens happened to be right: its
 * service anchors a missing `from` at the oldest row.)
 *
 * So the window is ALWAYS explicit now. For "All time" it starts at the
 * ledger's oldest row when the store knows it (every facets response carries
 * the ledger's range, whatever the filter), and at 0 when it does not — 0 is
 * still all time, it just leaves the server's auto bucket sizing to a 56-year
 * window, so stores fetch the range first in that case (see `metrics.ts`).
 *
 * The bucket is coarsened here too, against the same window, so the request
 * carries the width the chart will actually draw — see `metrics-coarsen.ts`.
 */
import {
  coarsenBucket,
  type BucketCoarsening,
  type MetricBucket,
} from "@dispatch/shared";
import { RANGE_PRESETS } from "./metrics.js";

export interface MetricWindow {
  from: number;
  to: number;
}

/**
 * The absolute window for a preset. `ledgerFrom` is the oldest row in the
 * ledger, or null when not yet known; only "All time" reads it.
 */
export function metricWindow(
  rangeId: string,
  ledgerFrom: number | null,
  now: number = Date.now(),
): MetricWindow {
  // `+1` so the window includes a row recorded this very millisecond — `to`
  // is exclusive on the server, and "now" is exactly when the newest row lands.
  const to = now + 1;
  const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[2]!;
  if (preset.ms !== null) return { from: to - 1 - preset.ms, to };
  return { from: Math.min(ledgerFrom ?? 0, to), to };
}

/** The window plus the bucket to send for it, and what that did to the pick. */
export function metricRequest(
  rangeId: string,
  bucket: MetricBucket,
  ledgerFrom: number | null,
  now: number = Date.now(),
): MetricWindow & { bucket: MetricBucket; coarsened: BucketCoarsening | null } {
  const win = metricWindow(rangeId, ledgerFrom, now);
  return { ...win, ...coarsenBucket(bucket, win.from, win.to) };
}
