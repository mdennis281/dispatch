import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../store/db.js";
import { MetricsService, eventKey, type MetricInput } from "./metrics.js";

let dir: string;
let db: StateDb;
let metrics: MetricsService;

/** A fixed "now" so every window/bucket assertion is deterministic. */
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0); // 2026-08-18T12:00:00Z
const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-metrics-"));
  db = new StateDb(dir);
  // flushMs 0 — no timer; every test flushes through a read or by hand, which
  // is also what proves the reads flush.
  metrics = new MetricsService({ db, now: () => NOW, flushMs: 0 });
});
afterEach(async () => {
  metrics.dispose();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Shorthand for a tool row `n` ms before NOW. */
function tool(name: string, over: Partial<MetricInput> = {}): MetricInput {
  return {
    ts: NOW - HOUR,
    category: "tool",
    identifier: name,
    chatId: "c1",
    projectId: "p1",
    toolUseId: `tu-${name}-${over.ts ?? ""}-${over.chatId ?? ""}`,
    ...over,
  };
}

describe("MetricsService — recording", () => {
  it("buffers writes and only touches the database on flush", () => {
    metrics.record(tool("Read"));
    metrics.record(tool("Bash"));
    expect(metrics.stats().buffered).toBe(2);
    expect(metrics.stats().rows).toBe(0);

    expect(metrics.flush()).toBe(2);
    expect(metrics.stats()).toMatchObject({ rows: 2, buffered: 0, dropped: 0 });
  });

  it("stamps `ts` from the clock when the caller omits it", () => {
    metrics.record({ category: "tool", identifier: "Read", toolUseId: "tu-1" });
    metrics.flush();
    expect(metrics.recent()[0]?.ts).toBe(NOW);
  });

  it("reports rows written by an auto-flush, not just by the trailing one", () => {
    // A batch longer than the 250-row size cap flushes part-way through. A
    // caller that counted only its own trailing `flush()` under-reported the
    // import by an order of magnitude — 1,616 claimed against 55,116 stored.
    const batch = Array.from({ length: 600 }, (_, i) =>
      tool("Read", { toolUseId: `bulk-${i}` }),
    );
    const written = metrics.recordMany(batch) + metrics.flush();
    expect(written).toBe(600);
    expect(metrics.stats().rows).toBe(600);
  });

  it("a read flushes first, so a chart never omits a just-recorded row", () => {
    metrics.record(tool("Read"));
    // No explicit flush: `series` must do it, or the number it returns is stale.
    expect(metrics.series({ bucket: "day", limit: 8 }).total).toBe(1);
  });

  it("round-trips every column, including a false `ok` and a null agent", () => {
    metrics.record({
      ts: NOW,
      category: "mcp",
      identifier: "proxmox/pve_nodes",
      detail: "proxmox",
      projectId: "p1",
      chatId: "c1",
      subagent: "Explore",
      model: "claude-opus-5",
      harness: "claude",
      turn: 3,
      ok: false,
      toolUseId: "tu-x",
    });
    metrics.flush();
    const [row] = metrics.recent();
    expect(row).toMatchObject({
      category: "mcp",
      identifier: "proxmox/pve_nodes",
      detail: "proxmox",
      projectId: "p1",
      chatId: "c1",
      subagent: "Explore",
      model: "claude-opus-5",
      harness: "claude",
      turn: 3,
      ok: false,
      source: "live",
    });
    // Absent, not null/"" — the wire shape drops what the column didn't hold.
    expect(row?.agent).toBeUndefined();
  });
});

describe("MetricsService — idempotency", () => {
  it("dedupes two recordings of the same tool call", () => {
    const row = tool("Read", { ts: NOW - DAY });
    metrics.record(row);
    expect(metrics.flush()).toBe(1);
    // Same call offered again — a re-import, or a backfill racing live recording.
    metrics.record({ ...row, source: "backfill" });
    expect(metrics.flush()).toBe(0);
    expect(metrics.stats().rows).toBe(1);
  });

  it("keeps the same tool name in two chats apart", () => {
    metrics.record(tool("Read", { chatId: "c1", toolUseId: "tu-1" }));
    metrics.record(tool("Read", { chatId: "c2", toolUseId: "tu-1" }));
    expect(metrics.flush()).toBe(2);
  });

  it("keys rows with no tool id off their coordinates + timestamp", () => {
    const memory = {
      category: "memory" as const,
      identifier: "two-instances",
      detail: "surfaced" as const,
      chatId: "c1",
    };
    metrics.record({ ...memory, ts: NOW });
    metrics.record({ ...memory, ts: NOW }); // same ms — the same surfacing
    metrics.record({ ...memory, ts: NOW + 1 }); // a later turn — a real second one
    expect(metrics.flush()).toBe(2);
  });

  it("distinguishes the two memory tiers, so a pointer isn't counted as a read", () => {
    metrics.record({ category: "memory", identifier: "m", detail: "surfaced", ts: NOW });
    metrics.record({ category: "memory", identifier: "m", detail: "pointed", ts: NOW });
    expect(metrics.flush()).toBe(2);
  });

  it("eventKey prefers the tool id and ignores everything else about the row", () => {
    const a = eventKey({ category: "tool", identifier: "Read", chatId: "c1", ts: 1 }, "tu-1");
    const b = eventKey({ category: "tool", identifier: "Bash", chatId: "c1", ts: 999 }, "tu-1");
    expect(a).toBe(b);
  });
});

describe("MetricsService — series", () => {
  beforeEach(() => {
    // Three days: 2 Read + 1 Bash, 1 Read, 3 Bash.
    metrics.recordMany([
      tool("Read", { ts: NOW - 2 * DAY, toolUseId: "a1" }),
      tool("Read", { ts: NOW - 2 * DAY, toolUseId: "a2" }),
      tool("Bash", { ts: NOW - 2 * DAY, toolUseId: "a3" }),
      tool("Read", { ts: NOW - DAY, toolUseId: "b1" }),
      tool("Bash", { ts: NOW, toolUseId: "c1" }),
      tool("Bash", { ts: NOW, toolUseId: "c2" }),
      tool("Bash", { ts: NOW, toolUseId: "c3" }),
    ]);
    metrics.flush();
  });

  it("buckets by day and splits by the grouped dimension", () => {
    const res = metrics.series({ bucket: "day", groupBy: "identifier", limit: 8 });
    expect(res.bucket).toBe("day");
    expect(res.buckets).toHaveLength(3);
    expect(res.total).toBe(7);
    // Ordered by total, biggest first: Bash 4, Read 3.
    expect(res.series.map((s) => [s.key, s.total])).toEqual([
      ["Bash", 4],
      ["Read", 3],
    ]);
    expect(res.series.find((s) => s.key === "Read")?.values).toEqual([2, 1, 0]);
    expect(res.series.find((s) => s.key === "Bash")?.values).toEqual([1, 0, 3]);
  });

  it("gap-fills quiet buckets rather than joining their neighbours", () => {
    const res = metrics.series({ bucket: "day", groupBy: "identifier", limit: 8 });
    // Day 2 has no Bash at all — it must be a 0, not a missing point.
    expect(res.series.find((s) => s.key === "Bash")?.values[1]).toBe(0);
    expect(res.buckets[1]! - res.buckets[0]!).toBe(DAY);
  });

  it("folds the long tail into one 'Other' series, sorted last", () => {
    const res = metrics.series({ bucket: "day", groupBy: "identifier", limit: 1 });
    expect(res.truncated).toBe(1);
    expect(res.series.map((s) => s.key)).toEqual(["Bash", "__other__"]);
    expect(res.series.at(-1)?.total).toBe(3); // the folded Read rows
    // The fold never loses rows — that is the point of reporting a total at all.
    expect(res.total).toBe(7);
  });

  it("returns one unnamed series when nothing is grouped", () => {
    const res = metrics.series({ bucket: "day", limit: 8 });
    expect(res.series).toHaveLength(1);
    expect(res.series[0]?.total).toBe(7);
  });

  it("resolves `auto` from the window's width", () => {
    expect(metrics.series({ from: NOW - 2 * DAY, to: NOW, bucket: "auto", limit: 8 }).bucket).toBe(
      "hour",
    );
    expect(metrics.series({ from: NOW - 60 * DAY, to: NOW, bucket: "auto", limit: 8 }).bucket).toBe(
      "day",
    );
    expect(metrics.series({ from: NOW - 400 * DAY, to: NOW, bucket: "auto", limit: 8 }).bucket).toBe(
      "week",
    );
  });

  it("coarsens an over-wide bucket rather than dropping rows off the end", () => {
    // Hourly over two years is ~17,500 buckets. Truncating that list to a cap
    // doesn't render fewer points — rows whose bucket start fell off the end
    // have nowhere to land, so they vanish from their series AND from the
    // reported total, with nothing saying so.
    const res = metrics.series({
      from: NOW - 730 * DAY,
      to: NOW + 1,
      bucket: "hour",
      groupBy: "identifier",
      limit: 8,
    });
    expect(res.bucket).not.toBe("hour"); // coarsened to something that fits
    expect(res.buckets.length).toBeLessThanOrEqual(1000);
    // The whole point: every row is still counted.
    expect(res.total).toBe(7);
    expect(res.series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0)).toBe(7);
  });

  it("still honours an explicit bucket the window can accommodate", () => {
    // Coarsening is a fit guarantee, not a takeover — a request that fits is
    // returned as asked.
    expect(metrics.series({ from: NOW - 2 * DAY, to: NOW + 1, bucket: "hour", limit: 8 }).bucket)
      .toBe("hour");
    expect(metrics.series({ from: NOW - 400 * DAY, to: NOW + 1, bucket: "month", limit: 8 }).bucket)
      .toBe("month");
  });

  it("is empty — not broken — for a window with no rows", () => {
    const res = metrics.series({ from: NOW + DAY, to: NOW + 2 * DAY, bucket: "day", limit: 8 });
    expect(res).toMatchObject({ buckets: [], series: [], total: 0, truncated: 0 });
  });
});

describe("MetricsService — filters", () => {
  beforeEach(() => {
    metrics.recordMany([
      tool("Read", { agent: "reviewer", projectId: "p1", toolUseId: "1" }),
      tool("Read", { agent: "reviewer", projectId: "p2", toolUseId: "2" }),
      tool("Bash", { agent: "builder", projectId: "p1", toolUseId: "3" }),
      // No agent at all — the chat ran the default.
      tool("Bash", { agent: undefined, projectId: "p1", toolUseId: "4" }),
    ]);
    metrics.flush();
  });

  it("ORs within a dimension and ANDs across them", () => {
    expect(metrics.series({ filter: { agent: ["reviewer", "builder"] }, limit: 8 }).total).toBe(3);
    expect(
      metrics.series({ filter: { agent: ["reviewer"], projectId: ["p1"] }, limit: 8 }).total,
    ).toBe(1);
  });

  it('selects rows with no value via "" — "(default agent)" is a real group', () => {
    expect(metrics.series({ filter: { agent: [""] }, limit: 8 }).total).toBe(1);
    expect(metrics.series({ filter: { agent: ["", "builder"] }, limit: 8 }).total).toBe(2);
  });

  it("cannot be used to smuggle SQL — values are bound, never interpolated", () => {
    expect(() =>
      metrics.series({ filter: { agent: ["x'; DROP TABLE metric; --"] }, limit: 8 }),
    ).not.toThrow();
    expect(metrics.stats().rows).toBe(4);
  });
});

describe("MetricsService — totals", () => {
  beforeEach(() => {
    metrics.recordMany([
      tool("Read", { chatId: "c1", toolUseId: "1" }),
      tool("Read", { chatId: "c2", toolUseId: "2" }),
      tool("Read", { chatId: "c2", toolUseId: "3" }),
      tool("Bash", { chatId: "c1", toolUseId: "4" }),
      tool("Edit", { chatId: "c1", toolUseId: "5" }),
    ]);
    metrics.flush();
  });

  it("ranks by count and reports how many distinct chats each reached", () => {
    const res = metrics.totals({ groupBy: "identifier", limit: 8, bucket: "auto" });
    expect(res.groups).toBe(3);
    expect(res.total).toBe(5);
    expect(res.totals[0]).toMatchObject({ key: "Read", count: 3, chats: 2 });
  });

  it("folds past the limit and labels the fold with how much it hides", () => {
    const res = metrics.totals({ groupBy: "identifier", limit: 1, bucket: "auto" });
    expect(res.totals).toHaveLength(2);
    expect(res.totals[1]).toMatchObject({ key: "__other__", label: "Other (2)", count: 2 });
    // Reach is the widest folded group, never the sum — one chat is in both.
    expect(res.totals[1]?.chats).toBe(1);
  });

  it("labels a null group by what its absence MEANS for that dimension", () => {
    expect(metrics.totals({ groupBy: "agent", limit: 8, bucket: "auto" }).totals[0]?.label).toBe(
      "(default agent)",
    );
    expect(metrics.totals({ groupBy: "subagent", limit: 8, bucket: "auto" }).totals[0]?.label).toBe(
      "(main loop)",
    );
  });
});

describe("MetricsService — facets", () => {
  beforeEach(() => {
    metrics.recordMany([
      tool("Read", { agent: "reviewer", projectId: "p1", toolUseId: "1" }),
      tool("Read", { agent: "builder", projectId: "p1", toolUseId: "2" }),
      tool("Read", { agent: "builder", projectId: "p2", toolUseId: "3" }),
    ]);
    metrics.flush();
  });

  it("offers every value a dimension actually has, weighted by count", () => {
    const { facets } = metrics.facets();
    expect(facets.agent).toEqual([
      { value: "builder", count: 2 },
      { value: "reviewer", count: 1 },
    ]);
  });

  it("does not apply a dimension's own filter to its own options", () => {
    // Having picked "builder", the list must still offer "reviewer" — otherwise
    // there is no way to change your mind without clearing the filter first.
    const { facets } = metrics.facets({ filter: { agent: ["builder"] } });
    expect(facets.agent?.map((f) => f.value).sort()).toEqual(["builder", "reviewer"]);
    // …but OTHER dimensions do narrow to the current selection.
    expect(facets.projectId?.map((f) => f.value).sort()).toEqual(["p1", "p2"]);
    const narrowed = metrics.facets({ filter: { agent: ["reviewer"] } });
    expect(narrowed.facets.projectId?.map((f) => f.value)).toEqual(["p1"]);
  });

  it("orders equal-count values deterministically", () => {
    // "reviewer" and a third agent both sit at 1. Without a tie-break SQLite may
    // return them in any order, so the pick-list reshuffles between loads — and
    // at the LIMIT boundary the tie would decide which values appear at all.
    metrics.record(tool("Read", { agent: "aardvark", toolUseId: "z1" }));
    metrics.flush();
    const order = () => metrics.facets().facets.agent?.map((f) => f.value);
    expect(order()).toEqual(["builder", "aardvark", "reviewer"]);
    expect(order()).toEqual(order());
  });

  it("omits the unbounded dimensions the UI filters by typing", () => {
    const { facets } = metrics.facets();
    expect(facets.identifier).toBeUndefined();
    expect(facets.chatId).toBeUndefined();
  });

  it("reports the ledger's whole range and size, ignoring the window", () => {
    const res = metrics.facets({ from: NOW, to: NOW + 1 });
    expect(res.rows).toBe(3);
    expect(res.range).toEqual({ from: NOW - HOUR, to: NOW - HOUR });
  });
});

describe("MetricsService — retention", () => {
  it("prunes only what is older than the cut-off", () => {
    metrics.recordMany([
      tool("Read", { ts: NOW - 10 * DAY, toolUseId: "old" }),
      tool("Read", { ts: NOW - DAY, toolUseId: "new" }),
    ]);
    metrics.flush();
    expect(metrics.prune(NOW - 5 * DAY)).toBe(1);
    expect(metrics.stats().rows).toBe(1);
  });
});
