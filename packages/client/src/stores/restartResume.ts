/**
 * What the server did about chats a deliberate restart cut short.
 *
 * Deliberately NOT persisted to localStorage, unlike `updatePrefs`. The status
 * describes one boot of one server: a tab that reloads should re-ask and get
 * whatever is true now, and a dismissal should die with the process it was about
 * — a banner restored from disk after the next restart would be reporting a
 * resume that already scrolled away.
 *
 * The server pushes `restart-resume` when the boot pass lands, so a tab that was
 * already open when the resumes happened gets it without polling. `load()` is
 * for the tab that connects afterwards.
 */
import { create } from "zustand";
import type { RestartResumeStatus } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface RestartResumeStore {
  status: RestartResumeStatus | null;
  /** A "Stop them" request is in flight. */
  stopping: boolean;
  /** Apply a status from a REST load or a `restart-resume` bus event. */
  set: (status: RestartResumeStatus | null) => void;
  load: () => Promise<void>;
  /** The undo: interrupt every turn the server started on its own. */
  stopAll: () => Promise<void>;
  dismiss: () => void;
}

export const useRestartResume = create<RestartResumeStore>((set, get) => ({
  status: null,
  stopping: false,

  set: (status) => set({ status }),

  load: async () => {
    try {
      set({ status: await api.restartResume.get() });
    } catch {
      // Best-effort: a server without the route simply never shows the banner.
    }
  },

  stopAll: async () => {
    if (get().stopping) return;
    set({ stopping: true });
    try {
      await api.restartResume.stop();
      // The server has already dropped its own status; clear ours rather than
      // waiting for the event, so the button cannot be pressed twice.
      set({ status: null });
    } catch {
      /* leave the banner up — nothing was stopped, so saying so would be a lie */
    } finally {
      set({ stopping: false });
    }
  },

  dismiss: () => {
    set({ status: null });
    // Tell the server too, so a second tab (and this one after a reload) does
    // not resurrect a banner this human has already dealt with.
    void api.restartResume.dismiss().catch(() => {});
  },
}));

/** Is there anything to say about the last restart? */
export function useShouldShowResumed(): boolean {
  return useRestartResume(
    (s) => (s.status?.resumed.length ?? 0) + (s.status?.needsInput.length ?? 0) > 0,
  );
}
