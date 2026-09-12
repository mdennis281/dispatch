import { create } from "zustand";
import { DEFAULT_HARNESS, type HarnessKind, type UsageSnapshot } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface UsageStore {
  /**
   * Latest snapshot PER PROVIDER — absent until that provider's first load.
   *
   * Keyed rather than a single slot because the card can show any configured
   * provider while the gauge reads another. The single slot also had to drop
   * every Claude `usage-update` while the gauge was on Codex (or the pushed
   * Claude numbers would have overwritten the Codex reading), so switching back
   * showed whatever Claude had said before the switch.
   */
  byProvider: Partial<Record<HarnessKind, UsageSnapshot>>;
  /** Providers with a manual refresh in flight (spins the card's button). */
  refreshing: Partial<Record<HarnessKind, boolean>>;
  /** The provider the header gauge reads: the active chat's, else the app default. */
  harness: HarnessKind;
  /** Apply a `usage-update` bus event (the server only pushes Claude's). */
  set: (usage: UsageSnapshot) => void;
  /** Point the gauge at a provider — the app default when omitted — and load it. */
  load: (harness?: HarnessKind) => Promise<void>;
  /** Load one provider's snapshot without moving the gauge (the card's switcher). */
  loadProvider: (harness: HarnessKind) => Promise<void>;
  /** Force a server-side refresh of one provider (the card's refresh button). */
  refresh: (harness: HarnessKind) => Promise<void>;
}

/**
 * Latest `load` call. Resolving the app default awaits a settings read, and a
 * chat on another provider can be opened while that is in flight — without this
 * the late default lands second and points the gauge back at the wrong provider.
 */
let loadSeq = 0;

/** Subscription usage (5h + weekly, or Codex's windows) — feeds the header usage meter. */
export const useUsage = create<UsageStore>((set, get) => {
  const put = (harness: HarnessKind, usage: UsageSnapshot) =>
    set((state) => ({ byProvider: { ...state.byProvider, [harness]: usage } }));

  return {
    byProvider: {},
    refreshing: {},
    harness: DEFAULT_HARNESS,

    set: (usage) => put(usage.provider ?? DEFAULT_HARNESS, usage),

    load: async (requested) => {
      const seq = ++loadSeq;
      const settings = requested ? null : await api.settings.get().catch(() => null);
      if (seq !== loadSeq) return;
      const harness = requested ?? settings?.harness?.defaultHarness ?? DEFAULT_HARNESS;
      set({ harness });
      await get().loadProvider(harness);
    },

    loadProvider: async (harness) => {
      try {
        put(harness, await api.usage.get(harness));
      } catch {
        // Best-effort: keep whatever this provider last showed (or nothing).
      }
    },

    refresh: async (harness) => {
      if (get().refreshing[harness]) return;
      const flag = (on: boolean) =>
        set((state) => ({ refreshing: { ...state.refreshing, [harness]: on } }));
      flag(true);
      try {
        put(harness, await api.usage.refresh(harness));
      } catch {
        /* keep the last snapshot; the button just stops spinning */
      } finally {
        flag(false);
      }
    },
  };
});
