/**
 * ChatProcessService — how many OS processes each chat is actually holding, and
 * a way to hand them back.
 *
 * WHY THE SIDEBAR NEEDS THIS. A chat's cost is not the `claude` process; it is
 * that process's whole TREE. Every MCP server a session runs is a child of it —
 * a browser server, an ssh server, whatever the project declares — and on a real
 * install that measured ~9 processes and ~1.3 GB per chat. Nothing evicts them:
 * an idle chat keeps its entire tree resident by design (see the broker's
 * `withinOverallContextBudget` — the cap bounds RUNNING turns, not RESIDENT
 * sessions), which is correct, because a chat parked waiting for someone to test
 * something must still be there when they come back.
 *
 * So the answer is not automatic eviction, it is VISIBILITY plus a manual reap:
 * put the number on the row, and let whoever sees it decide. Fifteen resident
 * sessions against four you are actually using is obvious the moment it is
 * displayed and invisible until then.
 *
 * TWO KINDS OF ROOT, because a chat owns two kinds of process:
 *   • its session subprocess — the harness runtime and every MCP server under it
 *   • its live shells       — `terminal({ background: true })` dev servers and
 *                             watchers, which TerminalService spawns off the
 *                             SERVER, not off the session, so they are their own
 *                             roots rather than descendants of the first
 *
 * COUNTED INCLUSIVELY. The root is one of the processes the chat is holding, so
 * "9" means nine real entries in the process table, not nine plus an implied one.
 */
import type { ProcRow, ProcTableFn, TerminalRoots } from "./processes.js";

/** What one chat is holding, split by who reaps it. */
export interface ChatProcessTally {
  /** Its runtime subprocess and every MCP server under it. Swept when idle. */
  session: number;
  /** Its background shells and their descendants. NEVER swept automatically. */
  shells: number;
}

/** Per-chat process totals, and when they were taken. */
export interface ChatProcessCounts {
  byChat: Record<string, ChatProcessTally>;
  at: number;
}

export interface ChatProcessDeps {
  /**
   * Enumerates the whole process table as pid → parent pid.
   *
   * Usually the SHARED, cached reader (`ProcTableCache`), so the sidebar's
   * count poll and the resource snapshot cost one scan between them rather
   * than one each.
   */
  procTable: ProcTableFn;
  /**
   * An UNCACHED read, for {@link ChatProcessService.pidsFor} only.
   *
   * Defaults to `procTable`, which is correct when that is already uncached.
   * It must be supplied whenever `procTable` is a cache: `pidsFor` feeds a
   * KILL, and signalling pids off a ten-second-old table risks hitting a pid
   * the OS has since recycled onto somebody else's process. Sharing the cache
   * with the count poll is a pure win; sharing it with a kill is a footgun.
   */
  procTableFresh?: ProcTableFn;
  /**
   * Dropped alongside this service's own cache by {@link
   * ChatProcessService.invalidate} — the shared `ProcTableCache` behind
   * `procTable`, when there is one.
   *
   * REQUIRED FOR A KILL TO LOOK LIKE A KILL. Invalidating only the tally cache
   * re-derives it from a TABLE that still lists every process just reaped, so
   * the reap is invisible for the rest of that table's TTL. Worse than
   * invisible, on the Resources page: the roots come from the live broker and
   * update at once, so the dead pids stop belonging to any chat while still
   * sitting in the server's subtree, and `unattributed = tree − Σ chats`
   * absorbs them — a successful reap renders as an "N processes belong to no
   * chat" banner sized exactly to what was just killed, which is the page's
   * leak warning.
   */
  invalidateSource?: () => void;
  /** Live session roots, as `chatId → pid`. Usually `broker.sessionPids()`. */
  sessionPids: () => Map<string, number>;
  /** Live shells and who owns them. Omitted → session roots only. */
  terminals?: TerminalRoots;
  /** Injectable clock (tests). */
  now?: () => number;
  /** How long a scan stays fresh. See {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

/**
 * How long a scan is reused.
 *
 * Enumerating the process table shells out (`Get-CimInstance Win32_Process` on
 * Windows, `ps` elsewhere) and costs a few hundred ms, so it must not run once
 * per connected client. The sidebar polls every 30 s; anything up to that is
 * free, and 10 s keeps the number honest right after someone presses the kill
 * button without making the poll itself the load.
 */
const DEFAULT_TTL_MS = 10_000;

export class ChatProcessService {
  private readonly procTable: ProcTableFn;
  private readonly procTableFresh: ProcTableFn;
  private readonly invalidateSource?: () => void;
  private readonly sessionPids: () => Map<string, number>;
  private readonly terminals?: TerminalRoots;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private cached?: ChatProcessCounts;
  /**
   * The scan currently running, so N concurrent callers cause ONE shell-out.
   * Without this the TTL alone is no protection: every client that polls in the
   * same tick misses the cache together and they all scan.
   */
  private inFlight?: Promise<ChatProcessCounts>;
  /**
   * Bumped by {@link invalidate}. A scan carries the generation it started in
   * and refuses to write the cache — or to clear the in-flight slot — if that
   * generation is no longer current.
   *
   * A counter rather than just dropping `inFlight`, because dropping it alone
   * leaves the OLD scan's `finally` free to clear the NEW scan that replaced it,
   * and leaves its result free to land in `cached` as if it were fresh. Both
   * halves matter: a scan that started before a kill saw every process still
   * alive, and caching that answer afterwards pins the row to its pre-kill
   * number for a full TTL — which is exactly the "reads as the button not
   * working" failure `invalidate` exists to prevent.
   */
  private generation = 0;

