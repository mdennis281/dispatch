/**
 * The Limits tab's state — one query, one response, like the Tokens tab.
 *
 * Polled while the tab is mounted (see `LimitMetrics`): unlike the ledgers the
 * other tabs read, this one grows on its own every few minutes whether or not
 * anyone is chatting, and a reset is exactly the kind of thing someone opens
 * the tab and waits to see.
 */
import { create } from "zustand";
import type { LimitPeriod, LimitReport } from "@dispatch/shared";
import { api } from "../lib/api.js";
import { latestLoad } from "../lib/latestLoad.js";
import { RANGE_PRESETS } from "./metrics.js";

interface LimitMetricsStore {
  rangeId: string;
  /** Width of the "what did 1% buy" periods. */
  period: LimitPeriod;
  report: LimitReport | null;
  loading: boolean;
  refetching: boolean;
  error: string | null;
  setRange: (id: string) => void;
  setPeriod: (p: LimitPeriod) => void;
  /** Re-run the query now (the Reload button, a control change). */
  load: () => Promise<void>;
  /**
   * The background poll's load: skipped while one is already in flight. A
   * poll that aborted the previous one instead would never finish on a box
   * where the read takes longer than the poll interval.
   */
  poll: () => Promise<void>;
}

export const useLimitMetrics = create<LimitMetricsStore>((set, get) => {
  // Debounced, aborting and generation-guarded — see `lib/latestLoad.ts`.
  const loader = latestLoad(async ({ signal, current }) => {
    const { rangeId, period, report } = get();
    set({ refetching: true, loading: report === null, error: null });
    const preset = RANGE_PRESETS.find((r) => r.id === rangeId) ?? RANGE_PRESETS[1]!;
    const to = Date.now();
    try {
      const res = await api.metrics.limits(
        preset.ms === null ? { period } : { from: to - preset.ms, to: to + 1, period },
        signal,
      );
      if (!current()) return;
      set({ report: res, loading: false, refetching: false });
    } catch (err) {
      if (!current()) return;
      set({
        error: err instanceof Error ? err.message : "Could not load limit history.",
        loading: false,
        refetching: false,
      });
    }
  });
  const load = (): Promise<void> => loader.run();
  return {
    // A week: the longest window either provider has, so one weekly period
    // is always fully in view.
    rangeId: "7d",
    period: "1d",
    report: null,
    loading: false,
    refetching: false,
    error: null,
    setRange: (rangeId) => {
      set({ rangeId, refetching: true });
      loader.schedule();
    },
    setPeriod: (period) => {
      set({ period, refetching: true });
      loader.schedule();
    },
    load,
    poll: () => (loader.inFlight() ? Promise.resolve() : load()),
  };
});
