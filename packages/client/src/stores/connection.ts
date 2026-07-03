import { create } from "zustand";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

interface ConnectionStore {
  state: ConnState;
  serverTime?: number;
  lastOpenAt?: number;
  attempts: number;
  setState: (s: ConnState) => void;
  onHello: (serverTime: number) => void;
}

/** Live WS connection health — drives the top-bar status dot. */
export const useConnection = create<ConnectionStore>((set) => ({
  state: "connecting",
  attempts: 0,
  setState: (state) =>
    set((p) => ({
      state,
      attempts: state === "reconnecting" ? p.attempts + 1 : p.attempts,
    })),
  onHello: (serverTime) =>
    set({ state: "open", serverTime, lastOpenAt: Date.now(), attempts: 0 }),
}));
