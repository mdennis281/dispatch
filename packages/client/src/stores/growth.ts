/**
 * The Growth tab's store — one repo's history, walked on demand.
 *
 * UNLIKE THE OTHER METRICS STORES, nothing here re-queries on a control
 * change. The server's walk is the whole history at day resolution, and every
 * control (range, split, bucket, the generated toggle, the series cap) is a
 * re-shape of that in memory — see `components/metrics/growth-shape`. So the
 * store holds ONE report and ONE set of view controls, and `load` runs only
 * on mount, on Reload, and when the project changes.
 *
 * NO CACHE, and no persistence across visits, deliberately. The walk takes
 * about a second per few hundred commits, and the answer it gives is only as
 * fresh as the moment it ran — a "size today" figure held from yesterday's
 * visit is a wrong number wearing today's label. The tab pays for the walk
 * each time it opens and shows its progress while it does.
 *
 * ABORTABLE. A tab flip or a project switch mid-walk aborts the fetch, which
 * closes the socket, which kills the git process server-side. Without that a
 * reader who opened the tab by mistake on a 50k-commit repo would leave git
 * diffing for a minute for nobody.
 */
import { create } from "zustand";
import type { GrowthProgress, GrowthReport } from "@dispatch/shared";
import { api } from "../lib/api.js";
import type { GrowthBucket, GrowthMeasure, GrowthSplit } from "../components/metrics/growth-shape.js";

const DAY = 86_400_000;

/**
 * The range presets. Longer than the ledger pages' — a repo's history runs
 * years where a tool-call ledger runs weeks — and "all time" leads, because
 * the growth curve of the whole history is the picture the tab exists for.
 */
export const GROWTH_RANGES: { id: string; label: string; ms: number | null }[] = [
  { id: "all", label: "All time", ms: null },
  { id: "1y", label: "Last year", ms: 365 * DAY },
  { id: "90d", label: "Last 90 days", ms: 90 * DAY },
  { id: "30d", label: "Last 30 days", ms: 30 * DAY },
];

export const GROWTH_SPLIT_LABELS: Record<GrowthSplit, string> = {
  none: "Nothing",
  language: "Language",
  extension: "Extension",
};

export const GROWTH_MEASURE_LABELS: Record<GrowthMeasure, string> = {
  size: "Size over time",
  churn: "Added vs deleted",
};

interface GrowthStore {
  /** Which project's repo. `null` until the page picks one. */
  projectId: string | null;
  report: GrowthReport | null;
  progress: GrowthProgress | null;
  /** True from the first frame to the last — the page shows the walk. */
  loading: boolean;
  error: string | null;
  /** When the current walk started, for the elapsed readout. */
  startedAt: number | null;

  /* ---- view controls; none of these touch the server ---- */
  rangeId: string;
  measure: GrowthMeasure;
  split: GrowthSplit;
  bucket: GrowthBucket;
  includeGenerated: boolean;
  limit: number;

  /**
   * Show this project: switch to it if it is not the current one, and walk it
   * unless a walk for it is already running. Idempotent on purpose — the page
   * calls it from a mount effect, and React's dev-mode double mount would
   * otherwise either walk twice or (with a naive "same id → return") not at all.
   */
  open: (projectId: string) => void;
  setRange: (id: string) => void;
  setMeasure: (m: GrowthMeasure) => void;
  setSplit: (s: GrowthSplit) => void;
  setBucket: (b: GrowthBucket) => void;
  setIncludeGenerated: (on: boolean) => void;
  setLimit: (n: number) => void;

  /** Walk the current project's history. Aborts any walk in flight first. */
  load: () => Promise<void>;
  /**
   * The page is going away: abort any walk in flight and DROP the report, so
   * the next visit starts from the progress bar rather than from a figure
   * walked some unknown time ago. Reload keeps the old report dimmed behind
   * the new walk; leaving does not, because nothing says how old it is.
   */
  leave: () => void;
}

/** The range start for a preset, or `null` for all time. */
export function growthRangeStart(rangeId: string, now = Date.now()): number | null {
  const preset = GROWTH_RANGES.find((r) => r.id === rangeId) ?? GROWTH_RANGES[0]!;
  return preset.ms === null ? null : now - preset.ms;
}

export const useGrowth = create<GrowthStore>((set, get) => {
  let inflight: AbortController | null = null;

  const cancel = () => {
    inflight?.abort();
    inflight = null;
  };

  return {
    projectId: null,
    report: null,
    progress: null,
    loading: false,
    error: null,
    startedAt: null,

    rangeId: "all",
    measure: "size",
    split: "language",
    bucket: "auto",
    includeGenerated: false,
    limit: 6,

    open: (projectId) => {
      const same = projectId === get().projectId;
      if (same && get().loading) return;
      if (!same) {
        // A report for the previous project must not sit under the new name
        // while the new walk runs; the progress bar is the honest placeholder.
        cancel();
        set({ projectId, report: null, error: null, progress: null });
      }
      void get().load();
    },
    setRange: (rangeId) => set({ rangeId }),
    setMeasure: (measure) => set({ measure }),
    setSplit: (split) => set({ split }),
    setBucket: (bucket) => set({ bucket }),
    setIncludeGenerated: (includeGenerated) => set({ includeGenerated }),
    setLimit: (limit) => set({ limit }),

    load: async () => {
      const { projectId } = get();
      if (!projectId) return;
      cancel();
      const ctl = new AbortController();
      inflight = ctl;
      set({ loading: true, error: null, progress: { phase: "counting" }, startedAt: Date.now() });
      try {
        const report = await api.growth.walk(
          projectId,
          (progress) => {
            if (inflight === ctl) set({ progress });
          },
          ctl.signal,
        );
        if (inflight !== ctl) return;
        set({ report, loading: false, progress: null });
      } catch (err) {
        // An abort is the page's own doing (unmount, project switch), not a
        // failure to report — and by then a newer walk may own the state.
        if (inflight !== ctl || ctl.signal.aborted) return;
        set({
          loading: false,
          progress: null,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (inflight === ctl) inflight = null;
      }
    },

    leave: () => {
      cancel();
      set({ loading: false, progress: null, report: null, error: null });
    },
  };
});
