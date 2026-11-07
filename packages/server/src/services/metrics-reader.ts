/**
 * The main thread's handle on the metrics worker (services/metrics-worker.ts):
 * the Metrics routes call `reader.call("spanTotals", query, signal)` and the
 * read runs on another thread, so a 7-day Runtime batch no longer freezes the
 * server for every other client.
 *
 * ONE worker, not a pool. SQLite serialises nothing between readers in WAL
 * mode, so more threads WOULD answer a batch in parallel — but each is a V8
 * isolate (tens of MB) with its own page cache, on a box that is already busy
 * running agents, and the rollups take the expensive reads from seconds to
 * tens of ms. What the worker had to buy was "the event loop never waits",
 * and one thread buys all of it. If batches ever queue visibly, this class is
 * the one place a pool would go.
 *
 * ONE REQUEST IN FLIGHT. The queue lives HERE, not in the worker's message
 * port: a request already posted can't be withdrawn, so a batch the client
 * abandoned would still run to the end. Holding the queue here means an
 * aborted request that hasn't started is dropped for free, and the one that
 * has is stopped at its next statement (the shared abort cell).
 *
 * FLUSH FIRST. The worker reads its own connection, which cannot see rows
 * still in `MetricsService`'s write buffer. Every call flushes that buffer
 * before queueing, so a read sees everything recorded before it was asked —
 * the guarantee the in-process reads gave by flushing at their top.
 *
 * NO ORPHANS. `dispose()` asks the worker to close its connections and exit,
 * and terminates it if it hasn't within a few seconds. A crash rejects what
 * was in flight and the next call starts a fresh worker; a worker that can't
 * start at all (no loader for a `.ts` entry, say) falls back to running the
 * same method table in-process, which is exactly the behaviour before this.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { StateDb } from "../store/db.js";
import type { MetricsService } from "./metrics.js";
import {
  createReadMethods,
  type MetricsReadDeps,
  type MetricsReadMethod,
  type MetricsReadMethods,
  type MetricsReadTable,
} from "./metrics-read-api.js";
import type { MetricsWorkerData, WorkerReply, WorkerRequest } from "./metrics-worker.js";

/** How long `dispose()` waits for a clean exit before terminating. */
const CLOSE_GRACE_MS = 3_000;
/** A worker that died this recently is not respawned for this long, so a
 * crash loop can't turn every request into a thread start. */
const RESPAWN_BACKOFF_MS = 2_000;

export interface MetricsReaderOptions extends MetricsReadDeps {
  /** The main thread's state database — opened (and migrated) before the
   * worker starts, since the worker's read-only handle never migrates. */
  db: StateDb;
  /** Run reads on a worker thread. False = in-process, the pre-worker path. */
  useWorker: boolean;
  /** Build the rollups in the worker. */
  rollups?: boolean;
  /** Expose the worker's `__spin` hook. Tests only. */
  testHooks?: boolean;
}

/** Rejection for a request abandoned by its caller. */
export class MetricsReadAborted extends Error {
  override name = "AbortError";
  constructor() {
    super("metrics read aborted");
  }
}

