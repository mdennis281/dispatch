import { create } from "zustand";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

interface ConnectionStore {
  state: ConnState;
  serverTime?: number;
  lastOpenAt?: number;
  attempts: number;
  /**
   * The server told us it was stopping on purpose (`server-shutdown`), rather
   * than the socket simply dying. Kept separate from `state` because it answers
   * a different question — not "are we connected" but "is there anything left to
   * connect TO" — and it's what stops the reconnect loop and swaps the app for
   * the stopped screen. Cleared by a `hello`, so restarting the server and
   * reloading (or just restarting it, for a tab that kept trying) recovers.
   */
  stopped: boolean;
  stoppedReason?: string;
  setState: (s: ConnState) => void;
  onHello: (serverTime: number) => void;
  onServerShutdown: (reason?: string) => void;
}

/** Live WS connection health — drives the top-bar status dot. */
export const useConnection = create<ConnectionStore>((set) => ({
  state: "connecting",
  attempts: 0,
  stopped: false,
  setState: (state) =>
    set((p) => ({
      state,
      attempts: state === "reconnecting" ? p.attempts + 1 : p.attempts,
    })),
  onHello: (serverTime) =>
    set({
      state: "open",
      serverTime,
      lastOpenAt: Date.now(),
      attempts: 0,
      stopped: false,
      stoppedReason: undefined,
    }),
  onServerShutdown: (reason) => set({ stopped: true, stoppedReason: reason }),
}));
