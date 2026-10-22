/**
 * The Tokens tab's state — one query, one response.
 *
 * Shaped like `stores/metrics.ts` (a shared window + filter, every control
 * re-queries, generation-guarded loads) but with ONE request where that store
 * makes four: the token ledger is one row per turn × model, small enough that
 * the server answers chart, table and pick-lists together, and one response
 * cannot disagree with itself the way four racing ones can.
 */
import { create } from "zustand";
import type {
  MetricBucket,
  TokenDimension,
  TokenFilter,
  TokenMeasure,
  TokenReport,
} from "@dispatch/shared";
import { api } from "../lib/api.js";
import { RANGE_PRESETS, type ChartKind } from "./metrics.js";

interface TokenMetricsStore {
  rangeId: string;
  filter: TokenFilter;
  groupBy: TokenDimension;
  measure: TokenMeasure;
  bucket: MetricBucket;
  limit: number;
  chart: ChartKind;

  report: TokenReport | null;
  loading: boolean;
  refetching: boolean;
  error: string | null;

  setRange: (id: string) => void;
  setGroupBy: (dim: TokenDimension) => void;
  setMeasure: (m: TokenMeasure) => void;
  setBucket: (b: MetricBucket) => void;
  setLimit: (n: number) => void;
  setChart: (c: ChartKind) => void;
  toggleFilter: (dim: TokenDimension, value: string) => void;
  clearFilter: (dim?: TokenDimension) => void;
  load: () => Promise<void>;
}

function windowFor(rangeId: string): { from?: number; to?: number } {
  const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[2]!;
  if (preset.ms === null) return {};
  const to = Date.now();
  return { from: to - preset.ms, to: to + 1 };
}

/** See `stores/metrics.ts` — the last click must win, not the slowest reply. */
let generation = 0;

export const useTokenMetrics = create<TokenMetricsStore>((set, get) => {
  const load = async (): Promise<void> => {
    const gen = ++generation;
    const { rangeId, filter, groupBy, measure, bucket, limit, report } = get();
    set({ refetching: true, loading: report === null, error: null });
    try {
      const res = await api.metrics.tokens({
        ...windowFor(rangeId),
        filter,
        groupBy,
        measure,
        bucket,
        limit,
      });
      if (gen !== generation) return;
      set({ report: res, loading: false, refetching: false });
    } catch (err) {
      if (gen !== generation) return;
      set({
        error: err instanceof Error ? err.message : "Could not load token usage.",
        loading: false,
        refetching: false,
      });
    }
  };

  const applyAndLoad = (patch: Partial<TokenMetricsStore>) => {
    set(patch);
    void load();
  };

  return {
    rangeId: "30d",
    filter: {},
    // Account first: "which login is burning my budget" is the question this
    // tab was asked to answer. Model is one click away.
    groupBy: "subscription",
    measure: "total",
    bucket: "auto",
    limit: 8,
    chart: "stacked-bar",

    report: null,
    loading: false,
    refetching: false,
    error: null,

    setRange: (rangeId) => applyAndLoad({ rangeId }),
    setGroupBy: (groupBy) => applyAndLoad({ groupBy }),
    setMeasure: (measure) => applyAndLoad({ measure }),
    setBucket: (bucket) => applyAndLoad({ bucket }),
    setLimit: (limit) => applyAndLoad({ limit }),
    // Geometry only — the same series render as lines or bars. No refetch.
    setChart: (chart) => set({ chart }),

    toggleFilter: (dim, value) => {
      const current = get().filter[dim] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      const filter = { ...get().filter };
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
