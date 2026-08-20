/**
 * WS route — the single multiplexed event stream + inbound action sink.
 *
 * On connect we send a `hello`, then subscribe the socket to the bus and forward
 * EVERY `WsServerEvent` (tagged by chatId) as JSON — one socket sees all chats so
 * the client keeps live status for unfocused chats. Inbound frames are parsed +
 * validated with `WsClientActionSchema` and handed to `dispatchClientAction`,
 * which routes them to the services. Malformed frames get an `error` reply; the
 * bus subscription is torn down on close.
 */
import type { FastifyInstance } from "fastify";
import { WsClientActionSchema, type WsServerEvent } from "@dispatch/shared";
import { readInstalledRelease } from "../services/release.js";
import { dispatchClientAction } from "./dispatch.js";

/** ws readyState OPEN (avoids importing the `ws` package for a constant). */
const WS_OPEN = 1;

/**
 * The build stamp this payload was published as, resolved once.
 *
 * Three states, not two — the same reason `health.ts`'s `payloadSha` keeps them
 * apart: `undefined` is "not looked up yet", `null` is "looked up, and there is
 * no answer". A source checkout has no `release-manifest.json` and never will,
 * and collapsing the two would re-stat the payload directory on every socket.
 *
 * Absent is the honest answer for a checkout, and the client is written to skip
 * the staleness comparison rather than guess when it gets nothing.
 */
let cachedVersion: string | null | undefined;
function payloadVersion(): string | undefined {
  if (cachedVersion === undefined) {
    try {
      cachedVersion = readInstalledRelease()?.version ?? null;
    } catch {
      cachedVersion = null;
    }
  }
  return cachedVersion ?? undefined;
}

/** Minimal structural view of the socket we depend on (ws WebSocket satisfies it). */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Optional in the structural type so a test double needn't implement it. */
  ping?(): void;
}

/**
 * How often to poll whether this socket's identity is still good.
 *
 * Was 1s, which meant every connected client re-read the shared auth/settings
 * files once a second — for a check whose answer only changes when a human
 * edits a user or signs out.
 */
const IDENTITY_POLL_MS = 5_000;

/**
 * Consecutive FAILED identity checks (the check threw) tolerated before the
 * socket is closed. A thrown check is not a "no": the read goes at files in the
 * SHARED config dir, so the other instance's atomic rename is enough to make one
 * land on EPERM/EBUSY. Closing on the first throw turned that race into a
 * dropped socket — and a dropped socket is a visible reload of whatever chat the
 * user was reading. Only a definitive `false` closes immediately.
 */
const IDENTITY_FAILURES_BEFORE_CLOSE = 3;

/**
 * Idle-connection keepalive: traffic on a socket that would otherwise go quiet
 * for minutes at a time, so an idle-timing proxy or NAT table doesn't reap it.
 *
 * This is NOT dead-connection detection — nothing tracks the pongs, and a socket
 * that stops answering keeps its timer until the transport notices. That's the
 * intended scope: the client already reconnects on close, and the point of this
 * change is that a reconnect no longer costs the reader their place.
 */
const PING_MS = 30_000;

export function registerWsRoutes(app: FastifyInstance): void {
  app.get("/ws", { websocket: true }, (rawSocket, req) => {
    const socket = rawSocket as unknown as SocketLike;
    const { bus } = app.services;

    const send = (evt: WsServerEvent): void => {
      if (socket.readyState !== WS_OPEN) return;
      try {
        socket.send(JSON.stringify(evt));
      } catch {
        /* a broken pipe is handled by the close listener */
      }
    };

    const version = payloadVersion();
    send({ type: "hello", serverTime: Date.now(), ...(version ? { version } : {}) });

    // Fan every bus event out to this socket (multiplexed, client routes by chatId).
    const unsub = bus.subscribe((evt) => send(evt));
    const unsubRevocation = req.authIdentity
      ? app.auth.onSessionRevoked((id) => {
          if (id === req.authIdentity?.sessionId) socket.close(4401, "session revoked");
        })
      : () => {};
    // Identity credentials live in shared config while session families are
    // per instance. Polling the small stamped auth snapshot ensures a delete or
    // credential reset in stable closes the same user's dev socket promptly.
    let identityFailures = 0;
    const identityTimer = setInterval(() => {
      const check = req.authIdentity
        ? app.auth.identityStillValid(req.authIdentity)
        : app.auth.enabled().then((enabled) => !enabled);
      void check.then((valid) => {
        identityFailures = 0;
        if (!valid) socket.close(4401, "authentication changed");
      }).catch(() => {
        // Fail OPEN for a bounded number of tries: a transient read error says
        // nothing about whether the identity is still good, and tearing the
        // socket down costs the user their place in the chat they're reading.
        if (++identityFailures >= IDENTITY_FAILURES_BEFORE_CLOSE) {
          socket.close(1011, "identity check failed");
        }
      });
    }, IDENTITY_POLL_MS);
    const pingTimer = setInterval(() => {
      if (socket.readyState !== WS_OPEN) return;
      try {
        socket.ping?.();
      } catch {
        /* the close listener owns teardown */
      }
    }, PING_MS);
    const cleanup = () => {
      unsub(); unsubRevocation();
      clearInterval(identityTimer);
      clearInterval(pingTimer);
    };

    socket.on("message", (raw: unknown) => {
      let json: unknown;
      try {
        json = JSON.parse(String(raw));
      } catch {
        send({ type: "error", message: "invalid JSON frame" });
        return;
      }
      const parsed = WsClientActionSchema.safeParse(json);
      if (!parsed.success) {
        send({
          type: "error",
          message: "invalid client action",
          detail: parsed.error.message,
        });
        return;
      }
      // Answered HERE rather than in `dispatchClientAction`, which routes to the
      // services and has no handle on the socket that asked. A pong is about
      // this one connection, not about any chat.
      if (parsed.data.type === "ping") {
        send({ type: "pong", nonce: parsed.data.nonce });
        return;
      }
      void dispatchClientAction(app.services, parsed.data);
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
