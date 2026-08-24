/**
 * ProcessService — OS-level visibility into what's ACTUALLY listening on a
 * project's ports, and a kill switch for it.
 *
 * The RunnerService tracks the processes IT spawned (by their shell pid), but a
 * dev server is usually a grandchild (`cmd.exe → pnpm → node → vite`), and a
 * server restart or a half-killed tree can leave that grandchild orphaned — still
 * holding port 5173/2567, invisible to the runner records, blocking the next
 * launch. This service closes that gap: it scans the OS for the pid LISTENING on
 * each of a project's declared/allocated ports, cross-references the active
 * runners, and flags anything untracked as an orphan. `killPids()` tree-kills by
 * pid so you can reap orphans the runner never knew about.
 *
 * The scan/describe/kill primitives are injectable so tests never shell out; the
 * default wiring parses `netstat -ano` (Windows) or `lsof` (POSIX) via execa.
 *
 * ── Why a port scan alone was not enough ─────────────────────────────────────
 * The candidate-port sweep can only find a process on a port we already know to
 * look at: a declared sub-app base, plus a hop window. An agent that starts its
 * own dev server on a port it invented is invisible to it. That is not
 * hypothetical — one chat on `the-salesman` (declared base 5273) ran Vite and an
 * npc-sim on 47820/47823/47830/47833/47840/47843 across four worktrees, none of
 * which this scan would ever have looked at, and none of which the UI could kill.
 *
 * So there is a second, port-agnostic source of truth: ANCESTRY. Every shell
 * TerminalService owns has a pid and a chatId, so a listener whose process
 * descends from one of those shells is attributable to that chat no matter which
 * port it picked. That makes the panel a real answer to "what is this chat still
 * running?" instead of "what is on the ports we declared?".
 */
import { execa } from "execa";
import treeKill from "tree-kill";
import type { Store } from "../store/index.js";
import { PORT_SCAN_RANGE } from "./runner.js";

/** A port and the pid LISTENING on it (as reported by the OS). */
export interface PortListener {
  port: number;
  pid: number;
}

/** One row of the project process view. */
export interface ProjectProcess {
  port: number;
  pid: number;
  /** Process image name (e.g. `node.exe`), best-effort. */
  name?: string;
  /** True when Dispatch can account for this listener (runner OR chat shell). */
  tracked: boolean;
  runnerId?: string;
  subAppId?: string;
  branch?: string;
  worktreePath?: string;
  /** How we know about it: an app runner, a chat's shell, or nothing at all. */
  source: "runner" | "terminal" | "orphan";
  /** Chat that owns the shell this descends from (`source: "terminal"`). */
  chatId?: string;
  chatTitle?: string;
  /** Name of that shell, e.g. "server" — what to `terminal_output` against. */
  terminalName?: string;
  /** `${chatId}::${name}` — the join key the Terminals panel matches cards on. */
  terminalId?: string;
}

/**
 * One row of the OS process table (pid → parent), for ancestry attribution.
 *
 * The two measurements are OPTIONAL because not every source carries them: a
 * test fake, an older capture, or a `ps` without the columns all produce rows
 * with ancestry and nothing else, and attribution has to keep working on those.
 * Absent is therefore meaningfully different from zero and must stay so — see
 * the NaN note in `parseProcCsv`.
 */
export interface ProcRow {
  pid: number;
  ppid: number;
  name?: string;
  /** Resident bytes (Windows working set / POSIX RSS). Counts SHARED pages. */
  rssBytes?: number;
  /** CUMULATIVE CPU time since the process started, ms. A rate needs two. */
  cpuMs?: number;
}

/** Result of a bulk kill: one entry per requested pid. */
export interface KillResult {
  pid: number;
  ok: boolean;
  error?: string;
}

