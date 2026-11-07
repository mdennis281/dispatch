/**
 * The Metrics view's state: one query, four responses, and the chart shape.
 *
 * Everything on the page reads the SAME window + filter — that is the whole
 * point of putting the controls in one row above the content. So the query
 * lives here once and every fetch derives from it, rather than each card owning
 * a copy that can drift out of step with the one beside it.
 *
 * Loads go through `lib/latestLoad.ts`: debounced, the superseded batch
 * aborted, and generation-guarded. The controls are chips and dropdowns, so a
 * fast series of clicks used to put several batches in flight at once, and the
 * LAST one clicked is not reliably the last one to land. Without the guard the
 * page settles on whichever response was slowest, which shows numbers for a
 * filter the user can see is not selected.
 */
import { create } from "zustand";
import type {
  BucketCoarsening,
  MetricBucket,
  MetricDimension,
  MetricEvent,
  MetricFacetsResponse,
  MetricFilter,
  MetricSeriesResponse,
  MetricTotalsResponse,
} from "@dispatch/shared";
import { api } from "../lib/api.js";
import { heldFresh, latestLoad, REMOUNT_FRESH_MS } from "../lib/latestLoad.js";
import { metricRequest, metricWindow } from "./metrics-window.js";

/**
 * The chart forms the view offers.
 *
 * Split by what the reader is doing, per the form heuristic: the first four
 * answer "how did this move over time" (time on X), the last three answer "how
 * much of the whole is each" (no time at all). They are one control rather than
 * two because the reader picks a QUESTION, not a geometry.
 */
export type ChartKind =
  | "line"
  | "area"
  | "stacked-area"
  | "stacked-bar"
  | "grouped-bar"
  | "ranked-bar"
  | "donut";

/** True when this form plots the time series rather than the window's totals. */
export function isTimeChart(kind: ChartKind): boolean {
  return kind !== "ranked-bar" && kind !== "donut";
}

/** True when this form draws bars per bucket — what the coarsening note counts. */
export function isBarChart(kind: ChartKind): boolean {
  return kind === "stacked-bar" || kind === "grouped-bar";
}

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  line: "Line",
  area: "Area",
  "stacked-area": "Stacked area",
  "stacked-bar": "Stacked bars",
  "grouped-bar": "Grouped bars",
  "ranked-bar": "Ranked bars",
  donut: "Donut",
};

/** A named window, as presets rather than a calendar grid nobody wants to fight. */
export interface RangePreset {
  id: string;
  label: string;
  /** Window width in ms, or null for "everything in the ledger". */
  ms: number | null;
}

const DAY = 86_400_000;

export const RANGE_PRESETS: RangePreset[] = [
  { id: "24h", label: "Last 24 hours", ms: DAY },
  { id: "7d", label: "Last 7 days", ms: 7 * DAY },
  { id: "30d", label: "Last 30 days", ms: 30 * DAY },
  { id: "90d", label: "Last 90 days", ms: 90 * DAY },
  { id: "all", label: "All time", ms: null },
];

interface MetricsStore {
  /* ---- the query every card on the page shares ---- */
  rangeId: string;
  filter: MetricFilter;
  groupBy: MetricDimension;
  bucket: MetricBucket;
  /** Series cap before the tail folds into "Other". 8 is the palette's ceiling. */
  limit: number;
  chart: ChartKind;

  /* ---- responses ---- */
  series: MetricSeriesResponse | null;
  totals: MetricTotalsResponse | null;
  facets: MetricFacetsResponse | null;
  recent: MetricEvent[];
  ledgerRows: number;
  /** Set when the picked bucket was too fine for the window and was stepped up. */
  coarsened: BucketCoarsening | null;

  /** True during the FIRST load only — later loads dim the existing render
   *  instead of replacing it, so the frame never jumps. */
  loading: boolean;
  /** True while any load is in flight (drives the reduced-opacity refetch). */
  refetching: boolean;
  error: string | null;

  setRange: (id: string) => void;
  setGroupBy: (dim: MetricDimension) => void;
  setBucket: (bucket: MetricBucket) => void;
  setChart: (chart: ChartKind) => void;
  setLimit: (limit: number) => void;
  /** Add/remove one value from a dimension's filter (the chips are toggles). */
  toggleFilter: (dim: MetricDimension, value: string) => void;
  clearFilter: (dim?: MetricDimension) => void;
  /** Re-run every query now (the Reload button). */
  load: () => Promise<void>;
  /** A mount's load: skipped while the held result for this query is fresh. */
  loadIfStale: () => Promise<void>;
  /** Abandon whatever is pending or in flight — the subpage unmounted. */
  cancel: () => void;
}

/** What a set of results answers, for "do I already hold this?". */
function queryKey(s: Pick<MetricsStore, "rangeId" | "filter" | "groupBy" | "bucket" | "limit">) {
  return JSON.stringify([s.rangeId, s.filter, s.groupBy, s.bucket, s.limit]);
}

/**
 * What the window+filter-only reads answer. Facets and the activity tail take
 * no group-by, bucket or limit, so a change to those leaves them as they were.
 */
function scopeKey(s: Pick<MetricsStore, "rangeId" | "filter">) {
  return JSON.stringify([s.rangeId, s.filter]);
}

