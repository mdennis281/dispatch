import { describe, expect, it } from "vitest";
import { HarnessEventQueue } from "./harness-queue.js";

describe("HarnessEventQueue", () => {
  it("hands items out in order, then parks", async () => {
    const q = new HarnessEventQueue<number>();
    q.push(1, 2);
    expect(await q.next()).toEqual({ value: 1, done: false });
    expect(await q.next()).toEqual({ value: 2, done: false });
    let settled = false;
    const pending = q.next().then((r) => ((settled = true), r));
    await Promise.resolve();
    expect(settled).toBe(false);
    q.push(3);
    expect(await pending).toEqual({ value: 3, done: false });
  });

  it("wakes a parked consumer on end, and drains what is left before done", async () => {
    const q = new HarnessEventQueue<string>();
    const parked = q.next();
    q.end();
    expect(await parked).toEqual({ value: undefined, done: true });

    const r = new HarnessEventQueue<string>();
    r.push("last");
    r.end();
    expect(await r.next()).toEqual({ value: "last", done: false });
    expect(await r.next()).toEqual({ value: undefined, done: true });
  });

  it("drops pushes after end — late events have nowhere to go", async () => {
    const q = new HarnessEventQueue<number>();
    q.end();
    q.push(1);
    expect(q.shift()).toBeUndefined();
    expect(q.ended).toBe(true);
  });

  it("wake() releases wait() without queueing anything", async () => {
    const q = new HarnessEventQueue<number>();
    const waited = q.wait();
    q.wake();
    await waited;
    expect(q.shift()).toBeUndefined();
  });

  it("iterates with for-await until ended", async () => {
    const q = new HarnessEventQueue<number>();
    const seen: number[] = [];
    const done = (async () => {
      for await (const n of q.iterable()) seen.push(n);
    })();
    q.push(1);
    await Promise.resolve();
    q.push(2, 3);
    q.end();
    await done;
    expect(seen).toEqual([1, 2, 3]);
  });

  it("some() looks at what is still queued", () => {
    const q = new HarnessEventQueue<{ type: string }>();
    q.push({ type: "text" }, { type: "turn-end" });
    expect(q.some((e) => e.type === "turn-end")).toBe(true);
    q.shift();
    q.shift();
    expect(q.some((e) => e.type === "turn-end")).toBe(false);
  });
});
