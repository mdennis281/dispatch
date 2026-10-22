/**
 * The Limits tab's state — one query, one response, like the Tokens tab.
 *
 * Polled while the tab is mounted (see `LimitMetrics`): unlike the ledgers the
 * other tabs read, this one grows on its own every few minutes whether or not
 * anyone is chatting, and a reset is exactly the kind of thing someone opens
 * the tab and waits to see.
 */
import { create } from "zustand";
import type { LimitReport } from "@dispatch/shared";
import { api } from "../lib/api.js";
import { RANGE_PRESETS } from "./metrics.js";

interface LimitMetricsStore {
  rangeId: string;
  report: LimitReport | null;
  loading: boolean;
  refetching: boolean;
  error: string | null;
  setRange: (id: string) => void;
  load: () => Promise<void>;
}

let generation = 0;

export const useLimitMetrics = create<LimitMetricsStore>((set, get) => {
  const load = async (): Promise<void> => {
    const gen = ++generation;
    const { rangeId, report } = get();
    set({ refetching: true, loading: report === null, error: null });
    const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[1]!;
    const to = Date.now();
    try {
      const res = await api.metrics.limits(
        preset.ms === null ? {} : { from: to - preset.ms, to: to + 1 },
      );
      if (gen !== generation) return;
      set({ report: res, loading: false, refetching: false });
    } catch (err) {
      if (gen !== generation) return;
      set({
        error: err instanceof Error ? err.message : "Could not load limit history.",
        loading: false,
        refetching: false,
      });
    }
  };
  return {
    // A week: the longest window either provider has, so one weekly period
    // is always fully in view.
    rangeId: "7d",
    report: null,
    loading: false,
    refetching: false,
    error: null,
    setRange: (rangeId) => {
      set({ rangeId });
      void load();
    },
    load,
  };
});
