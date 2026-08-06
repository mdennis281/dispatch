import { describe, it, expect } from "vitest";
import { EventBus } from "./bus.js";
import type { WsServerEvent } from "@dispatch/shared";

describe("EventBus", () => {
  it("delivers published events to all-subscribers and unsubscribes", () => {
    const bus = new EventBus();
    const got: WsServerEvent[] = [];
    const off = bus.subscribe((e) => got.push(e));
    const evt: WsServerEvent = { type: "hello", serverTime: 123 };
    bus.publish(evt);
    expect(got).toEqual([evt]);
    off();
    bus.publish(evt);
    expect(got).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it("routes typed subscriptions by event type", () => {
    const bus = new EventBus();
    const statuses: Extract<WsServerEvent, { type: "chat-status" }>[] = [];
    bus.on("chat-status", (e) => statuses.push(e));
    bus.publish({ type: "hello", serverTime: 1 });
    bus.publish({ type: "chat-status", chatId: "c1", status: "running" });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.chatId).toBe("c1");
  });
});
