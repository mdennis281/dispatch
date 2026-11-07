import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 86_400_000;
const OLDEST = Date.UTC(2024, 0, 1);

const calls: { route: string; q: Record<string, unknown> }[] = [];
const facetsRes = { facets: {}, range: { from: OLDEST, to: OLDEST + DAY }, rows: 3 };
const series = { buckets: [], bucket: "month", series: [], total: 0, truncated: 0 };
const totals = { totals: [], total: 0, groups: 0, chats: 0 };

vi.mock("../lib/api.js", () => {
  const rec =
    (route: string, res: unknown) =>
    async (q: Record<string, unknown>) => {
      calls.push({ route, q });
      return res;
    };
  return {
    api: {
      metrics: {
        series: rec("series", series),
        totals: rec("totals", totals),
        facets: rec("facets", facetsRes),
        recent: rec("recent", []),
      },
    },
  };
});

const { useMetrics } = await import("./metrics.js");

beforeEach(() => {
  calls.length = 0;
});

describe("Usage store — All time", () => {
  it("reads the ledger's range first, then sends a window from the oldest row", async () => {
    useMetrics.setState({ rangeId: "all", bucket: "day" });
    await useMetrics.getState().load();

    // Facets first, alone: nothing else can size its window without them.
    expect(calls[0]!.route).toBe("facets");
    expect(calls[0]!.q.from).toBe(0);

    const s = calls.find((c) => c.route === "series")!;
    // The bug: "All time" sent no `from`, which the server read as 30 days.
    expect(s.q.from).toBe(OLDEST);
    // Daily since 2024-01 is well past 200 buckets, so it went out coarsened —
    // the server never computes the daily series at all.
    expect(s.q.bucket).not.toBe("day");
    expect(useMetrics.getState().coarsened).toMatchObject({ wanted: "day" });
    // The pre-read facets stood in for the batch's own: one facets call total.
    expect(calls.filter((c) => c.route === "facets")).toHaveLength(1);
  });

  it("reuses the known oldest row without a second pre-read", async () => {
    useMetrics.setState({ rangeId: "all", bucket: "auto", filter: { model: ["x"] } });
    await useMetrics.getState().load();
    expect(calls[0]!.route).not.toBe("facets");
    expect(calls.find((c) => c.route === "series")!.q).toMatchObject({
      from: OLDEST,
      bucket: "auto",
    });
    expect(useMetrics.getState().coarsened).toBeNull();
  });
});
