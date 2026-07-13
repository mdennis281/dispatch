import { describe, it, expect, vi } from "vitest";
import type { WsServerEvent, UsageSnapshot } from "@cm/shared";
import { EventBus } from "../bus.js";
import { UsageService } from "./usage.js";

/** A minimal Response the service reads (.ok/.status/.json). */
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

/** Build a service with injected fetch/token/clock and an event capture. */
function make(opts: {
  fetchImpl: typeof fetch;
  token?: string | null;
  now?: () => number;
}) {
  const bus = new EventBus();
  const events: UsageSnapshot[] = [];
  bus.subscribe((e: WsServerEvent) => {
    if (e.type === "usage-update") events.push(e.usage);
  });
  const svc = new UsageService({
    bus,
    fetchImpl: opts.fetchImpl,
    readToken: async () => (opts.token === undefined ? "tok" : opts.token),
    now: opts.now ?? (() => 1_000),
    pollMs: 60_000,
  });
  return { svc, events };
}

describe("UsageService", () => {
  it("parses a 200 response into 5h + weekly windows (ISO → epoch ms)", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const { svc, events } = make({ fetchImpl });

    const snap = await svc.get();
    expect(snap.fiveHour).toEqual({
      percent: 7,
      resetsAt: Date.parse("2026-07-07T18:00:00.000+00:00"),
    });
    expect(snap.sevenDay?.percent).toBe(15);
    expect(snap.stale).toBeUndefined();
    // Published on the bus for live clients.
    expect(events.at(-1)?.fiveHour?.percent).toBe(7);
  });

  it("get() caches — a second call doesn't refetch", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl });
    await svc.get();
    await svc.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no token → an 'unavailable' snapshot (never calls fetch)", async () => {
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl, token: null });
    const snap = await svc.get();
    expect(snap.error).toBe("unavailable");
    expect(snap.fiveHour).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("429 keeps the last good windows, marks them stale + rate_limited", async () => {
    let t = 1_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(resp(200, OK_BODY))
      .mockResolvedValueOnce(resp(429)) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl, now: () => t });

    await svc.get(); // good
    t += 10_000; // clear the manual-refresh floor
    const stale = await svc.refresh(); // 429
    expect(stale.error).toBe("rate_limited");
    expect(stale.stale).toBe(true);
    expect(stale.fiveHour?.percent).toBe(7); // preserved
  });

  it("401 → unauthenticated (stale)", async () => {
    const fetchImpl = vi.fn(async () => resp(401)) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl });
    const snap = await svc.get();
    expect(snap.error).toBe("unauthenticated");
  });

  it("refresh() floor-spaces rapid calls (no double fetch)", async () => {
    let t = 1_000;
    const fetchImpl = vi.fn(async () => resp(200, OK_BODY)) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl, now: () => t });
    await svc.get(); // first fetch
    t += 100; // well under the 5s manual floor
    await svc.refresh(); // should be skipped
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
