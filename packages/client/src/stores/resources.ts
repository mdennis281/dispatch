/**
 * What Dispatch is costing this machine — the store behind the header widget
 * and the Resources page.
 *
 * TWO POLLS, NOT ONE, because the two readings cost four orders of magnitude
 * apart on the server:
 *
 *   • `system` is `os.cpus()`/`os.freemem()`, ~0.2 ms, no subprocess. It backs
 *     the header widget and runs WHENEVER THE APP IS OPEN, because a number you
 *     glance at has to already be there.
 *   • `snapshot` needs the OS process table — ~800 ms of `powershell.exe` on
 *     Windows. It runs ONLY while something is subscribed to it, which in
 *     practice means only while the Resources page is on screen.
 *
 * That split is the whole design. The point of this feature is a machine that
 * is running out of headroom; a monitor that polls an 800 ms scan every two
 * seconds to feel "live" would be a meaningful part of the problem it claims to
 * diagnose. So the cheap number is live and the expensive one is deliberate,
 * and the UI says which it is showing.
 *
 * REFERENCE COUNTED rather than mounted-once. Two components can want the
 * snapshot at the same time (the page, and a drill-down inside it), and each
 * starting its own interval would double the scanning. `subscribeSnapshot`
 * hands back a disposer; the timer exists exactly while at least one caller
 * holds one.
 */
import { create } from "zustand";
import type { ChatProcessDetail, ResourceSnapshot, SystemResources } from "@dispatch/shared";
import { api } from "../lib/api.js";

/**
 * How often the free system reading refreshes.
 *
 * 2 s rather than 1: it is one cheap HTTP round trip, but it is still a round
 * trip on every open tab, and a header figure does not become more useful for
 * updating twice as often. Fast enough to catch a spike, slow enough to ignore.
 */
const SYSTEM_POLL_MS = 2_000;

/**
 * How often the process-table snapshot refreshes while the page is open.
 *
 * 5 s against a server-side cache TTL of 10 s, so at most every other poll
 * actually scans and the rest are served from the shared table the sidebar's
 * count poll is already paying for. Tightening this would not make the page
 * more current — it would just miss the cache more often.
 */
const SNAPSHOT_POLL_MS = 5_000;

interface ResourceStore {
  /** The machine. Present as soon as the app has been open a moment. */
  system: SystemResources | null;
  /** Everything, including per-chat. `null` until the page asks for it. */
  snapshot: ResourceSnapshot | null;
  /** A row's per-process drill-down, keyed by chat. */
  details: Record<string, ChatProcessDetail>;
  /** True while the first snapshot is in flight, so the page can say so. */
  loading: boolean;
  /**
   * True while a FORCED rescan is in flight, so the Reload button can spin.
   *
   * Separate from `loading`, which is only the very first fetch: a reload with
   * a table already on screen should keep showing it and just say it is
   * working, not blank the page back to "Scanning…".
   */
  refetching: boolean;

  refreshSystem: () => Promise<void>;
  /** `fresh` forces a server-side rescan — for an explicit Reload only. */
  refreshSnapshot: (fresh?: boolean) => Promise<void>;
  loadDetail: (chatId: string) => Promise<void>;
  /** Start the expensive poll; call the disposer when the view goes away. */
  subscribeSnapshot: () => () => void;
}

export const useResources = create<ResourceStore>((set, get) => {
  let snapshotTimer: ReturnType<typeof setInterval> | undefined;
  let subscribers = 0;

  return {
    system: null,
    snapshot: null,
    details: {},
    loading: false,
    refetching: false,

    refreshSystem: async () => {
      // A failed read keeps the last one rather than blanking the widget: a
      // stale figure is off by one poll, an empty one reads as "no data" and
      // sends someone looking for a problem that isn't there.
      const res = await api.resources.system().catch(() => null);
      if (res) set({ system: res });
    },

    refreshSnapshot: async (fresh = false) => {
      if (fresh) set({ refetching: true });
      const res = await api.resources.snapshot(fresh).catch(() => null);
      // `refetching` clears on failure too — a spinner that never stops is a
      // worse lie than a table that did not change.
      set(res ? { snapshot: res, loading: false, refetching: false } : { loading: false, refetching: false });
    },

    loadDetail: async (chatId) => {
      const res = await api.resources.chatDetail(chatId).catch(() => null);
      if (res) set((s) => ({ details: { ...s.details, [chatId]: res } }));
    },

    subscribeSnapshot: () => {
      subscribers += 1;
      if (subscribers === 1) {
        if (get().snapshot === null) set({ loading: true });
        void get().refreshSnapshot();
        snapshotTimer = setInterval(() => void get().refreshSnapshot(), SNAPSHOT_POLL_MS);
      }
      let released = false;
      return () => {
        // Guarded because React 18's strict mode runs an effect's cleanup
        // twice in development; a double decrement would drop the count below
        // zero and leave the timer running for the rest of the session.
        if (released) return;
        released = true;
        subscribers -= 1;
        if (subscribers === 0 && snapshotTimer) {
          clearInterval(snapshotTimer);
          snapshotTimer = undefined;
        }
      };
    },
  };
});

/**
 * Start the cheap system poll for the lifetime of the app.
 *
 * Module scope rather than an effect: the header widget is always mounted, so
 * there is nothing to tear down, and hanging it off a component would mean the
 * first reading arrived a render late — with `cpuPct` null, since the server
 * needs two samples before it can report a rate at all.
 */
export function startSystemPolling(): () => void {
  const tick = () => void useResources.getState().refreshSystem();
  tick();
  const timer = setInterval(tick, SYSTEM_POLL_MS);
  return () => clearInterval(timer);
}

/**
 * Share of a total, as a percent, safe when the total is zero or unknown.
 *
 * Zero rather than a division by zero: a bar with no denominator should render
 * as empty, not as `NaN%` or a full bar.
 */
export function share(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (100 * part) / total));
}

/**
 * A per-process CPU figure re-expressed as a share of the WHOLE MACHINE.
 *
 * The server reports process CPU as a percent of ONE core, because that is what
 * a delta of CPU-time over wall-time naturally gives and it is the only form
 * that can exceed 100 for a multi-threaded process. But the system figure
 * beside it is a percent of ALL cores, and rendering both as "11%" put two
 * numbers that differ by 16x under the same label in the same dropdown.
 *
 * Everything the UI SHOWS is therefore machine-relative: a chat's percentage
 * and Dispatch's percentage are directly comparable with the machine's, and
 * with each other, and they add up. `null` survives the conversion, because
 * "not measured" must not become 0 here either.
 */
export function machinePct(cpuPct: number | null, cores: number): number | null {
  if (cpuPct === null) return null;
  if (!Number.isFinite(cores) || cores <= 0) return cpuPct;
  return cpuPct / cores;
}
