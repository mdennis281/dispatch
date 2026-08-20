/**
 * Durations, formatted for the two places a duration appears.
 *
 * The runtime half of the ledger answers in MILLISECONDS, and a millisecond
 * count is unreadable at every scale this page actually shows: the same axis
 * carries a 990ms tool call and a four-hour sleep. `Intl.NumberFormat` is right
 * for the usage page's counts and wrong here — `19,847,213` is not a duration a
 * human reads, it is a receipt.
 *
 * TWO formatters, because the two jobs have opposite constraints:
 *
 *   {@link formatDuration}  a figure someone READS — a hero number, a table
 *                           cell, a tooltip row. Up to two units, so "3h 12m"
 *                           keeps the precision that matters and drops the
 *                           precision that doesn't.
 *   {@link axisDuration}    an axis TICK, where six of them sit stacked in 44px
 *                           of gutter. One unit, ever, and no space in it.
 *
 * Both are stepped on the same boundaries, so a tick reading `3.2h` and the
 * tooltip beside it reading `3h 12m` are visibly the same quantity.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Drop a trailing `.0` — "3.0h" is a decimal point doing nothing. */
function trim(n: number, places: number): string {
  return n.toFixed(places).replace(/\.0+$/, "");
}

/**
 * A duration as a reader wants it: "990ms", "42s", "14m 20s", "3h 12m", "2d 7h".
 *
 * At most two units, and the second is omitted when it is zero — "3h" rather
 * than "3h 0m". Sub-second values keep milliseconds because at that scale the
 * milliseconds ARE the measurement; above a minute they are noise on a number
 * whose own error bar is bigger.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) return `${trim(ms / SECOND, ms < 10 * SECOND ? 1 : 0)}s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    const s = Math.round((ms % MINUTE) / SECOND);
    // Rounding seconds can reach 60; carry rather than print "14m 60s".
    return s === 60 ? `${m + 1}m` : s ? `${m}m ${s}s` : `${m}m`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MINUTE);
    return m === 60 ? `${h + 1}h` : m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.round((ms % DAY) / HOUR);
  return h === 24 ? `${d + 1}d` : h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * A duration as an AXIS TICK: one unit, no space, one decimal below ten.
 *
 * Zero is bare "0", not "0s" — it is the baseline every duration axis has, and
 * a unit on it is the one tick that carries no information.
 */
export function axisDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) return `${trim(ms / SECOND, ms < 10 * SECOND ? 1 : 0)}s`;
  if (ms < HOUR) return `${trim(ms / MINUTE, ms < 10 * MINUTE ? 1 : 0)}m`;
  if (ms < DAY) return `${trim(ms / HOUR, ms < 10 * HOUR ? 1 : 0)}h`;
  return `${trim(ms / DAY, ms < 10 * DAY ? 1 : 0)}d`;
}

/**
 * The parallelism factor — attributed ÷ busy.
 *
 * The one number that RECONCILES the page's two measures instead of leaving the
 * reader to notice they disagree. `busy` is the union of each actor's intervals
 * (true wall clock, never double-counted); `attributed` is the plain sum, which
 * exceeds it by exactly as much as work ran in parallel. On real data it runs
 * ~1.05x for a chat and ~1.12x inside a busy subagent, so the interesting digits
 * are the second and third — hence two decimals rather than a rounded "1x".
 *
 * `null` when there is no wall clock to divide by: an empty window has no
 * parallelism, and 0/0 rendered as "NaNx" is the failure this page is most
 * likely to ship.
 */
export function parallelism(attributedMs: number, busyMs: number): number | null {
  if (busyMs <= 0 || !Number.isFinite(attributedMs) || !Number.isFinite(busyMs)) return null;
  return attributedMs / busyMs;
}

/** The factor as it prints: "1.12x", or an em dash when there is nothing to divide. */
export function formatParallelism(attributedMs: number, busyMs: number): string {
  const factor = parallelism(attributedMs, busyMs);
  return factor === null ? "—" : `${factor.toFixed(2)}x`;
}

/** A share of a whole, as a percentage. Guards the empty window's 0/0. */
export function share(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Tick values for a duration axis, on boundaries a human recognises.
 *
 * Recharts picks ticks by decimal niceness on the RAW number, which for
 * milliseconds means round millisecond counts — and a round millisecond count
 * is never a round duration. Left to itself over a four-hour window it produced
 * `0 / 58m / 1.9h / 2.9h / 3.9h`: five ticks, three units between them, not one
 * of them a time anybody thinks in. Formatting alone cannot fix that, because
 * the problem is the VALUES, not their rendering.
 *
 * So the steps come off a ladder of real durations — seconds, then the minute
 * marks a clock has, then hours, then days — and the first one that yields
 * roughly 3–6 gridlines wins. Every tick is then a duration you could say out
 * loud, and the axis reads in ONE unit for its whole height.
 */
const TICK_LADDER = [
  // Sub-second steps matter: an hourly bucket of one fast tool is a plot whose
  // whole height is under a second, and without these its only gridlines are 0
  // and 1s.
  100,
  250,
  500,
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

/** How many gridlines to aim for — enough to read against, few enough to skim. */
const TARGET_TICKS = 5;

/**
 * Ticks from 0 to at least `max`, inclusive of the top one.
 *
 * The last tick is the axis's domain: returning it lets the caller pin
 * `domain={[0, last]}` so the plot's top edge IS a labelled gridline, rather
 * than a bare line somewhere above the highest one.
 */
export function durationTicks(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const step =
    TICK_LADDER.find((candidate) => max / candidate <= TARGET_TICKS) ??
    // Past the ladder's top, fall back to whole 30-day steps rather than
    // returning one tick for a window nothing here will realistically produce.
    Math.ceil(max / TARGET_TICKS / (30 * DAY)) * 30 * DAY;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return ticks;
}

/**
 * A share as it prints beside a duration.
 *
 * Anything non-zero rounds up to at least `<1%`. A row showing a real duration
 * next to a bare "0%" reads as "nothing", which is the one thing it
 * demonstrably isn't — 2m of tool time in a seven-hour window is small, not
 * absent, and the difference is exactly what someone scanning this column is
 * looking for.
 */
export function formatShare(part: number, whole: number): string {
  const value = share(part, whole);
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}
