import { create } from "zustand";
import { FALLBACK_MODELS, type ModelOption } from "@dispatch/shared";

interface ModelsStore {
  /** Selectable session models for the composer's model picker. */
  models: ModelOption[];
  setModels: (models: ModelOption[]) => void;
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
  setModels: (models) => set({ models: models.length ? models : FALLBACK_MODELS }),
}));
