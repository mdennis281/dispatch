/**
 * WebSocket client — the single multiplexed event stream to @dispatch/server.
 *
 * - Connects to /ws (Vite proxies to ws://127.0.0.1:4319 in dev; same-origin in
 *   prod), validates every inbound frame with `WsServerEventSchema`, and hands
 *   it to `applyServerEvent` which fans it to the stores.
 * - Auto-reconnects with jittered, capped exponential backoff, publishing enough
 *   detail into the connection store for `ConnectingScreen` to say WHY.
 * - `send()` posts a validated `WsClientAction`, queueing until the socket opens.
 *
 * ── Why this is more than "reconnect on close" ─────────────────────────────
 * Every timer below exists because some real failure produced a socket that
 * never fired `close`, or fired it so late the app was useless in the meantime:
 *
 *   - a ticket fetch that hangs leaves the client wedged with no retry at all,
 *     because the in-flight guard is never released;
 *   - a proxy that black-holes the upgrade leaves a socket CONNECTING for
 *     minutes before the browser gives up;
 *   - a proxy that completes the upgrade and then buffers leaves it OPEN with
 *     nothing ever arriving;
 *   - an OS suspend or a NAT/proxy idle-reap leaves `readyState === OPEN` on a
 *     peer that is simply gone.
 *
 * The last one is why there is an application-level ping: the browser exposes no
 * ping/pong event to JavaScript, so the server's transport pings cannot be
 * observed here, and without a round trip of our own an idle connection and a
 * dead one are indistinguishable.
 */
import {
  WsServerEventSchema,
  WsClientActionSchema,
  type WsClientAction,
} from "@dispatch/shared";
import { applyServerEvent, useConnection } from "../stores/index.js";
import { sessionFetch, useAuth } from "../stores/auth.js";

