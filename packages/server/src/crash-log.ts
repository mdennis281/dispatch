/**
 * Process-level crash net.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Nothing in this server installed `unhandledRejection` / `uncaughtException`
 * handlers, and since Node 15 an unhandled rejection is FATAL by default. So a
 * single stray `void somePromise()` anywhere in the tree — one whose callee
 * rejected on a path nobody guarded — terminated the whole process, taking every
 * live SDK session, every subApp and the user's in-flight chat with it.
 *
 * That happened twice on 2026-08-07 (server restarted 21:04:52; two chats in two
 * different projects were active, and both crash windows begin exactly at a
 * message sent to the SECOND project's chat). The reason it took a forensic
 * timeline reconstruction to find *that much* is the second half of the bug:
 * the death left NO record anywhere. `tools/app/launch.py` inherits stdout/stderr,
 * and under `pythonw` there is no console, so Node's final stack trace was
 * written to a handle that goes nowhere. The Windows Application log has no entry
 * either — a Node fatal error is an orderly `exit(1)`, not an SEH fault, so
 * Windows Error Reporting never sees it.
 *
 * This module fixes both halves:
 *  1. A stray rejection no longer kills the app. Losing one background poll is
 *     always a better trade than losing a three-hour agent run.
 *  2. Whatever did fire is appended to `<dataDir>/crash.log` with a full stack,
 *     so the NEXT one is diagnosable from the file instead of from transcript
 *     archaeology.
 *
 * Writes are `appendFileSync` on purpose: the whole point is a record that
 * survives, and an async write loses the race against a process that is exiting
 * for some *other* reason moments later.
 *
 * ── The net used to be the crash (2026-08-08) ───────────────────────────────
 * The first version turned the fatal crash into an infinite one. A single Node
 * process warning (a `MaxListenersExceededWarning`) was written to stderr; under
 * the installed launcher stderr is a pipe with no reader, so that write threw
 * EPIPE; the throw became an `uncaughtException`; this handler recorded it by
 * writing to stderr, which threw EPIPE, which... 391,428 entries and 106 MB in
 * roughly three minutes, off ONE seed fault.
 *
 * So the invariant here is stronger than "log the crash": **nothing in `record`
 * may throw, and `record` may not re-enter.** Both are enforced below, and the
 * second is what makes it robust against the failure we did NOT predict — the
 * first version did wrap its file write and its bus publish, and still looped,
 * because the console write nobody thought could fail was the one that did.
 *
 * ── And that still wasn't it (same day, second attempt) ─────────────────────
 * Wrapping the console write in `try/catch` did not stop the loop either. These
 * are ASYNC pipe writes on Windows: `console.error` returns normally and the
 * EPIPE arrives later as an `error` event on the stream, which — with no
 * listener — is itself an uncaught exception. So the fault landed back here
 * with `record` already returned and the `try` block long exited, carrying a
 * stack captured at write time that pointed straight at the guarded call and
 * made it look synchronous. The evidence agreed with the wrong theory.
 *
 * What actually fixes it is attaching an `error` listener to stdout/stderr, so
 * the failed write is a handled event rather than a crash. The lesson worth
 * keeping: a stack trace tells you where a write STARTED, not where it failed.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "./bus.js";

/** Filename inside the state dir. Stable so `pnpm app:status` etc. can find it. */
export const CRASH_LOG_NAME = "crash.log";

/**
 * Rotate the log past this, keeping one generation as `crash.log.1`.
 *
 * A crash log is only useful if a human can open it. The self-feeding loop this
 * module used to run reached 106 MB in about three minutes — large enough that
 * reading it needed `head`, and large enough to matter on disk. The re-entrancy
 * guard below means that can't recur, but an unbounded append-only file is worth
 * a cap regardless: it is written by definition when things are going wrong.
 */
export const CRASH_LOG_MAX_BYTES = 5_000_000;

