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
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "./bus.js";

/** Filename inside the state dir. Stable so `pnpm app:status` etc. can find it. */
export const CRASH_LOG_NAME = "crash.log";

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

  const record = (kind: string, err: unknown): void => {
    const stamp = now().toISOString();
    const detail = describe(err);
    const entry = `[${stamp}] ${kind}\n${detail}\n\n`;
    // Loud on stderr too — a `pnpm dev` terminal shows it immediately, and the
    // installed app's stderr is at least inherited by the supervisor.
    log(`[dispatch] ${kind} — the process SURVIVED this; see ${file}\n${detail}`);
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, entry, "utf8");
    } catch (writeErr) {
      // An unwritable state dir must not itself become the thing that kills us.
      log(`[dispatch] could not write ${file}: ${describe(writeErr)}`);
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
  };

  const onRejection = (reason: unknown): void => record("unhandledRejection", reason);
  const onException = (err: unknown): void => record("uncaughtException", err);

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  state.off = () => {
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
