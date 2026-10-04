import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, UsageSnapshot } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { FailoverService, nextReset } from "./failover.js";
import { usageExhausted, type AccountUsage } from "./usage-read.js";

/**
 * The usage registry and harness registry are both faked structurally: what is
 * under test is which account gets picked, and the real ones would need a live
 * Anthropic endpoint and an installed runtime to answer at all.
 */
const FULL: UsageSnapshot = { fiveHour: { percent: 100, resetsAt: null }, sevenDay: null, fetchedAt: 0 };
const FREE: UsageSnapshot = { fiveHour: { percent: 12, resetsAt: null }, sevenDay: null, fetchedAt: 0 };

describe("usageExhausted", () => {
  it("is true at or past 100% on any window", () => {
    expect(usageExhausted({ snapshot: FULL })).toBe(true);
    expect(usageExhausted({ snapshot: { ...FREE, sevenDay: { percent: 100, resetsAt: null } } })).toBe(true);
    expect(usageExhausted({ snapshot: FREE })).toBe(false);
  });

  it("trusts the runtime's own verdict over the percentages", () => {
    // Codex says "out of budget" outright; a 99.6% reading would not catch it.
    expect(usageExhausted({ reached: true, snapshot: { ...FREE } })).toBe(true);
  });

  it("answers NO on a failed or stale read", () => {
    // The bias that matters: an unreachable usage endpoint must not be able to
    // condemn an account that is perfectly usable.
    expect(usageExhausted({ snapshot: { ...FULL, stale: true } })).toBe(false);
    expect(usageExhausted({ snapshot: { ...FULL, error: "429" } })).toBe(false);
  });
});

describe("nextReset", () => {
  const at = (ms: number) => ({ percent: 100, resetsAt: ms });

  it("takes the LATEST full window — a weekly cap outlives a 5-hour rollover", () => {
    expect(
      nextReset({ snapshot: { fiveHour: at(1_000), sevenDay: at(9_000), fetchedAt: 0 } }),
    ).toBe(9_000);
  });

  it("ignores a window that still has room", () => {
    expect(
      nextReset({
        snapshot: { fiveHour: at(9_000), sevenDay: { percent: 10, resetsAt: 50_000 }, fetchedAt: 0 },
      }),
    ).toBe(9_000);
  });

  it("uses every window's reset when the runtime says `reached`", () => {
    // Codex sets `reached` from a spend cap, independent of the percentages — a
    // window can read 60% and still be out. Reading only the full ones found
    // nothing here and fell back to the one-hour guess, re-reading usage every
    // hour for as long as the cap held.
    expect(
      nextReset({
        reached: true,
        snapshot: {
          fiveHour: { percent: 60, resetsAt: 4_000 },
          sevenDay: { percent: 12, resetsAt: 80_000 },
          fetchedAt: 0,
        },
      }),
    ).toBe(80_000);
  });

  it("is undefined when nothing is out, or when no window named a time", () => {
    expect(nextReset({ snapshot: FREE })).toBeUndefined();
    expect(
      nextReset({ reached: true, snapshot: { fiveHour: { percent: 100, resetsAt: null }, sevenDay: null, fetchedAt: 0 } }),
    ).toBeUndefined();
  });
});