interface Job {
  id: number;
  method: MetricsReadMethod | "__spin";
  arg: unknown;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export class MetricsReader {
  private worker: Worker | null = null;
  private readonly cell = new SharedArrayBuffer(4);
  private readonly abortCell = new Int32Array(this.cell);
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private nextId = 1;
  private disposed = false;
  private diedAt = 0;
  private fallback: MetricsReadTable | null = null;
  private exited: Promise<void> | null = null;
  private readonly metrics: MetricsService;

  constructor(private readonly opts: MetricsReaderOptions) {
    this.metrics = opts.metrics;
    if (!opts.useWorker) this.fallback = createReadMethods(opts);
  }

  /** Whether reads currently go to a worker thread (for tests and stats). */
  get onWorker(): boolean {
    return this.worker !== null;
  }

  /** The worker's thread id, while one is running. */
  get threadId(): number | null {
    return this.worker?.threadId ?? null;
  }

  /** Start the worker now (rather than on first read), so the rollup build
   * begins at boot. Safe to call more than once. */
  start(): void {
    if (this.fallback || this.disposed || this.worker) return;
    this.spawn();
  }

  call<K extends MetricsReadMethod>(
    method: K,
    arg: MetricsReadMethods[K][0],
    signal?: AbortSignal,
  ): Promise<MetricsReadMethods[K][1]> {
    return this.enqueue(method, arg, signal) as Promise<MetricsReadMethods[K][1]>;
  }

  /** Burn `ms` of the worker's thread. Tests only (needs `testHooks`). */
  spin(ms: number, signal?: AbortSignal): Promise<number> {
    return this.enqueue("__spin", ms, signal) as Promise<number>;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.queue.splice(0)) this.settle(job, new Error("metrics reader disposed"));
    const worker = this.worker;
    if (!worker) return;
    const exited = this.exited;
    worker.postMessage({ type: "close" } satisfies WorkerRequest);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CLOSE_GRACE_MS);
    });
    // A read in progress finishes its current statement first; past the grace
    // window the thread is terminated, which SQLite survives (WAL makes an
    // interrupted reader harmless) and an orphaned thread would not.
    if ((await Promise.race([exited, timedOut])) === "timeout") await worker.terminate();
    clearTimeout(timer);
  }

  /* ------------------------------------------------------------- internals */

  private enqueue(method: Job["method"], arg: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new MetricsReadAborted());
    if (this.disposed) return Promise.reject(new Error("metrics reader disposed"));
    // Before anything else: the worker's connection can't see the buffer.
    if (method !== "__spin") this.metrics.flush();
    if (this.fallback) return this.runInProcess(method, arg);
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, method, arg, signal, resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => this.abort(job);
        signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private async runInProcess(method: Job["method"], arg: unknown): Promise<unknown> {
    if (method === "__spin") throw new Error("unknown metrics method: __spin");
    const fn = this.fallback![method] as (a: unknown) => unknown;
    return fn(arg);
  }

  private abort(job: Job): void {
    const i = this.queue.indexOf(job);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.settle(job, new MetricsReadAborted());
      return;
    }
    // Running: the worker checks this cell before every statement it prepares.
    if (this.running === job) Atomics.store(this.abortCell, 0, job.id);
  }

  private pump(): void {
    if (this.running || this.queue.length === 0 || this.disposed) return;
    if (!this.worker) {
      const wait = this.diedAt + RESPAWN_BACKOFF_MS - Date.now();
      if (wait > 0) {
        setTimeout(() => this.pump(), wait).unref?.();
        return;
      }
      this.spawn();
      if (this.fallback) {
        // Spawn failed outright: drain what's queued in-process.
        for (const job of this.queue.splice(0)) {
          this.runInProcess(job.method, job.arg).then(
            (v) => this.settle(job, null, v),
            (e: unknown) => this.settle(job, e instanceof Error ? e : new Error(String(e))),
          );
        }
        return;
      }
    }
    const job = this.queue.shift()!;
    this.running = job;
    this.worker!.postMessage({ type: "call", id: job.id, method: job.method, arg: job.arg } satisfies WorkerRequest);
  }

  private settle(job: Job, err: Error | null, value?: unknown): void {
    job.cleanup();
    if (err) job.reject(err);
    else job.resolve(value);
  }

  private spawn(): void {
    const data: MetricsWorkerData = {
      root: this.opts.db.root,
      abort: this.cell,
      rollups: this.opts.rollups ?? true,
      testHooks: this.opts.testHooks,
    };
    let worker: Worker;
    try {
      // The worker's handle is read-only and refuses a schema it doesn't
      // match, so the owner migrates first.
      this.opts.db.open();
      const { url, execArgv } = workerEntry();
      worker = new Worker(url, { workerData: data, ...(execArgv ? { execArgv } : {}) });
    } catch (err) {
      console.error("[Dispatch] metrics worker unavailable; reading in-process:", err);
      this.fallback = createReadMethods(this.opts);
      return;
    }
    // Never hold the process open for metrics. dispose() still ends it.
    worker.unref();
    this.worker = worker;
    Atomics.store(this.abortCell, 0, 0);
    worker.on("message", (msg: WorkerReply) => this.onReply(msg));
    worker.on("error", (err) => console.error("[Dispatch] metrics worker error:", err));
    this.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        if (this.worker === worker) this.worker = null;
        const running = this.running;
        this.running = null;
        if (!this.disposed) {
          this.diedAt = Date.now();
          console.error(`[Dispatch] metrics worker exited (code ${code}); restarting on next read.`);
        }
        if (running) this.settle(running, new Error("metrics worker exited"));
        if (this.disposed) {
          for (const job of this.queue.splice(0)) this.settle(job, new Error("metrics reader disposed"));
        } else this.pump();
        resolve();
      });
    });
  }

  private onReply(msg: WorkerReply): void {
    if (msg.type === "closed") return;
    const job = this.running;
    if (!job || job.id !== msg.id) return;
    this.running = null;
    if (msg.type === "result") this.settle(job, null, msg.value);
    else this.settle(job, msg.aborted ? new MetricsReadAborted() : new Error(msg.message));
    this.pump();
  }
}

/**
 * Where the worker's entry lives, and how to load it.
 *
 * Built (`dist/*.js`), it is a sibling `.js` file and needs nothing. From
 * source it is a `.ts` file: under `tsx watch` (pnpm dev) the thread inherits
 * tsx's loader through `process.execArgv`, but under vitest there is no such
 * flag to inherit, so tsx's loader is passed explicitly.
 */
function workerEntry(): { url: URL; execArgv?: string[] } {
  const here = import.meta.url;
  if (!here.endsWith(".ts")) return { url: new URL("./metrics-worker.js", here) };
  const url = new URL("./metrics-worker.ts", here);
  if (process.execArgv.some((a) => a.includes("tsx"))) return { url };
  const loader = pathToFileURL(createRequire(here).resolve("tsx")).href;
  return { url, execArgv: [...process.execArgv, "--import", loader] };
}
