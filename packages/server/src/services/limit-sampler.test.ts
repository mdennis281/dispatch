import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitReading, ResolvedSubscription } from "@dispatch/shared";
import { Store } from "../store/index.js";
import type { HarnessRegistry } from "../harness/index.js";
import { toHarnessLimits } from "@dispatch/plugin-codex/harness";
import { LimitLedger } from "./limit-ledger.js";
import {
  HarnessLimitSource,
  LimitSampler,
  limitSourceFor,
  readingsOfLimits,
  type LimitRead,
  type LimitSource,
} from "./limit-sampler.js";
import type { Harness } from "../harness/types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);

let dir: string;
let store: Store;
let ledger: LimitLedger;
let now: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-sampler-"));
  store = new Store(dir);
  now = T0;
  ledger = new LimitLedger(store.stateDb, () => now);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const sub = (id: string, provider: "claude" | "codex" = "claude"): ResolvedSubscription => ({
  id,
  name: id,
  provider,
});

class FakeSource implements LimitSource {
  cadence = { floorMs: 5 * MIN, activeMs: 5 * MIN, idleMs: 15 * MIN };
  reads: string[] = [];
  next: LimitRead = { ok: true, readings: [] };
  async read(s: ResolvedSubscription): Promise<LimitRead> {
    this.reads.push(s.id);
    return this.next;
  }
}

function sampler(source: FakeSource, accounts = [sub("claude1"), sub("claude2")]) {
  return new LimitSampler({
    ledger,
    harnesses: { list: () => [], find: () => undefined } as unknown as HarnessRegistry,
    settings: async () => null,
    now: () => now,
    random: () => 0.5,
    sourceFor: () => source,
    accounts: async () => accounts,
  });
}

const w = (percent: number, resetsAt: number | null): LimitReading => ({
  windowId: "five_hour",
  title: "5-hour session",
  windowMinutes: 300,
  percent,
  resetsAt,
});

describe("LimitSampler", () => {
  it("reads every account, then not again before the floor", async () => {
    const src = new FakeSource();
    const s = sampler(src);
    await s.tick();
    expect(src.reads.sort()).toEqual(["claude1", "claude2"]);
    now += 4 * MIN;
    await s.tick();
    expect(src.reads).toHaveLength(2);
    now += 2 * MIN;
    await s.tick();
    expect(src.reads).toHaveLength(4);
  });

  it("backs off to idle once readings stop moving, and a turn nudges it back", async () => {
    const src = new FakeSource();
    src.next = { ok: true, readings: [w(10, T0 + 20 * HOUR)] };
    const s = sampler(src, [sub("claude1")]);
    await s.tick();
    now += 10_000;
    await s.tick();
    for (let i = 0; i < 4; i++) {
      now += 5 * MIN + 30_000;
      await s.tick();
    }
    const [st] = s.status();
    // Idle: the read after the last one is 15 minutes out, not 5.
    expect(st!.nextAt! - st!.lastAt!).toBe(15 * MIN);
    s.nudge("claude1");
    expect(s.status()[0]!.nextAt).toBeLessThanOrEqual(now);
  });

  it("schedules a read just after an announced reset", async () => {
    const src = new FakeSource();
    src.next = { ok: true, readings: [w(60, T0 + 7 * MIN)] };
    const s = sampler(src, [sub("claude1")]);
    await s.tick();
    now += 10_000;
    await s.tick();
    // The 5-minute cadence would land at +5m; the reset at +7m pulls the
    // read after that one to just past it.
    now += 5 * MIN + 10_000;
    await s.tick();
    expect(s.status()[0]!.nextAt).toBeLessThan(now + 6 * MIN);
  });

  it("honours a 429's cooldown", async () => {
    const src = new FakeSource();
    src.next = { ok: false, error: "rate_limited", retryAt: T0 + 30 * MIN };
    const s = sampler(src, [sub("claude1")]);
    await s.tick();
    now += 10_000;
    await s.tick();
    expect(s.status()[0]).toMatchObject({ error: "rate_limited", nextAt: T0 + 30 * MIN });
  });

  it("records readings into the ledger and finds the reset", async () => {
    const src = new FakeSource();
    src.next = { ok: true, readings: [w(80, T0 + 3 * MIN)] };
    const s = sampler(src, [sub("claude1")]);
    await s.tick();
    now += 10_000;
    await s.tick();
    src.next = { ok: true, readings: [w(0, T0 + 5 * HOUR)] };
    now += 6 * MIN;
    await s.tick();
    expect(ledger.events({}).map((e) => e.kind)).toEqual(["reset"]);
  });
});

