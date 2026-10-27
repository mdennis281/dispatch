import { create } from "zustand";
import type { HarnessInfo } from "../lib/api.js";

interface HarnessesStore {
  harnesses: HarnessInfo[];
  /**
   * The server has answered at least once. An empty `harnesses` means two
   * different things without it — "not asked yet" and "nothing is registered"
   * — and only the second may render as "provider unavailable" (#426).
   */
  loaded: boolean;
  setHarnesses: (harnesses: HarnessInfo[]) => void;
}

export const useHarnesses = create<HarnessesStore>((set) => ({
  harnesses: [],
  loaded: false,
  setHarnesses: (harnesses) => set({ harnesses, loaded: true }),
}));
