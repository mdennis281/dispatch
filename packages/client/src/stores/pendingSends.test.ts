import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, WsClientAction } from "@dispatch/shared";

// The ws client is the one boundary: it says which socket generation a frame
// went out on (a number) or that it waited in the outbox (undefined).
const sent: WsClientAction[] = [];
let epoch: number | undefined = 1;
vi.mock("../lib/ws.js", () => ({
  ws: {
    send: (a: WsClientAction) => {
      sent.push(a);
      return epoch;
    },
  },
}));

const { actions } = await import("../lib/actions.js");
const { applyServerEvent, useMessages } = await import("./index.js");
const { usePendingSends } = await import("./pendingSends.js");

const CHAT = "chat-1";
const ghosts = () => usePendingSends.getState().byChat[CHAT] ?? [];
const sentIds = () =>
  sent.flatMap((a) => (a.type === "send-message" && a.clientId ? [a.clientId] : []));

function userRow(id: string, text: string, clientId?: string): ChatMessage {
  return { kind: "user", id, chatId: CHAT, ts: Date.now(), text, ...(clientId ? { clientId } : {}) } as ChatMessage;
}

beforeEach(() => {
  sent.length = 0;
  epoch = 1;
  usePendingSends.setState({ byChat: {}, restore: null });
  useMessages.setState({ byChat: { [CHAT]: [] } });
});

describe("pending sends", () => {
  it("shows a ghost from Send until its row arrives, then only the row", () => {
    const id = actions.sendMessage(CHAT, { text: "hello", ghost: true });
    expect(sentIds()).toEqual([id]);
    expect(ghosts()).toMatchObject([{ clientId: id, text: "hello", state: "sending", epoch: 1 }]);

    applyServerEvent({ type: "chat-message", chatId: CHAT, message: userRow("m1", "hello", id) });

    expect(ghosts()).toEqual([]);
    expect(useMessages.getState().byChat[CHAT]?.map((m) => m.id)).toEqual(["m1"]);
  });

  it("keeps several ghosts in send order and settles each independently", () => {
    const a = actions.sendMessage(CHAT, { text: "one", ghost: true });
    const b = actions.sendMessage(CHAT, { text: "two", ghost: true });
    const c = actions.sendMessage(CHAT, { text: "two", ghost: true }); // same text, distinct message
    expect(ghosts().map((g) => g.clientId)).toEqual([a, b, c]);

    // The middle one is acknowledged first; the others stay pending, in order.
    applyServerEvent({ type: "chat-message", chatId: CHAT, message: userRow("m2", "two", b) });
    expect(ghosts().map((g) => g.clientId)).toEqual([a, c]);

    applyServerEvent({ type: "chat-message", chatId: CHAT, message: userRow("m1", "one", a) });
    expect(ghosts().map((g) => g.clientId)).toEqual([c]);
  });

  it("does not settle a ghost off an unrelated row with the same text", () => {
    actions.sendMessage(CHAT, { text: "yes", ghost: true });
    applyServerEvent({ type: "chat-message", chatId: CHAT, message: userRow("p1", "yes") });
    expect(ghosts()).toHaveLength(1);
  });

  it("clears on a clean send-ack (a send parked behind a live turn writes no row)", () => {
    const id = actions.sendMessage(CHAT, { text: "later", ghost: true, sendMode: "queue" });
    applyServerEvent({ type: "send-ack", chatId: CHAT, clientId: id });
    expect(ghosts()).toEqual([]);
  });

  it("fails on an error ack, and Retry resends under the same id", () => {
    const id = actions.sendMessage(CHAT, { text: "hi", ghost: true });
    applyServerEvent({ type: "send-ack", chatId: CHAT, clientId: id, error: "provider unavailable" });
    expect(ghosts()).toMatchObject([{ state: "failed", error: "provider unavailable" }]);

    epoch = 2;
    actions.retrySend(CHAT, id);
    expect(sentIds()).toEqual([id, id]);
    expect(ghosts()).toMatchObject([{ clientId: id, state: "sending", epoch: 2 }]);
  });

  it("fails what went out on a socket that died, but not what is still in the outbox", () => {
    const out = actions.sendMessage(CHAT, { text: "went out", ghost: true });
    epoch = undefined; // socket down: the next one queues
    const queued = actions.sendMessage(CHAT, { text: "queued", ghost: true });

    usePendingSends.getState().lost(1);
    expect(ghosts().find((g) => g.clientId === out)?.state).toBe("failed");
    const waiting = ghosts().find((g) => g.clientId === queued);
    expect(waiting?.state).toBe("sending");
    expect(waiting?.epoch).toBeUndefined();

    // The outbox flushes on the next socket; a later drop of THAT one is what
    // would put the queued send in doubt.
    usePendingSends.getState().flushed(2);
    expect(ghosts().find((g) => g.clientId === queued)?.epoch).toBe(2);
  });

  it("clears a failed ghost when a transcript resync shows it did arrive", () => {
    const id = actions.sendMessage(CHAT, { text: "hi", ghost: true });
    usePendingSends.getState().lost(1);
    usePendingSends.getState().reconcile(CHAT, [userRow("m1", "hi", id)]);
    expect(ghosts()).toEqual([]);
  });

  it("Edit removes the ghost and hands its content to the composer", () => {
    const id = actions.sendMessage(CHAT, { text: "draft me", ghost: true });
    applyServerEvent({ type: "send-ack", chatId: CHAT, clientId: id, error: "nope" });
    usePendingSends.getState().restoreToComposer(CHAT, id);
    expect(ghosts()).toEqual([]);
    expect(usePendingSends.getState().restore).toMatchObject({ chatId: CHAT, text: "draft me" });
  });

  it("draws no ghost for a send that did not ask for one", () => {
    actions.sendMessage(CHAT, { text: "programmatic" });
    expect(ghosts()).toEqual([]);
  });
});
