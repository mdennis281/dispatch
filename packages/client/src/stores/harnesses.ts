import { create } from "zustand";
import type { HarnessInfo } from "../lib/api.js";

interface HarnessesStore {
  harnesses: HarnessInfo[];
  setHarnesses: (harnesses: HarnessInfo[]) => void;
}

export const useHarnesses = create<HarnessesStore>((set) => ({
  harnesses: [],
  setHarnesses: (harnesses) => set({ harnesses }),
}));
