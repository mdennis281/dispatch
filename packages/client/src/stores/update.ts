/**
 * Release update state: what's installed, what's published, and whether the user
 * has already waved this one away.
 *
 * `supported: false` (a build run from source) makes every selector here answer
 * "nothing to show", so no update affordance can appear on the dev instance.
 */
import { create } from "zustand";
import type { UpdateChannel, UpdateStatus } from "@dispatch/shared";
import { api } from "../lib/api.js";
import { dismissVersion, dismissedVersion } from "../lib/updatePrefs.js";

interface UpdateStore {
  status: UpdateStatus | null;
  /** True once an initial load has been attempted. */
  loaded: boolean;
  /** A manual "Check now" is in flight. */
  checking: boolean;
  /** A channel switch is in flight — it re-checks server-side, so it is not instant. */
  switching: boolean;
  /** The install request has been accepted; the server is on its way down. */
  installing: boolean;
  /** Version the user dismissed, mirrored into state so the card re-renders. */
  dismissed: string | null;

  /** Apply a status from a REST load or an `update-available` bus event. */
  set: (status: UpdateStatus) => void;
  load: () => Promise<void>;
  check: () => Promise<void>;
  /** Subscribe to a channel; resolves once the new channel's head is known. */
  setChannel: (channel: UpdateChannel) => Promise<void>;
  /**
   * Ask the server to install. Resolves false with a reason if it refused.
   * `tag` names the channel head explicitly — the only way to ask for a
   * step-back, since a downgrade is never reported as `available`.
   */
  install: (tag?: string) => Promise<{ ok: boolean; error?: string }>;
  dismiss: () => void;
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  status: null,
  loaded: false,
  checking: false,
  switching: false,
  installing: false,
  dismissed: dismissedVersion(),

  set: (status) => set({ status, loaded: true, ...(status.installing ? { installing: true } : {}) }),

  load: async () => {
    try {
      get().set(await api.update.get());
    } catch {
      // Best-effort: an older server with no /api/update simply never shows one.
      set({ loaded: true });
    }
  },

  check: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      get().set(await api.update.check());
    } catch {
      /* keep the last status; the button just stops spinning */
    } finally {
      set({ checking: false });
    }
  },

  setChannel: async (channel) => {
    if (get().switching) return;
    set({ switching: true });
    try {
      get().set(await api.update.setChannel(channel));
    } catch {
      /* keep the last status; the toggle springs back to the real channel */
    } finally {
      set({ switching: false });
    }
  },

  install: async (tag) => {
    // Latched before the request so a double-click cannot post twice; the
    // server refuses a second install anyway, but the UI should not offer it.
    if (get().installing) return { ok: true };
    set({ installing: true });
    try {
      const res = await api.update.install(tag);
      if (!res.ok) set({ installing: false });
      return res;
    } catch (err) {
      set({ installing: false });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  dismiss: () => {
    const version = get().status?.latest?.version;
    if (!version) return;
    dismissVersion(version);
    set({ dismissed: version });
  },
}));

/** An update exists and this payload can actually install it. */
export function hasUpdate(status: UpdateStatus | null): boolean {
  return Boolean(status?.supported && status.available && status.latest);
}

/**
 * Should the standing nudge be shown? Dismissal only silences the CARD — the
 * Settings banner deliberately ignores it, so "dismiss" means "not now, not
 * here", never "never tell me".
 */
export function useShouldNudgeUpdate(): boolean {
  const status = useUpdate((s) => s.status);
  const dismissed = useUpdate((s) => s.dismissed);
  const installing = useUpdate((s) => s.installing);
  if (installing || !hasUpdate(status)) return false;
  return dismissed !== status!.latest!.version;
}
