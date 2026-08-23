import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../store/db.js";
import { LEGACY_MANAGER_SERVER, MANAGER_TOOL_CATEGORY } from "@dispatch/shared";
import {
  MetricsService,
  RETIRED_TOOL_DETAIL,
  eventKey,
  type MetricInput,
  type MetricSpanInput,
} from "./metrics.js";

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

/* ========================================================================== */
/*                              RUNTIME SPANS                                 */
/* ========================================================================== */

/** Midnight UTC on NOW's day — the boundary the straddle tests cross. */
const MIDNIGHT = Date.UTC(2026, 7, 18);
const MIN = 60_000;

/** Shorthand for a closed tool span. */
function span(over: Partial<MetricSpanInput> = {}): MetricSpanInput {
  return {
    state: "tool",
    identifier: "Read",
    chatId: "c1",
    projectId: "p1",
    startTs: NOW - HOUR,
    ...over,
  };
}

describe("MetricsService — recording spans", () => {
  it("writes one complete row when a span opens and closes before the flush", () => {
    const key = metrics.openSpan(span({ startTs: NOW - HOUR }));
    metrics.closeSpan(key, NOW - HOUR + 5_000);
    expect(metrics.stats().spansBuffered).toBe(1);
    expect(metrics.flush()).toBe(1);
    expect(metrics.recentSpans()[0]).toMatchObject({
      startTs: NOW - HOUR,
      endTs: NOW - HOUR + 5_000,
      state: "tool",
    });
  });

  it("applies a close to a span already on disk", () => {
    const key = metrics.openSpan(span());
    metrics.flush();
    expect(metrics.recentSpans()[0]?.endTs).toBeNull();
    metrics.closeSpan(key, NOW - HOUR + 1_000);
    expect(metrics.recentSpans()[0]?.endTs).toBe(NOW - HOUR + 1_000);
  });

  it("shows a span that is STILL RUNNING, clipped to now", () => {
    // The whole point of writing the row at open time: a four-hour sleep should
    // be on the chart while it happens, not only once it ends.
    metrics.openSpan(span({ state: "sleeping", identifier: "wait", startTs: NOW - HOUR }));
    const summary = metrics.spanSummary();
    expect(summary.byState.sleeping).toBe(HOUR);
    expect(summary.open).toBe(1);
    expect(metrics.stats().openSpans).toBe(1);
  });

  it("refuses a negative duration when a close precedes its open", () => {
    // Applied on the DISK path (the close lands after the insert flushed), which
    // is where the guard is SQL rather than JS.
    const key = metrics.openSpan(span({ startTs: NOW - HOUR }));
    metrics.flush();
    metrics.closeSpan(key, NOW - 2 * HOUR);
    expect(metrics.recentSpans()[0]?.endTs).toBe(NOW - HOUR);
  });

  it("dedupes two recordings of the same tool call's span", () => {
    metrics.openSpan(span({ toolUseId: "tu-1", endTs: NOW - HOUR + 1_000 }));
    expect(metrics.flush()).toBe(1);
    metrics.openSpan(span({ toolUseId: "tu-1", endTs: NOW - HOUR + 1_000, source: "backfill" }));
    expect(metrics.flush()).toBe(0);
    expect(metrics.stats().spans).toBe(1);
  });

  it("closes spans left open by a previous process at its last heartbeat", () => {
    metrics.openSpan(span({ state: "shell", identifier: "Bash", startTs: NOW - HOUR }));
    metrics.flush(); // stamps the heartbeat at NOW

    // A new process, an hour later, finding the row still open. Without
    // recovery every read would clip it to ITS now, and the span would grow
    // for as long as nobody noticed.
    const next = new MetricsService({ db, now: () => NOW + HOUR, flushMs: 0 });
    expect(next.recoverOpenSpans()).toBe(1);
    const row = next.recentSpans({ from: NOW - 2 * HOUR, to: NOW + 2 * HOUR })[0];
    expect(row?.endTs).toBe(NOW);
    expect(row?.truncated).toBe(true);
    next.dispose();
  });

  it("ignores a second close, whichever side of a flush it lands on", () => {
    // The disk path enforces this with `AND end_ts IS NULL`. If the buffer
    // didn't, the same duplicate close would extend a span or not depending on
    // whether a flush happened to land between the two calls.
    const buffered = metrics.openSpan(span({ startTs: NOW - HOUR, toolUseId: "a" }));
    metrics.closeSpan(buffered, NOW - HOUR + 1_000);
    metrics.closeSpan(buffered, NOW - HOUR + 9_000, { ok: false });

    const flushed = metrics.openSpan(span({ startTs: NOW - HOUR, toolUseId: "b" }));
    metrics.flush();
    metrics.closeSpan(flushed, NOW - HOUR + 1_000);
    metrics.closeSpan(flushed, NOW - HOUR + 9_000, { ok: false });
    metrics.flush();

    for (const row of metrics.recentSpans()) {
      expect(row.endTs).toBe(NOW - HOUR + 1_000);
      expect(row.ok).toBeUndefined();
    }
  });

  it("keeps the runtime's own duration beside the observed one, never instead", () => {
    const key = metrics.openSpan(span({ state: "shell", startTs: NOW - HOUR }));
    metrics.closeSpan(key, NOW - HOUR + 10_000, { ok: false, reportedMs: 9_500 });
    const row = metrics.recentSpans()[0];
    expect(row?.endTs).toBe(NOW - HOUR + 10_000);
    expect(row?.reportedMs).toBe(9_500);
    expect(row?.ok).toBe(false);
  });
});

