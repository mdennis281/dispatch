import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UsageSnapshot } from "@dispatch/shared";
import { useUsage } from "./usage.js";
import { api } from "../lib/api.js";

vi.mock("../lib/api.js", () => ({
  api: {
    settings: { get: vi.fn() },
    usage: { get: vi.fn(), refresh: vi.fn() },
  },
}));

const settingsGet = vi.mocked(api.settings.get);
const usageGet = vi.mocked(api.usage.get);
const usageRefresh = vi.mocked(api.usage.refresh);

function snap(provider: "claude" | "codex", percent: number): UsageSnapshot {
  return {
    fiveHour: { percent, resetsAt: null },
    sevenDay: null,
    fetchedAt: 1,
    provider,
  };
}

beforeEach(() => {
  useUsage.setState({ byProvider: {}, refreshing: {}, harness: "claude" });
  settingsGet.mockReset();
  usageGet.mockReset();
  usageRefresh.mockReset();
});

describe("usage store", () => {
  it("keeps Claude's pushed updates while the gauge reads Codex", async () => {
    // The single-slot store had to DROP these, or Claude's numbers would have
    // replaced the Codex reading under the gauge — so the card's Claude view
    // would show whatever Claude said before the switch.
    usageGet.mockResolvedValue(snap("codex", 30));
    await useUsage.getState().load("codex");
    useUsage.getState().set(snap("claude", 72));

    const { harness, byProvider } = useUsage.getState();
    expect(harness).toBe("codex");
    expect(byProvider.codex?.fiveHour?.percent).toBe(30);
    expect(byProvider.claude?.fiveHour?.percent).toBe(72);
  });

  it("loading another provider for the card does not move the gauge", async () => {
    usageGet.mockImplementation(async (h = "claude") => snap(h, h === "codex" ? 10 : 50));
    await useUsage.getState().load("claude");
    await useUsage.getState().loadProvider("codex");

    expect(useUsage.getState().harness).toBe("claude");
    expect(Object.keys(useUsage.getState().byProvider).sort()).toEqual(["claude", "codex"]);
  });

  it("a late app-default resolution does not undo a chat's provider", async () => {
    // Mount resolves the default through a settings read; opening a Codex chat
    // while that read is in flight must win, not be overwritten by it.
    let resolveSettings!: (v: unknown) => void;
    settingsGet.mockReturnValue(new Promise((r) => (resolveSettings = r)) as never);
    usageGet.mockImplementation(async (h = "claude") => snap(h, 5));

    const defaulted = useUsage.getState().load();
    await useUsage.getState().load("codex");
    resolveSettings({ harness: { defaultHarness: "claude" } });
    await defaulted;

    expect(useUsage.getState().harness).toBe("codex");
  });

  it("the gauge keeps its reading until the next provider's first read lands", async () => {
    // Moving `harness` before the fetch unmounted the gauge (no snapshot for
    // the new key) for as long as a cold Codex app-server took to answer —
    // up to its 25s probe timeout — and took an open card down with it.
    usageGet.mockResolvedValueOnce(snap("claude", 40));
    await useUsage.getState().load("claude");

    let finish!: (v: UsageSnapshot) => void;
    usageGet.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const switching = useUsage.getState().load("codex");
    await Promise.resolve();
    expect(useUsage.getState().harness).toBe("claude");

    finish(snap("codex", 3));
    await switching;
    expect(useUsage.getState().harness).toBe("codex");
  });

  it("the gauge does not move to a provider it cannot show", async () => {
    // A rejected read (a proxy 502) or the server's own "unavailable" snapshot
    // both leave a slot with no windows. Moving the gauge onto it unmounted
    // the meter entirely — card included — with Claude's windows still live.
    usageGet.mockResolvedValueOnce(snap("claude", 40));
    await useUsage.getState().load("claude");

    usageGet.mockRejectedValueOnce(new Error("502"));
    await useUsage.getState().load("codex");
    expect(useUsage.getState().harness).toBe("claude");
    expect(useUsage.getState().byProvider.codex?.error).toBe("unavailable");

    usageGet.mockResolvedValueOnce({ ...snap("codex", 0), fiveHour: null, stale: true });
    await useUsage.getState().load("codex");
    expect(useUsage.getState().harness).toBe("claude");
  });

  it("a failed first read settles into a stale snapshot, not an endless load", async () => {
    // Nothing pushes Codex's windows, so an empty slot after a 502 would read
    // "Loading…" in the card until it was closed.
    usageGet.mockRejectedValue(new Error("502"));
    await useUsage.getState().loadProvider("codex");

    expect(useUsage.getState().byProvider.codex).toMatchObject({
      fiveHour: null,
      sevenDay: null,
      stale: true,
      error: "unavailable",
      provider: "codex",
    });
  });

  it("a failed read keeps the last windows, marked stale", async () => {
    useUsage.setState({ byProvider: { codex: snap("codex", 61) } });
    usageRefresh.mockRejectedValue(new Error("504"));
    await useUsage.getState().refresh("codex");

    const codex = useUsage.getState().byProvider.codex;
    expect(codex?.fiveHour?.percent).toBe(61);
    expect(codex).toMatchObject({ stale: true, error: "unavailable", fetchedAt: 1 });
  });

  it("refresh is tracked and stored per provider", async () => {
    let finish!: (v: UsageSnapshot) => void;
    usageRefresh.mockReturnValue(new Promise((r) => (finish = r)));

    const pending = useUsage.getState().refresh("codex");
    expect(useUsage.getState().refreshing).toEqual({ codex: true });
    finish(snap("codex", 88));
    await pending;

    expect(useUsage.getState().refreshing.codex).toBe(false);
    expect(useUsage.getState().byProvider.codex?.fiveHour?.percent).toBe(88);
    expect(useUsage.getState().byProvider.claude).toBeUndefined();
  });
});
