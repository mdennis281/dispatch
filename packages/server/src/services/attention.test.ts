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

describe("AttentionQueue — clear", () => {
  it("dismisses the retrospective kinds and leaves the blocking ones", () => {
    for (const kind of ["permission", "question", "idle", "done", "review"] as const) {
      queue.add(item(kind));
    }
    // The two blocking kinds are a live agent waiting on an answer — and what
    // puts the chat under "Needs input" — so a plain clear must not take them.
    expect(queue.clear().map((r) => r.id).sort()).toEqual(["done-0", "idle-0", "review-0"]);
    expect(queue.list().map((i) => i.kind)).toEqual(["permission", "question"]);
  });

  it("carries each item's chatId out, so the caller can broadcast the resolve", () => {
    queue.add(item("done", { id: "d1", chatId: "c2" }));
    expect(queue.clear()).toEqual([{ id: "d1", chatId: "c2" }]);
  });

  it("takes a blocking kind only when asked for it by name", () => {
    queue.add(item("permission", { id: "p1" }));
    queue.add(item("idle", { id: "i1" }));
    expect(queue.clear({ kinds: ["permission"] }).map((r) => r.id)).toEqual(["p1"]);
    expect(queue.list().map((i) => i.id)).toEqual(["i1"]);
  });

  it("scopes to one chat when given one", () => {
    queue.add(item("done", { id: "mine", chatId: "c1" }));
    queue.add(item("done", { id: "theirs", chatId: "c2" }));
    expect(queue.clear({ chatId: "c1" }).map((r) => r.id)).toEqual(["mine"]);
    expect(queue.list().map((i) => i.id)).toEqual(["theirs"]);
  });
});
