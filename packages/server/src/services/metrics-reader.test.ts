import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitQuerySchema } from "@dispatch/shared";
import { StateDb } from "../store/db.js";
import { MetricsService } from "./metrics.js";
import { TokenLedger } from "./metrics-tokens.js";
import { LimitLedger } from "./limit-ledger.js";
import { MetricsReadAborted, MetricsReader } from "./metrics-reader.js";

let dir: string;
let db: StateDb;
let metrics: MetricsService;
let limits: LimitLedger;
let reader: MetricsReader;

function makeReader(useWorker = true): MetricsReader {
  return new MetricsReader({
    db,
    metrics,
    tokens: new TokenLedger(db),
    limits,
    useWorker,
    testHooks: true,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-reader-"));
  db = new StateDb(dir);
  metrics = new MetricsService({ db, flushMs: 0 });
  limits = new LimitLedger(db);
  reader = makeReader();
});
afterEach(async () => {
  await reader.dispose();
  metrics.dispose();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Worst gap between 10 ms timer ticks on THIS thread while `work` runs. */
async function worstTimerGap<T>(work: Promise<T>): Promise<{ gap: number; value: T }> {
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    gap = Math.max(gap, t - last);
    last = t;
  }, 10);
  try {
    const value = await work;
    return { gap, value };
  } finally {
    clearInterval(timer);
  }
}

describe("MetricsReader — the metrics worker thread", () => {
  it("answers on a worker thread, and sees rows still in the main thread's buffer", async () => {
    reader.start();
    expect(reader.onWorker).toBe(true);
    // Buffered, NOT flushed: the worker's own connection can only see it
    // because the reader flushes before it sends the request.
    metrics.record({ ts: Date.now() - 1_000, category: "tool", identifier: "Bash", chatId: "c1", toolUseId: "t1" });
    const totals = await reader.call("totals", { groupBy: "identifier" });
    expect(totals.total).toBe(1);
    expect(totals.totals[0]?.key).toBe("Bash");
    // Same answer the in-process read gives, across the structured clone.
    expect(await reader.call("totals", { groupBy: "identifier" })).toEqual(
      metrics.totals({ groupBy: "identifier" }),
    );
  });

  it("keeps the main event loop free while the worker is busy", async () => {
    reader.start();
    await reader.call("ledgerCounts", undefined); // thread warm
    // 1.5 s of solid work on the worker. In-process, that is a 1.5 s freeze of
    // every request on the server; on the worker, 10 ms timers here keep
    // ticking. The bound is loose for a busy CI box, and still an order of
    // magnitude under the work being done.
    const { gap } = await worstTimerGap(reader.spin(1_500));
    expect(gap).toBeLessThan(250);
  });

  it("drops a queued request whose caller gave up, without running it", async () => {
    reader.start();
    const busy = reader.spin(800);
    const abort = new AbortController();
    const queued = reader.call("series", {}, abort.signal);
    const t0 = performance.now();
    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(MetricsReadAborted);
    // Rejected at once — not after the 800 ms request ahead of it.
    expect(performance.now() - t0).toBeLessThan(200);
    await busy;
  });

  it("stops the RUNNING request when its caller gives up", async () => {
    reader.start();
    const abort = new AbortController();
    const t0 = performance.now();
    const running = reader.spin(5_000, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(running).rejects.toBeInstanceOf(MetricsReadAborted);
    expect(performance.now() - t0).toBeLessThan(2_000);
    // …and the thread is free for the next one.
    expect(await reader.call("ledgerCounts", undefined)).toEqual({ rows: 0, spans: 0 });
  });

  it("exits cleanly on dispose — no thread left behind", async () => {
    reader.start();
    await reader.call("ledgerCounts", undefined);
    expect(reader.threadId).not.toBeNull();
    await reader.dispose();
    expect(reader.onWorker).toBe(false);
    await expect(reader.call("ledgerCounts", undefined)).rejects.toThrow(/disposed/);
  });

  it("comes back after the worker dies", async () => {
    reader.start();
    await reader.call("ledgerCounts", undefined);
    const first = reader.threadId;
    // Simulate a crash: kill the thread out from under it.
    await (reader as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    expect(reader.onWorker).toBe(false);
    expect(await reader.call("ledgerCounts", undefined)).toEqual({ rows: 0, spans: 0 });
    expect(reader.threadId).not.toBe(first);
  });

  it("carries the sampler's held-back readings across to the worker (Limits)", async () => {
    reader.start();
    const MIN = 60_000;
    const t0 = Date.now() - 2 * 60 * MIN;
    const reading = {
      windowId: "five_hour",
      title: "5-hour session",
      windowMinutes: 300,
      percent: 10,
      resetsAt: t0 + 4 * 60 * MIN,
    };
    limits.observe({ ts: t0, subscriptionId: "acct", provider: "claude", readings: [reading] });
    // Unchanged, so held back: in THIS thread's ledger memory, not the table.
    limits.observe({ ts: t0 + 10 * MIN, subscriptionId: "acct", provider: "claude", readings: [reading] });
    const held = limits.heldReadings();
    expect(held).toHaveLength(1);
    const query = LimitQuerySchema.parse({});
    const line = async (h: typeof held) =>
      (await reader.call("limits", { query, settings: null, held: h })).windows[0]?.points.map((p) => p.ts);
    // The worker's own ledger has an empty memory; the snapshot is what lets
    // its line reach the newest reading, as the in-process read always did.
    expect(await line(held)).toEqual([t0, t0 + 10 * MIN]);
    expect(await line([])).toEqual([t0]);
  });

  it("runs the same table in-process when told not to use a worker", async () => {
    await reader.dispose();
    reader = makeReader(false);
    reader.start();
    expect(reader.onWorker).toBe(false);
    metrics.record({ ts: Date.now() - 1_000, category: "tool", identifier: "Read", chatId: "c1", toolUseId: "t2" });
    expect((await reader.call("totals", { groupBy: "identifier" })).total).toBe(1);
  });
});
