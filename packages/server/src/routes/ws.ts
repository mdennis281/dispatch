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
import { WsClientActionSchema, type WsServerEvent } from "@cm/shared";
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
  app.get("/ws", { websocket: true }, (rawSocket, _req) => {
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

    socket.on("close", () => unsub());
    socket.on("error", () => unsub());
  });
}
