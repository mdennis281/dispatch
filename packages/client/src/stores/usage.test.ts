import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SubscriptionStatus, UsageSnapshot } from "@dispatch/shared";
import { usageKey, useUsage } from "./usage.js";
import { useSubscriptions } from "./subscriptions.js";
import { api, type UsageTarget } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({
  api: {
    settings: { get: vi.fn() },
    usage: { get: vi.fn(), refresh: vi.fn() },
    subscriptions: { list: vi.fn(), save: vi.fn() },
  },
}));

const settingsGet = vi.mocked(api.settings.get);
const usageGet = vi.mocked(api.usage.get);
const usageRefresh = vi.mocked(api.usage.refresh);

const CLAUDE1: UsageTarget = { harness: "claude", subscriptionId: "claude1" };
const CLAUDE2: UsageTarget = { harness: "claude", subscriptionId: "claude2" };
const CODEX: UsageTarget = { harness: "codex", subscriptionId: "codex1" };

function snap(target: UsageTarget, percent: number): UsageSnapshot {
  return {
    fiveHour: { percent, resetsAt: null },
    sevenDay: null,
    fetchedAt: 1,
    provider: target.harness,
    subscriptionId: target.subscriptionId,
  };
}

const answer = (percentOf: (t: UsageTarget) => number) => async (t: UsageTarget | undefined) =>
  snap(t!, percentOf(t!));

beforeEach(() => {
  useUsage.setState({ bySubscription: {}, refreshing: {}, target: { harness: "claude" } });
  useSubscriptions.setState({ list: [], loaded: false });
  settingsGet.mockReset();
  usageGet.mockReset();
  usageRefresh.mockReset();
});

