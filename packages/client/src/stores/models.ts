import { create } from "zustand";
import {
  FALLBACK_MODELS,
  fallbackModels,
  type HarnessKind,
  type ModelOption,
} from "@dispatch/shared";

interface ModelsStore {
  /** Selectable session models for the composer's model picker. */
  models: ModelOption[];
  activeHarness: HarnessKind;
  byHarness: Partial<Record<HarnessKind, ModelOption[]>>;
  setModels: (models: ModelOption[], harness?: HarnessKind) => void;
}

/**
 * The composer's selectable session models. Seeded with the static fallback so
 * the picker renders instantly, then replaced on hydrate by the server list —
 * which the server reads live from the Claude Code runtime, so it matches what
 * `/model` offers in the CLI. An empty server reply keeps the fallback rather
 * than blanking the picker.
 */
export const useModels = create<ModelsStore>((set) => ({
  models: FALLBACK_MODELS,
  activeHarness: "claude",
  byHarness: { claude: FALLBACK_MODELS },
  setModels: (models, harness = "claude") =>
    set((state) => {
      const next = models.length ? models : fallbackModels(harness);
      return {
        models: next,
        activeHarness: harness,
        byHarness: { ...state.byHarness, [harness]: next },
      };
    }),
}));
