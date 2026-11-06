/**
 * `ctx.shared` against a REAL database file, opened through two separate
 * connections — what stable and dev are to each other: two processes with
 * one config root. The point of the feature is that they agree, so a fake
 * would prove nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginInstance } from "@dispatch/shared";
import { PluginSharedStore, buildPluginShared, pluginSharedDbPath } from "./shared-state.js";

const dirs: string[] = [];
const stores: PluginSharedStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

/** A shared clock both "instances" read, so a test can let a lease run out. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function twoInstances(now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-shared-"));
  dirs.push(dir);
  const file = pluginSharedDbPath(dir);
  const a = new PluginSharedStore(file, now);
  const b = new PluginSharedStore(file, now);
  stores.push(a, b);
  return { file, a, b };
}

const STABLE: PluginInstance = { id: "inst-stable", role: "stable", dataDirFingerprint: "s" };
const DEV: PluginInstance = { id: "inst-dev", role: "dev", dataDirFingerprint: "d" };

describe("PluginSharedStore — two instances, one config root", () => {
  it("one instance's write is the other's read, versioned and attributed", async () => {
    const { a, b } = await twoInstances();
    expect(a.set("remote-host", "agent/cvx-mac", JSON.stringify({ v: "1.2.0" }), { instanceId: "inst-stable" })).toBe(1);
    expect(b.get("remote-host", "agent/cvx-mac")).toMatchObject({ value: { v: "1.2.0" }, version: 1, updatedBy: "inst-stable" });
    expect(b.set("remote-host", "agent/cvx-mac", JSON.stringify({ v: "1.3.0" }), { instanceId: "inst-dev" })).toBe(2);
    expect(a.get("remote-host", "agent/cvx-mac")).toMatchObject({ value: { v: "1.3.0" }, version: 2, updatedBy: "inst-dev" });
    expect(a.list("remote-host", "agent/")).toEqual(["agent/cvx-mac"]);
  });

  it("compareAndSet: of two writers that read the same version, exactly one wins", async () => {
    const { a, b } = await twoInstances();
    a.set("p", "k", "1", {});
    const seen = b.get("p", "k")!.version;
    expect(a.compareAndSet("p", "k", seen, "2", {})).toEqual({ ok: true, version: 2 });
    const lost = b.compareAndSet("p", "k", seen, "3", {});
    expect(lost.ok).toBe(false);
    expect(!lost.ok && lost.current).toMatchObject({ value: 2, version: 2 });
    // `null` means "only if absent": the second creator loses.
    expect(a.compareAndSet("p", "new", null, "1", {}).ok).toBe(true);
    expect(b.compareAndSet("p", "new", null, "1", {}).ok).toBe(false);
    // A conditional delete, against the version actually read.
    expect(b.compareAndSet("p", "new", a.get("p", "new")!.version, undefined, {})).toEqual({ ok: true, version: 0 });
    expect(a.get("p", "new")).toBeUndefined();
  });

  it("a key deleted and created again never gets back a version a reader is holding (no ABA)", async () => {
    const { a, b } = await twoInstances();
    a.set("p", "k", JSON.stringify("X"), {});
    const read = a.get("p", "k")!;
    // The other instance deletes it and writes something new in its place.
    expect(b.delete("p", "k")).toBe(true);
    b.set("p", "k", JSON.stringify("Y"), {});
    expect(b.get("p", "k")!.version).not.toBe(read.version);
    // A's update computed from X must not land on top of Y.
    const stale = a.compareAndSet("p", "k", read.version, JSON.stringify("f(X)"), {});
    expect(stale.ok).toBe(false);
    expect(a.get("p", "k")!.value).toBe("Y");
    // The same through a conditional delete and recreate.
    const v = a.get("p", "k")!.version;
    expect(b.compareAndSet("p", "k", v, undefined, {}).ok).toBe(true);
    expect(b.compareAndSet("p", "k", null, JSON.stringify("Z"), {}).ok).toBe(true);
    expect(a.compareAndSet("p", "k", v, JSON.stringify("late"), {}).ok).toBe(false);
  });

  it("a lock held by one instance is refused to the other until released", async () => {
    const { a, b } = await twoInstances();
    const got = a.tryLock("remote-host", "upgrade:cvx-mac", 30_000, { instanceId: "inst-stable", role: "stable" });
    expect(got.ok).toBe(true);
    const refused = b.tryLock("remote-host", "upgrade:cvx-mac", 30_000, { instanceId: "inst-dev" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.holder).toMatchObject({ instanceId: "inst-stable", role: "stable" });
    expect(got.ok && a.release("remote-host", "upgrade:cvx-mac", got.lock.token)).toBe(true);
    expect(b.tryLock("remote-host", "upgrade:cvx-mac", 30_000, { instanceId: "inst-dev" }).ok).toBe(true);
  });

  it("a lease that runs out is free for the other instance, and its old holder can no longer renew or release it", async () => {
    const c = clock();
    const { a, b } = await twoInstances(c.now);
    const got = a.tryLock("p", "l", 5_000, { instanceId: "inst-stable" });
    if (!got.ok) throw new Error("expected the lock");
    c.advance(4_000);
    expect(a.renew("p", "l", got.lock.token, 5_000)).toBe(c.now() + 5_000);
    c.advance(6_000); // past the renewed expiry: the stable instance died
    expect(a.holder("p", "l")).toBeUndefined();
    const taken = b.tryLock("p", "l", 5_000, { instanceId: "inst-dev" });
    expect(taken.ok).toBe(true);
    expect(a.renew("p", "l", got.lock.token, 5_000)).toBeNull();
    expect(a.release("p", "l", got.lock.token)).toBe(false);
    expect(b.holder("p", "l")).toMatchObject({ instanceId: "inst-dev" });
  });

  it("an expired lease is not renewed even when nobody took it", async () => {
    const c = clock();
    const { a } = await twoInstances(c.now);
    const got = a.tryLock("p", "l", 1_000, {});
    if (!got.ok) throw new Error("expected the lock");
    c.advance(1_001);
    expect(a.renew("p", "l", got.lock.token, 1_000)).toBeNull();
  });

  it("keeps plugins apart, and purges one without touching another", async () => {
    const { a, b } = await twoInstances();
    a.set("one", "k", "1", {});
    a.set("two", "k", "2", {});
    a.tryLock("one", "l", 30_000, {});
    expect(b.get("two", "k")?.value).toBe(2);
    expect(b.tryLock("two", "l", 30_000, {}).ok).toBe(true);
    expect(b.count("one")).toBe(1);
    expect(b.purge("one")).toBe(1);
    expect(a.get("one", "k")).toBeUndefined();
    expect(a.holder("one", "l")).toBeUndefined();
    expect(a.get("two", "k")?.value).toBe(2);
    expect(a.holder("two", "l")).toBeDefined();
  });

  it("works against a file a NEWER build has added to — the schema is additive only", async () => {
    const { file, a } = await twoInstances();
    a.set("p", "k", "1", {});
    a.close();
    // What a future build might do: a new column and a new table.
    const newer = new DatabaseSync(file);
    newer.exec("ALTER TABLE plugin_shared_kv ADD COLUMN expires_at INTEGER");
    newer.exec("CREATE TABLE plugin_shared_queue (plugin TEXT, item TEXT)");
    newer.close();
    const older = new PluginSharedStore(file);
    stores.push(older);
    expect(older.get("p", "k")?.value).toBe(1);
    expect(older.set("p", "k", "2", {})).toBe(2);
    expect(older.tryLock("p", "l", 30_000, {}).ok).toBe(true);
  });
});

describe("ctx.shared — the plugin's view", () => {
  async function pair(now?: () => number) {
    const { a, b } = await twoInstances(now);
    const stable = buildPluginShared(a, "remote-host", STABLE, { pollMs: 10 });
    const dev = buildPluginShared(b, "remote-host", DEV, { pollMs: 10 });
    return { stable, dev };
  }

  it("refuses bad keys, names, values and leases", async () => {
    const { stable } = await pair();
    const s = stable.api;
    await expect(s.set("", 1)).rejects.toThrow(/key/);
    await expect(s.get("k".repeat(257))).rejects.toThrow(/key/);
    await expect(s.set("k", "x".repeat(1024 * 1024 + 1))).rejects.toThrow(/over/);
    await expect(s.set("k", () => 1)).rejects.toThrow(/JSON/);
    await expect(s.lock("", {})).rejects.toThrow(/lock name/);
    await expect(s.lock("l", { ttlMs: 10 })).rejects.toThrow(/ttlMs/);
    await expect(s.lock("l", { waitMs: 700_000 })).rejects.toThrow(/waitMs/);
    await expect(s.compareAndSet("k", 0, 1)).rejects.toThrow(/expectedVersion/);
    expect(await s.set("k", undefined)).toBe(0);
  });

  it("entry + compareAndSet is the read-modify-write both instances can trust", async () => {
    const { stable, dev } = await pair();
    expect(await stable.api.compareAndSet("agents", null, { "cvx-mac": "1.0.0" })).toEqual({ ok: true, version: 1 });
    const e = await dev.api.entry<Record<string, string>>("agents");
    expect(e).toMatchObject({ version: 1, updatedBy: "inst-stable" });
    expect(await stable.api.set("agents", { "cvx-mac": "1.1.0" })).toBe(2);
    const late = await dev.api.compareAndSet("agents", e!.version, { ...e!.value, other: "1.0.0" });
    expect(late).toMatchObject({ ok: false, current: { version: 2, value: { "cvx-mac": "1.1.0" } } });
  });

  it("lock waits for the other instance to let go; holder says who has it", async () => {
    const { stable, dev } = await pair();
    const held = await stable.api.lock("upgrade:cvx-mac");
    expect(held).toBeDefined();
    expect(await dev.api.holder("upgrade:cvx-mac")).toMatchObject({ instanceId: "inst-stable", role: "stable", mine: false });
    expect(await stable.api.holder("upgrade:cvx-mac")).toMatchObject({ mine: true });
    // Not re-entrant, and no wait: refused at once.
    expect(await dev.api.lock("upgrade:cvx-mac")).toBeUndefined();

    const waiting = dev.api.lock("upgrade:cvx-mac", { waitMs: 2_000 });
    setTimeout(() => void held!.release(), 50);
    const got = await waiting;
    expect(got).toBeDefined();
    expect(await stable.api.holder("upgrade:cvx-mac")).toMatchObject({ instanceId: "inst-dev" });
    await got!.release();
    await got!.release(); // twice is fine
  });

  it("a signal stops the wait", async () => {
    const { stable, dev } = await pair();
    await stable.api.lock("l");
    const ac = new AbortController();
    const waiting = dev.api.lock("l", { waitMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    expect(await waiting).toBeUndefined();
  });

  it("a lease the holder could not keep is reported lost — renew false, onLost called once", async () => {
    const c = clock();
    const { stable, dev } = await pair(c.now);
    let lostCalls = 0;
    const held = await stable.api.lock("l", { ttlMs: 1_000, autoRenew: false, onLost: () => void lostCalls++ });
    c.advance(1_500);
    const stolen = await dev.api.lock("l", { ttlMs: 1_000, autoRenew: false });
    expect(stolen).toBeDefined();
    expect(await held!.renew()).toBe(false);
    expect(await held!.renew()).toBe(false);
    expect(held!.lost).toBe(true);
    expect(lostCalls).toBe(1);
    // Releasing a lost lease must not free the thief's.
    await held!.release();
    expect(await dev.api.holder("l")).toMatchObject({ instanceId: "inst-dev" });
  });

  it("auto-renew keeps a lease alive past its ttl", async () => {
    const { stable, dev } = await pair();
    const held = await stable.api.lock("l", { ttlMs: 1_000 });
    await new Promise((r) => setTimeout(r, 1_400));
    expect(held!.lost).toBe(false);
    expect(await dev.api.lock("l")).toBeUndefined();
    await held!.release();
  });

  it("dispose — the plugin going down — gives back every lease it holds", async () => {
    const { stable, dev } = await pair();
    await stable.api.lock("a");
    await stable.api.lock("b");
    stable.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(await dev.api.holder("a")).toBeUndefined();
    expect(await dev.api.holder("b")).toBeUndefined();
    expect(await stable.api.lock("c")).toBeUndefined();
  });
});