/** Enumerates every LISTENING TCP port → pid on the host. */
export type ScanFn = () => Promise<PortListener[]>;
/** Resolves pids to image names (best-effort; missing pids simply absent). */
export type DescribeFn = (pids: number[]) => Promise<Map<number, string>>;
/** Tree-kills a process (all descendants) — Windows-safe. */
export type KillTreeFn = (pid: number) => Promise<void>;
/** Enumerates the whole process table as pid → parent pid. */
export type ProcTableFn = () => Promise<ProcRow[]>;

/** The slice of TerminalService this needs: live shells and who owns them. */
export interface TerminalRoots {
  livePids(): { chatId: string; name: string; terminalId: string; pid: number }[];
}

export interface ProcessDeps {
  store: Store;
  scan?: ScanFn;
  describe?: DescribeFn;
  killTree?: KillTreeFn;
  procTable?: ProcTableFn;
  /** Is this pid still running? Defaults to a signal-0 probe. */
  alive?: (pid: number) => boolean;
  /** Omitted → no chat attribution, just the legacy declared-port sweep. */
  terminals?: TerminalRoots;
  /**
   * How far above each declared base port to look for a listener a tool may have
   * hopped to (Vite/Colyseus scan upward off a busy base). Defaults to the
   * allocator's own scan range (`PORT_SCAN_RANGE`) — anything narrower would hide
   * the far end of a runaway ladder from the very panel meant to reap it.
   */
  portWindow?: number;
}

const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);

/** A live chat shell, resolved to the chat that owns it. */
interface ShellRoot {
  chatId: string;
  chatTitle?: string;
  name: string;
  terminalId: string;
  pid: number;
}

/* -------------------------------------------------------------- default wiring */

