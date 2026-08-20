import { create } from "zustand";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Why the last socket went away — as much as the browser is willing to say.
 *
 * This used to be discarded: the close listener took no argument, so every
 * distinguishable failure collapsed into the same grey "Offline" dot. The codes
 * matter because they separate causes that need completely different fixes —
 * `1006` (no close frame at all) is the signature of a proxy that never
 * forwarded the upgrade, while `4401` is Dispatch itself saying the session is
 * no longer valid, and the server sends that one deliberately.
 */
export interface CloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
  at: number;
}

/**
 * What a probe of `/api/health` actually found.
 *
 * Deliberately more granular than "did it work", because behind a reverse proxy
 * the interesting answers all come back as failures of different kinds and each
 * points somewhere else: a gateway error means the edge is fine and Dispatch
 * behind it is not, an HTML body means something that isn't Dispatch answered,
 * and a 503 with `problems` means Dispatch is running and broken.
 */
export type ProbeKind =
  | "ok"
  | "degraded"
  | "gateway"
  | "unauthorized"
  | "not-json"
  | "unreachable";

export interface ServerProbe {
  kind: ProbeKind;
  /** HTTP status, when one came back at all. */
  status?: number;
  /** `problems[]` from a degraded health report — already human-readable. */
  problems?: string[];
  /** Whether the built SPA is servable, per the health report. */
  spa?: boolean;
  /** Whether the state/config roots read back, per the health report. */
  store?: boolean;
  /** Auth is switched on server-side but this tab holds no session. */
  needsLogin?: boolean;
  at: number;
}

interface ConnectionStore {
  state: ConnState;
  serverTime?: number;
  lastOpenAt?: number;
  attempts: number;
  /**
   * When we stopped being usably connected, or undefined while we are.
   *
   * Set on any non-open transition and cleared ONLY by `hello` — not by the
   * socket opening. An open socket that never says hello is exactly the
   * proxy-buffering failure this screen exists to name, so treating `open` as
   * recovery would hide it. It's also the clock the connecting screen's grace
   * period runs off, so a 400ms server restart never flashes a diagnostic panel.
   */
  downSince?: number;
  /** Epoch ms of the next scheduled reconnect, for the countdown. */
  nextRetryAt?: number;
  lastClose?: CloseInfo;
  /** Build stamp the server reported in `hello`; absent from a source checkout. */
  serverVersion?: string;
  /**
   * Inbound frames that failed `WsServerEventSchema`, and the `type`s they
   * claimed. Counted rather than dropped on the floor: a non-zero count with a
   * live socket is the silent-freeze failure, and it is otherwise undetectable
   * from inside the app.
   */
  badFrames: number;
  badFrameTypes: string[];
  probe?: ServerProbe;
  /** `navigator.onLine`, kept live off the window events. */
  online: boolean;
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
  /**
   * Dev-only: the offline mock seed ran, so this shell is showing fabricated
   * data on purpose (see main.tsx). The connecting screen stands down for it —
   * covering the mock with a diagnostic panel would break the design/screenshot
   * workflow the seed exists for.
   */
  mockSeeded: boolean;
  /**
   * `startLiveApp` has run, so this tab is actually trying to hold a connection.
   *
   * Until then there is no expectation to fail. The case that matters: with auth
   * enabled and no session, the app deliberately does NOT open a socket — it
   * shows the sign-in form and waits. Without this flag the connecting screen
   * reads "down since page load", clears its grace period, and covers the login
   * form with a connection diagnosis for a server that is perfectly healthy and
   * simply hasn't been logged into.
   */
  liveStarted: boolean;
  setState: (s: ConnState) => void;
  noteAttempt: () => void;
  setNextRetry: (at?: number) => void;
  noteClose: (info: CloseInfo) => void;
  noteBadFrame: (type: string) => void;
  setProbe: (probe: ServerProbe) => void;
  setOnline: (online: boolean) => void;
  noteMockSeeded: () => void;
  noteLiveStarted: () => void;
  noteLiveStopped: () => void;
  clearStopped: () => void;
  onHello: (serverTime: number, version?: string) => void;
  onServerShutdown: (reason?: string) => void;
}

/** How many distinct rejected frame `type`s are worth keeping for the report. */
const BAD_TYPE_SAMPLE = 4;

/** Live WS connection health — drives the top-bar dot and the connecting screen. */
export const useConnection = create<ConnectionStore>((set) => ({
  state: "connecting",
  attempts: 0,
  // Seeded, not left undefined: the very first connect is itself a "down"
  // period, so a cold boot against a dead server gets the same grace period and
  // the same diagnosis as a mid-session drop rather than falling through to a
  // shell that pretends everything loaded.
  downSince: Date.now(),
  badFrames: 0,
  badFrameTypes: [],
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  mockSeeded: false,
  liveStarted: false,
  stopped: false,
  setState: (state) =>
    set((p) => ({
      state,
      downSince: state === "open" ? p.downSince : (p.downSince ?? Date.now()),
      ...(state === "open" ? { nextRetryAt: undefined } : {}),
    })),
  noteAttempt: () => set((p) => ({ attempts: p.attempts + 1 })),
  setNextRetry: (nextRetryAt) => set({ nextRetryAt }),
  noteClose: (lastClose) => set({ lastClose }),
  noteBadFrame: (type) =>
    set((p) => ({
      badFrames: p.badFrames + 1,
      badFrameTypes: p.badFrameTypes.includes(type)
        ? p.badFrameTypes
        : [...p.badFrameTypes, type].slice(-BAD_TYPE_SAMPLE),
    })),
  setProbe: (probe) => set({ probe }),
  setOnline: (online) => set({ online }),
  noteMockSeeded: () => set({ mockSeeded: true }),
  noteLiveStarted: () => set({ liveStarted: true }),
  noteLiveStopped: () => set({ liveStarted: false }),
  clearStopped: () => set({ stopped: false, stoppedReason: undefined }),
  onHello: (serverTime, version) =>
    set({
      state: "open",
      serverTime,
      serverVersion: version,
      lastOpenAt: Date.now(),
      attempts: 0,
      downSince: undefined,
      nextRetryAt: undefined,
      lastClose: undefined,
      // A fresh handshake means the schemas in play are whatever this pairing
      // agrees on now. Carrying the old tally across a reconnect would keep
      // reporting a mismatch that a server restart may well have just fixed.
      badFrames: 0,
      badFrameTypes: [],
      stopped: false,
      stoppedReason: undefined,
    }),
  onServerShutdown: (reason) => set({ stopped: true, stoppedReason: reason }),
}));