export interface CrashNetOptions {
  /** State dir the log is written into (`config.dataDir`). */
  dataDir: string;
  /** Optional bus — surfaces the fault in the UI instead of only on disk. */
  bus?: EventBus;
  /** Injected for tests so nothing touches the real console/clock. */
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Render an unknown thrown value as a stack trace when it has one. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * The one live installation, or undefined when the net is off.
 *
 * Module-level because `process.on` is: two live nets mean two handler pairs,
 * every crash appended to `crash.log` twice, and an uninstall that only takes
 * half of them down.
 */
interface LiveNet {
  /** Mutable — see {@link attachCrashBus}. Read at FIRE time, not install time. */
  bus?: EventBus;
  off: () => void;
}
let live: LiveNet | undefined;

/**
 * Install the net. Returns an uninstall fn.
 *
 * Installing twice REPLACES the live net rather than stacking a second pair of
 * `process.on` handlers. Replacing — rather than ignoring the second call — is
 * what keeps re-installing with different options possible, which tests need.
 */
export function installCrashNet(opts: CrashNetOptions): () => void {
  live?.off();

  const now = opts.now ?? (() => new Date());
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((m: string) => console.error(m));
  const file = join(opts.dataDir, CRASH_LOG_NAME);
  const state: LiveNet = { bus: opts.bus, off: () => {} };

  /**
   * True while `record` is on the stack.
   *
   * THE loop-breaker. Every write below can throw, and a throw inside an
   * `uncaughtException` handler is itself an uncaught exception — which re-enters
   * this very handler, synchronously, forever. That is not hypothetical: it ran
   * 391,428 times on 2026-08-08 off a SINGLE seed fault, from the one unguarded
   * line in this function.
   *
   * Guarding each individual call site is not enough, because it only covers the
   * throws we thought of. This covers re-entry itself, whatever the source.
   */
  let recording = false;
  /** Faults dropped because they arrived while `recording` — reported on the next. */
  let dropped = 0;

  /**
   * Console output that cannot take the process down.
   *
   * Under the installed launcher, stderr is a pipe whose read end is gone —
   * `launch.py` runs under `pythonw`, which has no console.
   *
   * ── The try/catch here was NOT enough, and the reason matters ──────────────
   * On Windows these are ASYNC pipe writes. `console.error` queues and returns
   * normally; the EPIPE surfaces later as an `error` event on the stream. A
   * stream `error` event with no listener IS an uncaught exception — so the
   * fault arrives at `onException` long after `safeLog`'s `try` block has
   * exited, carrying a stack captured at write time that makes it LOOK
   * synchronous. `recording` cannot help either: by then `record` has returned,
   * so every one of them is a fresh top-level fault.
   *
   * The first fix read the stack, believed it, and wrapped the call. The result
   * was a loop that no longer recursed but still ran flat out — bounded only by
   * log rotation. The error listeners below are the actual fix: with a listener
   * attached, the failure is a handled event and never becomes a crash at all.
   *
   * Latched, so once the pipe is known dead nothing writes to it again.
   */
  let consoleDead = false;

  /**
   * Adopt stdout/stderr's `error` events.
   *
   * This is the load-bearing line. Without it every failed write to a dead pipe
   * is an uncaught exception; with it, it is a no-op that flips `consoleDead`.
   * Removed on uninstall so tests don't stack listeners on the real streams.
   */
  const onStreamError = (): void => {
    consoleDead = true;
  };
  const streams = [process.stdout, process.stderr];
  for (const s of streams) s.on("error", onStreamError);
  const safeLog = (msg: string): void => {
    if (consoleDead) return;
    try {
      log(msg);
    } catch {
      consoleDead = true;
    }
  };

  /** Keep one generation, so a fresh fault can't be buried by an old flood. */
  const rotateIfHuge = (): void => {
    try {
      if (statSync(file).size < CRASH_LOG_MAX_BYTES) return;
      renameSync(file, `${file}.1`);
    } catch {
      /* no log yet, or a locked file — appending is still the priority */
    }
  };

  const record = (kind: string, err: unknown): void => {
    if (recording) {
      dropped++;
      return;
    }
    recording = true;
    try {
      const stamp = now().toISOString();
      const detail = describe(err);
      // Loud on stderr too — a `pnpm dev` terminal shows it immediately, and the
      // installed app's stderr is at least inherited by the supervisor.
      safeLog(`[dispatch] ${kind} — the process SURVIVED this; see ${file}\n${detail}`);
      // Counted AFTER the console write, which is the most likely thing to fault
      // and re-enter — so the entry we are about to write accounts for it.
      const note = dropped ? `  (${dropped} further fault(s) suppressed while recording)\n` : "";
      const entry = `[${stamp}] ${kind}\n${detail}\n${note}\n`;
      dropped = 0;
      try {
        mkdirSync(dirname(file), { recursive: true });
        rotateIfHuge();
        appendFileSync(file, entry, "utf8");
      } catch (writeErr) {
        // An unwritable state dir must not itself become the thing that kills us.
        safeLog(`[dispatch] could not write ${file}: ${describe(writeErr)}`);
      }
      // Best-effort UI surfacing. Read off `state`, not `opts`, so a bus attached
      // AFTER install still receives this — see attachCrashBus. Wrapped because a
      // throwing bus subscriber here would re-enter this very handler.
      try {
        state.bus?.publish({
          type: "error",
          message: `Internal error (${kind}) — the server stayed up`,
          detail: detail.split("\n")[0],
        });
      } catch {
        /* the disk record is the one that matters */
      }
    } catch {
      // Nothing in here gets to escape. An exception leaving an
      // `uncaughtException` handler is an uncaught exception, and we would be
      // back at the top of this function with `recording` already reset by the
      // `finally` — the same infinite loop by a different door.
    } finally {
      recording = false;
    }
  };

  const onRejection = (reason: unknown): void => record("unhandledRejection", reason);
  const onException = (err: unknown): void => record("uncaughtException", err);

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  state.off = () => {
    for (const s of streams) s.off("error", onStreamError);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    // Only surrender the slot if we still hold it: a later install already
    // replaced us, and our uninstall must not tear down ITS handlers.
    if (live === state) live = undefined;
  };
  live = state;
  return state.off;
}

/**
 * Point the live net's bus at `bus`, so a survived crash also reaches the UI.
 *
 * `start()` installs the net as its very first statement — deliberately, because
 * everything it goes on to await can reject — but `app.cm.bus` does not exist
 * until `buildApp()` has returned. Binding late is what closes that gap: the net
 * reads its bus when a crash FIRES, so the handlers never have to come down and
 * be rebuilt, and the "installed before anything can reject" property stays
 * literally true.
 *
 * Without this the publish is a permanent no-op in production and a crash is
 * only ever visible in `crash.log`. No-op when nothing is installed.
 */
export function attachCrashBus(bus: EventBus): void {
  if (live) live.bus = bus;
}