/** Parse `netstat -ano` (Windows) into LISTENING port→pid pairs. */
export function parseNetstat(output: string): PortListener[] {
  const out: PortListener[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/\bLISTENING\b/.test(line)) continue;
    const parts = line.split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>
    const local = parts[1] ?? "";
    const pid = Number(parts[parts.length - 1]);
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0) {
      out.push({ port, pid });
    }
  }
  return out;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` (POSIX) into LISTENING port→pid pairs. */
export function parseLsof(output: string): PortListener[] {
  const out: PortListener[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    // COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME(*:5173)
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    const name = parts[parts.length - 1];
    const port = Number(name.slice(name.lastIndexOf(":") + 1));
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0) {
      out.push({ port, pid });
    }
  }
  return out;
}

const defaultScan: ScanFn = async () => {
  if (process.platform === "win32") {
    // `-p TCP` is IPv4-only on Windows. Vite commonly binds localhost as the
    // IPv6-only `[::1]`, which made a live dev server invisible to the roster.
    // With no protocol filter netstat returns both TCP families plus UDP; UDP
    // has no LISTENING state, so the parser's state check excludes those rows.
    const res = await execa("netstat", ["-ano"], {
      reject: false,
      buffer: true,
    });
    return parseNetstat(res.stdout ?? "");
  }
  const res = await execa("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
    reject: false,
    buffer: true,
  });
  return parseLsof(res.stdout ?? "");
};

/** Parse `tasklist /FO CSV /NH` into a pid→image-name map. */
export function parseTasklist(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    // "node.exe","12345","Console","1","120,000 K"
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

const defaultDescribe: DescribeFn = async (pids) => {
  if (pids.length === 0) return new Map();
  if (process.platform === "win32") {
    const res = await execa("tasklist", ["/FO", "CSV", "/NH"], {
      reject: false,
      buffer: true,
    });
    const all = parseTasklist(res.stdout ?? "");
    const wanted = new Set(pids);
    return new Map([...all].filter(([pid]) => wanted.has(pid)));
  }
  const res = await execa("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], {
    reject: false,
    buffer: true,
  });
  const map = new Map<number, string>();
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
};

/**
 * Split one CSV line, honouring quoted fields and `""` escapes.
 *
 * A plain `split(",")` was fine while the only text column was last: a comma in
 * a process name could corrupt nothing after it, because there was nothing
 * after it. Now that the row carries numbers the caller does arithmetic on, a
 * name like `Foo, Bar.exe` shifting every later cell by one would silently
 * charge one process's memory to another column. Cheap to do properly.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      // `""` inside a quoted field is one literal quote, not the end of it.
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Column names this understands, mapped to where they land on a {@link ProcRow}. */
const PROC_CSV_COLUMNS: Record<string, "pid" | "ppid" | "name" | "rss" | "kernel" | "user"> = {
  processid: "pid",
  parentprocessid: "ppid",
  name: "name",
  workingsetsize: "rss",
  kernelmodetime: "kernel",
  usermodetime: "user",
};

/**
 * Parse `ConvertTo-Csv` output from `Get-CimInstance Win32_Process`.
 *
 * HEADER-DRIVEN rather than positional. The query asks for six columns now and
 * asked for three before; binding by name means neither the column ORDER nor a
 * future addition can silently shift memory into the CPU field. A file with no
 * recognisable header falls back to the original `pid,ppid,name` positions, so
 * older captures (and the tests written against them) still parse.
 *
 * `KernelModeTime`/`UserModeTime` are CUMULATIVE 100-nanosecond counters, summed
 * here into `cpuMs`. They are not a rate and cannot be turned into one by a
 * single reading — see `ResourceService`, which differences two.
 */
export function parseProcCsv(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  let cols: (string | undefined)[] | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    if (cols === null) {
      const mapped = cells.map((c) => PROC_CSV_COLUMNS[c.toLowerCase()]);
      // A real header names at least the two columns everything else needs.
      if (mapped.includes("pid") && mapped.includes("ppid")) {
        cols = mapped;
        continue;
      }
      cols = ["pid", "ppid", "name"];
    }
    const at = (key: string): string | undefined => {
      const i = cols!.indexOf(key);
      return i === -1 ? undefined : cells[i];
    };
    const pid = Number(at("pid"));
    const ppid = Number(at("ppid"));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
    const row: ProcRow = { pid, ppid, name: at("name") || undefined };
    const rss = Number(at("rss"));
    if (Number.isFinite(rss) && at("rss") !== undefined) row.rssBytes = rss;
    // 100 ns ticks → ms. Absent columns give NaN, which must not become a 0:
    // a real 0 means "this process has used no CPU", and a missing column means
    // "we did not ask", and a delta against a fabricated 0 would report the
    // process's ENTIRE lifetime CPU as if it had burned it in one window.
    const kernel = Number(at("kernel"));
    const user = Number(at("user"));
    if (Number.isFinite(kernel) && Number.isFinite(user)) {
      row.cpuMs = (kernel + user) / 10_000;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse `ps -e -o pid=,ppid=,rss=,time=,comm=` into pid → parent rows.
 *
 * Tolerates the older three-column `pid,ppid,comm` form: `rss` and `time` are
 * only read when the line actually carries an integer and a clock-shaped field
 * in those positions, so a command name is never mistaken for a measurement.
 * `rss` is KiB on both Linux and macOS; `time` is `[[dd-]hh:]mm:ss`.
 */
export function parsePsTable(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(?:(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+)?(.*)$/);
    if (!m) continue;
    const row: ProcRow = { pid: Number(m[1]), ppid: Number(m[2]), name: m[5] || undefined };
    if (m[3] !== undefined) row.rssBytes = Number(m[3]) * 1024;
    if (m[4] !== undefined) row.cpuMs = parsePsTime(m[4]);
    rows.push(row);
  }
  return rows;
}

/** `[[dd-]hh:]mm:ss` → milliseconds. */
function parsePsTime(t: string): number {
  const [days, rest] = t.includes("-") ? t.split("-") : ["0", t];
  const parts = rest.split(":").map(Number);
  // Pad to [h, m, s] — `ps` drops the hours field until it's needed.
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return ((Number(days) * 24 + h) * 3600 + m * 60 + s) * 1000;
}

/**
 * The process table. Windows has no `ps`, and `wmic` is gone from current
 * Windows 11 images, so this goes through CIM — the same source Task Manager
 * reads. `-NoProfile` because a user profile that prints anything would land in
 * the CSV.
 *
 * THE MEMORY AND CPU COLUMNS ARE FREE. Measured against 888 processes on a real
 * install: `ProcessId,ParentProcessId,Name` took 356 ms and the six-column form
 * below took 419 ms — and both are dwarfed by the ~400 ms of `powershell.exe`
 * startup that wraps them, so the difference does not survive spawn jitter. The
 * expensive things were considered and rejected: `WorkingSetPrivate` (the only
 * memory figure that doesn't double-count shared pages) lives in
 * `Win32_PerfRawData_PerfProc_Process` at SEVEN SECONDS, and per-process GPU via
 * `Get-Counter "\GPU Engine(*)"` costs FOUR, for a figure that measured ≤0.09%
 * across every process on the box — agent workloads don't touch the GPU.
 */
export const defaultProcTable: ProcTableFn = async () => {
  if (process.platform === "win32") {
    const res = await execa(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name | ConvertTo-Csv -NoTypeInformation",
      ],
      { reject: false, buffer: true, windowsHide: true },
    );
    return parseProcCsv(res.stdout ?? "");
  }
  // `comm` LAST: it is the only field that can contain a space, so anything
  // after it would be unparseable.
  const res = await execa("ps", ["-e", "-o", "pid=,ppid=,rss=,time=,comm="], {
    reject: false,
    buffer: true,
  });
  return parsePsTable(res.stdout ?? "");
};

/**
 * Signal 0: no signal is sent, it just asks whether the pid is addressable.
 *
 * `EPERM` means the process EXISTS but this user may not signal it — reporting
 * that as dead would turn a kill that genuinely failed into a reported success,
 * which is the one answer this probe must never give. Only `ESRCH` ("no such
 * process") and anything else unrecognized count as gone.
 */
export const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

const defaultKillTree: KillTreeFn = (pid) =>
  new Promise((res, rej) =>
    treeKill(pid, "SIGTERM", (err) => (err ? rej(err) : res())),
  );

/* -------------------------------------------------------------- the service */

export class ProcessService {
  private readonly store: Store;
  private readonly scan: ScanFn;
  private readonly describe: DescribeFn;
  private readonly killTree: KillTreeFn;
  private readonly portWindow: number;
  private readonly procTable: ProcTableFn;
  private readonly terminals?: TerminalRoots;
  private readonly alive: (pid: number) => boolean;

  constructor(deps: ProcessDeps) {
    this.store = deps.store;
    this.scan = deps.scan ?? defaultScan;
    this.describe = deps.describe ?? defaultDescribe;
    this.killTree = deps.killTree ?? defaultKillTree;
    this.portWindow = deps.portWindow ?? PORT_SCAN_RANGE;
    this.procTable = deps.procTable ?? defaultProcTable;
    this.terminals = deps.terminals;
    this.alive = deps.alive ?? defaultAlive;
  }

  /**
   * Every OS process LISTENING on a port that belongs to this project — its
   * sub-apps' declared bases (plus a hop window), any port an active runner
   * allocated, and any port a process descended from one of this project's chat
   * shells has taken, whether or not we would ever have thought to look there.
   * Each row is flagged `tracked` (a runner or a chat shell accounts for it) or
   * an orphan.
   */
  async listForProject(projectId: string): Promise<ProjectProcess[]> {
    const project = await this.store.getProject(projectId).catch(() => null);
    const runners = (await this.store.listRunners().catch(() => []))
      .filter((r) => r.projectId === projectId && ACTIVE_STATUSES.has(r.status));
    const shells = await this.shellsForProject(projectId);

    // Candidate ports: declared bases + hop window, plus runner-allocated ports.
    const candidates = new Set<number>();
    for (const s of project?.subApps ?? []) {
      for (const base of s.ports ?? []) {
        for (let p = base; p <= base + this.portWindow; p++) candidates.add(p);
      }
    }
    for (const r of runners) {
      for (const p of r.ports ?? (r.port !== undefined ? [r.port] : [])) {
        candidates.add(p);
      }
    }
    if (candidates.size === 0 && shells.length === 0) return [];

    // Port → the active runner that allocated it (grandchild pid ≠ runner.pid, so
    // match by PORT, which is the stable identity between record and OS).
    const runnerByPort = new Map<number, (typeof runners)[number]>();
    for (const r of runners) {
      for (const p of r.ports ?? (r.port !== undefined ? [r.port] : [])) {
        if (!runnerByPort.has(p)) runnerByPort.set(p, r);
      }
    }

    // pid → the chat shell it descends from. Built only when this project has
    // live shells, because it costs a full process-table read.
    const owner = await this.ownersByPid(shells);

    const listeners = (await this.scan().catch(() => [])).filter(
      (l) => candidates.has(l.port) || owner.has(l.pid),
    );
    // Dedup (a port can appear on both IPv4 and IPv6) keyed by port+pid.
    const seen = new Set<string>();
    const unique = listeners.filter((l) => {
      const key = `${l.port}:${l.pid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const names = await this.describe([...new Set(unique.map((l) => l.pid))]).catch(
      () => new Map<number, string>(),
    );

    return unique
      .map((l): ProjectProcess => {
        const runner = runnerByPort.get(l.port);
        // A runner record is the stronger claim: it names the sub-app and the
        // worktree. Shell ancestry only fires for what no runner explains.
        const shell = runner ? undefined : owner.get(l.pid);
        return {
          port: l.port,
          pid: l.pid,
          name: names.get(l.pid),
          tracked: !!runner || !!shell,
          source: runner ? "runner" : shell ? "terminal" : "orphan",
          runnerId: runner?.id,
          subAppId: runner?.subAppId,
          branch: runner?.branch,
          worktreePath: runner?.worktreePath,
          chatId: shell?.chatId,
          chatTitle: shell?.chatTitle,
          terminalName: shell?.name,
          terminalId: shell?.terminalId,
        };
      })
      .sort((a, b) => a.port - b.port || a.pid - b.pid);
  }

  /** Live chat shells belonging to this project, with their chat titles. */
  private async shellsForProject(projectId: string): Promise<ShellRoot[]> {
    const live = this.terminals?.livePids() ?? [];
    if (live.length === 0) return [];
    const out: ShellRoot[] = [];
    // Chats are looked up one by one and cached per chatId: a chat can own
    // several shells, and the cap is 8 per chat, so this is a handful of reads.
    const chats = new Map<string, { projectId?: string; title?: string } | null>();
    for (const s of live) {
      if (!chats.has(s.chatId)) {
        chats.set(s.chatId, await this.store.getChat(s.chatId).catch(() => null));
      }
      const chat = chats.get(s.chatId);
      if (chat?.projectId !== projectId) continue;
      out.push({ ...s, chatTitle: chat.title });
    }
    return out;
  }

  /**
   * Map every descendant pid of every shell back to that shell.
   *
   * The shell itself is included: `powershell.exe` never listens, but a shell
   * whose command REPLACED it (or a fake in a test) might, and a row we can
   * attribute is always better than an orphan. Walks children iteratively —
   * a pid table can contain cycles after pid reuse, and `visited` makes that a
   * non-event rather than a hung request.
   */
  private async ownersByPid(shells: ShellRoot[]): Promise<Map<number, ShellRoot>> {
    const owner = new Map<number, ShellRoot>();
    if (shells.length === 0) return owner;

    const table = await this.procTable().catch(() => [] as ProcRow[]);
    const children = new Map<number, number[]>();
    for (const row of table) {
      const kids = children.get(row.ppid);
      if (kids) kids.push(row.pid);
      else children.set(row.ppid, [row.pid]);
    }

    for (const shell of shells) {
      const queue = [shell.pid];
      while (queue.length) {
        const pid = queue.pop()!;
        // First shell to claim a pid keeps it — two shells cannot legitimately
        // share a descendant, and a pid-reuse cycle must not re-enter here.
        if (owner.has(pid)) continue;
        owner.set(pid, shell);
        for (const kid of children.get(pid) ?? []) queue.push(kid);
      }
    }
    return owner;
  }

  /**
   * Tree-kill each pid (deduped). Best-effort per pid; never throws.
   *
   * Two things stop this reporting failures for work that actually succeeded:
   *
   * 1. DESCENDANTS ARE PRUNED. A "kill this chat" set contains a shell AND the
   *    dev server under it. Tree-killing both in parallel is a race: the first
   *    takes the second down with it, and the loser's `taskkill /T` then fails
   *    with "there is no running instance of the task" — a red error toast for a
   *    completely successful kill (observed: "Killed 1/2 processes", with both
   *    processes gone). A pid whose ancestor is also being killed is covered by
   *    that kill, so it is never issued and is reported ok.
   * 2. A KILL THAT FINDS NOTHING IS A SUCCESS. If the tree-kill errors but the
   *    pid is gone afterwards, the outcome we were asked for holds — the process
   *    may simply have exited on its own between the scan and the click. Checked
   *    by probing liveness rather than by matching the error text, which is
   *    localized and differs per platform.
   */
  async killPids(pids: number[]): Promise<KillResult[]> {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (unique.length === 0) return [];

    const covered = unique.length > 1 ? await this.coveredByAncestor(unique) : new Set<number>();
    const results = new Map<number, KillResult>();

    // The roots first: everything the caller asked for that nothing else in the
    // set contains.
    await Promise.all(
      unique
        .filter((pid) => !covered.has(pid))
        .map(async (pid) => results.set(pid, await this.killOne(pid))),
    );

    // Then verify the covered ones actually went with their ancestor. Assuming
    // they did would report ok for a process still holding its port whenever the
    // ancestor's kill failed (permissions, a transient OS error) — the failure
    // would vanish from the toast AND the row. If one survived, kill it directly.
    await Promise.all(
      [...covered].map(async (pid) => {
        if (!this.alive(pid)) {
          results.set(pid, { pid, ok: true });
          return;
        }
        results.set(pid, await this.killOne(pid));
      }),
    );

    // Reported in the order asked for, so a caller can zip results to input.
    return unique.map((pid) => results.get(pid) ?? { pid, ok: false, error: "not attempted" });
  }

  /** One tree-kill, where "it's already gone" is the success it looks like. */
  private async killOne(pid: number): Promise<KillResult> {
    try {
      await this.killTree(pid);
      return { pid, ok: true };
    } catch (err) {
      if (!this.alive(pid)) return { pid, ok: true };
      return { pid, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Which of `pids` descend from another pid in the same set. */
  private async coveredByAncestor(pids: number[]): Promise<Set<number>> {
    const table = await this.procTable().catch(() => [] as ProcRow[]);
    if (table.length === 0) return new Set();
    const parent = new Map(table.map((r) => [r.pid, r.ppid]));
    const wanted = new Set(pids);
    const covered = new Set<number>();
    for (const pid of pids) {
      // Walk up; `seen` bounds a pid-reuse cycle (same hazard as `ownersByPid`).
      const seen = new Set<number>([pid]);
      let cur = parent.get(pid);
      while (cur !== undefined && cur > 0 && !seen.has(cur)) {
        if (wanted.has(cur)) {
          covered.add(pid);
          break;
        }
        seen.add(cur);
        cur = parent.get(cur);
      }
    }
    // A cycle makes every member "descend from" another member, which would
    // prune the whole set and kill NOTHING — silently, with every row reported
    // ok. Covering everything is never a valid answer: if it happens, distrust
    // the table and issue every kill. The `alive` re-check absorbs any resulting
    // race. (A test drives the two-pid cycle that found this.)
    if (covered.size === pids.length) return new Set();
    return covered;
  }
}
