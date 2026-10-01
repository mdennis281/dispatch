/**
 * The homepage's store — one snapshot, one window width.
 *
 * KEEPS THE LAST SNAPSHOT ACROSS VISITS, which is the difference between a page
 * that feels instant and one that is merely fast. The server already serves a
 * cached snapshot in single-digit milliseconds, but a store that cleared itself
 * on unmount would still paint a spinner for one round trip every time you came
 * home. Holding the previous answer means the second visit paints the numbers in
 * the same frame as the layout, and the fetch that follows swaps in a newer set
 * without a loading state. `computedAt` is on screen, so a reading a few seconds
 * old is labelled rather than passed off as live.
 *
 * `loading` is therefore only ever true for the FIRST load of a window — see
 * `load`. A refetch over an existing snapshot sets `refetching`, which spins the
 * reload glyph and nothing else.
 *
 * NOTHING HERE POLLS. The page is a glance you arrive at, not a dashboard left
 * open on a second monitor, and a background timer re-running a cross-project
 * rollup for a tab nobody is looking at is exactly the cost this feature was
 * asked to avoid. Reload is a button, plus one fetch on arrival.
 */
import { create } from "zustand";
import type { HomeOverview, HomeWindow } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface HomeStore {
  window: HomeWindow;
  /** The last snapshot for the CURRENT window, or null before the first one. */
  overview: HomeOverview | null;
  /** First load of a window — the only state that shows a skeleton. */
  loading: boolean;
  /** A load over an existing snapshot. Spins the glyph; nothing moves. */
  refetching: boolean;
  error: string | null;
  /** Round-trip of the last fetch, ms. Shown in the footer, and honest. */
  fetchMs: number | null;
  /** `force` bypasses the server's cache and waits — see `services/home.ts`. */
  load: (opts?: { force?: boolean }) => Promise<void>;
  setWindow: (window: HomeWindow) => void;
}

/**
 * Snapshots already fetched, by width.
 *
 * Outside the store rather than in it so switching width paints the width you
 * had before, instantly, instead of flashing a skeleton on the way back to a
 * figure the tab has already shown you once.
 */
const seen = new Map<HomeWindow, HomeOverview>();

/**
 * Bumped by every `load()`; a response from an older one may still be CACHED
 * but must not touch the current view's state.
 *
 * The specific bug: switch from a cold 7d to 24h and let 7d land first. Without
 * this the 7d response clears `loading`, so the 24h skeleton vanishes while its
 * own request is still in flight — and a 7d failure would be shown as the 24h
 * error. Module-level, like `stores/metrics`, so bumping it re-renders nothing.
 */
let generation = 0;

export const useHome = create<HomeStore>((set, get) => ({
  window: "7d",
  overview: null,
  loading: false,
  refetching: false,
  error: null,
  fetchMs: null,

  load: async ({ force = false } = {}) => {
    const gen = ++generation;
    const window = get().window;
    const had = get().overview !== null;
    set(had ? { refetching: true } : { loading: true, error: null });
    const started = performance.now();
    try {
      const overview = await api.home.overview(window, force);
      // Still worth caching even if it is no longer the width on screen: it is
      // correct for its OWN width, and the user may well switch back to it.
      seen.set(overview.window, overview);
      if (gen !== generation) return; // a newer load is already in flight
      set({
        overview,
        loading: false,
        refetching: false,
        error: null,
        fetchMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      if (gen !== generation) return;
      set({
        loading: false,
        refetching: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setWindow: (window) => {
    if (get().window === window) return;
    // The cached snapshot for the new width paints immediately; `load` then
    // refreshes it as a `refetching`, so the width flip never shows a skeleton
    // for a width you've already seen.
    set({ window, overview: seen.get(window) ?? null, error: null });
    void get().load();
  },
}));