  constructor(deps: ChatProcessDeps) {
    this.procTable = deps.procTable;
    this.procTableFresh = deps.procTableFresh ?? deps.procTable;
    this.invalidateSource = deps.invalidateSource;
    this.sessionPids = deps.sessionPids;
    this.terminals = deps.terminals;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Every chat's process total. Cached; see {@link DEFAULT_TTL_MS}. */
  async counts(): Promise<ChatProcessCounts> {
    const fresh = this.cached;
    if (fresh && this.now() - fresh.at < this.ttlMs) return fresh;
    if (!this.inFlight) {
      const generation = this.generation;
      this.inFlight = this.scan(generation).finally(() => {
        if (generation === this.generation) this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /**
   * Drop the cache so the next `counts()` re-scans.
   *
   * Called after a kill: the row must show the reap immediately, and a stale
   * "9" sitting there for another ten seconds reads as the button not working.
   */
  invalidate(): void {
    // The SHARED table first. Dropping only the tally below would re-derive it
    // from a table that still lists everything just reaped — see
    // `invalidateSource`.
    this.invalidateSource?.();
    this.cached = undefined;
    // Retires the in-flight scan as well as the cache. That scan read the
    // process table BEFORE the kill, so its answer is not merely stale — it is
    // the exact number the caller is invalidating to get rid of.
    this.generation += 1;
    this.inFlight = undefined;
  }

  /**
   * Every pid this chat is holding — its roots and all their descendants.
   *
   * Deliberately NOT served from the count cache: this one feeds a kill, and
   * killing pids off a ten-second-old table risks signalling a pid the OS has
   * since recycled onto somebody else's process.
   */
  async pidsFor(chatId: string): Promise<number[]> {
    const table = await this.procTableFresh().catch(() => [] as ProcRow[]);
    const roots = this.rootsByChat(table).get(chatId);
    if (!roots?.length) return [];
    return [...descendantsOf(roots, table)];
  }

  private async scan(generation: number): Promise<ChatProcessCounts> {
    const table = await this.procTable().catch(() => [] as ProcRow[]);
    // An empty table is a FAILED table, not a machine with no processes on it —
    // the shell-out died, or its output didn't parse. Walking it anyway would
    // find each root and none of its children, and every chat would quietly drop
    // to "1": a plausible number, uniformly wrong, and indistinguishable from a
    // real answer. Keep the last real reading instead, and don't cache this, so
    // the next poll retries rather than serving the gap for a full TTL.
    if (table.length === 0) return this.cached ?? { byChat: {}, at: this.now() };

    const byChat: Record<string, ChatProcessTally> = {};
    const sessionRoots = this.sessionRootsByChat(table);
    for (const [chatId, roots] of this.rootsByChat(table)) {
      // The session subtree first, so a shell the session itself started is
      // attributed there and not counted twice on the shells side.
      const sessionPids = descendantsOf(sessionRoots.get(chatId) ?? [], table);
      const all = descendantsOf(roots, table);
      const session = sessionPids.size;
      const shells = all.size - session;
      // Absent rather than a pair of zeroes, matching `MetricsService.chatRuntime`:
      // the row renders nothing for a chat it has no reading for, and "0" is a
      // claim that we looked and found none — which is exactly what a failed
      // scan would also produce.
      if (session > 0 || shells > 0) byChat[chatId] = { session, shells };
    }
    const counts = { byChat, at: this.now() };
    // A scan `invalidate` retired still RESOLVES — callers that asked before the
    // kill are owed an answer — but it must not become the cache the next
    // caller reads.
    if (generation === this.generation) this.cached = counts;
    return counts;
  }

  /** `chatId → session root pid`, the half an idle sweep retires. */
  private sessionRootsByChat(table: readonly ProcRow[]): Map<string, number[]> {
    const roots = new Map<string, number[]>();
    const add = (chatId: string, pid: number): void => {
      if (!Number.isInteger(pid) || pid <= 0) return;
      const list = roots.get(chatId);
      if (list) list.push(pid);
      else roots.set(chatId, [pid]);
    };
    for (const [chatId, pid] of this.sessionPids()) add(chatId, pid);
    // Codex owns MCP servers through its shared app-server, so those processes
    // are not descendants of a per-chat runtime pid. The browser shim's output
    // directory is the ownership boundary; recover that root from the fresh OS
    // table so a completed/stopped chat can still display and reap its orphan.
    for (const row of table) {
      const chatId = browserMcpOwner(row.commandLine);
      if (chatId) add(chatId, row.pid);
    }
    return roots;
  }

  /** `chatId → root pids`, from both kinds of root. */
  private rootsByChat(table: readonly ProcRow[]): Map<string, number[]> {
    const roots = this.sessionRootsByChat(table);
    const add = (chatId: string, pid: number): void => {
      if (!Number.isInteger(pid) || pid <= 0) return;
      const list = roots.get(chatId);
      if (list) list.push(pid);
      else roots.set(chatId, [pid]);
    };
    for (const shell of this.terminals?.livePids() ?? []) add(shell.chatId, shell.pid);
    return roots;
  }
}

/** Chat id embedded by `lazy-browser-shim` in its per-chat output directory. */
function browserMcpOwner(commandLine: string | undefined): string | undefined {
  if (!commandLine) return undefined;
  const normalized = commandLine.replace(/\\/g, "/");
  return /(?:^|\/)dispatch-browser-mcp\/([^/\s"']+)/i.exec(normalized)?.[1];
}

/**
 * `roots` plus everything descending from them, as a set.
 *
 * A SET, not a count, because the two root kinds can overlap: a shell the
 * session itself started would be reachable from the session root too, and
 * adding two subtree sizes would count it twice. Iterative rather than
 * recursive, and `seen`-guarded, so a cyclic or self-parented row in the table
 * (pid 0 on Windows reports itself) can't spin forever.
 */
function descendantsOf(roots: readonly number[], table: readonly ProcRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of table) {
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
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
