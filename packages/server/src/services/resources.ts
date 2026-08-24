/**
 * ResourceService — what Dispatch is costing this machine, and which chat is
 * costing it.
 *
 * THE PROBLEM IT ANSWERS. The sidebar already shows how MANY processes a chat
 * holds, which turned out to be the wrong question: nine cheap processes and
 * nine expensive ones render identically. What actually maxes a box is a couple
 * of chats sitting on multi-gigabyte trees, and there was no way to see which.
 * Measured on a live install, Dispatch's own tree was 349 of the machine's 888
 * processes and 20.3 GB of working set — against a server process that was
 * itself 362 MB. Essentially all of it is chats, and none of it was visible.
 *
 * ── THREE SCOPES, AND ONLY ONE OF THEM IS CHEAP ──────────────────────────────
 *
 * SYSTEM is free: `os.cpus()` and `os.freemem()` are in-process reads that
 * measured 0.2 ms with no subprocess at all. That is what the header widget
 * runs on, which is why it can tick every second without being the load.
 *
 * DISPATCH and PER-CHAT both need the process table, at ~800 ms a scan. They
 * share ONE read via {@link ProcTableCache} — including with the sidebar's
 * existing count poll, so this whole feature adds no scans to a box that is
 * already busy. This is the central performance constraint: the poll cadence
 * lives in the client, and the server's job is to make sure that however often
 * it is asked, it scans at most once per TTL.
 *
 * ── CPU IS A DELTA, WHICH MAKES IT STATEFUL ──────────────────────────────────
 *
 * `Win32_Process` reports CUMULATIVE CPU time, so a percentage cannot come from
 * one reading. This service keeps the previous sample and differences against
 * it, which has two consequences worth stating rather than hiding:
 *
 *   1. The FIRST snapshot after startup has no percentages at all. They are
 *      `null`, not 0 — a real 0 means "measured, idle", and showing that for
 *      "not yet measured" is the reading that makes someone stop looking.
 *   2. The window is however long since the last call, because sampling is
 *      DEMAND-DRIVEN. Nothing runs on a timer here; a standing sampler would
 *      burn a `powershell.exe` spawn every few seconds forever, on a machine
 *      whose problem is that it is out of headroom. So `windowMs` is reported
 *      with the snapshot and the UI shows it — a percentage over an undisclosed
 *      interval is not a measurement.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * GPU. Per-process GPU on Windows costs four seconds via `Get-Counter
 * "\GPU Engine(*)"`, and measured ≤0.09% across every process on the box —
 * agent workloads are CPU and memory bound, and the GPU consumers are the
 * browser and the compositor. `nvidia-smi` is fast but reports `[N/A]` for
 * per-process memory under WDDM, so there is no cheap path either. Dropped on
 * purpose; the numbers are in `parseProcCsv`'s note so nobody re-derives them.
 */
import os from "node:os";
import type {
  ChatProcessDetail,
  ChatProcessSample,
  ChatResources,
  DispatchResources,
  ResourceSnapshot,
  SystemResources,
} from "@dispatch/shared";
import type { ProcRow, TerminalRoots } from "./processes.js";
import type { ProcTableCache } from "./proc-table-cache.js";

export interface ResourceDeps {
  /** The shared table read. See {@link ProcTableCache}. */
  procTable: ProcTableCache;
  /** Live session roots, as `chatId → pid`. Usually `broker.sessionPids()`. */
  sessionPids: () => Map<string, number>;
  /** Live shells and who owns them. Omitted → session roots only. */
  terminals?: TerminalRoots;
  /** The server's own pid — the root of the Dispatch tree. */
  serverPid?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable `os` reads (tests). */
  cpus?: () => os.CpuInfo[];
  freemem?: () => number;
  totalmem?: () => number;
}

/** The previous per-process reading, kept so the next one can be a rate. */
interface CpuSample {
  /** pid → cumulative ms. */
  byPid: Map<number, number>;
  at: number;
}

/**
 * The previous whole-machine reading.
 *
 * SEPARATE from {@link CpuSample} because the two are sampled on different
 * clocks: the header widget calls {@link ResourceService.system} every second
 * or so, while the process table behind a snapshot is scanned at most once per
 * cache TTL. Sharing one baseline would mean the header's CPU figure was
 * averaged over however long ago the last full snapshot was — smoothed to
 * uselessness exactly when a spike is what you are watching for.
 */
