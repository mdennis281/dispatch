/**
 * WebSocket client — the single multiplexed event stream to @dispatch/server.
 *
 * - Connects to /ws (Vite proxies to ws://127.0.0.1:4319 in dev; same-origin in
 *   prod), validates every inbound frame with `WsServerEventSchema`, and hands
 *   it to `applyServerEvent` which fans it to the stores.
 * - Auto-reconnects with capped exponential backoff, updating the connection
 *   store so the top-bar dot reflects reality.
 * - `send()` posts a validated `WsClientAction`, queueing until the socket opens.
 *
 * The shell runs entirely on the mock seed; this client connects opportunistically
 * so 2b's live features light up the moment the backend is running — no rewrite.
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

export interface WsClientOptions {
  /** Disable auto-connect (the shell/tests pass true to stay purely on mock). */
  disabled?: boolean;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private backoff = MIN_BACKOFF;
  private outbox: string[] = [];
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(private opts: WsClientOptions = {}) {}

  connect(): void {
    if (this.opts.disabled || this.closedByUser) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.connecting) return;
    this.connecting = true;
    void this.open();
  }

  private async open(): Promise<void> {

    useConnection.getState().setState(this.backoff === MIN_BACKOFF ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      let ticket: string | undefined;
      if (useAuth.getState().status?.enabled) {
        const response = await sessionFetch("/api/auth/ws-ticket", { method: "POST" });
        if (!response.ok) throw new Error("unable to authorize websocket");
        ticket = (await response.json() as { ticket: string }).ticket;
      }
      socket = new WebSocket(wsUrl(ticket));
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    this.socket = socket;

    socket.addEventListener("open", () => {
      // Stale-socket guard: a `send()` during the CLOSING window can replace this
      // socket before its events fire; ignore the loser so it can't clobber the
      // live connection's state or double-schedule a reconnect.
      if (this.socket !== socket) return;
      this.backoff = MIN_BACKOFF;
      useConnection.getState().setState("open");
      // flush anything queued while offline
      for (const frame of this.outbox.splice(0)) socket.send(frame);
    });

    socket.addEventListener("message", (ev) => {
      if (this.socket !== socket) return;
      this.onMessage(ev.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      useConnection.getState().setState("closed");
      this.scheduleReconnect();
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

  private onMessage(raw: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = WsServerEventSchema.safeParse(json);
    if (!parsed.success) return;
    applyServerEvent(parsed.data);
  }

  private scheduleReconnect(): void {
    if (this.opts.disabled || this.closedByUser) return;
    // The server said it was stopping. Retrying a port nobody is listening on
    // achieves nothing except a console full of failed connections, and it makes
    // the UI claim it's "reconnecting" to something that has to be started by
    // hand. A reload once it's back up reconnects normally.
    if (useConnection.getState().stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

/** App-wide singleton. Import `ws` and call `ws.send(action)` from anywhere. */
export const ws = new WsClient();
