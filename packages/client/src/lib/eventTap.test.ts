import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WsServerEvent } from "@dispatch/shared";
import { onServerEvent, publishServerEvent, resetServerEventTap, subscribeServerEvents } from "./eventTap.js";

const notice: WsServerEvent = { type: "notice", level: "info", text: "hi" };
const pluginEvt: WsServerEvent = { type: "plugin-event", plugin: "voice", payload: { x: 1 } };

describe("event tap", () => {
  beforeEach(resetServerEventTap);

  it("delivers by type and to catch-all subscribers, and unsubscribes", () => {
    const typed: WsServerEvent[] = [];
    const all: WsServerEvent[] = [];
    const off = onServerEvent("plugin-event", (e) => typed.push(e));
    const offAll = subscribeServerEvents((e) => all.push(e));
    publishServerEvent(notice);
    publishServerEvent(pluginEvt);
    expect(typed).toEqual([pluginEvt]);
    expect(all).toEqual([notice, pluginEvt]);
    off();
    offAll();
    publishServerEvent(pluginEvt);
    expect(typed.length).toBe(1);
    expect(all.length).toBe(2);
  });

  it("a listener that throws is reported and does not stop the next one", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onServerEvent("notice", () => {
      throw new Error("boom");
    });
    onServerEvent("notice", (e) => seen.push(e.text));
    expect(() => publishServerEvent(notice)).not.toThrow();
    expect(seen).toEqual(["hi"]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
