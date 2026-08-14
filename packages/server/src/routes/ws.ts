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
import { dispatchClientAction } from "./dispatch.js";

/** ws readyState OPEN (avoids importing the `ws` package for a constant). */
const WS_OPEN = 1;

/** Minimal structural view of the socket we depend on (ws WebSocket satisfies it). */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

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

    send({ type: "hello", serverTime: Date.now() });

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
    const identityTimer = setInterval(() => {
      const check = req.authIdentity
        ? app.auth.identityStillValid(req.authIdentity)
        : app.auth.enabled().then((enabled) => !enabled);
      void check.then((valid) => {
        if (!valid) socket.close(4401, "authentication changed");
      }).catch(() => socket.close(1011, "identity check failed"));
    }, 1_000);
    const cleanup = () => {
      unsub(); unsubRevocation();
      clearInterval(identityTimer);
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
      void dispatchClientAction(app.services, parsed.data);
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
