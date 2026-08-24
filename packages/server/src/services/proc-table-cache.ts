/**
 * One process-table read, shared by everything that needs one.
 *
 * WHY. Enumerating the process table costs ~800 ms on Windows — a
 * `powershell.exe` spawn (~400 ms of it pure startup) plus a CIM query over ~900
 * processes. Two services now want that table on overlapping schedules: the
 * sidebar's per-chat process COUNT every 30 s, and the resource snapshot behind
 * the header widget and the Resources page. Each holding its own cache would
 * double the spawns for data that is byte-for-byte the same read, and the whole
 * point of the resource feature is to REDUCE load on a box that is already
 * struggling. A monitor that becomes the thing being monitored is worse than no
 * monitor.
 *
 * So the table is cached HERE, once, and both services take a reader off it.
 *
 * FRESHNESS IS A CALLER'S CHOICE. `read()` serves the cache; `read(true)` forces
 * a scan and is what a KILL path must use. Killing by pid off a ten-second-old
 * table risks signalling a pid the OS has since recycled onto somebody else's
 * process, which is why `ChatProcessService.pidsFor` never touched a cache
 * before this existed and must not start now.
 */
import { defaultProcTable, type ProcRow, type ProcTableFn } from "./processes.js";

export interface ProcTableCacheDeps {
  /** The underlying scan. Defaults to the real one; injected in tests. */
  read?: ProcTableFn;
  /** Injectable clock (tests). */
  now?: () => number;
  /** How long a scan stays fresh. See {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

/**
 * How long one scan is reused.
 *
 * Matches what `ChatProcessService` used when it owned its own cache. The
 * sidebar polls at 30 s and the resource views at 5 s; 10 s means the faster of
 * the two paces the scanning and the slower one rides along free, while a kill
 * is still reflected within a blink because it invalidates rather than waits.
 */
const DEFAULT_TTL_MS = 10_000;

/** A table and when it was taken. */
export interface ProcTableSnapshot {
  rows: ProcRow[];
  at: number;
}

export class ProcTableCache {
  private readonly source: ProcTableFn;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private cached?: ProcTableSnapshot;
  /** The scan in flight, so N concurrent callers cause ONE spawn. */
  private inFlight?: Promise<ProcTableSnapshot>;
  /** See `ChatProcessService.generation` — same hazard, same guard. */
  private generation = 0;

  constructor(deps: ProcTableCacheDeps = {}) {
    this.source = deps.read ?? defaultProcTable;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * The table, from cache when it is fresh enough.
   *
   * @param fresh Bypass the cache and scan now. For kill paths only — see the
   *   module note on pid reuse.
   */
  async read(fresh = false): Promise<ProcTableSnapshot> {
    if (fresh) {
      const rows = await this.source().catch(() => [] as ProcRow[]);
      const snap = { rows, at: this.now() };
      // A forced read still refreshes the cache when it actually found
      // something: it is strictly newer than whatever is there.
      if (rows.length > 0) this.cached = snap;
      return snap;
    }
    const hit = this.cached;
    if (hit && this.now() - hit.at < this.ttlMs) return hit;
    if (!this.inFlight) {
      const generation = this.generation;
      this.inFlight = this.scan(generation).finally(() => {
        if (generation === this.generation) this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Drop the cache so the next `read()` re-scans. Called after a kill. */
  invalidate(): void {
    this.cached = undefined;
    this.generation += 1;
    this.inFlight = undefined;
  }

  private async scan(generation: number): Promise<ProcTableSnapshot> {
    const rows = await this.source().catch(() => [] as ProcRow[]);
    // An empty table is a FAILED table, not a machine with no processes on it.
    // Serving it would tell every consumer that every chat holds nothing —
    // a plausible number, uniformly wrong. Keep the last real reading, and
    // don't cache the gap, so the next call retries instead of serving it for
    // a full TTL. (`ChatProcessService.scan` has the long-form version.)
    if (rows.length === 0) return this.cached ?? { rows: [], at: this.now() };
    const snap = { rows, at: this.now() };
    if (generation === this.generation) this.cached = snap;
    return snap;
  }
}
