/**
 * ProcessTracker — the ONE place Dispatch learns which OS processes exist,
 * which chat each belongs to, and what each is costing.
 *
 * WHY IT EXISTS. Three features each read the process table on their own
 * schedule and attributed it their own way: the sidebar's per-chat count, the
 * Resources page's CPU/memory figures, and the kill button. The first two had
 * learned to share a cached read; the kill path deliberately bypassed it and
 * scanned FRESH, twice per chat (once to list the chat's pids, once more inside
 * `killPids` to prune descendants), then the client scanned a third time to
 * repaint the row. Each scan is a `powershell.exe` CIM query, and on the box
 * this was measured on that added up to a 21 s kill request — and the sidebar,
 * the Resources page and the kill could each disagree about which pids a chat
 * owned, because each derived it separately.
 *
 * WHAT IT DOES INSTEAD. Sweeps in the BACKGROUND on a timer and keeps the
 * latest {@link ProcessSnapshot}: the table, the per-chat ownership, and the
 * per-pid CPU rate against the previous sweep. Everything reads that. Nothing
 * on a request path waits for a scan unless it explicitly asks for one.
 *
 * THE COST, AND WHY IT IS LOWER THAN BEFORE. A standing sampler was rejected
 * once (see the old note in `resources.ts`) because every read was a fresh
 * `powershell.exe` at ~3 s. Two things change that sum: the Windows read now
 * goes through a persistent PowerShell (`proc-table-reader.ts`, ~850 ms of
 * query and no start-up), and the cadence backs off — {@link
 * TrackerDeps.intervalMs} while someone is looking, {@link
 * TrackerDeps.idleIntervalMs} when nobody has asked in a while, and never more
 * often than four times the last sweep's own duration, so a box that is
 * struggling gets swept LESS, not more.
 *
 * PID REUSE. A snapshot can be seconds old, and a pid in it can have been
 * handed to an unrelated process since. Nothing here kills by snapshot pid
 * without checking identity — {@link sameProcess} compares name and start time
 * against a fresh row first. See `ChatProcessService.release`.
 */
import os from "node:os";
import type { ProcRow, ProcTableFn, TerminalRoots } from "./processes.js";
import { defaultAlive } from "./processes.js";

/** Which pids one chat holds, split by who reaps them. */
export interface ChatOwnership {
  /** Its runtime subprocess and everything under it (MCP servers included). */
  session: Set<number>;
  /** Its background shells and their descendants, minus anything in `session`. */
  shells: Set<number>;
}

/** One sweep: the table, who owns what, and the CPU rate since the last sweep. */
export interface ProcessSnapshot {
  rows: ProcRow[];
  byPid: Map<number, ProcRow>;
  /** pid → child pids. Self-parented rows (Windows pid 0) are dropped. */
  children: Map<number, number[]>;
  /** When the table was read. */
  at: number;
  /** pid → CPU %, over {@link windowMs}. Absent = not measured (new, or no baseline). */
  cpuByPid: Map<number, number>;
  /** The window the rates cover; 0 when there are none. */
  windowMs: number;
  /** chatId → what it holds. A chat holding nothing is absent. */
  owners: Map<string, ChatOwnership>;
}

