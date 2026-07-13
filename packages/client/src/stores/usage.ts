import { create } from "zustand";
import type { UsageSnapshot } from "@cm/shared";
import { api } from "../lib/api.js";

interface UsageStore {
  /** Latest snapshot (null until the first load). */
  usage: UsageSnapshot | null;
  /** A manual refresh is in flight (spins the refresh button). */
  refreshing: boolean;
  /** True once an initial load has been attempted (drives first-paint state). */
  loaded: boolean;
  /** Apply a snapshot from a REST load or a `usage-update` bus event. */
  set: (usage: UsageSnapshot) => void;
  /** Initial fetch (called once when the meter mounts). */
  load: () => Promise<void>;
  /** Force a server-side refresh (the dropdown's refresh button). */
  refresh: () => Promise<void>;
}

/** Account subscription usage (5h + weekly) — feeds the header usage meter. */
export const useUsage = create<UsageStore>((set, get) => ({
  usage: null,
  refreshing: false,
  loaded: false,

  set: (usage) => set({ usage, loaded: true }),

  load: async () => {
    try {
      const usage = await api.usage.get();
      set({ usage, loaded: true });
    } catch {
      // Best-effort: leave the meter hidden until a bus event or retry lands.
      set({ loaded: true });
    }
  },

  refresh: async () => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const usage = await api.usage.refresh();
      set({ usage, loaded: true });
    } catch {
      /* keep the last snapshot; the button just stops spinning */
    } finally {
      set({ refreshing: false });
    }
  },
}));