describe("MetricsService — span series", () => {
  it("splits a span across every bucket it covers", () => {
    // 23:00 to 03:00: one hour of the 17th, three of the 18th. Banked whole it
    // would read as a four-hour burst on one day or the other.
    metrics.openSpan(
      span({
        state: "sleeping",
        identifier: "wait",
        startTs: MIDNIGHT - HOUR,
        endTs: MIDNIGHT + 3 * HOUR,
      }),
    );
    const res = metrics.spanSeries({ from: NOW - 3 * DAY, to: NOW + 1, bucket: "day" });
    const values = res.series[0]!.values;
    expect(values[res.buckets.indexOf(Date.UTC(2026, 7, 17))]).toBe(HOUR);
    expect(values[res.buckets.indexOf(Date.UTC(2026, 7, 18))]).toBe(3 * HOUR);
    expect(res.total).toBe(4 * HOUR);
    expect(res.spans).toBe(1);
  });

  it("sums spans that sit inside one bucket", () => {
    metrics.recordSpans([
      span({ startTs: MIDNIGHT + HOUR, endTs: MIDNIGHT + 2 * HOUR, toolUseId: "a" }),
      span({ startTs: MIDNIGHT + 3 * HOUR, endTs: MIDNIGHT + 4 * HOUR, toolUseId: "b" }),
    ]);
    const res = metrics.spanSeries({ from: NOW - 2 * DAY, to: NOW + 1, bucket: "day" });
    expect(res.series[0]!.values[res.buckets.indexOf(Date.UTC(2026, 7, 18))]).toBe(2 * HOUR);
    expect(res.series[0]!.count).toBe(2);
  });

  it("gap-fills the quiet days between two spans", () => {
    metrics.recordSpans([
      span({ startTs: NOW - 3 * DAY, endTs: NOW - 3 * DAY + HOUR, toolUseId: "a" }),
      span({ startTs: NOW - MIN, endTs: NOW, toolUseId: "b" }),
    ]);
    const res = metrics.spanSeries({ from: NOW - 4 * DAY, to: NOW + 1, bucket: "day" });
    expect(res.buckets.length).toBe(4);
    expect(res.series[0]!.values.filter((v) => v === 0).length).toBe(2);
  });

  it("clips a span that began before the window to the part inside it", () => {
    metrics.openSpan(span({ startTs: NOW - 5 * DAY, endTs: NOW - DAY }));
    const res = metrics.spanSummary({ from: NOW - 2 * DAY, to: NOW + 1 });
    expect(res.attributedMs).toBe(DAY);
  });

  it("groups by the derived activity class", () => {
    metrics.recordSpans([
      span({ state: "generating", identifier: "turn", startTs: NOW - HOUR, endTs: NOW - 50 * MIN, toolUseId: "g" }),
      span({ state: "shell", identifier: "Bash", startTs: NOW - 50 * MIN, endTs: NOW - 20 * MIN, toolUseId: "s" }),
      span({ state: "sleeping", identifier: "wait", startTs: NOW - 20 * MIN, endTs: NOW, toolUseId: "w" }),
    ]);
    const res = metrics.spanSeries({ groupBy: "class", bucket: "day" });
    const by = new Map(res.series.map((s) => [s.key, s.total]));
    expect(by.get("thinking")).toBe(10 * MIN);
    expect(by.get("working")).toBe(30 * MIN);
    expect(by.get("blocked")).toBe(20 * MIN);
    expect(res.series.find((s) => s.key === "thinking")?.label).toBe("Thinking");
  });

  it("keys a NULL group as \"\", not as null", () => {
    // `run_id` is NULL for every main-loop span, so this is the commonest group
    // in the table rather than an edge case — a raw NULL here would key the
    // whole main loop on nothing and skip the label the UI shows for it.
    metrics.recordSpans([
      span({ startTs: NOW - 10 * MIN, endTs: NOW - 5 * MIN, toolUseId: "main" }),
      span({ runId: "task-1", startTs: NOW - 9 * MIN, endTs: NOW - 6 * MIN, toolUseId: "child" }),
    ]);
    const res = metrics.spanSeries({ groupBy: "runId", bucket: "day" });
    const main = res.series.find((s) => s.key === "");
    expect(main?.label).toBe("(main loop)");
    expect(main?.total).toBe(5 * MIN);
    expect(res.series.find((s) => s.key === "task-1")?.total).toBe(3 * MIN);
    expect(metrics.spanTotals({ groupBy: "runId" }).totals.map((t) => t.key).sort()).toEqual([
      "",
      "task-1",
    ]);
  });

  it("returns an empty response for a window with no spans", () => {
    metrics.openSpan(span({ startTs: NOW - 40 * DAY, endTs: NOW - 39 * DAY }));
    const res = metrics.spanSeries({ from: NOW - DAY, to: NOW + 1 });
    expect(res).toMatchObject({ buckets: [], series: [], total: 0, spans: 0 });
  });
});

