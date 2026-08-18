/**
 * The Metrics view's state: one query, four responses, and the chart shape.
 *
 * Everything on the page reads the SAME window + filter — that is the whole
 * point of putting the controls in one row above the content. So the query
 * lives here once and every fetch derives from it, rather than each card owning
 * a copy that can drift out of step with the one beside it.
 *
 * `load()` is generation-guarded: the controls are chips and dropdowns, so a
 * fast series of clicks has several requests in flight at once and the LAST one
 * clicked is not reliably the last one to land. Without the guard the page
 * settles on whichever response was slowest, which shows numbers for a filter
 * the user can see is not selected.
 */
import { create } from "zustand";
import type {
  MetricBucket,
  MetricDimension,
  MetricEvent,
  MetricFacetsResponse,
  MetricFilter,
  MetricSeriesResponse,
  MetricTotalsResponse,
} from "@dispatch/shared";
import { api } from "../lib/api.js";

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
  load: () => Promise<void>;
}

/** Resolve the selected preset into an absolute window. */
function windowFor(rangeId: string): { from?: number; to?: number } {
  const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[2]!;
  if (preset.ms === null) return {};
  const to = Date.now();
  return { from: to - preset.ms, to: to + 1 };
}

/**
 * Bumped by every `load()`; a response whose generation is stale is dropped.
 * Module-level rather than store state so writing it never re-renders anything.
 */
let generation = 0;

export const useMetrics = create<MetricsStore>((set, get) => {
  /** Re-run every query. Debounced by the caller, guarded by `generation`. */
  const load = async (): Promise<void> => {
    const gen = ++generation;
    const { rangeId, filter, groupBy, bucket, limit, series } = get();
    set({ refetching: true, loading: series === null, error: null });
    const scope = { ...windowFor(rangeId), filter };
    try {
      // One round trip each, in parallel: they read the same window, and a
      // sequential chain would make the page settle four times.
      const [seriesRes, totalsRes, facetsRes, recentRes] = await Promise.all([
        api.metrics.series({ ...scope, groupBy, bucket, limit }),
        api.metrics.totals({ ...scope, groupBy, bucket, limit }),
        api.metrics.facets(scope),
        api.metrics.recent({ ...scope, limit: 50 }),
      ]);
      if (gen !== generation) return; // a newer query is already in flight
      set({
        series: seriesRes,
        totals: totalsRes,
        facets: facetsRes,
        recent: recentRes,
        ledgerRows: facetsRes.rows,
        loading: false,
        refetching: false,
      });
    } catch (err) {
      if (gen !== generation) return;
      set({
        error: err instanceof Error ? err.message : "Could not load metrics.",
        loading: false,
        refetching: false,
      });
    }
  };

  /** Apply a change and immediately re-query — every control is live. */
  const applyAndLoad = (patch: Partial<MetricsStore>) => {
    set(patch);
    void load();
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
  };
});

/** How many filter values are selected across every dimension. */
export function activeFilterCount(filter: MetricFilter): number {
  return Object.values(filter).reduce((n, values) => n + (values?.length ?? 0), 0);
}
