import { describe, it, expect, vi } from "vitest";
import { ClaudeUsage, ClaudeUsagePoller, limitReadingsOf, limitsOfUsage, resetGrantsOf } from "./usage.js";
import { ClaudeHarness } from "./index.js";

/** A minimal Response the poller reads (.ok/.status/.json). */
function resp(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const OK_BODY = {
  five_hour: { utilization: 7, resets_at: "2026-07-07T18:00:00.000+00:00" },
  seven_day: { utilization: 15, resets_at: "2026-07-10T16:00:00.000+00:00" },
};

function make(opts: { fetchImpl: typeof fetch; token?: string | null; now?: () => number }) {
  return new ClaudeUsagePoller({
    configDir: "/nowhere",
    fetchImpl: opts.fetchImpl,
    readToken: async () => (opts.token === undefined ? "tok" : opts.token),
    now: opts.now ?? (() => 1_000),
  });
}

describe("ClaudeUsagePoller", () => {
  it("parses a 200 response into 5h + weekly windows (ISO → epoch ms)", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const limits = await make({ fetchImpl }).cached();
    expect(limits.primary).toEqual({
      usedPercent: 7,
      windowMinutes: 300,
      resetsAt: Date.parse("2026-07-07T18:00:00.000+00:00"),
    });
    expect(limits.secondary?.usedPercent).toBe(15);
    // The card keeps Claude's own names, not "5-hour window".
    expect(limits.windows?.map((w) => w.title)).toEqual(["5-hour session", "Weekly"]);
    expect(limits.stale).toBeUndefined();
  });

  it("cached() caches — a second call doesn't refetch", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const poller = make({ fetchImpl });
    await poller.cached();
    await poller.cached();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no token → an 'unavailable' answer (never calls fetch)", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const limits = await make({ fetchImpl, token: null }).cached();
    expect(limits).toMatchObject({ stale: true, error: "unavailable" });
    expect(limits.primary).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("429 keeps the last good windows, marks them stale, and holds every read off", async () => {
    let t = 1_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(resp(200, OK_BODY))
      .mockResolvedValueOnce(resp(429)) as unknown as typeof fetch;
    const poller = make({ fetchImpl, now: () => t });

    await poller.fresh(); // good
    t += 10_000; // clear the double-click floor
    const err = await poller.fresh().catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "rate_limited", retryAt: t + 30 * 60_000 });
    const stale = await poller.cached();
    expect(stale).toMatchObject({ stale: true, error: "rate_limited" });
    expect(stale.primary?.usedPercent).toBe(7); // preserved

    // Inside the cooldown, a fresh read is refused WITHOUT a request.
    t += 60_000;
    await expect(poller.fresh()).rejects.toMatchObject({ message: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("401 → unauthenticated", async () => {
    const fetchImpl = vi.fn(async () => resp(401)) as unknown as typeof fetch;
    expect(await make({ fetchImpl }).cached()).toMatchObject({ error: "unauthenticated" });
  });

  it("fresh() floor-spaces rapid calls (no double fetch)", async () => {
    let t = 1_000;
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const poller = make({ fetchImpl, now: () => t });
    await poller.fresh();
    t += 100; // well under the 5s floor
    await poller.fresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeUsage", () => {
  it("keeps one poller per config dir — never one shared by every empty overlay", () => {
    // The old registry served the DEFAULT login's poller to any account whose
    // env overlay was empty, which is every provider's default account. A goose
    // default account therefore read, and was stamped with, Claude's windows.
    const usage = new ClaudeUsage((dir) => new ClaudeUsagePoller({ configDir: dir, readToken: async () => null }));
    const a = usage.for({ subscriptionId: "claude", configDir: "/home/ada/.claude", env: {} });
    const b = usage.for({ subscriptionId: "work", configDir: "/home/ada/.claude-work", env: { CLAUDE_CONFIG_DIR: "x" } });
    expect(a).not.toBe(b);
    expect(usage.for({ subscriptionId: "renamed", configDir: "/home/ada/.claude", env: {} })).toBe(a);
  });
});

describe("ClaudeHarness limits", () => {
  it("declares usageLimits and answers readLimits from the poller", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const harness = new ClaudeHarness({
      usage: new ClaudeUsage((dir) => new ClaudeUsagePoller({ configDir: dir, fetchImpl, readToken: async () => "t" })),
    });
    expect(harness.capabilities.usageLimits).toBe(true);
    const limits = await harness.readLimits(undefined, { fresh: true });
    expect(limits?.primary?.usedPercent).toBe(7);
  });
});

describe("limit readings", () => {
  it("every window in the response, nulls skipped, under the ids history has always used", () => {
    const body = {
      five_hour: { utilization: 12, resets_at: "2026-10-22T15:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2026-10-25T00:00:00Z" },
      seven_day_opus: { utilization: 0, resets_at: null },
      seven_day_oauth_apps: null,
      extra_usage: { is_enabled: false },
    };
    expect(limitReadingsOf(body).map((x) => [x.windowId, x.title, x.windowMinutes, x.percent])).toEqual([
      ["five_hour", "5-hour session", 300, 12],
      ["seven_day", "Weekly", 10080, 40],
      ["seven_day_opus", "Weekly · Opus", 10080, 0],
    ]);
    expect(limitsOfUsage(body).tracked?.map((w) => [w.id, w.usedPercent, w.resetsAt])).toEqual([
      ["five_hour", 12, Date.parse("2026-10-22T15:00:00Z")],
      ["seven_day", 40, Date.parse("2026-10-25T00:00:00Z")],
      ["seven_day_opus", 0, undefined],
    ]);
  });
});

/*
 * The `cedar_ember` block, shaped from a real 200 (2026-11-13). Dispatch read
 * this endpoint for months without the `?cedar_ember=1` flag and with a 2.0.0
 * User-Agent, got null or `ineligible_reason: "cli_version"`, and concluded
 * Claude had no resets while the account held two.
 */
const NOW = Date.parse("2026-11-13T00:00:00Z");
const CEDAR = {
  eligible: true,
  grants: [
    {
      id: "full-reset-2611",
      label: "One full limit reset (November 2026)",
      resets_total: 1,
      resets_left: 1,
      ends_at: "2026-12-10T22:00:00+00:00",
      clears: ["seven_day", "seven_day_overage_included"],
      usable_now: true,
      unavailable_reason: null,
    },
    {
      id: "launch-2610-fable",
      label: "New model launch: one Fable reset",
      resets_total: 1,
      resets_left: 0,
      ends_at: "2027-03-09T07:59:00+00:00",
      clears: ["seven_day_overage_included"],
      usable_now: false,
      unavailable_reason: "not_at_wall",
    },
    { id: "expired", label: "Old", resets_total: 1, resets_left: 1, ends_at: "2026-10-01T00:00:00+00:00" },
  ],
};

describe("reset grants", () => {
  it("maps each live grant: count, use-by, what it refills, and why it can't be used", () => {
    const limits = limitsOfUsage({ ...OK_BODY, cedar_ember: CEDAR }, NOW);
    expect(limits.resetGrants).toEqual([
      {
        id: "full-reset-2611",
        label: "One full limit reset (November 2026)",
        left: 1,
        total: 1,
        expiresAt: Date.parse("2026-12-10T22:00:00+00:00"),
        usableNow: true,
        refills: ["Weekly", "Weekly · Overage Included"],
      },
      {
        id: "launch-2610-fable",
        label: "New model launch: one Fable reset",
        left: 0,
        total: 1,
        expiresAt: Date.parse("2027-03-09T07:59:00+00:00"),
        usableNow: false,
        unavailableReason: "not_at_wall",
        refills: ["Weekly · Overage Included"],
      },
    ]);
    expect(limits.resetHint).toMatch(/\/limit-reset/);
  });

  // Absent and ineligible must not read as "0 resets left" on the card.
  it("reports NO grants (not an empty list) when the block is missing or ineligible", () => {
    expect(limitsOfUsage(OK_BODY, NOW).resetGrants).toBeUndefined();
    const ineligible = { eligible: false, ineligible_reason: "cli_version", grants: [] };
    expect(limitsOfUsage({ ...OK_BODY, cedar_ember: ineligible }, NOW).resetGrants).toBeUndefined();
    expect(resetGrantsOf(null, NOW)).toBeNull();
  });

  it("asks with the cedar_ember flag and names the installed CLI version", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    await new ClaudeUsagePoller({
      configDir: "/nowhere",
      fetchImpl,
      readToken: async () => "tok",
      cliVersion: () => "2.1.400",
    }).cached();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toContain("cedar_ember=1");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("claude-cli/2.1.400 (external, cli)");
  });

  it("falls back to a version the endpoint accepts when the runtime's is unknown", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    await make({ fetchImpl }).cached();
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>)["User-Agent"]).not.toContain("2.0.0");
  });
});