describe("MetricsService — attributed time vs wall clock", () => {
  it("counts parallel tool calls once for wall clock and twice for attribution", () => {
    // Two Bash calls open at once. The agent was busy for ten minutes, and it
    // spent nineteen agent-minutes doing it — both true, and the gap between
    // them is the parallelism the chart should be able to show.
    metrics.recordSpans([
      span({ state: "shell", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "t1" }),
      span({ state: "shell", startTs: NOW - 9 * MIN, endTs: NOW, toolUseId: "t2" }),
    ]);
    const res = metrics.spanTotals({ groupBy: "chatId" });
    expect(res.totals[0]).toMatchObject({ key: "c1", ms: 19 * MIN, busyMs: 10 * MIN });
  });

  it("treats a subagent run as an actor of its own", () => {
    // The parent blocks on the child for the whole run. That is two actors busy,
    // not one — else a fleet of subagents would cost nothing at all.
    metrics.recordSpans([
      span({
        state: "waiting_agent",
        identifier: "Explore",
        startTs: NOW - 10 * MIN,
        endTs: NOW,
        toolUseId: "task-1",
      }),
      span({
        state: "generating",
        identifier: "turn",
        runId: "task-1",
        subagent: "Explore",
        startTs: NOW - 9 * MIN,
        endTs: NOW - MIN,
        toolUseId: "child-1",
      }),
    ]);
    const summary = metrics.spanSummary();
    expect(summary.actors).toBe(2);
    expect(summary.chats).toBe(1);
    expect(summary.busyMs).toBe(10 * MIN + 8 * MIN);
    expect(summary.byClass).toEqual({ blocked: 10 * MIN, thinking: 8 * MIN });
  });

  it("does not merge two chats running at the same time", () => {
    metrics.recordSpans([
      span({ chatId: "c1", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "a" }),
      span({ chatId: "c2", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "b" }),
    ]);
    const summary = metrics.spanSummary();
    expect(summary.busyMs).toBe(20 * MIN);
    expect(summary.attributedMs).toBe(20 * MIN);
  });

  it("re-unions the folded groups rather than summing their wall clocks", () => {
    // One chat, three overlapping states. Group by state with room for one, and
    // the two that fold share the same actor — summing them would report more
    // wall clock than the window contains.
    metrics.recordSpans([
      span({ state: "shell", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "a" }),
      span({ state: "tool", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "b" }),
      span({ state: "generating", startTs: NOW - 10 * MIN, endTs: NOW, toolUseId: "c" }),
    ]);
    const res = metrics.spanTotals({ groupBy: "state", limit: 1 });
    const other = res.totals.find((t) => t.key === "__other__");
    expect(other?.ms).toBe(20 * MIN);
    expect(other?.busyMs).toBe(10 * MIN);
    expect(res.busyMs).toBe(10 * MIN);
  });
});

