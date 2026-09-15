/**
 * Shaping a growth report for the page — pure functions, no React.
 *
 * The server hands back the whole history at day resolution, once, and every
 * control on the Growth tab is a re-shape of that in memory: the range is a
 * slice, the bucket is a fold, the split is a regroup, the generated toggle is
 * a filter. None of them go back to the server, which is the point — the walk
 * is the expensive part and a control that re-ran it would make the page
 * unusable on any repo big enough to be interesting.
 *
 * TWO MEASURES from one dataset:
 *
 *   size   the running line count at the END of each bucket — additions minus
 *          deletions, accumulated from the first commit. This is the growth
 *          curve. Its baseline at the range start is the sum of everything
 *          BEFORE the range, so a 30-day view starts at the size the repo was
 *          30 days ago rather than at zero.
 *   churn  the lines added and the lines deleted WITHIN each bucket, kept
 *          apart. Net alone hides a refactor that swapped 4,000 lines for
 *          4,000 others; churn is what shows it.
 *
 * SERIES ARE RANKED ON THE WHOLE HISTORY, not the window. The rank picks the
 * colour, and colour must follow the entity: narrowing to last week must not
 * repaint TypeScript from blue to orange because Markdown happened to move more
 * in those seven days.
 */
import {
  GROWTH_GENERATED_KEY,
  METRIC_OTHER_KEY,
  extensionLabel,
  languageOf,
  type GrowthPoint,
  type GrowthReport,
} from "@dispatch/shared";

export type GrowthSplit = "none" | "language" | "extension";
export type GrowthMeasure = "size" | "churn";
export type GrowthBucket = "auto" | "day" | "week" | "month";
export type GrowthBucketWidth = Exclude<GrowthBucket, "auto">;

export interface GrowthShapeOptions {
  /** Range start (UTC ms), or `null` for the whole history. */
  from: number | null;
  split: GrowthSplit;
  bucket: GrowthBucket;
  includeGenerated: boolean;
  /** How many series before the tail folds into Other. */
  limit: number;
  /** "Now" — injectable so tests are stable. */
  now?: number;
}

/** One group (a language, an extension, or everything), over the whole history. */
export interface GrowthGroup {
  key: string;
  label: string;
  /** Growth keys folded into this group — the extensions behind a language. */
  keys: string[];
  /** Lines at HEAD, for text files. */
  now: number;
  /** Files at HEAD. */
  files: number;
  /** Lines added / deleted WITHIN the range. */
  added: number;
  deleted: number;
}

/** One series of the chart: a group, or the Other fold. */
export interface GrowthSeries {
  key: string;
  label: string;
  /** Lines at HEAD — what the legend prints. */
  now: number;
}

export interface GrowthShape {
  bucket: GrowthBucketWidth;
  /** Bucket starts, oldest → newest, contiguous. */
  buckets: number[];
  /** Ranked, capped at `limit` with the tail folded into Other. */
  series: GrowthSeries[];
  /** `size[s][b]` — series `s`'s line count at the end of bucket `b`. */
  size: number[][];
  /** `added[s][b]` / `deleted[s][b]` — lines moved within bucket `b`. */
  added: number[][];
  deleted: number[][];
  /** Commits per bucket. */
  commits: number[];
  /** Every group, ranked by lines at HEAD — the composition table. */
  groups: GrowthGroup[];
  /** How many groups were folded into Other on the chart. */
  folded: number;
  /** Range totals. */
  linesNow: number;
  linesAtStart: number;
  addedInRange: number;
  deletedInRange: number;
  commitsInRange: number;
}

const DAY = 86_400_000;

/* ---------------------------------------------------------------- buckets */

