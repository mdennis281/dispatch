import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { TtsEngine, WsServerEvent } from "@dispatch/shared";
import { publishServerEvent, resetServerEventTap } from "./eventTap.js";
import { createTtsFeeder } from "./ttsFeeder.js";

interface Calls {
  feed: string[];
  flush: number;
  cancel: number;
}

function fakeEngine(): { engine: TtsEngine; calls: Calls } {
  const calls: Calls = { feed: [], flush: 0, cancel: 0 };
  return {
    calls,
    engine: {
      feed: (t) => calls.feed.push(t),
      flush: () => calls.flush++,
      cancel: () => calls.cancel++,
    },
  };
}

function chunk(chatId: string, messageId: string, delta: string, channel: "text" | "thinking" = "text"): WsServerEvent {
  return { type: "message-chunk", chatId, messageId, delta, channel };
}

function assistant(chatId: string, id: string, text: string): WsServerEvent {
  return { type: "chat-message", chatId, message: { id, chatId, ts: 1, kind: "assistant", text } } as WsServerEvent;
}

/** A harness with hand-driven state: which chat is active, whether speaking is on, and the engine. */
function harness() {
  let active: string | null = "A";
  let enabled = true;
  const made: Calls[] = [];
  const listeners = { engine: new Set<() => void>(), chat: new Set<() => void>(), enabled: new Set<() => void>() };
  const stop = createTtsFeeder({
    activeChatId: () => active,
    engine: () => {
      const f = fakeEngine();
      made.push(f.calls);
      return f.engine;
    },
    onEngineChange: (fn) => (listeners.engine.add(fn), () => listeners.engine.delete(fn)),
    onActiveChatChange: (fn) => (listeners.chat.add(fn), () => listeners.chat.delete(fn)),
    enabled: () => enabled,
    onEnabledChange: (fn) => (listeners.enabled.add(fn), () => listeners.enabled.delete(fn)),
  });
  return {
    made,
    stop,
    switchChat(id: string | null) {
      active = id;
      listeners.chat.forEach((fn) => fn());
    },
    setEnabled(on: boolean) {
      enabled = on;
      listeners.enabled.forEach((fn) => fn());
    },
    changeEngine() {
      listeners.engine.forEach((fn) => fn());
    },
  };
}

describe("createTtsFeeder", () => {
  beforeEach(resetServerEventTap);
  afterEach(resetServerEventTap);

  it("speaks the active chat's streamed reply a sentence at a time and flushes on the assistant row", () => {
    const h = harness();
    publishServerEvent(chunk("A", "m1", "Hello the"));
    publishServerEvent(chunk("A", "m1", "re. Second one"));
    expect(h.made[0]?.feed).toEqual(["Hello there."]);
    publishServerEvent(assistant("A", "m1", "Hello there. Second one"));
    expect(h.made[0]?.feed).toEqual(["Hello there.", "Second one"]);
    expect(h.made[0]?.flush).toBe(1);
    h.stop();
  });

  it("ignores thinking, other chats, and everything while speaking is off", () => {
    const h = harness();
    publishServerEvent(chunk("A", "m1", "Thinking hard. ", "thinking"));
    publishServerEvent(chunk("B", "m2", "Other chat. "));
    expect(h.made.length).toBe(0);
    h.setEnabled(false);
    publishServerEvent(chunk("A", "m3", "Quiet now. "));
    expect(h.made.length).toBe(0);
    h.stop();
  });

  it("speaks a row that never streamed, in one go, through the same rule", () => {
    const h = harness();
    publishServerEvent(assistant("A", "m9", "Whole reply. Spoken.\n\n---\nNot this."));
    expect(h.made[0]?.feed).toEqual(["Whole reply.", "Spoken."]);
    expect(h.made[0]?.flush).toBe(1);
    h.stop();
  });

  it("cancels on a chat switch and when speaking is turned off, and rebuilds the engine when the pick changes", () => {
    const h = harness();
    publishServerEvent(chunk("A", "m1", "Start. mid"));
    h.switchChat("B");
    expect(h.made[0]?.cancel).toBe(1);
    // The dropped tail is gone: finishing the old row later says nothing.
    publishServerEvent(assistant("A", "m1", "Start. middle"));
    expect(h.made[0]?.feed).toEqual(["Start."]);
    h.switchChat("A");
    h.changeEngine();
    publishServerEvent(chunk("A", "m2", "Fresh. "));
    expect(h.made.length).toBe(2);
    expect(h.made[1]?.feed).toEqual(["Fresh."]);
    h.setEnabled(false);
    expect(h.made[1]?.cancel).toBe(1);
    h.stop();
  });

  it("finishes a row whose turn ended without its message landing", () => {
    const h = harness();
    publishServerEvent(chunk("A", "m1", "Interrupted mid"));
    publishServerEvent({ type: "chat-status", chatId: "A", status: "idle" });
    expect(h.made[0]?.feed).toEqual(["Interrupted mid"]);
    expect(h.made[0]?.flush).toBe(1);
    h.stop();
  });
});