function wsUrl(ticket?: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ""}`;
}

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;
/** Max frames buffered while offline before the oldest are dropped. */
const MAX_OUTBOX = 256;

/**
 * Deadline on the ws-ticket POST.
 *
 * Without one this is a permanent wedge, not a slow path: the request is awaited
 * while the in-flight guard is held, so a half-open socket after a network
 * change — the request that never resolves and never rejects — leaves `connect()`
 * returning early forever and `scheduleReconnect()` never reached. No retry, no
 * error, no reason shown.
 */
const TICKET_TIMEOUT_MS = 10_000;

/** How long a socket may sit in CONNECTING before we call it a failure. */
const OPEN_TIMEOUT_MS = 12_000;

/** How long after OPEN to wait for `hello` before treating the socket as dead. */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Liveness probe cadence on an otherwise silent socket. Comfortably under the
 * 60s idle timeout that proxies commonly default to.
 */
const HEARTBEAT_MS = 25_000;

/** How long a `pong` may take before the connection is presumed dead. */
const PONG_TIMEOUT_MS = 10_000;

/** The same, when the probe was triggered by the user coming back to the tab. */
const WAKE_PONG_TIMEOUT_MS = 5_000;

/** Floor between wake-triggered reconnects, so alt-tabbing can't be a hammer. */
const WAKE_MIN_INTERVAL_MS = 2_000;

export interface WsClientOptions {
  /** Disable auto-connect (the shell/tests pass true to stay purely on mock). */
  disabled?: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

export class WsClient {
  private socket: WebSocket | null = null;
  private backoff = MIN_BACKOFF;
  private outbox: string[] = [];
  private closedByUser = false;
  private reconnectTimer: Timer | null = null;
  private connecting = false;
  private ticketAbort: AbortController | null = null;
  private openTimer: Timer | null = null;
  private helloTimer: Timer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: Timer | null = null;
  private pendingNonce: string | null = null;
  private nonceSeq = 0;
  private lastAttemptAt = 0;
  private hooksInstalled = false;
  /**
   * Why WE closed the socket, when we did. The browser reports a forced close as
   * a bare 1006 with no reason, which would throw away the one thing we actually
   * knew about the failure.
   */
  private forcedReason: string | null = null;

  constructor(private opts: WsClientOptions = {}) {}

  connect(): void {
    if (this.opts.disabled || this.closedByUser) return;
    this.installHooks();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.connecting) return;
    // A direct connect supersedes a scheduled one. Leaving the timer armed means
    // it fires into a live socket, and the countdown the connecting screen shows
    // is describing a retry that will never do anything.
    this.clearReconnect();
    this.connecting = true;
    void this.open();
  }

  /**
   * Retry right now, at the user's request.
   *
   * Clears the `stopped` latch too: that flag means "the server said there is
   * nothing left to connect to", and someone pressing a retry button is
   * explicitly overriding that verdict.
   */
  retryNow(): void {
    if (this.opts.disabled) return;
    this.closedByUser = false;
    useConnection.getState().clearStopped();
    this.backoff = MIN_BACKOFF;
    this.clearReconnect();
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // It claims to be up. Prove it rather than tearing down a connection that
      // may be perfectly good.
      this.probeLiveness(WAKE_PONG_TIMEOUT_MS);
      return;
    }
    if (socket) this.forceClose(socket, "retry requested");
    this.connect();
  }

  private async fetchTicket(): Promise<string> {
    const controller = new AbortController();
    this.ticketAbort = controller;
    const timer = setTimeout(() => controller.abort(), TICKET_TIMEOUT_MS);
    try {
      const response = await sessionFetch("/api/auth/ws-ticket", {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("unable to authorize websocket");
      return (await response.json() as { ticket: string }).ticket;
    } finally {
      clearTimeout(timer);
      this.ticketAbort = null;
    }
  }

  private async open(): Promise<void> {
    const conn = useConnection.getState();
    conn.setState(this.backoff === MIN_BACKOFF ? "connecting" : "reconnecting");
    conn.noteAttempt();
    this.lastAttemptAt = Date.now();

    let socket: WebSocket;
    try {
      let ticket: string | undefined;
      if (useAuth.getState().status?.enabled) ticket = await this.fetchTicket();
      socket = new WebSocket(wsUrl(ticket));
    } catch {
      this.connecting = false;
      this.noteClose({ code: 1006, reason: "could not start the connection", wasClean: false });
      useConnection.getState().setState("closed");
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    this.socket = socket;
    // The old socket may have died during the ticket fetch above and armed a
    // retry while this attempt was already in flight.
    this.clearReconnect();

    this.openTimer = setTimeout(() => {
      // Still CONNECTING. Browsers do give up eventually, but "eventually" is
      // minutes when a proxy black-holes the upgrade rather than refusing it,
      // and for those minutes nothing tells the user anything is wrong.
      this.forceClose(socket, "timed out opening");
    }, OPEN_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      // Stale-socket guard: a `send()` during the CLOSING window can replace this
      // socket before its events fire; ignore the loser so it can't clobber the
      // live connection's state or double-schedule a reconnect.
      if (this.socket !== socket) return;
      this.clearTimer("openTimer");
      useConnection.getState().setState("open");
      // Deliberately NOT resetting `backoff` here — see `onMessage`. An open
      // socket proves the TCP handshake worked and nothing else.
      this.helloTimer = setTimeout(() => {
        this.forceClose(socket, "no handshake from the server");
      }, HELLO_TIMEOUT_MS);
      // flush anything queued while offline
      for (const frame of this.outbox.splice(0)) socket.send(frame);
    });

    socket.addEventListener("message", (ev) => {
      if (this.socket !== socket) return;
      this.onMessage(ev.data);
    });

    socket.addEventListener("close", (ev) => {
      this.handleClose(socket, {
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
      });
    });

    socket.addEventListener("error", () => {
      // `close` fires right after; let it own the reconnect.
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    });
  }

  /**
   * Tear this socket down and start the retry clock.
   *
   * Idempotent per socket: the first call detaches it, so a real `close` event
   * arriving after a forced one is ignored by the same stale-socket guard that
   * ignores a superseded connection.
   */
  private handleClose(
    socket: WebSocket,
    info: { code: number; reason: string; wasClean: boolean },
  ): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearSocketTimers();

    const reason = info.reason || this.forcedReason || "";
    this.forcedReason = null;
    this.noteClose({ ...info, reason });
    useConnection.getState().setState("closed");

    // A close arriving while another attempt is already in flight (the old
    // socket dying during the new one's ticket fetch) must not add a second
    // schedule — `open()` owns the outcome of the attempt it is running.
    if (this.connecting) return;
    this.scheduleReconnect();
  }

  private noteClose(info: { code: number; reason: string; wasClean: boolean }): void {
    useConnection.getState().noteClose({ ...info, at: Date.now() });
  }

  private forceClose(socket: WebSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.forcedReason = reason;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    // Drive the teardown rather than waiting on an event: a socket closed while
    // still CONNECTING is exactly the case where engines have historically been
    // inconsistent about firing one, and this path exists to escape sockets that
    // don't report for themselves.
    this.handleClose(socket, { code: 1006, reason, wasClean: false });
  }

  private onMessage(raw: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      useConnection.getState().noteBadFrame("unparseable");
      return;
    }
    const parsed = WsServerEventSchema.safeParse(json);
    if (!parsed.success) {
      // Counted, not merely dropped. Silently discarding these is what turns a
      // build/protocol mismatch into "the app froze with a green dot" — the one
      // failure mode with no symptom at all until someone notices nothing has
      // updated for ten minutes.
      const type =
        typeof json === "object" && json !== null && typeof (json as { type?: unknown }).type === "string"
          ? (json as { type: string }).type
          : "unknown";
      useConnection.getState().noteBadFrame(type);
      return;
    }

    if (parsed.data.type === "pong") {
      this.onPong(parsed.data.nonce);
      return;
    }

    if (parsed.data.type === "hello") {
      this.clearTimer("helloTimer");
      // Backoff resets HERE, not on `open`. A server that accepts and then
      // immediately drops the connection — crashing on accept, or a proxy that
      // completes the upgrade and hangs up — would otherwise reset the interval
      // on every cycle and retry twice a second forever. A `hello` is the first
      // moment we know the connection actually carried something.
      this.backoff = MIN_BACKOFF;
      this.startHeartbeat();
    }

    applyServerEvent(parsed.data);
  }

  /* ------------------------------------------------------------- liveness */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.probeLiveness(PONG_TIMEOUT_MS), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Ask the server to prove it's still there.
   *
   * This cannot be inferred from traffic: a genuinely idle Dispatch sends
   * nothing for minutes at a time, so "silent" and "dead" look identical from
   * here. Only a round trip separates them.
   */
  private probeLiveness(timeout: number): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.pongTimer) return; // one outstanding probe is enough
    const nonce = String(++this.nonceSeq);
    this.pendingNonce = nonce;
    try {
      socket.send(JSON.stringify({ type: "ping", nonce }));
    } catch {
      this.forceClose(socket, "connection is not writable");
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket) return;
      // `readyState` still says OPEN and the peer is gone — a proxy idle-reap, a
      // laptop that slept, a network that moved. No `close` is coming for this
      // socket; it has to be abandoned deliberately.
      this.forceClose(socket, "no response to heartbeat");
    }, timeout);
  }

  private onPong(nonce: string): void {
    if (nonce !== this.pendingNonce) return;
    this.pendingNonce = null;
    this.clearTimer("pongTimer");
  }

  /* ---------------------------------------------------------- wake / hooks */

  private installHooks(): void {
    if (this.hooksInstalled || typeof window === "undefined") return;
    this.hooksInstalled = true;
    window.addEventListener("online", () => {
      useConnection.getState().setOnline(true);
      this.wake(true);
    });
    window.addEventListener("offline", () => useConnection.getState().setOnline(false));
    window.addEventListener("focus", () => this.wake(false));
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.wake(false);
      });
    }
  }

  /**
   * The network came back, or the user did. Either way the schedule built out of
   * the last failure is stale — waiting out another eight seconds of backoff in
   * front of someone who is looking at the screen is the whole complaint.
   *
   * @param immediate the network itself just returned, so skip the rate limit.
   */
  private wake(immediate: boolean): void {
    if (this.opts.disabled || this.closedByUser) return;
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Precisely when a socket is most likely to be a corpse: the machine was
      // asleep, or the network moved under it, and `readyState` has no idea.
      this.probeLiveness(WAKE_PONG_TIMEOUT_MS);
      return;
    }
    if (this.connecting || socket) return;
    if (!immediate && Date.now() - this.lastAttemptAt < WAKE_MIN_INTERVAL_MS) return;
    this.backoff = MIN_BACKOFF;
    this.clearReconnect();
    this.connect();
  }

  /* ------------------------------------------------------------- schedule */

  private scheduleReconnect(): void {
    if (this.opts.disabled || this.closedByUser) return;
    // The server said it was stopping. Retrying a port nobody is listening on
    // achieves nothing except a console full of failed connections, and it makes
    // the UI claim it's "reconnecting" to something that has to be started by
    // hand. `retryNow()` (or a reload) clears this.
    if (useConnection.getState().stopped) return;
    if (this.reconnectTimer) return;
    const base = this.backoff;
    this.backoff = Math.min(base * 2, MAX_BACKOFF);
    // Jitter across 50–100% of the interval. Without it every tab — and in host
    // mode every DEVICE that had one open — retries on the same doubling
    // schedule and arrives at the restarting server in one synchronised wave.
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    useConnection.getState().setNextRetry(Date.now() + delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    useConnection.getState().setNextRetry(undefined);
  }

  private clearTimer(field: "openTimer" | "helloTimer" | "pongTimer"): void {
    const timer = this[field];
    if (timer) clearTimeout(timer);
    this[field] = null;
  }

  private clearSocketTimers(): void {
    this.clearTimer("openTimer");
    this.clearTimer("helloTimer");
    this.clearTimer("pongTimer");
    this.stopHeartbeat();
    this.pendingNonce = null;
  }

  /* ----------------------------------------------------------------- send */

  /** Send a client action (validated); queues while the socket is down. */
  send(action: WsClientAction): void {
    const parsed = WsClientActionSchema.safeParse(action);
    if (!parsed.success) {
      console.warn("[ws] refusing to send invalid action", parsed.error.message);
      return;
    }
    const frame = JSON.stringify(parsed.data);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
    } else {
      // Cap the offline queue so a long outage with an eager clicker can't grow
      // it without bound; drop the oldest (least-relevant) frames first.
      this.outbox.push(frame);
      if (this.outbox.length > MAX_OUTBOX) {
        this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
      }
      this.connect();
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearReconnect();
    this.clearSocketTimers();
    this.ticketAbort?.abort();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

/** App-wide singleton. Import `ws` and call `ws.send(action)` from anywhere. */
export const ws = new WsClient();
