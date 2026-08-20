import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WsClient } from "./ws.js";
import { useConnection } from "../stores/connection.js";

/**
 * A WebSocket that behaves like the real one in the way that matters here:
 * `close()` does NOT synchronously fire the close event.
 *
 * That asymmetry is the whole reason these tests exist. Code that tears a socket
 * down and assumes the event will arrive to finish the job is code that leaves
 * the store describing a connection that is already gone — which is exactly the
 * defect `WsClient.close()` had.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  private pendingClose: { code: number; reason: string; wasClean: boolean } | null = null;

  constructor(public url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSING;
    this.pendingClose ??= { code: 1006, reason: "", wasClean: false };
  }

  private emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  /* ---- test drivers ---- */

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  fireMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  /** Deliver the close event the browser would have delivered asynchronously. */
  flushClose(): void {
    const info = this.pendingClose ?? { code: 1006, reason: "", wasClean: false };
    this.pendingClose = null;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", info);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
let savedWebSocket: unknown;
let savedLocation: unknown;

function resetStore(): void {
  useConnection.setState({
    state: "connecting",
    attempts: 0,
    downSince: Date.now(),
    nextRetryAt: undefined,
    lastClose: undefined,
    serverVersion: undefined,
    badFrames: 0,
    badFrameTypes: [],
    probe: undefined,
    online: true,
    mockSeeded: false,
    liveStarted: true,
    stopped: false,
    stoppedReason: undefined,
  });
}

/** A client with an OPEN socket that has completed the handshake. */
function connected(): { client: WsClient; socket: FakeSocket } {
  const client = new WsClient();
  client.connect();
  const socket = FakeSocket.last!;
  socket.fireOpen();
  socket.fireMessage({ type: "hello", serverTime: 1 });
  return { client, socket };
}

beforeEach(() => {
  savedWebSocket = globals.WebSocket;
  savedLocation = globals.location;
  globals.WebSocket = FakeSocket;
  globals.location = { protocol: "http:", host: "dispatch.test" };
  FakeSocket.last = null;
  resetStore();
});

afterEach(() => {
  globals.WebSocket = savedWebSocket;
  globals.location = savedLocation;
});

describe("WsClient — handshake", () => {
  it("only counts as connected once `hello` lands, not when the socket opens", () => {
    const client = new WsClient();
    client.connect();
    const socket = FakeSocket.last!;

    socket.fireOpen();
    // Open is not connected: a proxy that completes the upgrade and then buffers
    // leaves exactly this state, and `downSince` staying set is what lets the
    // connecting screen report it.
    expect(useConnection.getState().downSince).toBeDefined();

    socket.fireMessage({ type: "hello", serverTime: 42, version: "2026.08.20.00001" });
    const after = useConnection.getState();
    expect(after.state).toBe("open");
    expect(after.downSince).toBeUndefined();
    expect(after.serverVersion).toBe("2026.08.20.00001");
    client.close();
  });
});

describe("WsClient — close()", () => {
  it("records the close instead of swallowing it", () => {
    // Regression: `close()` used to null `this.socket` before calling
    // `socket.close()`. The close event then failed the stale-socket guard in
    // `handleClose` and was ignored, so the store went on reporting `open` for a
    // connection that had deliberately been torn down.
    const { client } = connected();
    expect(useConnection.getState().state).toBe("open");

    client.close();

    const after = useConnection.getState();
    expect(after.state).toBe("closed");
    expect(after.lastClose?.code).toBe(1000);
    expect(after.lastClose?.wasClean).toBe(true);
  });

  it("stands the diagnosis down, because a teardown is not a fault", () => {
    const { client } = connected();
    client.close();
    expect(useConnection.getState().liveStarted).toBe(false);
  });

  it("is idempotent when the socket's own close event arrives afterwards", () => {
    const { client, socket } = connected();
    client.close();
    const recorded = useConnection.getState().lastClose;

    socket.flushClose();

    // The late event must not overwrite the deliberate close with a bare 1006,
    // nor arm a retry for a client that was explicitly shut down.
    expect(useConnection.getState().lastClose).toBe(recorded);
    expect(useConnection.getState().nextRetryAt).toBeUndefined();
  });

  it("stops reconnecting for good", () => {
    const { client } = connected();
    client.close();
    FakeSocket.last = null;
    client.connect();
    expect(FakeSocket.last).toBeNull();
  });
});

describe("WsClient — frames", () => {
  it("counts frames that fail the schema rather than dropping them silently", () => {
    // Silently discarding these is what turns a build mismatch into "the app
    // froze with a green dot" — the failure with no symptom at all.
    const { client, socket } = connected();
    socket.fireMessage({ type: "chat-status", chatId: "c1" }); // missing `status`
    socket.fireMessage({ type: "not-a-real-event" });
    socket.fireMessage("}{ not json");

    const after = useConnection.getState();
    expect(after.badFrames).toBe(3);
    expect(after.badFrameTypes).toContain("chat-status");
    expect(after.badFrameTypes).toContain("not-a-real-event");
    client.close();
  });

  it("clears the bad-frame tally on a fresh handshake", () => {
    // A new pairing may well agree where the old one didn't; carrying the count
    // across would keep reporting a mismatch a restart has already fixed.
    const { client, socket } = connected();
    socket.fireMessage({ type: "not-a-real-event" });
    expect(useConnection.getState().badFrames).toBe(1);

    socket.fireMessage({ type: "hello", serverTime: 2 });
    expect(useConnection.getState().badFrames).toBe(0);
    client.close();
  });
});

describe("WsClient — heartbeat", () => {
  it("sends a ping and treats the matching pong as proof of life", () => {
    const { client, socket } = connected();
    client.retryNow(); // an open socket is probed rather than torn down

    const ping = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === "ping");
    expect(ping).toBeDefined();
    expect(useConnection.getState().state).toBe("open");

    socket.fireMessage({ type: "pong", nonce: ping.nonce });
    // A pong is consumed by the client and must not reach the reducer or the
    // store — it is about this socket's liveness, nothing else.
    expect(useConnection.getState().state).toBe("open");
    expect(useConnection.getState().badFrames).toBe(0);
    client.close();
  });
});