/** The start of the UTC day / ISO week (Monday) / month containing `ts`. */
export function bucketStart(ts: number, width: GrowthBucketWidth): number {
  const d = new Date(ts);
  if (width === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (width === "week") {
    // getUTCDay: Sunday = 0. Roll back to Monday.
    const back = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The bucket after `start`. Months are irregular, so it is not a constant. */
function nextBucket(start: number, width: GrowthBucketWidth): number {
  if (width === "day") return start + DAY;
  if (width === "week") return start + 7 * DAY;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Pick a width for a span, aiming for something a chart can show without
 * a bar per pixel: days up to a quarter, weeks up to two years, then months.
 */
export function autoBucket(spanMs: number): GrowthBucketWidth {
  if (spanMs <= 92 * DAY) return "day";
  if (spanMs <= 2 * 366 * DAY) return "week";
  return "month";
}

/* ----------------------------------------------------------------- shape */

/** The group a growth key belongs to under a split. */
function groupOf(key: string, split: GrowthSplit): string {
  if (split === "none") return "all";
  if (split === "language") return languageOf(key);
  return key;
}

function labelOf(group: string, split: GrowthSplit): string {
  if (split === "none") return "All code";
  if (split === "extension") return extensionLabel(group);
  return group;
}

export function shapeGrowth(report: GrowthReport, opts: GrowthShapeOptions): GrowthShape {
  const now = opts.now ?? Date.now();
  const { split, includeGenerated, limit } = opts;
  const keep = (key: string) => includeGenerated || key !== GROWTH_GENERATED_KEY;

  /* ---- groups over the whole history, ranked by lines at HEAD ---- */

  const groupMap = new Map<string, GrowthGroup>();
  for (const [key, t] of Object.entries(report.totals)) {
    if (!keep(key)) continue;
    const g = groupOf(key, split);
    let row = groupMap.get(g);
    if (!row) {
      row = { key: g, label: labelOf(g, split), keys: [], now: 0, files: 0, added: 0, deleted: 0 };
      groupMap.set(g, row);
    }
    row.keys.push(key);
    row.now += t.additions - t.deletions;
    row.files += t.files;
  }

  /* ---- the range ---- */

  const first = report.points[0]?.ts ?? now;
  const from = opts.from === null ? first : Math.max(first, opts.from);
  const width = opts.bucket === "auto" ? autoBucket(now - from) : opts.bucket;

  // Contiguous buckets from the range start to now, so a quiet month is a
  // flat stretch on the curve rather than a missing one.
  const buckets: number[] = [];
  const end = bucketStart(now, width);
  for (let b = bucketStart(from, width); b <= end; b = nextBucket(b, width)) buckets.push(b);
  const indexOf = new Map(buckets.map((b, i) => [b, i] as const));

  /* ---- fold the points ---- */

  // Per group: lines before the range (the baseline), then per-bucket
  // additions and deletions.
  const baseline = new Map<string, number>();
  const addedBy = new Map<string, number[]>();
  const deletedBy = new Map<string, number[]>();
  const commits = new Array<number>(buckets.length).fill(0);
  let commitsInRange = 0;
  const slot = (map: Map<string, number[]>, g: string) => {
    let arr = map.get(g);
    if (!arr) {
      arr = new Array<number>(buckets.length).fill(0);
      map.set(g, arr);
    }
    return arr;
  };

  const fold = (point: GrowthPoint, into: number | null) => {
    for (const [key, d] of Object.entries(point.keys)) {
      if (!keep(key)) continue;
      const g = groupOf(key, split);
      if (into === null) {
        baseline.set(g, (baseline.get(g) ?? 0) + d.additions - d.deletions);
      } else {
        const a = slot(addedBy, g);
        const z = slot(deletedBy, g);
        a[into] = (a[into] ?? 0) + d.additions;
        z[into] = (z[into] ?? 0) + d.deletions;
        const row = groupMap.get(g);
        if (row) {
          row.added += d.additions;
          row.deleted += d.deletions;
        }
      }
    }
  };

  for (const point of report.points) {
    if (point.ts < from) {
      fold(point, null);
      continue;
    }
    // A day bucket can only ever be one chart bucket; wider buckets contain
    // it whole. A point after `now` (a clock skew) lands in the last bucket.
    const i = indexOf.get(bucketStart(point.ts, width)) ?? buckets.length - 1;
    fold(point, i);
    commits[i] = (commits[i] ?? 0) + point.commits;
    commitsInRange += point.commits;
  }

  /* ---- rank, cap, fold the tail ---- */

  // A group with nothing at HEAD and no files is pure history — an extension
  // that was deleted wholesale. It still moved lines in some window, but a
  // composition row reading 0 / 0 answers nothing about what the repo IS.
  const groups = [...groupMap.values()]
    .filter((g) => g.now !== 0 || g.files > 0)
    .sort((a, b) => b.now - a.now || a.label.localeCompare(b.label));
  const head = groups.slice(0, limit);
  const tail = groups.slice(limit);
  const series: GrowthSeries[] = head.map((g) => ({ key: g.key, label: g.label, now: g.now }));
  if (tail.length) {
    series.push({
      key: METRIC_OTHER_KEY,
      label: "Other",
      now: tail.reduce((n, g) => n + g.now, 0),
    });
  }

  const size: number[][] = [];
  const added: number[][] = [];
  const deleted: number[][] = [];
  const members = (s: GrowthSeries) =>
    s.key === METRIC_OTHER_KEY ? tail.map((g) => g.key) : [s.key];
  for (const s of series) {
    const keys = members(s);
    let running = keys.reduce((n, g) => n + (baseline.get(g) ?? 0), 0);
    const a = new Array<number>(buckets.length).fill(0);
    const d = new Array<number>(buckets.length).fill(0);
    const z = new Array<number>(buckets.length).fill(0);
    for (const g of keys) {
      const ga = addedBy.get(g);
      const gd = deletedBy.get(g);
      if (!ga || !gd) continue;
      for (let i = 0; i < buckets.length; i++) {
        a[i] = a[i]! + ga[i]!;
        d[i] = d[i]! + gd[i]!;
      }
    }
    for (let i = 0; i < buckets.length; i++) {
      running += a[i]! - d[i]!;
      z[i] = running;
    }
    size.push(z);
    added.push(a);
    deleted.push(d);
  }

  const linesNow = groups.reduce((n, g) => n + g.now, 0);
  const addedInRange = groups.reduce((n, g) => n + g.added, 0);
  const deletedInRange = groups.reduce((n, g) => n + g.deleted, 0);

  return {
    bucket: width,
    buckets,
    series,
    size,
    added,
    deleted,
    commits,
    groups,
    folded: tail.length,
    linesNow,
    linesAtStart: linesNow - addedInRange + deletedInRange,
    addedInRange,
    deletedInRange,
    commitsInRange,
  };
}

/* ------------------------------------------------------------------ axis */

/** About how many gridlines a 300px plot carries comfortably. */
const TARGET_TICKS = 5;

/**
 * A round step for a line-count axis: 1 / 2 / 2.5 / 5 × a power of ten, the
 * largest that still yields about {@link TARGET_TICKS} ticks. Recharts' own
 * "nice" domain gave 65K / 130K / 195K / 260K over this repo — evenly spaced
 * and unreadable, because nobody counts lines in 65-thousands.
 */
export function lineStep(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const raw = max / TARGET_TICKS;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

/** Ticks from `lo` (≤ 0) to `hi` (≥ 0) on a round step, always including 0. */
export function lineTicks(lo: number, hi: number): number[] {
  // A flat window still needs a two-tick domain, or Recharts collapses the axis.
  if (hi <= 0 && lo >= 0) return [0, 1];
  const step = lineStep(Math.max(hi, -lo));
  const ticks: number[] = [];
  // `v === 0 ? 0 : v` scrubs the `-0` the floor arithmetic produces for a
  // window with no deletions, which Intl would otherwise print as "-0".
  for (let v = -Math.ceil(-lo / step) * step; v <= hi + step - 1e-9; v += step) {
    ticks.push(v === 0 ? 0 : v);
  }
  if (!ticks.includes(0)) ticks.push(0);
  return ticks.sort((a, b) => a - b);
}