interface SysSample {
  idle: number;
  total: number;
}

/**
 * Below this, a CPU delta is noise.
 *
 * Two scans 40 ms apart divide a scheduling quantum by a near-zero window and
 * produce percentages in the hundreds for processes that did nothing. Rather
 * than emit a number that is certainly wrong, report `null` — the same "not
 * measured" the first snapshot uses — and let the next poll produce a real one.
 */
const MIN_WINDOW_MS = 250;

export class ResourceService {
  private readonly procTable: ProcTableCache;
  private readonly sessionPids: () => Map<string, number>;
  private readonly terminals?: TerminalRoots;
  private readonly serverPid: number;
  private readonly now: () => number;
  private readonly cpus: () => os.CpuInfo[];
  private readonly freemem: () => number;
  private readonly totalmem: () => number;

  private previous?: CpuSample;
  private sysPrevious?: SysSample;

  constructor(deps: ResourceDeps) {
    this.procTable = deps.procTable;
    this.sessionPids = deps.sessionPids;
    this.terminals = deps.terminals;
    this.serverPid = deps.serverPid ?? process.pid;
    this.now = deps.now ?? (() => Date.now());
    this.cpus = deps.cpus ?? (() => os.cpus());
    this.freemem = deps.freemem ?? (() => os.freemem());
    this.totalmem = deps.totalmem ?? (() => os.totalmem());
  }

