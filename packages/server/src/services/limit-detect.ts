/**
 * What a change between two readings of one window MEANT.
 *
 * Pure, so every rule is a test case rather than a hope. The sampler reads each
 * account every few minutes; this decides, for consecutive readings of the
 * same window, whether the step between them was ordinary use, the window's
 * scheduled reset, or one of the things nobody announced — see
 * `LimitEventKind` in `shared/limit-history.ts` for the vocabulary.
 *
 * Both providers report WHOLE percents, so the thresholds below are in points
 * and deliberately coarse: a 1-point wobble is rounding, not news.
 */
import type { LimitEventKind } from "@dispatch/shared";

/** One reading of one window, as far as classification cares. */
export interface Seen {
  ts: number;
  percent: number;
  resetsAt: number | null;
}

/**
 * A reading taken this close BEFORE the announced reset already counts as past
 * it. Clocks disagree by seconds, and Claude reports `resets_at` rounded, so a
 * window read at 13:59:30 for a 14:00 reset has, for all purposes, reset.
 */
export const RESET_SLACK_MS = 2 * 60_000;

/**
 * Smallest fall in usage that counts as a DROP. One point is what integer
 * rounding of a fractional figure can produce between two reads with no real
 * change; two is not.
 */
export const DROP_MIN_POINTS = 2;

/** Below this a window is empty. */
const EMPTY = 0.5;

/**
 * How far an announced reset may move before it is news. Ten minutes, or 2% of
 * the window's length if that is more: a weekly window whose reset slides by an
 * hour is a provider recomputing, and flagging it would bury the day it moved.
 */
export function resetMoveTolerance(windowMinutes: number | null): number {
  return Math.max(10 * 60_000, (windowMinutes ?? 0) * 60_000 * 0.02);
}

/**
 * Classify the step from `prev` to `next` (same account, same window), or
 * null when it was ordinary use (or nothing at all).
 */
export function classifyStep(
  prev: Seen,
  next: Seen,
  windowMinutes: number | null,
): LimitEventKind | null {
  const tol = resetMoveTolerance(windowMinutes);
  const fell = prev.percent - next.percent;
  const emptied = next.percent < EMPTY && prev.percent >= 1;
  const dropped = fell >= DROP_MIN_POINTS || emptied;

  // The announced reset has come and gone between the two reads.
  if (prev.resetsAt !== null && next.ts >= prev.resetsAt - RESET_SLACK_MS) {
    // An empty window rolling over is not worth a row — a 5-hour window nobody
    // used resets four times a day.
    if (prev.percent < EMPTY) return null;
    // Either it fell, or it came back with a LATER reset time (a gap long
    // enough to span the reset AND refill past the old figure still shows as
    // a new reset time). Without either, the provider simply hasn't rolled the
    // window yet; the next read will see it.
    const rolled = next.resetsAt !== null && next.resetsAt > prev.resetsAt + RESET_SLACK_MS;
    return fell > 0 || rolled ? "reset" : null;
  }

  if (dropped) {
    // Same window or a restarted one? A restarted window comes back with a
    // different reset time — or none, which is how Claude reports a 5-hour
    // window nothing has opened yet.
    const sameWindow =
      prev.resetsAt !== null &&
      next.resetsAt !== null &&
      Math.abs(next.resetsAt - prev.resetsAt) <= tol;
    return sameWindow ? "drop" : "early_reset";
  }

  // Usage held or grew, but the deadline shifted. A window going from no reset
  // time to one is just a window opening (Claude starts the 5-hour clock on
  // first use), so only a change between two STATED times counts.
  if (
    prev.resetsAt !== null &&
    next.resetsAt !== null &&
    Math.abs(next.resetsAt - prev.resetsAt) > tol
  ) {
    return "reset_moved";
  }
  return null;
}

/**
 * Did the reading change enough to be worth a stored sample? Looser than
 * {@link classifyStep}: ANY change in percent is a new point on the line, and a
 * reset time that moved by more than a minute is too.
 */
export function readingChanged(prev: Seen, next: Seen): boolean {
  if (Math.abs(prev.percent - next.percent) >= 0.01) return true;
  if ((prev.resetsAt === null) !== (next.resetsAt === null)) return true;
  return prev.resetsAt !== null && Math.abs(prev.resetsAt - next.resetsAt!) > 60_000;
}