describe("MetricsService — span facets and retention", () => {
  it("offers the states and classes that actually occur", () => {
    metrics.recordSpans([
      span({ state: "shell", startTs: NOW - HOUR, endTs: NOW - 30 * MIN, toolUseId: "a" }),
      span({ state: "sleeping", startTs: NOW - 30 * MIN, endTs: NOW, toolUseId: "b" }),
    ]);
    const res = metrics.spanFacets();
    expect(res.facets.state?.map((f) => f.value).sort()).toEqual(["shell", "sleeping"]);
    // Unbounded dimensions are typed, not picked from a list.
    expect(res.facets.identifier).toBeUndefined();
    expect(res.facets.runId).toBeUndefined();
    expect(res.rows).toBe(2);
  });

  it("stretches the range to now for a span that is still open", () => {
    // The window controls read this range. An open span's effective end is now
    // on every other read, and stopping at its START would leave the range
    // short of the present exactly while something is running.
    metrics.openSpan(span({ startTs: NOW - HOUR }));
    expect(metrics.spanFacets().range).toEqual({ from: NOW - HOUR, to: NOW });
  });

  it("prunes spans that ENDED before the cut-off, and keeps the ones still running", () => {
    metrics.recordSpans([
      span({ startTs: NOW - 10 * DAY, endTs: NOW - 9 * DAY, toolUseId: "old" }),
      span({ startTs: NOW - DAY, endTs: NOW, toolUseId: "new" }),
    ]);
    // Started before the cut-off but has not finished — not history yet.
    metrics.openSpan(span({ startTs: NOW - 10 * DAY, toolUseId: "running" }));
    expect(metrics.prune(NOW - 5 * DAY)).toBe(1);
    expect(metrics.stats().spans).toBe(2);
  });
});

describe("MetricsService — chatRuntime (the sidebar's per-row figure)", () => {
  it("sums a chat's main loop and its subagents into one number", () => {
    // A subagent's spans carry its PARENT's chatId — the actor is (chatId,
    // runId) — so "all the agents under this chat" needs no join, and the two
    // parallel subagents below really are 2 minutes of agent time between them.
    metrics.openSpan(span({ startTs: NOW - 10 * MIN, endTs: NOW - 9 * MIN, toolUseId: "main" }));
    metrics.openSpan(
      span({ startTs: NOW - 8 * MIN, endTs: NOW - 7 * MIN, runId: "r1", toolUseId: "s1" }),
    );
    metrics.openSpan(
      span({ startTs: NOW - 8 * MIN, endTs: NOW - 7 * MIN, runId: "r2", toolUseId: "s2" }),
    );

    expect(metrics.chatRuntime().byChat).toEqual({ c1: 3 * MIN });
  });

  it("keeps chats apart and reports every one of them", () => {
    // The reason this isn't `spanTotals({groupBy:"chatId"})`: that one caps at
    // 50 groups and folds the rest into `__other__`, which cannot label a
    // sidebar. Every chat gets its own key here, however many there are.
    for (let i = 0; i < 60; i++) {
      metrics.openSpan(
        span({ chatId: `c${i}`, startTs: NOW - MIN, endTs: NOW - MIN + 1_000, toolUseId: `t${i}` }),
      );
    }
    const { byChat } = metrics.chatRuntime();

    expect(Object.keys(byChat)).toHaveLength(60);
    expect(byChat.c59).toBe(1_000);
  });

  it("counts a span that is still running, up to the instant it measured", () => {
    metrics.openSpan(span({ startTs: NOW - 4 * MIN }));
    const { byChat, at } = metrics.chatRuntime();

    expect(at).toBe(NOW);
    expect(byChat.c1).toBe(4 * MIN);
  });

  it("has no window — a chat that last ran months ago still reports", () => {
    // The figure sits beside "3d ago" on a row whose work is long finished. The
    // 7-day default every other span read uses would quietly show it as absent.
    metrics.openSpan(span({ startTs: NOW - 90 * DAY, endTs: NOW - 90 * DAY + 5 * MIN }));

    expect(metrics.chatRuntime().byChat).toEqual({ c1: 5 * MIN });
  });

  it("omits a chat it has no reading for rather than claiming zero", () => {
    metrics.openSpan(span({ startTs: NOW - MIN, endTs: NOW - MIN, toolUseId: "instant" }));

    expect(metrics.chatRuntime().byChat).toEqual({});
  });

  it("flushes buffered spans first, so a just-finished turn is already counted", () => {
    metrics.openSpan(span({ startTs: NOW - 2 * MIN, endTs: NOW - MIN }));
    expect(metrics.stats().spansBuffered).toBe(1);

    expect(metrics.chatRuntime().byChat.c1).toBe(MIN);
  });
});

