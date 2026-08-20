/**
 * The Runtime subpage's state: one query, five responses.
 *
 * The same shape as `stores/metrics.ts`, deliberately — same generation guard,
 * same "every control re-queries itself", same hold-the-previous-render refetch
 * flag — so the two halves of the Metrics screen behave identically under a
 * fast series of clicks.
 *
 * A SEPARATE store rather than a `measure` field on the usage one, for the same
 * reason the API has separate paths: the two ledgers have different dimensions.
 * `state` and `class` do not exist in the event table and `category` does not
 * exist in the span table, so a single `filter` would be a map whose keys are
 * only valid for whichever half is showing — and switching tabs would either
 * silently drop the chips you had set or send the other endpoint a dimension it
 * answers with a 400. Two stores means each tab's filter is always sendable,
 * and means the tab you come back to is the one you left.
 *
 * `summary` is the fifth response and the reason this page exists: it carries
 * BOTH measures for the window. `busyMs` is the union of each actor's intervals
 * — true wall clock, never double-counted — and `attributedMs` is the plain sum,
 * which exceeds it by exactly as much as work ran in parallel. The page leads
 * with busy, breaks down attributed, and shows the ratio between them rather
 * than letting the reader discover the gap.
 */
import { create } from "zustand";
import type {
  MetricBucket,
  MetricSpan,
  MetricSpanDimension,
  MetricSpanFacetsResponse,
  MetricSpanFilter,
  MetricSpanSeriesResponse,
  MetricSpanSummary,
  MetricSpanTotalsResponse,
} from "@dispatch/shared";
import { api } from "../lib/api.js";
import { RANGE_PRESETS, type ChartKind } from "./metrics.js";

interface SpanMetricsStore {
  /* ---- the query every card on the subpage shares ---- */
  rangeId: string;
  filter: MetricSpanFilter;
  groupBy: MetricSpanDimension;
  bucket: MetricBucket;
  /** Series cap before the tail folds into "Other". 8 is the palette's ceiling. */
  limit: number;
  chart: ChartKind;
  /**
   * Which column the breakdown table is sorted by.
   *
   * Client-side, over the rows the server already returned — see the table's
   * own note. It is NOT part of the query: the server ranks by attributed time
   * to decide which groups survive `limit`, and re-ranking here reorders that
   * set without changing which groups are in it.
   */
  sort: SpanSort;

  /* ---- responses ---- */
  series: MetricSpanSeriesResponse | null;
  totals: MetricSpanTotalsResponse | null;
  summary: MetricSpanSummary | null;
  facets: MetricSpanFacetsResponse | null;
  recent: MetricSpan[];
  ledgerRows: number;

  /** True during the FIRST load only — later loads dim the existing render
   *  instead of replacing it, so the frame never jumps. */
  loading: boolean;
  /** True while any load is in flight (drives the reduced-opacity refetch). */
  refetching: boolean;
  error: string | null;

  setRange: (id: string) => void;
  setGroupBy: (dim: MetricSpanDimension) => void;
  setBucket: (bucket: MetricBucket) => void;
  setChart: (chart: ChartKind) => void;
  setLimit: (limit: number) => void;
  setSort: (sort: SpanSort) => void;
  /** Add/remove one value from a dimension's filter (the chips are toggles). */
  toggleFilter: (dim: MetricSpanDimension, value: string) => void;
  clearFilter: (dim?: MetricSpanDimension) => void;
  load: () => Promise<void>;
}

/** The breakdown table's sortable columns. */
export type SpanSort = "ms" | "busyMs" | "avg" | "count";

export const SPAN_SORT_LABELS: Record<SpanSort, string> = {
  ms: "Time",
  busyMs: "Busy",
  avg: "Average",
  count: "Spans",
};

/** Resolve the selected preset into an absolute window. */
function windowFor(rangeId: string): { from?: number; to?: number } {
  const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[1]!;
  if (preset.ms === null) return {};
  const to = Date.now();
  return { from: to - preset.ms, to: to + 1 };
}

/**
 * Bumped by every `load()`; a response whose generation is stale is dropped.
 * Module-level rather than store state so writing it never re-renders anything.
 */
let generation = 0;

export const useSpanMetrics = create<SpanMetricsStore>((set, get) => {
  /** Re-run every query. Guarded by `generation`. */
  const load = async (): Promise<void> => {
    const gen = ++generation;
    const { rangeId, filter, groupBy, bucket, limit, series } = get();
    set({ refetching: true, loading: series === null, error: null });
    const scope = { ...windowFor(rangeId), filter };
    try {
      // One round trip each, in parallel: they read the same window, and a
      // sequential chain would make the page settle five times.
      const [seriesRes, totalsRes, summaryRes, facetsRes, recentRes] = await Promise.all([
        api.metrics.spans.series({ ...scope, groupBy, bucket, limit }),
        api.metrics.spans.totals({ ...scope, groupBy, bucket, limit }),
        api.metrics.spans.summary(scope),
        api.metrics.spans.facets(scope),
        api.metrics.spans.recent({ ...scope, limit: 50 }),
      ]);
      if (gen !== generation) return; // a newer query is already in flight
      set({
        series: seriesRes,
        totals: totalsRes,
        summary: summaryRes,
        facets: facetsRes,
        recent: recentRes,
        ledgerRows: facetsRes.rows,
        loading: false,
        refetching: false,
      });
    } catch (err) {
      if (gen !== generation) return;
      set({
        error: err instanceof Error ? err.message : "Could not load runtime metrics.",
        loading: false,
        refetching: false,
      });
    }
  };

  /** Apply a change and immediately re-query — every control is live. */
  const applyAndLoad = (patch: Partial<SpanMetricsStore>) => {
    set(patch);
    void load();
  };

  return {
    // 7 days rather than the usage page's 30: the questions this half answers
    // ("where did today's agent-time go", "which chat owns the window") are
    // about the recent past, and a month of spans buries a day's shape in it.
    rangeId: "7d",
    filter: {},
    // State is the split the whole page is FOR — generating versus waiting on a
    // shell versus asleep — so it is what the chart opens on.
    groupBy: "state",
    bucket: "auto",
    limit: 8,
    // Stacked bars, not stacked area: with `state` the stack is a part-to-whole
    // of each bucket's attributed time, and discrete bars say "this bucket" where
    // a continuous area implies a value between two bucket starts that was never
    // measured.
    chart: "stacked-bar",
    sort: "ms",

    series: null,
    totals: null,
    summary: null,
    facets: null,
    recent: [],
    ledgerRows: 0,
    loading: false,
    refetching: false,
    error: null,

    setRange: (rangeId) => applyAndLoad({ rangeId }),
    setGroupBy: (groupBy) => applyAndLoad({ groupBy }),
    setBucket: (bucket) => applyAndLoad({ bucket }),
    setLimit: (limit) => applyAndLoad({ limit }),
    // Chart form alone changes no query — the same series render as lines or
    // bars — so it must NOT refetch. Doing so would flash the whole page on a
    // control that only changes geometry. Same for the table's sort, which
    // reorders rows already in hand.
    setChart: (chart) => set({ chart }),
    setSort: (sort) => set({ sort }),

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
  };
});
