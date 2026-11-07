/**
 * The Runtime subpage's state: one query, five responses.
 *
 * The same shape as `stores/metrics.ts`, deliberately — same debounced,
 * aborting, generation-guarded loader (`lib/latestLoad.ts`), same "every
 * control re-queries itself", same facets-only-when-the-scope-moved rule, same
 * hold-the-previous-render refetch flag — so the two halves of the Metrics
 * screen behave identically under a fast series of clicks.
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
  BucketCoarsening,
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
import { heldFresh, latestLoad, REMOUNT_FRESH_MS } from "../lib/latestLoad.js";
import type { ChartKind } from "./metrics.js";
import { metricRequest, metricWindow } from "./metrics-window.js";

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
  /** Set when the picked bucket was too fine for the window and was stepped up. */
  coarsened: BucketCoarsening | null;

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
  /** Re-run every query now (the Reload button). */
  load: () => Promise<void>;
  /** A mount's load: skipped while the held result for this query is fresh. */
  loadIfStale: () => Promise<void>;
  /** Abandon whatever is pending or in flight — the subpage unmounted. */
  cancel: () => void;
}

/** The breakdown table's sortable columns. */
export type SpanSort = "ms" | "busyMs" | "avg" | "count";

export const SPAN_SORT_LABELS: Record<SpanSort, string> = {
  ms: "Time",
  busyMs: "Busy",
  avg: "Average",
  count: "Spans",
};

/** What a set of results answers, for "do I already hold this?". */
function queryKey(s: Pick<SpanMetricsStore, "rangeId" | "filter" | "groupBy" | "bucket" | "limit">) {
  return JSON.stringify([s.rangeId, s.filter, s.groupBy, s.bucket, s.limit]);
}

/**
 * What the window+filter-only reads answer. Summary, facets and the activity
 * tail take no group-by, bucket or limit, so a change to those three leaves
 * them exactly as they were — re-running them was most of the batch.
 */
function scopeKey(s: Pick<SpanMetricsStore, "rangeId" | "filter">) {
  return JSON.stringify([s.rangeId, s.filter]);
}

export const useSpanMetrics = create<SpanMetricsStore>((set, get) => {
  /**
   * The scope the held facets were read for, and the scope + time of the held
   * summary and tail; null forces a fetch. Same policy as `stores/metrics.ts`:
   * facets are pick lists and are held while the scope is unchanged; the hero
   * row and tail sit beside the chart, so they are held only briefly. Set only
   * once they LAND, so a superseded load leaves the next one to fetch them.
   */
  let facetsFor: string | null = null;
  let windowedFor: { key: string; at: number } | null = null;

  /** The oldest span in the ledger, for "All time" — see `stores/metrics.ts`. */
  let ledgerFrom: number | null = null;

  /** Every query, guarded and cancellable — see `lib/latestLoad.ts`. */
  const loader = latestLoad(async ({ signal, current, landed }) => {
    const state = get();
    const { rangeId, filter, groupBy, limit, series } = state;
    set({ refetching: true, loading: series === null, error: null });
    const scopeId = scopeKey(state);
    let keepFacets = facetsFor === scopeId && state.facets !== null;
    const keepWindowed = heldFresh(windowedFor, scopeId) && state.summary !== null;
    try {
      // "All time" with no ledger range yet reads the facets first, for the
      // window's start — same reasoning as `stores/metrics.ts`.
      let facetsPre: MetricSpanFacetsResponse | null = null;
      if (rangeId === "all" && ledgerFrom === null && !keepFacets) {
        facetsPre = await api.metrics.spans.facets(
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
      // sequential chain would make the page settle five times.
      const [seriesRes, totalsRes, summaryRes, facetsRes, recentRes] = await Promise.all([
        api.metrics.spans.series({ ...scope, groupBy, bucket, limit }, signal),
        api.metrics.spans.totals({ ...scope, groupBy, bucket, limit }, signal),
        keepWindowed ? state.summary! : api.metrics.spans.summary(scope, signal),
        keepFacets ? (facetsPre ?? state.facets!) : api.metrics.spans.facets(scope, signal),
        keepWindowed ? state.recent : api.metrics.spans.recent({ ...scope, limit: 50 }, signal),
      ]);
      if (!current()) return; // a newer query is already in flight
      facetsFor = scopeId;
      ledgerFrom = facetsRes.range.from;
      if (!keepWindowed) windowedFor = { key: scopeId, at: Date.now() };
      set({
        series: seriesRes,
        totals: totalsRes,
        summary: summaryRes,
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
        error: err instanceof Error ? err.message : "Could not load runtime metrics.",
        loading: false,
        refetching: false,
      });
    }
  });

  /** Re-run EVERY query now, the scope-only ones included — the Reload button. */
  const load = (): Promise<void> => {
    facetsFor = null;
    windowedFor = null;
    return loader.run();
  };

  /**
   * Apply a change and re-query once the controls settle. `refetching` goes up
   * at once so the page dims on the click rather than 250 ms after it.
   */
  const applyAndLoad = (patch: Partial<SpanMetricsStore>) => {
    set({ ...patch, refetching: true });
    loader.schedule();
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
    loadIfStale: () =>
      loader.fresh(queryKey(get()), REMOUNT_FRESH_MS) ? Promise.resolve() : load(),
    cancel: () => {
      loader.cancel();
      set({ loading: false, refetching: false });
    },
  };
});