describe("usage store", () => {
  it("keeps two accounts of ONE provider apart", async () => {
    // Keyed by provider, claude2's reading would land in claude1's slot and the
    // gauge would show another login's 5-hour window under this chat's name.
    usageGet.mockImplementation(answer((t) => (t.subscriptionId === "claude2" ? 90 : 12)));
    await useUsage.getState().load(CLAUDE1);
    await useUsage.getState().loadTarget(CLAUDE2);

    const { target, bySubscription } = useUsage.getState();
    expect(target).toEqual(CLAUDE1);
    expect(bySubscription.claude1?.fiveHour?.percent).toBe(12);
    expect(bySubscription.claude2?.fiveHour?.percent).toBe(90);
  });

  it("keeps Claude's pushed updates while the gauge reads Codex", async () => {
    usageGet.mockResolvedValue(snap(CODEX, 30));
    await useUsage.getState().load(CODEX);
    useUsage.getState().set(snap(CLAUDE1, 72));

    const { target, bySubscription } = useUsage.getState();
    expect(target).toEqual(CODEX);
    expect(bySubscription.codex1?.fiveHour?.percent).toBe(30);
    expect(bySubscription.claude1?.fiveHour?.percent).toBe(72);
  });

  it("files an unstamped push under the account at the provider's default dir", () => {
    // The server's boot-time poller can push before anything told it its id.
    useSubscriptions.setState({
      list: [
        { id: "claude2", provider: "claude", atDefaultDir: false } as SubscriptionStatus,
        { id: "claude1", provider: "claude", atDefaultDir: true } as SubscriptionStatus,
      ],
    });
    useUsage.getState().set({ ...snap(CLAUDE1, 44), subscriptionId: undefined });
    expect(useUsage.getState().bySubscription.claude1?.fiveHour?.percent).toBe(44);
  });

  it("files a bare-provider read under both the ask and the account it resolved to", async () => {
    settingsGet.mockResolvedValue({ harness: { defaultHarness: "claude" } } as never);
    usageGet.mockResolvedValue(snap(CLAUDE1, 7));
    await useUsage.getState().load();
    const { bySubscription, target } = useUsage.getState();
    expect(bySubscription[usageKey({ harness: "claude" })]?.fiveHour?.percent).toBe(7);
    expect(bySubscription.claude1?.fiveHour?.percent).toBe(7);
    expect(target).toEqual({ harness: "claude" });
  });

  it("a late app-default resolution does not undo a chat's account", async () => {
    // Mount resolves the default through a settings read; opening a Codex chat
    // while that read is in flight must win, not be overwritten by it.
    let resolveSettings!: (v: unknown) => void;
    settingsGet.mockReturnValue(new Promise((r) => (resolveSettings = r)) as never);
    usageGet.mockImplementation(answer(() => 5));

    const defaulted = useUsage.getState().load();
    await useUsage.getState().load(CODEX);
    resolveSettings({ harness: { defaultHarness: "claude" } });
    await defaulted;

    expect(useUsage.getState().target).toEqual(CODEX);
  });

  it("the gauge keeps its reading until the next account's first read lands", async () => {
    // Moving the target before the fetch unmounted the gauge (no snapshot for
    // the new key) for as long as a cold Codex app-server took to answer —
    // up to its 25s probe timeout — and took an open card down with it.
    usageGet.mockResolvedValueOnce(snap(CLAUDE1, 40));
    await useUsage.getState().load(CLAUDE1);

    let finish!: (v: UsageSnapshot) => void;
    usageGet.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const switching = useUsage.getState().load(CODEX);
    await Promise.resolve();
    expect(useUsage.getState().target).toEqual(CLAUDE1);

    finish(snap(CODEX, 3));
    await switching;
    expect(useUsage.getState().target).toEqual(CODEX);
  });

  it("the gauge does not move to an account it cannot show", async () => {
    usageGet.mockResolvedValueOnce(snap(CLAUDE1, 40));
    await useUsage.getState().load(CLAUDE1);

    usageGet.mockRejectedValueOnce(new Error("502"));
    await useUsage.getState().load(CODEX);
    expect(useUsage.getState().target).toEqual(CLAUDE1);
    expect(useUsage.getState().bySubscription.codex1?.error).toBe("unavailable");

    usageGet.mockResolvedValueOnce({ ...snap(CODEX, 0), fiveHour: null, stale: true });
    await useUsage.getState().load(CODEX);
    expect(useUsage.getState().target).toEqual(CLAUDE1);
  });

  it("a failed first read settles into a stale snapshot, not an endless load", async () => {
    usageGet.mockRejectedValue(new Error("502"));
    await useUsage.getState().loadTarget(CODEX);

    expect(useUsage.getState().bySubscription.codex1).toMatchObject({
      fiveHour: null,
      sevenDay: null,
      stale: true,
      error: "unavailable",
      provider: "codex",
      subscriptionId: "codex1",
    });
  });

  it("a failed read keeps the last windows, marked stale", async () => {
    useUsage.setState({ bySubscription: { codex1: snap(CODEX, 61) } });
    usageRefresh.mockRejectedValue(new Error("504"));
    await useUsage.getState().refresh(CODEX);

    const codex = useUsage.getState().bySubscription.codex1;
    expect(codex?.fiveHour?.percent).toBe(61);
    expect(codex).toMatchObject({ stale: true, error: "unavailable", fetchedAt: 1 });
  });

  it("refresh is tracked and stored per account", async () => {
    let finish!: (v: UsageSnapshot) => void;
    usageRefresh.mockReturnValue(new Promise((r) => (finish = r)));

    const pending = useUsage.getState().refresh(CLAUDE2);
    expect(useUsage.getState().refreshing).toEqual({ claude2: true });
    finish(snap(CLAUDE2, 88));
    await pending;

    expect(useUsage.getState().refreshing.claude2).toBe(false);
    expect(useUsage.getState().bySubscription.claude2?.fiveHour?.percent).toBe(88);
    expect(useUsage.getState().bySubscription.claude1).toBeUndefined();
  });
});
