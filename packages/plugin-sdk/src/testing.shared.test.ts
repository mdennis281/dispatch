/**
 * `ctx.shared` in the fake: one `createTestSharedStore()` behind two contexts
 * is stable and dev sharing a config root.
 */
import { describe, it, expect } from "vitest";
import { createTestContext, createTestSharedStore } from "./testing.js";

describe("createTestContext shared state", () => {
  it("two instances share values and locks; leases run out on the store's clock", async () => {
    let t = 1_000;
    const store = createTestSharedStore({ now: () => t });
    const stable = createTestContext({ id: "remote-host", instance: { id: "stable", role: "stable" }, sharedStore: store });
    const dev = createTestContext({ id: "remote-host", instance: { id: "dev", role: "dev" }, sharedStore: store });
    const other = createTestContext({ id: "another", sharedStore: store });

    expect(await stable.ctx.shared!.set("k", { a: 1 })).toBe(1);
    expect(await dev.ctx.shared!.entry("k")).toMatchObject({ value: { a: 1 }, version: 1, updatedBy: "stable" });
    expect(await other.ctx.shared!.get("k")).toBeUndefined();
    expect(await dev.ctx.shared!.compareAndSet("k", 1, { a: 2 })).toEqual({ ok: true, version: 2 });
    expect((await stable.ctx.shared!.compareAndSet("k", 1, { a: 3 })).ok).toBe(false);
    expect(await stable.ctx.shared!.list()).toEqual(["k"]);

    // No ABA: delete and recreate never hands back a version still held.
    const read = await stable.ctx.shared!.entry("k");
    await dev.ctx.shared!.delete("k");
    await dev.ctx.shared!.set("k", { a: 9 });
    expect((await stable.ctx.shared!.compareAndSet("k", read!.version, { a: 0 })).ok).toBe(false);

    const held = await stable.ctx.shared!.lock("l", { ttlMs: 5_000 });
    expect(await dev.ctx.shared!.lock("l")).toBeUndefined();
    expect(await dev.ctx.shared!.holder("l")).toMatchObject({ instanceId: "stable", mine: false });
    t += 6_000;
    expect(await dev.ctx.shared!.lock("l")).toBeDefined();
    expect(await held!.renew()).toBe(false);
    expect(held!.lost).toBe(true);
  });

  it("is absent without the capability", () => {
    expect(createTestContext({ capabilities: ["kv"] }).ctx.shared).toBeUndefined();
  });
});
