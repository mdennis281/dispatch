import { create } from "zustand";
import { fallbackModels, type HarnessKind, type ModelOption } from "@dispatch/shared";

interface ModelsStore {
  /** Selectable session models for the composer's model picker. */
  models: ModelOption[];
  /** Whose catalogue `models` is; undefined before any provider has answered. */
  activeHarness: HarnessKind | undefined;
  byHarness: Partial<Record<HarnessKind, ModelOption[]>>;
  /** No provider means no catalogue: an empty picker, not somebody else's list. */
  setModels: (models: ModelOption[], harness: HarnessKind | undefined) => void;
}

/**
 * The composer's selectable session models, replaced on hydrate and on every
 * provider change by the server list — which each runtime reads live, so it
 * matches what that CLI offers. An empty server reply falls back to the
 * provider's own static seed rather than blanking the picker.
 *
 * Starts EMPTY. It used to start on Claude's aliases, so a chat on any other
 * provider — or on a machine with no Claude at all — briefly offered Opus and
 * Sonnet, and a pick made in that window sent a Claude id to Codex (#426).
 */
export const useModels = create<ModelsStore>((set) => ({
  models: [],
  activeHarness: undefined,
  byHarness: {},
  setModels: (models, harness) =>
    set((state) => {
      if (!harness) return { models: [], activeHarness: undefined };
      const next = models.length ? models : fallbackModels(harness);
      return {
        models: next,
        activeHarness: harness,
        byHarness: { ...state.byHarness, [harness]: next },
      };
    }),
}));
