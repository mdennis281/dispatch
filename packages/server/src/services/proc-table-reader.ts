/**
 * Reading the process table on Windows WITHOUT starting PowerShell every time.
 *
 * WHY. The CIM query itself is cheap; starting `powershell.exe` is not.
 * Measured on a live install (~1,250 processes): the query run inside an
 * already-running PowerShell took ~850 ms, and the same query in a fresh
 * `powershell.exe -Command …` took ~3,000 ms. The difference is pure startup,
 * paid on every read, and on a box that is already loaded it gets much worse:
 * `perf.log` recorded 24 spawned reads in one minute averaging 11 s of wall
 * time each. Now that the tracker sweeps in the background, paying that start
 * every sweep would make the monitor the load.
 *
 * So ONE PowerShell stays up with a piped stdin, the same way a chat's managed
 * shell does (`terminal.ts`), and each read writes the query plus a sentinel and
 * collects stdout up to it. Reads are serialized — the worker has one stdout.
 *
 * FAILURE IS NOT FATAL, AND NOT STICKY. A read that outlives its deadline kills
 * the worker (its next read starts a new one) and returns `[]`, which every
 * consumer already treats as "failed — keep the last real table". If the
 * worker cannot be kept alive at all, reads fall back to spawning per read,
 * which is what everything did before this existed.
 *
 * POSIX has no such problem: `ps` costs ~20 ms to spawn, so it is just called.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  PROC_TABLE_QUERY,
  PROC_TABLE_TIMEOUT_MS,
  defaultProcTable,
  parseProcCsv,
  posixProcTable,
  type ProcRow,
  type ProcTableFn,
} from "./processes.js";

/** The slice of a ChildProcess the worker drives — small so tests can fake it. */
export interface WorkerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  pid?: number;
  kill(): boolean;
  on(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface ProcTableReader {
  /** One table read. Never rejects; a failed read is `[]`. */
  read: ProcTableFn;
  /** The worker's pid, so the tracker can leave it out of "unattributed". */
  workerPid(): number | undefined;
  /** Stop the worker. Reads after this fall back to a spawn. */
  dispose(): void;
}

export interface ReaderOptions {
  /** Starts the worker. Injected in tests. */
  spawn?: () => WorkerProcess;
  /** The per-spawn fallback. Injected in tests. */
  fallback?: ProcTableFn;
  timeoutMs?: number;
  /** Worker deaths in a row before giving up on it for good. */
  maxFailures?: number;
}

/** Printed after the CSV so a read knows where its output ends. */
const SENTINEL = "__DISPATCH_PROC_TABLE_END__";

const defaultSpawn = (): WorkerProcess =>
  nodeSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });

/** The platform's reader: a persistent PowerShell on Windows, `ps` elsewhere. */
export function createProcTableReader(opts: ReaderOptions = {}): ProcTableReader {
  if (process.platform !== "win32" && !opts.spawn) {
    return { read: () => posixProcTable().catch(() => []), workerPid: () => undefined, dispose() {} };
  }
  return new PowerShellTableReader(opts);
}

export class PowerShellTableReader implements ProcTableReader {
  private readonly spawnWorker: () => WorkerProcess;
  private readonly fallback: ProcTableFn;
  private readonly timeoutMs: number;
  private readonly maxFailures: number;

  private worker?: WorkerProcess;
  private buffer = "";
  /** The read waiting on the worker's output, if any. */
  private pending?: { lines: string[]; done: (rows: ProcRow[]) => void };
  /** Serializes reads: one worker, one stdout. */
  private queue: Promise<unknown> = Promise.resolve();
  private failures = 0;
  private disposed = false;

  constructor(opts: ReaderOptions = {}) {
    this.spawnWorker = opts.spawn ?? defaultSpawn;
    this.fallback = opts.fallback ?? defaultProcTable;
    this.timeoutMs = opts.timeoutMs ?? PROC_TABLE_TIMEOUT_MS;
    this.maxFailures = opts.maxFailures ?? 3;
  }

  read: ProcTableFn = () => {
    const next = this.queue.then(() => this.readOnce());
    this.queue = next.catch(() => {});
    return next;
  };

  workerPid(): number | undefined {
    return this.worker?.pid;
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
  }

  private async readOnce(): Promise<ProcRow[]> {
    if (this.disposed || this.failures >= this.maxFailures) {
      return this.fallback().catch(() => []);
    }
    const worker = this.ensureWorker();
    if (!worker?.stdin) return this.fallback().catch(() => []);
    return new Promise<ProcRow[]>((resolve) => {
      const timer = setTimeout(() => {
        // The worker is wedged (WMI under load, or a PowerShell that stopped
        // reading). Throw it away rather than queue the next read behind it.
        this.failures += 1;
        this.stopWorker();
        finish([]);
      }, this.timeoutMs);
      timer.unref?.();
      const finish = (rows: ProcRow[]): void => {
        clearTimeout(timer);
        if (this.pending?.done === finish) this.pending = undefined;
        resolve(rows);
      };
      this.pending = { lines: [], done: finish };
      try {
        worker.stdin!.write(`${PROC_TABLE_QUERY}; Write-Output '${SENTINEL}'\n`);
      } catch {
        this.failures += 1;
        this.stopWorker();
        finish([]);
      }
    });
  }

  private ensureWorker(): WorkerProcess | undefined {
    if (this.worker) return this.worker;
    let worker: WorkerProcess;
    try {
      worker = this.spawnWorker();
    } catch {
      this.failures += 1;
      return undefined;
    }
    this.worker = worker;
    this.buffer = "";
    worker.stdout?.setEncoding?.("utf8");
    worker.stdout?.on("data", (chunk: Buffer | string) => this.onData(worker, String(chunk)));
    const gone = (): void => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      // A worker that dies mid-read must not leave that read hanging until its
      // deadline — resolve it as failed now.
      if (this.pending) {
        this.failures += 1;
        this.pending.done([]);
      }
    };
    worker.on("exit", gone);
    worker.on("error", gone);
    // A pipe error on a worker that just died is reported here, not thrown.
    worker.stdin?.on?.("error", () => {});
    return worker;
  }

  private onData(worker: WorkerProcess, chunk: string): void {
    if (this.worker !== worker) return;
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      const pending = this.pending;
      if (!pending) continue;
      if (line.trim() === SENTINEL) {
        const rows = parseProcCsv(pending.lines.join("\n"));
        // Only a read that produced a table counts as the worker working.
        if (rows.length > 0) this.failures = 0;
        pending.done(rows);
      } else {
        pending.lines.push(line);
      }
    }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try {
      worker.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      worker.kill();
    } catch {
      /* already dead */
    }
  }
}
