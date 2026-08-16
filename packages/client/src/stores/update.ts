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
import {
  clearFlight,
  dismissVersion,
  dismissedVersion,
  readFlight,
  writeFlight,
  type UpdateFlight,
} from "../lib/updatePrefs.js";
import { probeHealth } from "../lib/updateProbe.js";

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
  /**
   * The persisted record of that install — crucially, the identity of the server
   * that accepted it. Non-null exactly when the updating screen should be up.
   * Hydrated from localStorage at store creation so a reload lands straight back
   * on the update screen instead of on a login form.
   */
  flight: UpdateFlight | null;
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
  /**
   * Take over an install this tab did not start — a second tab, or this tab
   * after a reload that beat the shutdown. The baseline has to be probed rather
   * than assumed: the server still answering IS the one the installer is about
   * to stop, so its identity is exactly what the screen needs to watch for.
   */
  adopt: () => Promise<void>;
  /** The update reached a conclusion (or the user dismissed a failed one). */
  endFlight: () => void;
  dismiss: () => void;
}

const initialFlight = readFlight();

export const useUpdate = create<UpdateStore>((set, get) => ({
  status: null,
  loaded: false,
  checking: false,
  switching: false,
  // A persisted marker means an update was running when this tab last had a
  // say. Believing it BEFORE any network call is the point: the screen is up on
  // the first frame, so there is no window in which the shell (or the login
  // form) renders over an install in progress.
  installing: initialFlight !== null,
  flight: initialFlight,
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

    // Probed BEFORE the install is asked for, while the answer is unambiguously
    // the outgoing process. Probing afterwards would race the shutdown and could
    // record the identity of the build we are waiting for as the one we are
    // waiting to LOSE, which strands the screen forever.
    const baseline = await probeHealth();

    try {
      const res = await api.update.install(tag);
      if (!res.ok) {
        set({ installing: false });
        return res;
      }
      const flight: UpdateFlight = {
        tag: res.tag ?? tag ?? null,
        version: get().status?.latest?.version ?? null,
        fromPid: baseline?.pid ?? null,
        fromStartedAt: baseline?.startedAt ?? null,
        startedAt: Date.now(),
      };
      writeFlight(flight);
      set({ flight });
      return res;
    } catch (err) {
      set({ installing: false });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  adopt: async () => {
    if (get().flight) return;
    const baseline = await probeHealth();
    // Re-checked after the await: another caller may have landed a flight while
    // the probe was out, and two markers for one install would disagree about
    // which process to watch for.
    if (get().flight) return;
    const flight: UpdateFlight = {
      tag: get().status?.latest?.tag ?? null,
      version: get().status?.latest?.version ?? null,
      fromPid: baseline?.pid ?? null,
      fromStartedAt: baseline?.startedAt ?? null,
      startedAt: Date.now(),
    };
    writeFlight(flight);
    set({ flight, installing: true });
  },

  endFlight: () => {
    clearFlight();
    set({ flight: null, installing: false });
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
