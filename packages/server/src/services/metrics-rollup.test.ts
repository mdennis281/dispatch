import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METRIC_STATES, type MetricState } from "@dispatch/shared";
import { StateDb } from "../store/db.js";
import { MetricsService, type MetricInput, type MetricSpanInput } from "./metrics.js";
import {
  HOUR_MS,
  RollupBuilder,
  ROLLUP_VERSION,
  floorHour,
  readRollupState,
  rollSpans,
  rollupFrontier,
  type RawSpan,
} from "./metrics-rollup.js";

const NOW = Date.UTC(2026, 7, 18, 12, 20, 0) + 37; // deliberately off the hour
const MIN = 60_000;
const DAY = 86_400_000;

/** Seeds for the equivalence sweep. Each is a different ledger; a failure
 * names its seed, so it reproduces exactly. */
const SEEDS = process.env.ROLLUP_SEEDS
  ? Array.from({ length: Number(process.env.ROLLUP_SEEDS) }, (_, i) => i + 1)
  : [42, 1001, 2024];

let dir: string;
let db: StateDb;
let metrics: MetricsService;
let builder: RollupBuilder;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-rollup-"));
  db = new StateDb(dir);
  metrics = new MetricsService({ db, now: () => NOW, flushMs: 0 });
  builder = new RollupBuilder(db, () => NOW);
});
afterEach(async () => {
  metrics.dispose();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Deterministic PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A ledger shaped like the real one where it matters: several actors per
 * chat, overlapping spans of different keys inside one actor (parallel tool
 * calls), zero-length spans, spans crossing hour and day boundaries, a few
 * longer than SPAN_LONG_MS, some still open, NULLs in the dimension columns.
 */
function seed(r: () => number): void {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const chats = ["c1", "c2", "c3"];
  const runs = [undefined, undefined, "r1", "r2"];
  const tools = ["Bash", "Read", "Edit", "mcp__x__y"];
  const durations = [0, 0, 1_000, 30_000, 4 * MIN, 25 * MIN, 70 * MIN, 3 * HOUR_MS, 7 * HOUR_MS];
  const spans: MetricSpanInput[] = [];
  for (let i = 0; i < 900; i++) {
    const chatId = pick(chats);
    const startTs = NOW - Math.floor(r() * 4 * DAY);
    const open = r() < 0.03;
    const dur = pick(durations);
    spans.push({
      state: pick(METRIC_STATES) as MetricState,
      identifier: pick(tools),
      chatId,
      runId: pick(runs),
      projectId: chatId === "c3" ? undefined : `p-${chatId}`,
      agent: r() < 0.3 ? undefined : pick(["a1", "a2"]),
      model: pick(["m1", "m2"]),
      startTs,
      endTs: open ? undefined : Math.min(startTs + dur, NOW),
      spanKey: `s${i}`,
    });
  }
  metrics.recordSpans(spans);
  const events: MetricInput[] = [];
  for (let i = 0; i < 1500; i++) {
    events.push({
      ts: NOW - Math.floor(r() * 4 * DAY),
      category: pick(["tool", "skill", "memory"] as const),
      identifier: pick(tools),
      chatId: r() < 0.1 ? undefined : pick(chats),
      projectId: r() < 0.2 ? undefined : pick(["p-c1", "p-c2"]),
      agent: r() < 0.3 ? undefined : pick(["a1", "a2"]),
      toolUseId: `e${i}`,
    });
  }
  metrics.recordMany(events);
  metrics.flush();
}

/** Every read the Metrics screen makes, over windows that exercise the raw
 * path, the mixed path, and both kinds of edge. */
function snapshot(): unknown {
  const windows = [
    { from: NOW - 4 * DAY - 30 * MIN, to: NOW + 1 },
    { from: floorHour(NOW - 2 * DAY), to: NOW - 3 * HOUR_MS + 17 * MIN },
    { from: floorHour(NOW - 3 * DAY) + 1, to: floorHour(NOW - HOUR_MS) },
    { from: NOW - 20 * MIN, to: NOW + 1 },
  ];
  const out: unknown[] = [];
  for (const w of windows) {
    out.push(metrics.series({ ...w, bucket: "hour" }));
    out.push(metrics.series({ ...w, groupBy: "identifier", limit: 2, bucket: "day" }));
    out.push(metrics.series({ ...w, groupBy: "chatId", filter: { agent: ["a1", ""] } }));
    out.push(metrics.totals({ ...w, groupBy: "chatId", limit: 2 }));
    out.push(metrics.totals({ ...w, groupBy: "agent", filter: { category: ["tool"] } }));
    out.push(metrics.facets(w));
    out.push(metrics.facets({ ...w, filter: { identifier: ["Bash"], projectId: [""] } }));
    out.push(metrics.spanSeries({ ...w, groupBy: "state", bucket: "hour" }));
    out.push(metrics.spanSeries({ ...w, groupBy: "class", bucket: "day", limit: 2 }));
    out.push(metrics.spanSeries({ ...w, groupBy: "identifier", filter: { runId: [""] } }));
    for (const groupBy of ["state", "identifier", "chatId", "runId", "projectId"] as const) {
      out.push(metrics.spanTotals({ ...w, groupBy, limit: 2 }));
      out.push(metrics.spanTotals({ ...w, groupBy, limit: 8 }));
    }
    out.push(metrics.spanTotals({ ...w, groupBy: "identifier", filter: { state: ["tool", "shell"] } }));
    out.push(metrics.spanTotals({ ...w, groupBy: "class", filter: { agent: [""] } }));
    out.push(metrics.spanSummary(w));
    out.push(metrics.spanSummary({ ...w, filter: { chatId: ["c1"], runId: ["r1", ""] } }));
    out.push(metrics.spanFacets(w));
    out.push(metrics.spanFacets({ ...w, filter: { state: ["generating"] } }));
  }
  return out;
}

/** The same reads with the rollup switched off, for comparison. A version
 * mismatch is exactly what makes every read ignore it. */
function rawSnapshot(): unknown {
  const v = readRollupState(db).version;
  db.prepare("UPDATE metric_rollup_state SET version = -1 WHERE id = 1").run();
  try {
    return snapshot();
  } finally {
    db.prepare("UPDATE metric_rollup_state SET version = ? WHERE id = 1").run(v);
  }
}

function build(): void {
  for (let i = 0; i < 10_000 && builder.step(); i++);
}

describe("rollSpans", () => {
  const base = (over: Partial<RawSpan>): RawSpan => ({
    chat_id: "c",
    run_id: null,
    state: "tool",
    identifier: "Bash",
    detail: null,
    project_id: null,
    agent: null,
    subagent: null,
    model: null,
    harness: null,
    source: "live",
    start_ts: 0,
    end_ts: 0,
    ...over,
  });

  it("slices a span at hour boundaries and counts it once, in the hour it starts", () => {
    const h = 10 * HOUR_MS;
    const { rows } = rollSpans([base({ start_ts: h + 30 * MIN, end_ts: h + 2 * HOUR_MS + 15 * MIN })], 0, 100 * HOUR_MS);
    expect(rows.map((r) => [r.hour - h, r.ms, r.n, r.last - h])).toEqual([
      [0, 30 * MIN, 1, HOUR_MS],
      [HOUR_MS, HOUR_MS, 0, 2 * HOUR_MS],
      [2 * HOUR_MS, 15 * MIN, 0, 2 * HOUR_MS + 15 * MIN],
    ]);
  });

  it("stores overlapping rows as segments whose sums give every selection's union", () => {
    // Bash [0, 40m) and Read [20m, 60m): union 60m, Bash alone 40m, Read 40m.
    const { rows, segs } = rollSpans(
      [
        base({ identifier: "Bash", start_ts: 0, end_ts: 40 * MIN }),
        base({ identifier: "Read", start_ts: 20 * MIN, end_ts: 60 * MIN }),
      ],
      0,
      HOUR_MS,
    );
    const busy = (pick: (id: string) => boolean) =>
      segs
        .filter((s) => s.members.some((m) => pick(rows[m]!.identifier)))
        .reduce((a, s) => a + s.dur, 0);
    expect(busy(() => true)).toBe(60 * MIN);
    expect(busy((id) => id === "Bash")).toBe(40 * MIN);
    expect(busy((id) => id === "Read")).toBe(40 * MIN);
  });

  it("keeps a zero-length span countable without giving it any busy time", () => {
    const { rows, segs } = rollSpans([base({ start_ts: 5 * HOUR_MS, end_ts: 5 * HOUR_MS })], 0, 10 * HOUR_MS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hour: 5 * HOUR_MS, ms: 0, n: 1 });
    expect(segs).toHaveLength(0);
  });
});

describe("rollups — every read is exactly what the raw rows give", () => {
  it.each(SEEDS)("matches raw for every window, filter, group-by and fold (seed %i)", (n) => {
    seed(rng(n));
    const raw = rawSnapshot();
    expect(rollupFrontier(db)).toBe(0);
    build();
    // Built up to the last hour that has ended (plus grace), so the mixed path
    // is genuinely in play for every multi-hour window above.
    expect(rollupFrontier(db)).toBe(floorHour(NOW - 60_000));
    expect(snapshot()).toEqual(raw);
  });

  it("stays exact through late writes into sealed hours, and recovers the rollup", () => {
    seed(rng(7));
    build();
    // A span closing late (its hours were sealed while it was open), a span
    // imported into the past, an event backfilled into a sealed hour.
    const open = db.prepare("SELECT span_key AS k FROM metric_span WHERE end_ts IS NULL LIMIT 1").get() as
      | { k: string }
      | undefined;
    expect(open).toBeDefined();
    metrics.closeSpan(open!.k, NOW - 5 * MIN);
    metrics.recordSpans([
      { state: "tool", identifier: "Bash", chatId: "c2", startTs: NOW - 2 * DAY, endTs: NOW - 2 * DAY + 95 * MIN, spanKey: "late" },
    ]);
    metrics.record({ ts: NOW - 3 * DAY, category: "tool", identifier: "Edit", chatId: "c1", toolUseId: "late-e" });
    metrics.flush();

    // Dirty below the frontier: reads refuse the rollup outright…
    expect(rollupFrontier(db)).toBe(0);
    expect(snapshot()).toEqual(rawSnapshot());
    // …until the worker's step recomputes those hours.
    while (builder.processDirty());
    expect(rollupFrontier(db)).toBeGreaterThan(0);
    expect(snapshot()).toEqual(rawSnapshot());
  });

  it("is thrown away by prune and rebuilt from what is left", () => {
    seed(rng(99));
    build();
    metrics.prune(NOW - 2 * DAY);
    expect(rollupFrontier(db)).toBe(0);
    build();
    expect(readRollupState(db).version).toBe(ROLLUP_VERSION);
    expect(rollupFrontier(db)).toBeGreaterThan(0);
    expect(snapshot()).toEqual(rawSnapshot());
  });

  it("discards a rollup built under another version before rebuilding", () => {
    seed(rng(3));
    build();
    db.prepare("UPDATE metric_rollup_state SET version = ? WHERE id = 1").run(ROLLUP_VERSION + 1);
    expect(rollupFrontier(db)).toBe(0);
    build();
    expect(readRollupState(db).version).toBe(ROLLUP_VERSION);
    expect(snapshot()).toEqual(rawSnapshot());
  });

  it("records only where a sealed hour changed, and nothing for unsealed ones", () => {
    seed(rng(5));
    build();
    const dirty = () => (db.prepare("SELECT COUNT(*) AS n FROM metric_rollup_dirty").get() as { n: number }).n;
    expect(dirty()).toBe(0);
    // Live recording lands past the frontier: no trigger work at all.
    metrics.record({ ts: NOW, category: "tool", identifier: "Bash", chatId: "c1", toolUseId: "now" });
    metrics.flush();
    expect(dirty()).toBe(0);
    metrics.record({ ts: NOW - DAY, category: "tool", identifier: "Bash", chatId: "c1", toolUseId: "old" });
    metrics.flush();
    expect(dirty()).toBe(1);
  });
});