describe("FailoverService", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let clock: number;
  let switched: { chatId: string; subscriptionId: string }[];
  let switchFails: string | null;
  /** subscription id → the usage its account reports. */
  let usage: Record<string, AccountUsage>;
  let reads: string[];
  let notices: string[];

  const NOW = Date.parse("2026-08-01T18:00:00.000Z");

  /** Two Claude logins that rescue each other, plus a Codex that points at both. */
  const ACCOUNTS = [
    { id: "claude1", name: "One", provider: "claude" as const, configDir: "", fallbacks: ["claude2"] },
    { id: "claude2", name: "Two", provider: "claude" as const, configDir: "", fallbacks: ["claude1"] },
    { id: "codex1", name: "Codex", provider: "codex" as const, configDir: "", fallbacks: ["claude1", "claude2"] },
  ];

  /**
   * Real directories with a real login file: `subscriptionStatuses` reads the
   * filesystem for `loggedIn`, and the picker refuses an account without one.
   */
  function withDirs() {
    return ACCOUNTS.map((a) => {
      const configDir = join(dir, a.id);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, a.provider === "claude" ? ".credentials.json" : "auth.json"),
        "{}",
      );
      return { ...a, configDir };
    });
  }

  function makeService(opts: { installed?: string[] } = {}) {
    const installed = opts.installed ?? ["claude", "codex"];
    const harnesses = {
      list: () =>
        ["claude", "codex"].map((kind) => ({
          kind,
          runtime: () => ({ available: installed.includes(kind) }),
        })),
      find: () => undefined,
    };
    const accountUsage = {
      for: (account: { subscriptionId: string }) => ({
        get: async () => {
          reads.push(account.subscriptionId);
          return (usage[account.subscriptionId] ?? { snapshot: FREE }).snapshot;
        },
        refresh: async () => {
          reads.push(account.subscriptionId);
          return (usage[account.subscriptionId] ?? { snapshot: FREE }).snapshot;
        },
      }),
    };
    return new FailoverService({
      store,
      bus,
      // Structural fakes: see the note at the top of the file.
      harnesses: harnesses as never,
      accountUsage: accountUsage as never,
      switchTo: async (chatId, subscriptionId) => {
        if (switchFails) throw new Error(switchFails);
        switched.push({ chatId, subscriptionId });
      },
      now: () => clock,
    });
  }

  function chat(id: string, over: Partial<Chat> = {}): Chat {
    return {
      id,
      projectId: "p1",
      title: "Work",
      harness: "claude",
      worktrees: [],
      prs: [],
      createdAt: NOW - 60_000,
      ...over,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cm-failover-"));
    store = new Store(dir);
    bus = new EventBus();
    clock = NOW;
    switched = [];
    switchFails = null;
    usage = {};
    reads = [];
    notices = [];
    bus.subscribe((e) => {
      if (e.type === "notice") notices.push(e.text);
    });
    await store.saveSettings({ ...(await store.getSettings()), subscriptions: withDirs() });
    await store.saveChat(chat("c1", { subscriptionId: "claude1" }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves the chat to the first fallback with budget", async () => {
    const f = makeService();
    const moved = await f.onLimit("c1", "You've hit your session limit", NOW + 3_600_000);
    expect(moved?.from.id).toBe("claude1");
    expect(moved?.to.id).toBe("claude2");
    expect(switched).toEqual([{ chatId: "c1", subscriptionId: "claude2" }]);
    // The cause is announced before the move, because `setSubscription` only
    // says "Switched to …" and a switch with no stated cause reads as manual.
    expect(notices[0]).toContain("out of budget");
    expect(notices[0]).toContain("Two");
  });

  it("skips a fallback that is itself out of budget and takes the next tier", async () => {
    await store.saveChat(chat("c2", { harness: "codex", subscriptionId: "codex1" }));
    usage.claude1 = { snapshot: FULL };
    const f = makeService();
    const moved = await f.onLimit("c2", "rate limit reached", NOW + 600_000);
    expect(moved?.to.id).toBe("claude2");
  });

  it("returns null when every fallback is exhausted — the caller then waits", async () => {
    usage.claude2 = { snapshot: FULL };
    const f = makeService();
    expect(await f.onLimit("c1", "You've hit your session limit", NOW + 600_000)).toBeNull();
    expect(switched).toEqual([]);
  });

  it("returns null when the account names no fallback at all", async () => {
    const settings = await store.getSettings();
    await store.saveSettings({
      ...settings,
      subscriptions: withDirs().map((a) => ({ ...a, fallbacks: undefined })),
    });
    const f = makeService();
    expect(await f.onLimit("c1", "You've hit your session limit", NOW + 600_000)).toBeNull();
    // Nothing configured means nothing read — the chain is checked first.
    expect(reads).toEqual([]);
  });

  it("will not fall back onto a provider that isn't installed", async () => {
    await store.saveChat(chat("c2", { harness: "codex", subscriptionId: "codex1" }));
    const f = makeService({ installed: ["codex"] });
    expect(await f.onLimit("c2", "rate limit reached", NOW + 600_000)).toBeNull();
  });

  it("will not fall back onto an account with no login", async () => {
    // claude2's directory exists but holds no credentials file.
    rmSync(join(dir, "claude2", ".credentials.json"));
    const f = makeService();
    expect(await f.onLimit("c1", "You've hit your session limit", NOW + 600_000)).toBeNull();
  });

  it("does not bounce back to an account it just failed over AWAY from", async () => {
    // The ping-pong this service's ledger exists to prevent: A↔B, where B's own
    // limit arrives before any usage poll has noticed A is empty. Both read as
    // having budget, and without the ledger the chat returns to A immediately.
    const f = makeService();
    expect((await f.onLimit("c1", "limit · resets 5pm", NOW + 3_600_000))?.to.id).toBe("claude2");
    await store.saveChat(chat("c1", { subscriptionId: "claude2" }));
    expect(await f.onLimit("c1", "limit · resets 6pm", NOW + 7_200_000)).toBeNull();
  });

  it("forgets the ledger entry once the window it recorded has passed", async () => {
    const f = makeService();
    f.markExhausted("claude2", NOW + 600_000);
    expect(await f.onLimit("c1", "limit", NOW + 600_000)).toBeNull();
    clock = NOW + 600_001;
    expect((await f.onLimit("c1", "limit", clock + 600_000))?.to.id).toBe("claude2");
  });

  it("keeps the LATER reset when two limits are seen for one account", async () => {
    // A weekly limit must not be shortened by a 5-hour one seen afterwards.
    const f = makeService();
    f.markExhausted("claude2", NOW + 7 * 24 * 3_600_000);
    f.markExhausted("claude2", NOW + 600_000);
    clock = NOW + 3_600_000;
    expect(await f.onLimit("c1", "limit", clock)).toBeNull();
  });

  it("reports a failed switch rather than claiming the chat moved", async () => {
    switchFails = "session transfer exploded";
    const f = makeService();
    expect(await f.onLimit("c1", "You've hit your session limit", NOW + 600_000)).toBeNull();
    expect(notices.at(-1)).toContain("Could not fall back");
  });

  it("is a no-op for a chat that doesn't exist", async () => {
    const f = makeService();
    expect(await f.onLimit("nope", "limit", NOW)).toBeNull();
  });

  describe("redirectNewChat", () => {
    it("leaves a healthy account alone", async () => {
      const f = makeService();
      const all = await store.getSettings();
      const claude1 = all.subscriptions!.find((s) => s.id === "claude1")!;
      expect(await f.redirectNewChat(claude1)).toBeNull();
    });

    it("redirects off an account with nothing left", async () => {
      usage.claude1 = { snapshot: FULL };
      const f = makeService();
      const claude1 = (await store.getSettings()).subscriptions!.find((s) => s.id === "claude1")!;
      expect((await f.redirectNewChat(claude1))?.id).toBe("claude2");
    });

    it("returns null when it is out of budget with nowhere to go", async () => {
      usage.claude1 = { snapshot: FULL };
      usage.claude2 = { snapshot: FULL };
      const f = makeService();
      const claude1 = (await store.getSettings()).subscriptions!.find((s) => s.id === "claude1")!;
      expect(await f.redirectNewChat(claude1)).toBeNull();
    });
  });
});
