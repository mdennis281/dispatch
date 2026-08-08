import { describe, it, expect, beforeEach } from "vitest";
import type { AttentionItem } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { AttentionQueue } from "./attention.js";

let bus: EventBus;
let queue: AttentionQueue;

const item = (
  kind: AttentionItem["kind"],
  over: Partial<AttentionItem> = {},
): AttentionItem => ({
  id: `${kind}-${over.createdAt ?? 0}`,
  chatId: "c1",
  kind,
  summary: kind,
  createdAt: 0,
  ...over,
});

beforeEach(() => {
  bus = new EventBus();
  queue = new AttentionQueue({ bus });
  queue.start();
});

describe("AttentionQueue — triage order", () => {
  it("ranks a review round below the blocking kinds and above the FYI ones", () => {
    // A review round is real, unfinished work — but nothing is blocked on it
    // this second, so it must not push a waiting permission prompt down.
    for (const kind of ["done", "review", "idle", "question", "permission"] as const) {
      queue.add(item(kind));
    }
    expect(queue.list().map((i) => i.kind)).toEqual([
      "permission",
      "question",
      "review",
      "idle",
      "done",
    ]);
  });

  it("keeps review items oldest-first among themselves", () => {
    queue.add(item("review", { id: "r2", createdAt: 200 }));
    queue.add(item("review", { id: "r1", createdAt: 100 }));
    expect(queue.list().map((i) => i.id)).toEqual(["r1", "r2"]);
  });

  it("aggregates a `review` item published on the bus", () => {
    bus.publish({
      type: "attention-add",
      item: item("review", { id: "rev-1", prNumber: 42, url: "https://x/42" }),
    });
    const [got] = queue.listForChat("c1");
    expect(got).toMatchObject({ kind: "review", prNumber: 42, url: "https://x/42" });
  });

  it("drops review items with the rest when a chat is deleted", () => {
    queue.add(item("review", { id: "rev-1" }));
    queue.add(item("idle", { id: "idle-1" }));
    expect(queue.clearChat("c1").sort()).toEqual(["idle-1", "rev-1"]);
    expect(queue.size()).toBe(0);
  });
});
