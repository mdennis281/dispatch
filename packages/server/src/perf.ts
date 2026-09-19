/**
 * Event-loop health, measured from inside the process and written somewhere a
 * human can read it afterwards.
 *
 * WHY. On 2026-09-19 the installed app 503'd for everyone through HAProxy for
 * most of an evening. `/api/health` answered `ok` the whole time — it just took
 * 0.8–2.4 s to do so, because the loop was stalling on synchronous work (see
 * `services/exec-binary.ts`), and HAProxy's check timed out. Nothing in the
 * process measured the loop, the supervisor discards stdout, and the only
 * on-disk record was `crash.log`, which had nothing to say because nothing
 * crashed. Diagnosis needed a live CPU profile. This module exists so the next
 * stall is named by the server itself: how long the loop was gone, and which
 * spawns were on it at the time.
 *
 * Two outputs:
 *   - {@link perfSnapshot} — the current window's lag percentiles and spawn
 *     account, returned on `/api/health` so a slow probe carries its own reason.
 *   - `<dataDir>/perf.log` — one line per minute-window whose lag crossed the
 *     thresholds below. Rotated once past {@link PERF_LOG_MAX_BYTES}. Quiet
 *     windows write nothing, so an idle server never grows the file.
 */
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { execStats, resetExecStats, type ExecStat } from "./services/exec-binary.js";

/** How often the window rolls and (if warranted) a log line is written. */
export const PERF_WINDOW_MS = 60_000;
/** A window whose p99 loop delay crosses this is logged. */
export const PERF_LOG_P99_MS = 250;
/** A window with ANY single stall past this is logged, whatever the p99. */
export const PERF_LOG_MAX_MS = 1_000;
/** Rotate `perf.log` past this, keeping one generation as `perf.log.1`. */
export const PERF_LOG_MAX_BYTES = 1024 * 1024;
export const PERF_LOG_NAME = "perf.log";

export interface LoopLag {
  /** Window start, ms epoch. */
  since: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface PerfSnapshot {
  loop: LoopLag;
  /** Spawn cost per command family in the same window, worst first. */
  exec: ExecStat[];
  /**
   * The last window that crossed a threshold, so a probe that arrives after
   * the stall — the usual case, since the stall is what delayed it — still
   * carries the evidence.
   */
  lastStall?: { loop: LoopLag; exec: ExecStat[] };
}

let histogram: IntervalHistogram | null = null;
let windowStart = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let lastStall: PerfSnapshot["lastStall"];
let logFile: string | null = null;
let logging: Promise<void> = Promise.resolve();

const ms = (ns: number): number => Math.round(ns / 1e6);

function readLoop(): LoopLag {
  if (!histogram) return { since: windowStart, p50Ms: 0, p99Ms: 0, maxMs: 0 };
  return {
    since: windowStart,
    p50Ms: ms(histogram.percentile(50)),
    p99Ms: ms(histogram.percentile(99)),
    maxMs: ms(histogram.max),
  };
}

/** Current window, without rolling it. Undefined until {@link startPerfMonitor}. */
export function perfSnapshot(): PerfSnapshot | undefined {
  if (!histogram) return undefined;
  return {
    loop: readLoop(),
    exec: execStats(),
    ...(lastStall ? { lastStall } : {}),
  };
}

/** One human-readable line for a window that crossed a threshold. */
export function formatStallLine(loop: LoopLag, exec: ExecStat[], now = Date.now()): string {
  const top = exec
    .slice(0, 5)
    .map((e) => `${e.file}×${e.count} sync=${e.syncMs}ms max=${e.maxSyncMs}ms wall=${e.wallMs}ms`)
    .join("; ");
  return (
    `[${new Date(now).toISOString()}] loop stall: p50=${loop.p50Ms}ms p99=${loop.p99Ms}ms ` +
    `max=${loop.maxMs}ms over ${Math.round((now - loop.since) / 1000)}s` +
    (top ? ` — spawns: ${top}` : " — no spawns in window")
  );
}

async function rotateIfLarge(file: string): Promise<void> {
  try {
    const { size } = await stat(file);
    if (size > PERF_LOG_MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    /* absent, or a rotation race — either way the append below still works */
  }
}

function rollWindow(): void {
  if (!histogram) return;
  const loop = readLoop();
  const exec = execStats();
  histogram.reset();
  resetExecStats();
  windowStart = Date.now();
  if (loop.p99Ms < PERF_LOG_P99_MS && loop.maxMs < PERF_LOG_MAX_MS) return;
  lastStall = { loop, exec };
  const file = logFile;
  if (!file) return;
  const line = formatStallLine(loop, exec);
  // Serialised so a rotation never interleaves with an append; best-effort so
  // a full disk can never take the server down over its own diagnostics.
  logging = logging
    .then(() => rotateIfLarge(file))
    .then(() => appendFile(file, line + "\n", "utf8"))
    .catch(() => undefined);
}

/**
 * Start sampling. Idempotent — the tests build many apps in one process and
 * only one histogram should ever run. `dataDir` decides where `perf.log` goes;
 * omit it (tests) to measure without writing.
 */
export function startPerfMonitor(opts: { dataDir?: string; windowMs?: number } = {}): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  windowStart = Date.now();
  logFile = opts.dataDir ? join(opts.dataDir, PERF_LOG_NAME) : null;
  timer = setInterval(rollWindow, opts.windowMs ?? PERF_WINDOW_MS);
  // Never the reason the process stays up.
  timer.unref();
}

/** Stop sampling and forget everything — the test seam. */
export function stopPerfMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
  lastStall = undefined;
  logFile = null;
}

/** Test seam: roll the window now instead of waiting for the interval. */
export function rollPerfWindowForTest(): void {
  rollWindow();
}

/** Test seam: wait for any in-flight log write. */
export function flushPerfLog(): Promise<void> {
  return logging;
}