export interface TrackerDeps {
  /** One table read. Never expected to reject; `[]` means the read failed. */
  read: ProcTableFn;
  /** Live session roots, as `chatId → pid`. Usually `broker.sessionPids()`. */
  sessionPids: () => Map<string, number>;
  /** Live shells and who owns them. */
  terminals?: TerminalRoots;
  /**
   * Is this chat one of THIS instance's? Gates the browser-MCP marker below.
   *
   * The marker is a directory under the OS temp dir, shared by every Dispatch
   * on the machine, so without this a dev instance attributed the stable
   * instance's browser shims to chats it has never heard of — seen live: a
   * scratch instance with no chats at all reported fifteen. Omitted → trust
   * every marker (tests, single-instance callers).
   */
  ownsChat?: (chatId: string) => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable wait, for the baseline prime (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Is this pid still running? Defaults to a signal-0 probe. */
  alive?: (pid: number) => boolean;
  /**
   * Background cadence while somebody is reading, ms. `0` disables the timer
   * entirely — tests drive {@link ProcessTracker.sweep} by hand.
   */
  intervalMs?: number;
  /** Background cadence once nobody has read for {@link activeForMs}. */
  idleIntervalMs?: number;
  /** How long after a read the tracker counts as "being looked at". */
  activeForMs?: number;
  /** Gap between the two sweeps that establish the first CPU baseline. */
  primeDelayMs?: number;
  /** Called after every successful sweep — the idle-shell reaper hangs here. */
  onSweep?: (snapshot: ProcessSnapshot) => void | Promise<void>;
}

export const DEFAULT_INTERVAL_MS = 15_000;
export const DEFAULT_IDLE_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVE_FOR_MS = 120_000;
const DEFAULT_PRIME_DELAY_MS = 1_000;

/**
 * Below this, a CPU delta is noise: two scans 40 ms apart divide a scheduling
 * quantum by a near-zero window and produce percentages in the hundreds for
 * processes that did nothing. The previous sweep's rates are served instead.
 */
const MIN_WINDOW_MS = 250;

/**
 * Above this, a baseline is too old to difference against. With background
 * sweeps the window is normally the interval; this only trips after the tracker
 * was stopped, or a sweep stalled for minutes. Averaging over a window that
 * long hides exactly the spike someone opened the page to find, and every
 * process spawned in it is "new" and skipped — the bug that once read
 * "Dispatch 1.2%" on a machine where Dispatch held half the cores.
 */
const MAX_WINDOW_MS = 5 * DEFAULT_IDLE_INTERVAL_MS;

/** Two readings of a start time this close are the same process (POSIX `etime` is whole seconds). */
const START_TOLERANCE_MS = 2_000;

export class ProcessTracker {
  private readonly readTable: ProcTableFn;
  private readonly sessionPids: () => Map<string, number>;
  private readonly terminals?: TerminalRoots;
  private readonly ownsChat: (chatId: string) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly alive: (pid: number) => boolean;
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly activeForMs: number;
  private readonly primeDelayMs: number;
  private readonly onSweep?: (snapshot: ProcessSnapshot) => void | Promise<void>;

  private current?: ProcessSnapshot;
  /** The sweep in flight. */
  private running?: Promise<ProcessSnapshot>;
  /** A sweep promised to callers who arrived while {@link running} was underway. */
  private queued?: Promise<ProcessSnapshot>;
  /** Rates of the last sweep that could measure any, for a too-short window. */
  private lastRates?: { cpuByPid: Map<number, number>; windowMs: number; at: number };
  /** pid → when it was forgotten; a sweep whose read STARTED earlier must not resurrect it. */
  private forgotten = new Map<number, number>();
  private lastReadAt = 0;
  private lastSweepMs = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(deps: TrackerDeps) {
    this.readTable = deps.read;
    this.sessionPids = deps.sessionPids;
    this.terminals = deps.terminals;
    this.ownsChat = deps.ownsChat ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.alive = deps.alive ?? defaultAlive;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.idleIntervalMs = Math.max(this.intervalMs, deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS);
    this.activeForMs = deps.activeForMs ?? DEFAULT_ACTIVE_FOR_MS;
    this.primeDelayMs = deps.primeDelayMs ?? DEFAULT_PRIME_DELAY_MS;
    this.onSweep = deps.onSweep;
  }

  /**
   * Begin background sweeping. The first two sweeps run a second apart, so the
   * very first snapshot anyone reads after boot already carries CPU rates.
   */
  start(): void {
    if (this.started || this.intervalMs <= 0) return;
    this.started = true;
    void (async () => {
      await this.sweep();
      await this.sleep(this.primeDelayMs);
      if (!this.started) return;
      await this.sweep();
      this.schedule();
    })();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The latest snapshot, without waiting. Undefined before the first sweep lands. */
  latest(): ProcessSnapshot | undefined {
    return this.current;
  }

  /**
   * The latest snapshot, or a sweep's when there is none yet (or `fresh`).
   *
   * Every read marks the tracker as being looked at, which keeps the
   * background cadence at {@link TrackerDeps.intervalMs}.
   */
  async read(fresh = false): Promise<ProcessSnapshot> {
    this.lastReadAt = this.now();
    if (!fresh && this.current) return this.current;
    return this.sweep();
  }

  /**
   * A sweep that STARTS no earlier than this call.
   *
   * Joining a sweep already in flight would be wrong for the callers that ask
   * for one — a kill wants the table as it is AFTER the kill, and the in-flight
   * read may have started before it. So a caller arriving mid-sweep gets the
   * NEXT one, shared with everyone else who arrived in the meantime.
   */
  sweep(): Promise<ProcessSnapshot> {
    if (this.queued) return this.queued;
    if (this.running) {
      const queued = this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = undefined;
          return this.runSweep();
        });
      this.queued = queued;
      return queued;
    }
    return this.runSweep();
  }

