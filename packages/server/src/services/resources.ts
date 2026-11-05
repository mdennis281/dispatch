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
 * DISPATCH and PER-CHAT both need the process table, and they read it from the
 * {@link ProcessTracker} — the same background sweep, and the same chat → pid
 * ownership, that the sidebar's count and the kill button use. So the CPU
 * figure on a chat and the process count beside it describe the SAME pids,
 * and nothing here ever waits on a scan unless a human pressed Reload.
 *
 * CPU IS A DELTA between two sweeps, which the tracker computes once per sweep
 * (see `ProcessTracker.rates`). `windowMs` is reported with the snapshot and
 * the UI shows it — a percentage over an undisclosed interval is not a
 * measurement. Figures that cannot be measured are `null`, not 0: a real 0
 * means "measured, idle".
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
  HotProcess,
  ResourceSnapshot,
  SystemResources,
} from "@dispatch/shared";
import type { ProcRow } from "./processes.js";
import {
  descendantsOf,
  type ProcessSnapshot,
  type ProcessTracker,
} from "./process-tracker.js";

export interface ResourceDeps {
  /** The shared background sweep. See {@link ProcessTracker}. */
  tracker: ProcessTracker;
  /** The server's own pid — the root of the Dispatch tree. */
  serverPid?: number;
  /**
   * Pids that are Dispatch's own machinery rather than anybody's work — the
   * tracker's persistent PowerShell reader — so they don't surface as an
   * "unattributed" leak in the tree.
   */
  infraPids?: () => Iterable<number | undefined>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable `os` reads (tests). */
  cpus?: () => os.CpuInfo[];
  freemem?: () => number;
  totalmem?: () => number;
}

/**
 * The previous whole-machine reading.
 *
 * Its own baseline, separate from the tracker's per-process one, because the
 * header widget calls {@link ResourceService.system} every second or so while
 * sweeps land every 15 s. Sharing one would average the header's CPU figure
 * over the sweep interval — smoothed to uselessness exactly when a spike is
 * what you are watching for.
 */
interface SysSample {
  idle: number;
  total: number;
  at: number;
}

export class ResourceService {
  private readonly tracker: ProcessTracker;
  private readonly serverPid: number;
  private readonly infraPids: () => Iterable<number | undefined>;
  private readonly now: () => number;
  private readonly cpus: () => os.CpuInfo[];
  private readonly freemem: () => number;
  private readonly totalmem: () => number;

  private sysPrevious?: SysSample;
  /** Last real whole-machine CPU reading; survives a zero-tick window. */
  private lastSysCpu: number | null = null;

