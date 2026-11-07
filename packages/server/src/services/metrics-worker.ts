/**
 * The metrics worker thread: every Metrics-route read, plus the rollup build.
 *
 * WHY A THREAD. `node:sqlite` is synchronous, so a metrics read held the
 * server's ONE event loop for its whole duration — 9 s for a 7-day Runtime
 * batch even after stage 1, 71 s in the worst stacked case in the request
 * log — and every other request, websocket frame and terminal byte waited
 * behind it. Here a read blocks only this thread.
 *
 * Its own connections, never the main thread's: a `DatabaseSync` belongs to
 * the thread that opened it. The DB is WAL, so this thread's readers get a
 * consistent snapshot while the main thread keeps writing.
 *   - `reads`: READ-ONLY. Nothing a query does here can write, so the rule
 *     "ledger writes stay on the main thread" is enforced, not just intended.
 *   - `rollupDb`: writable, used ONLY by the rollup builder, and only for the
 *     rollup tables (see metrics-rollup.ts on keeping its locks short).
 *
 * ABORT. The main thread queues requests and sends one at a time, so a
 * superseded request still in ITS queue is simply never sent. For the one
 * running here, it writes that request's id into a shared Int32Array, and
 * every statement this thread prepares checks it first — so an abandoned
 * 7-day Runtime read stops at its next statement instead of finishing.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { StatementSync } from "node:sqlite";
import { StateDb } from "../store/db.js";
import { MetricsService } from "./metrics.js";
import { TokenLedger } from "./metrics-tokens.js";
import { LimitLedger } from "./limit-ledger.js";
import { createReadMethods, type MetricsReadMethod } from "./metrics-read-api.js";
import { RollupBuilder } from "./metrics-rollup.js";

export interface MetricsWorkerData {
  /** The state root whose `state.db` to open. */
  root: string;
  /** Shared abort cell: holds the id of the request to abandon. */
  abort: SharedArrayBuffer;
  /** Build and maintain the rollups. Off only in tests that want the raw path. */
  rollups: boolean;
  /** Expose `__spin` (burn N ms of this thread) — test builds only. */
  testHooks?: boolean;
}

export type WorkerRequest =
  | { type: "call"; id: number; method: MetricsReadMethod | "__spin"; arg: unknown }
  | { type: "close" };

export type WorkerReply =
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; message: string; aborted: boolean }
  | { type: "closed" };

/** Thrown at a statement boundary when the running request was abandoned. */
class Abandoned extends Error {}

/** A read-only StateDb whose every statement first checks the abort cell. */
class AbortableDb extends StateDb {
  current = 0;
  constructor(
    root: string,
    private readonly cell: Int32Array,
  ) {
    super(root, { readOnly: true });
  }
  override prepare(sql: string): StatementSync {
    if (this.current !== 0 && Atomics.load(this.cell, 0) === this.current) throw new Abandoned();
    return super.prepare(sql);
  }
}

const data = workerData as MetricsWorkerData;
const port = parentPort!;
const cell = new Int32Array(data.abort);
const reads = new AbortableDb(data.root, cell);
const methods = createReadMethods({
  // flushMs 0: never armed. This instance only ever reads; its write buffers
  // stay empty, so the `flush()` at the top of every read is a no-op here. The
  // MAIN thread flushes before it sends a request (see MetricsReader.call).
  metrics: new MetricsService({ db: reads, flushMs: 0 }),
  tokens: new TokenLedger(reads),
  limits: new LimitLedger(reads),
});

const rollupDb = data.rollups ? new StateDb(data.root) : null;
const builder = rollupDb ? new RollupBuilder(rollupDb) : null;
let timer: ReturnType<typeof setTimeout> | null = null;
let closing = false;

/**
 * The build loop: one bounded step at a time, re-scheduled through the timer
 * queue so requests that arrived meanwhile are served between steps. Caught
 * up, it sleeps until the next hour is sealable — but no longer than 15 s, so
 * a change to an already-sealed hour (a span closing late) is recomputed
 * promptly even when nobody is looking at Metrics.
 */
function schedule(delay: number): void {
  if (!builder || closing) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delay);
}

function tick(): void {
  timer = null;
  if (!builder || closing) return;
  try {
    const more = builder.step();
    schedule(more ? 0 : Math.min(15_000, builder.msUntilNextSeal()));
  } catch (err) {
    // A locked file, a full disk: reads fall back to raw rows whatever state
    // the rollup is in, so the only cost of backing off is staying slow longer.
    console.error("[Dispatch] metrics rollup step failed:", err);
    schedule(60_000);
  }
}

/** Bring dirty hours current before a read, so the read can use the rollup
 * instead of falling back to raw rows for the whole window. Bounded: a burst
 * of late writes must not hold a request hostage. */
function settleDirty(): void {
  if (!builder) return;
  try {
    for (let i = 0; i < 4 && builder.hasDirty(); i++) builder.processDirty();
  } catch (err) {
    console.error("[Dispatch] metrics rollup refresh failed:", err);
  }
}

/** Test hook: hold this thread for `ms`, honouring the abort cell the way a
 * statement boundary does — so the abort path is testable without a ledger
 * big enough to make a real read slow. */
function spin(ms: number, id: number): number {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) {
    if ((++n & 0xffff) === 0 && Atomics.load(cell, 0) === id) throw new Abandoned();
  }
  return n;
}

port.on("message", (msg: WorkerRequest) => {
  if (msg.type === "close") {
    closing = true;
    if (timer) clearTimeout(timer);
    reads.close();
    rollupDb?.close();
    port.postMessage({ type: "closed" } satisfies WorkerReply);
    // Dropping the port's last ref is what lets this thread exit on its own.
    port.close();
    return;
  }
  const { id, method, arg } = msg;
  reads.current = id;
  try {
    let value: unknown;
    if (method === "__spin") {
      if (!data.testHooks) throw new Error("unknown metrics method: __spin");
      value = spin(Number(arg), id);
    } else {
      const fn = methods[method] as ((a: unknown) => unknown) | undefined;
      if (!fn) throw new Error(`unknown metrics method: ${String(method)}`);
      settleDirty();
      value = fn(arg);
    }
    port.postMessage({ type: "result", id, value } satisfies WorkerReply);
  } catch (err) {
    port.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
      aborted: err instanceof Abandoned,
    } satisfies WorkerReply);
  } finally {
    reads.current = 0;
  }
});

schedule(0);