  /**
   * Drop pids from the latest snapshot — called after a kill, with the pids
   * that are confirmed gone, so the sidebar and Resources page show the reap at
   * once instead of a full interval later. A sweep whose read started before
   * this call cannot put them back.
   */
  forget(pids: Iterable<number>): void {
    const at = this.now();
    const gone = new Set<number>();
    for (const pid of pids) {
      gone.add(pid);
      this.forgotten.set(pid, at);
    }
    if (!this.current || gone.size === 0) return;
    this.current = this.derive(
      this.current.rows.filter((r) => !gone.has(r.pid)),
      this.current.at,
      this.current.cpuByPid,
      this.current.windowMs,
    );
  }

  /** Every pid a chat holds in the latest snapshot, with its row. */
  owned(chatId: string): ProcRow[] {
    const snap = this.current;
    const own = snap?.owners.get(chatId);
    if (!snap || !own) return [];
    return [...own.session, ...own.shells].flatMap((pid) => {
      const row = snap.byPid.get(pid);
      return row ? [row] : [];
    });
  }

  /* ------------------------------------------------------------- internals */

  private runSweep(): Promise<ProcessSnapshot> {
    const run = this.doSweep().finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async doSweep(): Promise<ProcessSnapshot> {
    const startedAt = this.now();
    const rows = await this.readTable().catch(() => [] as ProcRow[]);
    this.lastSweepMs = Math.max(0, this.now() - startedAt);
    // An empty table is a FAILED read, not a machine with no processes —
    // serving it would tell every consumer every chat holds nothing.
    if (rows.length === 0) return this.current ?? this.derive([], startedAt, new Map(), 0);

    // Pids forgotten while this read was in flight are dead as far as anyone
    // is concerned; the read just predates the kill. Older entries are
    // settled — a read that started after them saw the real state.
    const skip = new Set<number>();
    for (const [pid, at] of this.forgotten) {
      if (at >= startedAt) skip.add(pid);
      else this.forgotten.delete(pid);
    }
    const live = skip.size ? rows.filter((r) => !skip.has(r.pid)) : rows;
    const { cpuByPid, windowMs } = this.rates(live, startedAt);
    const snap = this.derive(live, startedAt, cpuByPid, windowMs);
    this.current = snap;
    // Detached, not awaited: a consumer that itself asks for a sweep (the
    // reaper killing a shell, say) would otherwise wait on the very sweep that
    // is waiting on it. And its failure must not break sweeping.
    if (this.onSweep) {
      const onSweep = this.onSweep;
      void Promise.resolve()
        .then(() => onSweep(snap))
        .catch(() => {});
    }
    return snap;
  }

  private schedule(): void {
    if (!this.started) return;
    const active = this.now() - this.lastReadAt < this.activeForMs;
    const base = active ? this.intervalMs : this.idleIntervalMs;
    // Self-pacing: a sweep that took 3 s on a loaded box waits at least 12 s
    // before the next, so the tracker never occupies more than a fifth of the
    // time it is meant to be measuring.
    const delay = Math.max(base, this.lastSweepMs * 4);
    this.timer = setTimeout(() => {
      void this.sweep().finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  /**
   * CPU % per pid between the previous sweep and this one.
   *
   * Cumulative CPU counters only become a rate across two readings. A pid
   * absent from the previous reading — or present with a different start time,
   * i.e. a recycled pid — is new: its lifetime CPU is not this window's.
   */
  private rates(
    rows: ProcRow[],
    at: number,
  ): { cpuByPid: Map<number, number>; windowMs: number } {
    const prev = this.current;
    const windowMs = prev ? at - prev.at : 0;
    if (!prev || windowMs < MIN_WINDOW_MS || windowMs > MAX_WINDOW_MS) {
      // Too short to divide by but measured recently: serve the last real
      // answer rather than blanking every figure over a scheduling accident.
      const last = this.lastRates;
      if (prev && windowMs < MIN_WINDOW_MS && last && at - last.at <= MAX_WINDOW_MS) {
        return { cpuByPid: last.cpuByPid, windowMs: last.windowMs };
      }
      return { cpuByPid: new Map(), windowMs: 0 };
    }
    const cores = Math.max(1, this.logicalCores());
    const cpuByPid = new Map<number, number>();
    for (const row of rows) {
      const was = prev.byPid.get(row.pid);
      if (row.cpuMs === undefined || was?.cpuMs === undefined) continue;
      if (!sameStart(was, row)) continue;
      const delta = row.cpuMs - was.cpuMs;
      // Backwards means a recycled pid the start time could not catch.
      if (delta < 0) continue;
      cpuByPid.set(row.pid, clampPct((100 * delta) / windowMs, 100 * cores));
    }
    if (cpuByPid.size > 0) this.lastRates = { cpuByPid, windowMs, at };
    return { cpuByPid, windowMs: cpuByPid.size > 0 ? windowMs : 0 };
  }

  private logicalCores(): number {
    // Lazy: `os` is only needed for the clamp, and tests never reach a value
    // where the bound matters.
    return osCores();
  }

  /** Build the derived views (index, tree, ownership) over a set of rows. */
  private derive(
    rows: ProcRow[],
    at: number,
    cpuByPid: Map<number, number>,
    windowMs: number,
  ): ProcessSnapshot {
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const children = childMap(rows);

    const sessionRoots = new Map<string, number[]>();
    const allRoots = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, chatId: string, pid: number): void => {
      if (!Number.isInteger(pid) || pid <= 0) return;
      const list = map.get(chatId);
      if (list) list.push(pid);
      else map.set(chatId, [pid]);
    };
    for (const [chatId, pid] of this.sessionPids()) {
      add(sessionRoots, chatId, pid);
      add(allRoots, chatId, pid);
    }
    // Codex launches MCP servers from its SHARED app-server, so those are not
    // descendants of any per-chat runtime pid. The browser shim's per-chat
    // output directory in its command line is the ownership marker; it is
    // what lets a stopped chat still show — and reap — that orphan.
    for (const row of rows) {
      const chatId = browserMcpOwner(row.commandLine);
      if (chatId && this.ownsChat(chatId)) {
        add(sessionRoots, chatId, row.pid);
        add(allRoots, chatId, row.pid);
      }
    }
    for (const shell of this.terminals?.livePids() ?? []) add(allRoots, shell.chatId, shell.pid);

    const owners = new Map<string, ChatOwnership>();
    for (const [chatId, roots] of allRoots) {
      // Session first, so a shell the session itself started counts once, there.
      const session = present(descendantsOf(sessionRoots.get(chatId) ?? [], children), byPid);
      const shells = new Set(
        [...present(descendantsOf(roots, children), byPid)].filter((p) => !session.has(p)),
      );
      // Absent rather than empty: "0" would claim we looked and found nothing,
      // which is what a failed read also produces.
      if (session.size || shells.size) owners.set(chatId, { session, shells });
    }
    return { rows, byPid, children, at, cpuByPid, windowMs, owners };
  }
}

/* ------------------------------------------------------------------ helpers */

let cachedCores = 0;
function osCores(): number {
  if (!cachedCores) cachedCores = os.cpus().length || 1;
  return cachedCores;
}

/**
 * Is `fresh` the same process `old` described? Same name and — when both carry
 * one — the same start time. A recycled pid fails one or the other; a process
 * we cannot tell apart from the original on either axis is treated as it.
 */
export function sameProcess(old: ProcRow, fresh: ProcRow | undefined): boolean {
  if (!fresh || fresh.pid !== old.pid) return false;
  if (old.name && fresh.name && old.name.toLowerCase() !== fresh.name.toLowerCase()) return false;
  return sameStart(old, fresh);
}

function sameStart(a: ProcRow, b: ProcRow): boolean {
  if (a.startedAt === undefined || b.startedAt === undefined) return true;
  return Math.abs(a.startedAt - b.startedAt) <= START_TOLERANCE_MS;
}

/** Chat id embedded by `lazy-browser-shim` in its per-chat owner directory. */
export function browserMcpOwner(commandLine: string | undefined): string | undefined {
  if (!commandLine) return undefined;
  const normalized = commandLine.replace(/\\/g, "/");
  return /(?:^|\/)dispatch-browser-mcp\/([^/\s"']+)/i.exec(normalized)?.[1];
}

/** pid → its children. Self-parented rows are dropped so walks terminate. */
export function childMap(rows: readonly ProcRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return children;
}

/**
 * `roots` plus every descendant. A SET, because the two kinds of root can
 * overlap; iterative and `seen`-guarded, so a pid-reuse cycle can't spin.
 */
export function descendantsOf(
  roots: Iterable<number>,
  children: Map<number, number[]>,
): Set<number> {
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

/**
 * Only the pids the table actually lists. A root that is not in the table has
 * exited (or the table predates it) and holds nothing — counting it anyway
 * reported "1" for chats whose session was long gone.
 */
function present(pids: Set<number>, byPid: Map<number, ProcRow>): Set<number> {
  return new Set([...pids].filter((p) => byPid.has(p)));
}

function clampPct(pct: number, max = 100): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(max, pct));
}