  constructor(deps: ResourceDeps) {
    this.tracker = deps.tracker;
    this.serverPid = deps.serverPid ?? process.pid;
    this.infraPids = deps.infraPids ?? (() => []);
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
    // Rolling, for the same reason the per-process baseline is: the header
    // widget polls this every 2 s AND every `snapshot()` call goes through
    // here, so a consumed baseline would have the two starving each other.
    // A 1 s floor because this is the number someone watches tick; the
    // per-process rates use the coarser per-scan memo in `rates`.
    if (!prev || this.now() - prev.at >= 1_000) {
      this.sysPrevious = { idle, total, at: this.now() };
    }
    // These are tick COUNTS accumulated across every core, so the ratio is the
    // busy fraction of the machine as a whole, not of one core.
    const dIdle = prev ? idle - prev.idle : 0;
    const dTotal = prev ? total - prev.total : 0;
    const totalBytes = this.totalmem();
    const freeBytes = this.freemem();
    // No previous sample (or a suspiciously backwards one, which a counter wrap
    // would give) means not measured — not idle.
    if (dTotal > 0 && dIdle >= 0) {
      this.lastSysCpu = clampPct(100 * (1 - dIdle / dTotal));
    }
    return {
      // Two callers land here on different clocks — the header widget every 2 s
      // and every `snapshot()` — so they occasionally read in the same
      // millisecond and the second one finds no ticks to divide. Serving the
      // last real figure rather than `null` is what stops the page's CPU tile
      // flickering to "—" while the header beside it reads 11%. Still `null`
      // until the very first measurement, which is honestly unmeasured.
      cpuPct: this.lastSysCpu,
      logicalCores: cores.length,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  }

  /**
   * Everything: system, Dispatch's tree, and every chat.
   *
   * @param fresh Sweep now instead of serving the latest background sweep.
   *   For an explicit Reload only.
   */
  async snapshot(fresh = false): Promise<ResourceSnapshot> {
    const snap = await this.tracker.read(fresh);
    const system = this.system();
    const cpuOf = (pid: number): number | null => snap.cpuByPid.get(pid) ?? null;

    const chats: ChatResources[] = [];
    for (const [chatId, own] of snap.owners) {
      const session = tally(own.session, snap.byPid, cpuOf);
      const shells = tally(own.shells, snap.byPid, cpuOf);
      if (session.procs === 0 && shells.procs === 0) continue;
      chats.push({
        chatId,
        procs: session.procs + shells.procs,
        rssBytes: session.rssBytes + shells.rssBytes,
        cpuPct: addRates(session.cpuPct, shells.cpuPct),
        session,
        shells,
        hottest: hottestOf([...own.session, ...own.shells], snap.byPid, cpuOf),
      });
    }
    // Memory is the default ORDER on the wire; the client re-sorts by whichever
    // column the reader picked.
    chats.sort((a, b) => b.rssBytes - a.rssBytes || b.procs - a.procs);

    return {
      system,
      dispatch: this.dispatchTree(snap, cpuOf),
      chats,
      at: this.now(),
      windowMs: snap.windowMs,
    };
  }

  /** Every process one chat holds, individually. The drill-down. */
  async chatDetail(chatId: string): Promise<ChatProcessDetail> {
    const snap = await this.tracker.read();
    const cpuOf = (pid: number): number | null => snap.cpuByPid.get(pid) ?? null;
    const own = snap.owners.get(chatId);
    const procs: ChatProcessSample[] = own
      ? [...own.session, ...own.shells].flatMap((pid) => {
          const row = snap.byPid.get(pid);
          if (!row) return [];
          return [
            {
              pid,
              ppid: row.ppid,
              name: row.name,
              rssBytes: row.rssBytes ?? 0,
              cpuPct: cpuOf(pid),
              kind: own.session.has(pid) ? ("session" as const) : ("shell" as const),
            },
          ];
        })
      : [];
    procs.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
    return { chatId, procs, at: this.now(), windowMs: snap.windowMs };
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
    snap: ProcessSnapshot,
    cpuOf: (pid: number) => number | null,
  ): DispatchResources | null {
    // Absent rather than zeroed when the server can't be found in the table:
    // a scan that failed must not render as "Dispatch is using nothing".
    if (!snap.byPid.has(this.serverPid)) return null;
    const treePids = descendantsOf([this.serverPid], snap.children);
    const tree = tally(treePids, snap.byPid, cpuOf);
    const server = snap.byPid.get(this.serverPid);

    // Which pids in the tree some chat already claims — an INTERSECTION,
    // because a chat can hold processes outside the tree (a session adopted
    // across a restart), and subtracting those would drive `unattributed`
    // negative. Its own machinery (the table reader) is not a leak either.
    const claimed = new Set<number>();
    for (const own of snap.owners.values()) {
      for (const pid of own.session) if (treePids.has(pid)) claimed.add(pid);
      for (const pid of own.shells) if (treePids.has(pid)) claimed.add(pid);
    }
    for (const pid of this.infraPids()) {
      if (pid === undefined) continue;
      for (const p of descendantsOf([pid], snap.children)) claimed.add(p);
    }
    const leftover = [...treePids].filter((pid) => !claimed.has(pid));
    const unattributed = tally(leftover, snap.byPid, cpuOf);

    return {
      pid: this.serverPid,
      procs: tree.procs,
      rssBytes: tree.rssBytes,
      cpuPct: tree.cpuPct,
      serverRssBytes: server?.rssBytes ?? 0,
      serverCpuPct: cpuOf(this.serverPid),
      unattributed,
    };
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
 * The image name accounting for most of a tree, grouped by name.
 *
 * BY CPU WHEN THERE IS ANY, otherwise by memory. Those are the two ways a chat
 * can be the problem, and picking the wrong one names the wrong culprit: the
 * case this exists for was a chat pinning ten cores whose biggest MEMORY
 * consumer was the ordinary `claude.exe`, while the actual answer was a
 * headless `chrome.exe` the browser MCP had left running. Falling back to
 * memory only when nothing is measurable keeps the row useful on the first
 * poll, before any rate exists.
 *
 * Grouped by NAME rather than reported per pid because seventeen Chrome
 * processes at 60% each are ONE problem — naming the single biggest pid would
 * both understate it and finger an arbitrary member of the group.
 */
function hottestOf(
  pids: Iterable<number>,
  byPid: Map<number, ProcRow>,
  cpuOf: (pid: number) => number | null,
): HotProcess | null {
  const groups = new Map<string, HotProcess>();
  for (const pid of pids) {
    const row = byPid.get(pid);
    if (!row) continue;
    // Unnamed rows are grouped together rather than dropped: they still cost
    // something, and a tree of them should not report "nothing here".
    const name = row.name || "unknown";
    const g = groups.get(name) ?? { name, count: 0, cpuPct: null, rssBytes: 0 };
    g.count += 1;
    g.rssBytes += row.rssBytes ?? 0;
    g.cpuPct = addRates(g.cpuPct, cpuOf(pid));
    groups.set(name, g);
  }
  let best: HotProcess | null = null;
  for (const g of groups.values()) {
    if (!best || hotter(g, best)) best = g;
  }
  return best;
}

/**
 * Should `a` displace `b` as the name on the row?
 *
 * TOTALLY ORDERED, and that is the point. The first cut compared on CPU alone
 * whenever any group had a rate, with a strict `>`, so once every group was
 * measured-and-idle — which is the STEADY STATE for most chats — nothing ever
 * beat the incumbent and the incumbent was whatever `descendantsOf`'s DFS
 * happened to pop first. An idle chat named a 5 MB `powershell.exe` instead of
 * its 2.4 GB of Chrome, and the label changed between polls with nothing having
 * changed in the world. `sortChats` on the client had already needed a
 * deterministic tiebreak for exactly this reason.
 *
 * UNMEASURED COUNTS AS ZERO rather than as less than zero. A group whose pids
 * are all new this window is unknown, not idle-er than idle, and ranking it
 * below a measured 0% let a 5 MB shell outrank seventeen Chromes that simply
 * hadn't been sampled twice yet. Scoring both at 0 lets memory settle it, which
 * is the answer the docstring above promises.
 */
function hotter(a: HotProcess, b: HotProcess): boolean {
  const ac = a.cpuPct ?? 0;
  const bc = b.cpuPct ?? 0;
  if (ac !== bc) return ac > bc;
  if (a.rssBytes !== b.rssBytes) return a.rssBytes > b.rssBytes;
  // Genuinely indistinguishable: order by name so the row is at least stable
  // across polls rather than reflecting process-table iteration order.
  return a.name < b.name;
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