export const useMetrics = create<MetricsStore>((set, get) => {
  /**
   * The scope the held facets were read for, and the scope + time of the held
   * activity tail; null forces a fetch.
   *
   * Facets cost the most of the four reads (a grouping query per dimension
   * plus a whole-ledger COUNT) and depend only on window + filter, yet they
   * were refetched for a group-by, bucket or top-N change too. They are pick
   * lists, so holding them while the scope is unchanged costs nothing visible.
   * The tail is shown beside the chart, so it is held only briefly: long enough
   * to cover a burst of clicks, not so long that it visibly lags the chart's
   * window. Both are set only once they LAND, so a superseded load leaves the
   * next one to fetch them. Closure variables rather than store state so
   * writing them never re-renders anything.
   */
  let facetsFor: string | null = null;
  let tailFor: { key: string; at: number } | null = null;

  /**
   * The oldest row in the ledger, from the last facets response — "All time"
   * starts there (see `metrics-window.ts`). Whole-ledger, so it holds across
   * filters; it only ever moves if rows are pruned, and a stale value then
   * merely starts the window a little early.
   */
  let ledgerFrom: number | null = null;

  /** Every query, guarded and cancellable — see `lib/latestLoad.ts`. */
  const loader = latestLoad(async ({ signal, current, landed }) => {
    const state = get();
    const { rangeId, filter, groupBy, limit, series } = state;
    set({ refetching: true, loading: series === null, error: null });
    const scopeId = scopeKey(state);
    let keepFacets = facetsFor === scopeId && state.facets !== null;
    const keepTail = heldFresh(tailFor, scopeId);
    try {
      // "All time" with no ledger range yet: read the facets FIRST. Their
      // `range` is what the window starts at, and the bucket is sized from
      // that window — guessing 0 would size it for a 56-year window, so auto
      // would pick months for a two-week-old ledger and "daily" would be
      // coarsened all the way to monthly.
      // It is not wasted: the same response stands in for the batch's facets.
      let facetsPre: MetricFacetsResponse | null = null;
      if (rangeId === "all" && ledgerFrom === null && !keepFacets) {
        facetsPre = await api.metrics.facets(
          { ...metricWindow(rangeId, null), filter },
          signal,
        );
        if (!current()) return;
        ledgerFrom = facetsPre.range.from;
        keepFacets = true;
      }
      const req = metricRequest(rangeId, state.bucket, ledgerFrom);
      const scope = { from: req.from, to: req.to, filter };
      const bucket = req.bucket;
      // One round trip each, in parallel: they read the same window, and a
      // sequential chain would make the page settle four times.
      const [seriesRes, totalsRes, facetsRes, recentRes] = await Promise.all([
        api.metrics.series({ ...scope, groupBy, bucket, limit }, signal),
        api.metrics.totals({ ...scope, groupBy, bucket, limit }, signal),
        keepFacets ? (facetsPre ?? state.facets!) : api.metrics.facets(scope, signal),
        keepTail ? state.recent : api.metrics.recent({ ...scope, limit: 50 }, signal),
      ]);
      if (!current()) return; // a newer query is already in flight
      facetsFor = scopeId;
      ledgerFrom = facetsRes.range.from;
      if (!keepTail) tailFor = { key: scopeId, at: Date.now() };
      set({
        series: seriesRes,
        totals: totalsRes,
        facets: facetsRes,
        recent: recentRes,
        ledgerRows: facetsRes.rows,
        coarsened: req.coarsened,
        loading: false,
        refetching: false,
      });
      landed(queryKey(state));
    } catch (err) {
      if (!current()) return;
      set({
        error: err instanceof Error ? err.message : "Could not load metrics.",
        loading: false,
        refetching: false,
      });
    }
  });

  /** Re-run EVERY query now, the scope-only ones included — the Reload button. */
  const load = (): Promise<void> => {
    facetsFor = null;
    tailFor = null;
    return loader.run();
  };

  /**
   * Apply a change and re-query once the controls settle. `refetching` goes up
   * at once so the page dims on the click rather than 250 ms after it.
   */
  const applyAndLoad = (patch: Partial<MetricsStore>) => {
    set({ ...patch, refetching: true });
    loader.schedule();
  };

  return {
    rangeId: "30d",
    filter: {},
    groupBy: "identifier",
    bucket: "auto",
    limit: 8,
    chart: "stacked-area",

    series: null,
    totals: null,
    facets: null,
    recent: [],
    ledgerRows: 0,
    coarsened: null,
    loading: false,
    refetching: false,
    error: null,

    setRange: (rangeId) => applyAndLoad({ rangeId }),
    setGroupBy: (groupBy) => applyAndLoad({ groupBy }),
    setBucket: (bucket) => applyAndLoad({ bucket }),
    setLimit: (limit) => applyAndLoad({ limit }),
    // Chart form alone changes no query — the same series render as lines or
    // bars — so it must NOT refetch. Doing so would flash the whole page on a
    // control that only changes geometry.
    setChart: (chart) => set({ chart }),

    toggleFilter: (dim, value) => {
      const current = get().filter[dim] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const filter = { ...get().filter };
      // Delete rather than store an empty array: an empty list would read as
      // "match nothing" on the server, when what the user did is clear the
      // filter — which means "match everything".
      if (next.length) filter[dim] = next;
      else delete filter[dim];
      applyAndLoad({ filter });
    },

    clearFilter: (dim) => {
      if (!dim) return applyAndLoad({ filter: {} });
      const filter = { ...get().filter };
      delete filter[dim];
      applyAndLoad({ filter });
    },

    load,
    loadIfStale: () =>
      loader.fresh(queryKey(get()), REMOUNT_FRESH_MS) ? Promise.resolve() : load(),
    cancel: () => {
      loader.cancel();
      set({ loading: false, refetching: false });
    },
  };
});