describe("HarnessLimitSource", () => {
  it("asks for a fresh read, so a runtime failure is a failed read — not the cache", async () => {
    const calls: unknown[] = [];
    const harness = {
      readLimits: async (_account: unknown, opts?: { fresh?: boolean }) => {
        calls.push(opts);
        if (opts?.fresh) throw new Error("timed out");
        return { primary: { usedPercent: 50 } };
      },
    } as unknown as Harness;
    const s = new LimitSampler({
      ledger,
      harnesses: { list: () => [], find: () => undefined } as unknown as HarnessRegistry,
      settings: async () => null,
      now: () => now,
      random: () => 0.5,
      sourceFor: () => new HarnessLimitSource(harness),
      accounts: async () => [sub("codex1", "codex")],
    });
    await s.tick();
    expect(calls).toEqual([{ fresh: true }]);
    expect(s.status()[0]).toMatchObject({ error: "timed out", lastOkAt: null });
    expect(ledger.stats().rows).toBe(0);
  });

  it("holds the next read until the retryAt a failed read names (a 429 cooldown)", async () => {
    const harness = {
      readLimits: async () => {
        throw Object.assign(new Error("rate_limited"), { retryAt: T0 + 30 * MIN });
      },
    } as unknown as Harness;
    const read = await new HarnessLimitSource(harness).read(sub("claude1"));
    expect(read).toEqual({ ok: false, error: "rate_limited", retryAt: T0 + 30 * MIN });
  });

  it("reports each good read to onRead — the header meter's feed", async () => {
    const seen: Array<[string, number | undefined]> = [];
    const harness = { readLimits: async () => ({ primary: { usedPercent: 12 } }) } as unknown as Harness;
    await new HarnessLimitSource(harness, (s, l) => seen.push([s.id, l.primary?.usedPercent])).read(sub("claude1"));
    expect(seen).toEqual([["claude1", 12]]);
  });
});

describe("limitSourceFor", () => {
  const registry = (h: Partial<Harness> | undefined) => ({ find: () => h as Harness | undefined });

  it("reads any provider that declares usageLimits — no provider names", () => {
    const claude = { kind: "claude", capabilities: { usageLimits: true } } as unknown as Harness;
    expect(limitSourceFor("claude", registry(claude))).toBeInstanceOf(HarnessLimitSource);
  });

  it("gives a provider without usageLimits no source at all", () => {
    // Regression (#425): goose's usage row used to show the Claude account's
    // numbers, because "no usageLimits" routed to the Claude OAuth poller.
    const goose = { kind: "goose", capabilities: { usageLimits: false } } as unknown as Harness;
    expect(limitSourceFor("goose", registry(goose))).toBeUndefined();
    expect(limitSourceFor("claude", registry(undefined))).toBeUndefined();
  });
});

describe("provider readings", () => {
  it("Codex: every bucket, keyed by length rather than slot, plus reset credits", () => {
    const limits = toHarnessLimits(
      { limitId: "codex", primary: { usedPercent: 53, windowDurationMins: 10080, resetsAt: 1793129113 } },
      {
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 53, windowDurationMins: 10080, resetsAt: 1793129113 } },
          premium: {
            limitName: "GPT-6 Pro",
            primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1793000000 },
          },
        },
        rateLimitResetCredits: { availableCount: 1 },
      },
    );
    expect(limits.resetCredits).toBe(1);
    expect(readingsOfLimits(limits).map((r) => [r.windowId, r.title, r.percent, r.resetsAt])).toEqual([
      ["codex:10080m", "Weekly", 53, 1793129113000],
      ["premium:300m", "5-hour session · GPT-6 Pro", 4, 1793000000000],
    ]);
  });
});
