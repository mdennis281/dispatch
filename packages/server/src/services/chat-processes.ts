/**
 * ChatProcessService — how many OS processes each chat is holding, and the ONE
 * way to hand them back.
 *
 * WHY THE SIDEBAR NEEDS THIS. A chat's cost is not the `claude` process; it is
 * that process's whole TREE. Every MCP server a session runs is a child of it,
 * and on a real install that measured ~9 processes and ~1.3 GB per chat. The
 * number goes on the row so whoever sees it can decide; the button beside it
 * reaps.
 *
 * WHERE THE NUMBERS COME FROM. The {@link ProcessTracker}, which sweeps in the
 * background and owns the chat → pid attribution for everything in Dispatch —
 * this, the Resources page, and the kill below all read the same ownership, so
 * they cannot disagree about what a chat holds.
 *
 * TWO KINDS OF ROOT, because a chat owns two kinds of process:
 *   • its session subprocess — the harness runtime and every MCP server under it
 *   • its live shells       — `terminal({ background: true })` dev servers and
 *                             watchers, which TerminalService spawns off the
 *                             SERVER, not off the session
 */
import type { KillResult, ProcRow } from "./processes.js";
import { defaultAlive } from "./processes.js";
import { sameProcess, type ProcessTracker } from "./process-tracker.js";

/** What one chat is holding, split by who reaps it. */
export interface ChatProcessTally {
  /** Its runtime subprocess and every MCP server under it. Swept when idle. */
  session: number;
  /** Its background shells and their descendants. Swept only when idle AND empty. */
  shells: number;
}

/** Per-chat process totals, and when they were taken. */
export interface ChatProcessCounts {
  byChat: Record<string, ChatProcessTally>;
  at: number;
}

/** What a release did. */
export interface ReleaseResult {
  /** Processes the chats held that are gone now. */
  freed: number;
  /** Processes that outlived the session stop and the shell kills and were killed directly. */
  orphans: number;
}

export interface ChatProcessDeps {
  tracker: ProcessTracker;
  /** Kill every shell a chat owns, resolving once the tree-kills have FINISHED. */
  killShells: (chatId: string) => void | Promise<void>;
  /** Tree-kill by pid. Usually `ProcessService.killPids`. */
  killPids: (pids: number[]) => Promise<KillResult[]>;
  /** Is this pid still running? Defaults to a signal-0 probe. */
  alive?: (pid: number) => boolean;
}

export class ChatProcessService {
  private readonly tracker: ProcessTracker;
  private readonly killShells: (chatId: string) => void | Promise<void>;
  private readonly killPids: (pids: number[]) => Promise<KillResult[]>;
  private readonly alive: (pid: number) => boolean;

  constructor(deps: ChatProcessDeps) {
    this.tracker = deps.tracker;
    this.killShells = deps.killShells;
    this.killPids = deps.killPids;
    this.alive = deps.alive ?? defaultAlive;
  }

  /** Every chat's process total, from the latest background sweep. */
  async counts(): Promise<ChatProcessCounts> {
    const snap = await this.tracker.read();
    const byChat: Record<string, ChatProcessTally> = {};
    for (const [chatId, own] of snap.owners) {
      byChat[chatId] = { session: own.session.size, shells: own.shells.size };
    }
    return { byChat, at: snap.at };
  }

  /**
   * Stop these chats' sessions, kill their shells, and kill whatever survived
   * both — the one path the kill button, Pause's "kill processes", the
   * integration `release`, and chat deletion all go through.
   *
   * NO SCAN ON THE HAPPY PATH. It used to be: one fresh process-table read per
   * chat to find what to kill, another inside `killPids` to prune descendants,
   * and a third when the client repainted — each a `powershell.exe` CIM query,
   * 21 s end to end on a loaded box, and a second click during that wait looked
   * like the button had died. Now:
   *
   *   1. What each chat holds comes from the tracker's latest snapshot.
   *   2. The session stops and the shells are tree-killed through the HANDLES
   *      Dispatch already holds — no pid lookup involved. The shell kill is
   *      AWAITED: it used to be fire-and-forget, so the residual scan raced it
   *      and issued a second `taskkill` against trees already dying.
   *   3. Anything from step 1 still alive is an orphan (a Codex-launched
   *      browser MCP, a child that escaped its tree). Only THEN is a fresh
   *      sweep taken, and an orphan is killed only if the fresh row is the same
   *      process — same name, same start time — so a pid Windows recycled since
   *      the snapshot is never signalled.
   *   4. The dead pids are dropped from the snapshot at once, so the row
   *      repaints with the real number on the client's very next read.
   *
   * `stopSession` is the caller's because the callers differ: Pause must keep
   * what is queued behind it (`broker.stopKeepingQueued`), everything else
   * uses `broker.stop`.
   */
  async release(
    chatIds: readonly string[],
    stopSession: (chatId: string) => Promise<void>,
  ): Promise<ReleaseResult> {
    // Never scans when a sweep already exists; the very first one after boot
    // is the only time this waits.
    if (!this.tracker.latest()) await this.tracker.read().catch(() => undefined);
    // Which read the pids were captured from — the fresh sweep below has to
    // be a LATER read to count as evidence at all.
    const capturedSeq = this.tracker.latest()?.seq ?? 0;
    const captured = new Map<number, ProcRow>();
    for (const id of chatIds) {
      for (const row of this.tracker.owned(id)) captured.set(row.pid, row);
    }

    // Settled, not all: one chat failing to stop must not abandon the rest.
    await Promise.allSettled(
      chatIds.map(async (id) => {
        await stopSession(id).catch(() => {});
        await Promise.resolve(this.killShells(id)).catch(() => {});
      }),
    );

    let orphans = 0;
    const survivors = [...captured.values()].filter((r) => this.alive(r.pid));
    if (survivors.length > 0) {
      const fresh = await this.tracker.sweep();
      // A sweep whose read FAILED (CIM timeout, a dead worker — the loaded box
      // this exists for) hands back the previous snapshot, and comparing a
      // captured row against the very snapshot it came from is no identity
      // check at all: a recycled pid would sail through and get killed. No new
      // table, no orphan kill — the next click, or the next sweep, gets them.
      const reread = fresh.seq > capturedSeq;
      const targets = reread
        ? survivors.filter((r) => sameProcess(r, fresh.byPid.get(r.pid))).map((r) => r.pid)
        : [];
      if (targets.length > 0) {
        orphans = targets.length;
        await this.killPids(targets).catch(() => []);
      }
    }

    const gone = [...captured.keys()].filter((pid) => !this.alive(pid));
    this.tracker.forget(gone);
    return { freed: gone.length, orphans };
  }
}