describe("migrateLegacyManagerDetail", () => {
  /** A row as it was stored BEFORE the servers were split: `detail` held the one
   *  server name, where it now holds the tool's category. */
  const legacyRow = (identifier: string, category: MetricInput["category"] = "manager") => ({
    ts: NOW - HOUR,
    category,
    identifier,
    detail: LEGACY_MANAGER_SERVER,
    chatId: "c1",
    toolUseId: `tu-${category}-${identifier}`,
  });

  const detailsById = () =>
    new Map(
      (
        db.prepare("SELECT identifier, detail FROM metric").all() as {
          identifier: string;
          detail: string;
        }[]
      ).map((r) => [r.identifier, r.detail]),
    );

  it("re-files every legacy row, including tools that no longer exist", async () => {
    metrics.record(legacyRow("create_pr"));
    metrics.record(legacyRow("terminal"));
    // A tool deleted from the registry. The first version of this migration
    // matched on `identifier` against the registry and left these under the old
    // server name forever — the same legacy bucket it existed to remove, just
    // smaller, and it would never have emptied.
    metrics.record(legacyRow("wait_for_pr"));
    // A DIFFERENT category that happens to carry the same detail is not ours.
    metrics.record(legacyRow("x/y", "mcp"));
    await metrics.flush();

    expect(metrics.migrateLegacyManagerDetail()).toBe(3);
    const detail = detailsById();
    expect(detail.get("create_pr")).toBe(MANAGER_TOOL_CATEGORY.create_pr);
    expect(detail.get("terminal")).toBe(MANAGER_TOOL_CATEGORY.terminal);
    expect(detail.get("wait_for_pr")).toBe(RETIRED_TOOL_DETAIL);
    expect(detail.get("x/y")).toBe(LEGACY_MANAGER_SERVER);

    // Nothing is left under the retired server name — that was the whole point.
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM metric WHERE category = 'manager' AND detail = ?")
      .get(LEGACY_MANAGER_SERVER) as { n: number };
    expect(left.n).toBe(0);
  });

  it("is a no-op on every boot after the first", async () => {
    metrics.record(legacyRow("create_pr"));
    await metrics.flush();
    expect(metrics.migrateLegacyManagerDetail()).toBe(1);
    expect(metrics.migrateLegacyManagerDetail()).toBe(0);
  });

  it("does not throw on an empty table", () => {
    expect(metrics.migrateLegacyManagerDetail()).toBe(0);
  });

  it("leaves an already-migrated row alone", async () => {
    metrics.record({
      ...legacyRow("create_pr"),
      detail: MANAGER_TOOL_CATEGORY.create_pr,
    });
    await metrics.flush();
    expect(metrics.migrateLegacyManagerDetail()).toBe(0);
    expect(detailsById().get("create_pr")).toBe(MANAGER_TOOL_CATEGORY.create_pr);
  });
});