  /**
   * The whole machine, with NO process table read.
   *
   * Split out because the header widget only ever wants this, and it is four
   * orders of magnitude cheaper than the rest of the snapshot — 0.2 ms of
   * in-process `os` reads against ~800 ms of `powershell.exe`. That gap is the
   * whole reason the widget can update every second while the Resources page
   * cannot.
   *
   * Advances its OWN baseline, so the window is the gap between consecutive
   * `system()` calls — see {@link SysSample}.
   */
  system(): SystemResources {
    const cores = this.cpus();
    const { idle, total } = sumCpuTicks(cores);
    const prev = this.sysPrevious;
    this.sysPrevious = { idle, total };
    // These are tick COUNTS accumulated across every core, so the ratio is the
    // busy fraction of the machine as a whole, not of one core.
    const dIdle = prev ? idle - prev.idle : 0;
    const dTotal = prev ? total - prev.total : 0;
    const totalBytes = this.totalmem();
    const freeBytes = this.freemem();
    return {
      // No previous sample (or a suspiciously backwards one, which a counter
      // wrap would give) means not measured — not idle.
      cpuPct: dTotal > 0 && dIdle >= 0 ? clampPct(100 * (1 - dIdle / dTotal)) : null,
      logicalCores: cores.length,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  }

  /**
   * Everything: system, Dispatch's tree, and every chat.
   *
   * Reads the shared table (cached), differences the CPU counters against the
   * previous call, then REPLACES the baseline. One baseline serves both this
   * and {@link system} because both are driven by the same client poll — a
   * reading always differences against whatever was measured last, whichever
   * entry point took it, and `windowMs` says which that was.
   */
  async snapshot(): Promise<ResourceSnapshot> {
    const { rows } = await this.procTable.read();
    const at = this.now();
    const prev = this.previous;
    const windowMs = prev ? at - prev.at : 0;
    // A window too short to divide by yields no rates at all rather than
    // fabricated ones. Note this still records a new baseline below, so the
    // NEXT call gets a clean window instead of inheriting the bad one.
    const usable = windowMs >= MIN_WINDOW_MS;

    const system = this.system();
    const byPid = new Map(rows.map((r) => [r.pid, r]));

    /** Cumulative-ms delta for one pid, as a percent of one core. */
    const cpuOf = (pid: number): number | null => {
      if (!usable || !prev) return null;
      const cur = byPid.get(pid)?.cpuMs;
      const was = prev.byPid.get(pid);
      // A pid absent from the previous sample is NEW. Its lifetime CPU is not
      // this window's, and charging it here would show a just-spawned `tsc` at
      // several thousand percent.
      if (cur === undefined || was === undefined) return null;
      // Negative means pid reuse: the number went backwards because this is a
      // different process wearing a recycled id. Discard rather than report.
      const delta = cur - was;
      if (delta < 0) return null;
      return clampPct((100 * delta) / windowMs, 100 * system.logicalCores);
    };

    const children = childMap(rows);
    const sessionRoots = this.sessionRootsByChat();
    const allRoots = this.rootsByChat();

    const chats: ChatResources[] = [];
    for (const [chatId, roots] of allRoots) {
      const sessionPids = descendantsOf(sessionRoots.get(chatId) ?? [], children);
      const allPids = descendantsOf(roots, children);
      // Shells = everything the chat holds that its session subtree doesn't, so
      // a shell the session itself started is attributed once, to the session.
      const shellPids = [...allPids].filter((p) => !sessionPids.has(p));
      const session = tally(sessionPids, byPid, cpuOf);
      const shells = tally(shellPids, byPid, cpuOf);
      if (session.procs === 0 && shells.procs === 0) continue;
      chats.push({
        chatId,
        procs: session.procs + shells.procs,
        rssBytes: session.rssBytes + shells.rssBytes,
        cpuPct: addRates(session.cpuPct, shells.cpuPct),
        session,
        shells,
      });
    }
    chats.sort((a, b) => b.rssBytes - a.rssBytes || b.procs - a.procs);

    // Recorded even when the window was unusable, so the NEXT call differences
    // against something recent rather than inheriting the too-short gap.
    this.previous = {
      byPid: new Map(
        rows.flatMap((r): [number, number][] => (r.cpuMs === undefined ? [] : [[r.pid, r.cpuMs]])),
      ),
      at,
    };

    return {
      system,
      dispatch: this.dispatchTree(rows, byPid, children, cpuOf, chats),
      chats,
      at,
      windowMs: usable ? windowMs : 0,
    };
  }

  /** Every process one chat holds, individually. The drill-down. */
  async chatDetail(chatId: string): Promise<ChatProcessDetail> {
    const { rows } = await this.procTable.read();
    const at = this.now();
    const prev = this.previous;
    const windowMs = prev ? at - prev.at : 0;
    const usable = windowMs >= MIN_WINDOW_MS;
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const cores = this.cpus().length;
    const cpuOf = (pid: number): number | null => {
      if (!usable || !prev) return null;
      const cur = byPid.get(pid)?.cpuMs;
      const was = prev.byPid.get(pid);
      if (cur === undefined || was === undefined) return null;
      const delta = cur - was;
      if (delta < 0) return null;
      return clampPct((100 * delta) / windowMs, 100 * cores);
    };

    const children = childMap(rows);
    const sessionPids = descendantsOf(this.sessionRootsByChat().get(chatId) ?? [], children);
    const allPids = descendantsOf(this.rootsByChat().get(chatId) ?? [], children);

    // Deliberately does NOT advance the baseline. This is a drill-down opened
    // alongside the snapshot poll; consuming the delta here would leave the
    // main view with a near-zero window and blank its whole CPU column.
    const procs: ChatProcessSample[] = [...allPids].flatMap((pid) => {
      const row = byPid.get(pid);
      if (!row) return [];
      return [
        {
          pid,
          ppid: row.ppid,
          name: row.name,
          rssBytes: row.rssBytes ?? 0,
          cpuPct: cpuOf(pid),
          kind: sessionPids.has(pid) ? ("session" as const) : ("shell" as const),
        },
      ];
    });
    procs.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
    return { chatId, procs, at, windowMs: usable ? windowMs : 0 };
  }

  /**
   * Dispatch's whole footprint, rooted at the server process.
   *
   * One subtree walk covers everything, because every session and every
   * background shell is spawned as a descendant of the server — verified on a
   * live install, where the server's tree held all 12 live `claude.exe` sessions
   * and all 32 shells. The DB needs no separate accounting: `node:sqlite` is
   * IN-PROCESS, so it is already inside the server's own resident set.
   */
  private dispatchTree(
    rows: ProcRow[],
    byPid: Map<number, ProcRow>,
    children: Map<number, number[]>,
    cpuOf: (pid: number) => number | null,
    chats: ChatResources[],
  ): DispatchResources | null {
    // Absent rather than zeroed when the server can't be found in the table:
    // a scan that failed, or a pid the table doesn't list, must not render as
    // "Dispatch is using nothing".
    if (!byPid.has(this.serverPid)) return null;
    const treePids = descendantsOf([this.serverPid], children);
    const tree = tally(treePids, byPid, cpuOf);
    const server = byPid.get(this.serverPid);

    // Chats can hold processes OUTSIDE the server tree (a session the server
    // adopted across a restart), so subtract only what the tree actually
    // contains — otherwise `unattributed` could go negative and read as a bug.
    const inTree = { procs: 0, rssBytes: 0 };
    for (const chat of chats) {
      const roots = this.rootsByChat().get(chat.chatId) ?? [];
      for (const pid of descendantsOf(roots, children)) {
        if (!treePids.has(pid)) continue;
        inTree.procs += 1;
        inTree.rssBytes += byPid.get(pid)?.rssBytes ?? 0;
      }
    }

    return {
      pid: this.serverPid,
      procs: tree.procs,
      rssBytes: tree.rssBytes,
      cpuPct: tree.cpuPct,
      serverRssBytes: server?.rssBytes ?? 0,
      serverCpuPct: cpuOf(this.serverPid),
      unattributed: {
        procs: Math.max(0, tree.procs - inTree.procs),
        rssBytes: Math.max(0, tree.rssBytes - inTree.rssBytes),
      },
    };
  }

  /** `chatId → session root pid`, the half an idle sweep retires. */
  private sessionRootsByChat(): Map<string, number[]> {
    const roots = new Map<string, number[]>();
    for (const [chatId, pid] of this.sessionPids()) {
      if (Number.isInteger(pid) && pid > 0) roots.set(chatId, [pid]);
    }
    return roots;
  }

  /** `chatId → root pids`, from both kinds of root. Mirrors ChatProcessService. */
  private rootsByChat(): Map<string, number[]> {
    const roots = new Map<string, number[]>();
    const add = (chatId: string, pid: number): void => {
      if (!Number.isInteger(pid) || pid <= 0) return;
      const list = roots.get(chatId);
      if (list) list.push(pid);
      else roots.set(chatId, [pid]);
    };
    for (const [chatId, pid] of this.sessionPids()) add(chatId, pid);
    for (const shell of this.terminals?.livePids() ?? []) add(shell.chatId, shell.pid);
    return roots;
  }
}

/* ------------------------------------------------------------------ helpers */

/** Summed idle and total tick counts across every core. */
function sumCpuTicks(cores: os.CpuInfo[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const core of cores) {
    for (const [key, value] of Object.entries(core.times)) {
      total += value;
      if (key === "idle") idle += value;
    }
  }
  return { idle, total };
}

/** pid → its children, from a flat table. */
function childMap(rows: readonly ProcRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    // A self-parented row (pid 0 reports itself on Windows) would make the
    // walk below its own child and never terminate without the `seen` guard;
    // dropping the edge here is cheaper than relying on it.
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return children;
}

/** `roots` plus every descendant, as a set. See `ChatProcessService`. */
function descendantsOf(roots: readonly number[], children: Map<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return seen;
}

/** Sum memory and CPU over a set of pids. */
function tally(
  pids: Iterable<number>,
  byPid: Map<number, ProcRow>,
  cpuOf: (pid: number) => number | null,
): { procs: number; rssBytes: number; cpuPct: number | null } {
  let procs = 0;
  let rssBytes = 0;
  let cpu: number | null = null;
  for (const pid of pids) {
    const row = byPid.get(pid);
    // A pid the table doesn't contain has exited between the roots being
    // listed and the scan landing. Not counted — it costs nothing now.
    if (!row) continue;
    procs += 1;
    rssBytes += row.rssBytes ?? 0;
    cpu = addRates(cpu, cpuOf(pid));
  }
  return { procs, rssBytes, cpuPct: cpu };
}

/**
 * Add two rates where `null` means "not measured".
 *
 * `null + 5` is 5, not null: one unmeasurable process in a tree of nine must not
 * blank the whole tree's figure. But `null + null` stays null, so a tree nothing
 * could be measured for still reports honestly rather than claiming 0%.
 */
function addRates(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Keep a computed percentage inside the range it can physically occupy. */
function clampPct(pct: number, max = 100): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(max, pct));
}
