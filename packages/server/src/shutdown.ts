/**
 * Graceful shutdown for the server process.
 *
 * Nothing in the app tore down on a kill signal before this: `services.dispose()`
 * (and with it `runner.stopAll()`, the broker teardown, and the persistent
 * shells) only runs from Fastify's `onClose`, which only fires if someone calls
 * `app.close()`. A bare `taskkill`/Ctrl-C therefore left every subApp dev server
 * running as an orphan — exactly the state the Ports & processes panel exists to
 * clean up after.
 *
 * ── Why stdin and not just SIGTERM ──────────────────────────────────────────
 * Windows has no POSIX signal delivery: `process.kill(pid, 'SIGTERM')` maps to
 * `TerminateProcess`, which kills abruptly and never runs a handler. So the
 * desktop shell — which owns this process — asks over stdin instead, and only
 * escalates to a tree-kill if the grace window expires. SIGINT/SIGTERM are still
 * wired for the terminal (`pnpm start`) and POSIX cases.
 *
 * ── Why the shells are reaped FIRST, and then again on `exit` ───────────────
 * `services.dispose()` did kill the persistent shells — as its LAST step, behind
 * `runner.stopAll()`, `broker.dispose()` and `harnesses.dispose()`, inside the
 * grace window below. Miss that window and `exit(1)` fires with every shell
 * still running; `launch.py` then waits its own 25s and calls `proc.kill()`,
 * which on Windows is a `TerminateProcess` on the SERVER ALONE. Every
 * `powershell.exe` it spawned, and every dev server under those, survives —
 * holding its port, invisible, with nothing left that knows it exists.
 *
 * That makes the shells the one teardown step whose omission is externally
 * visible, so they go first (`reapTerminals`, awaited with its own budget) and
 * again from a synchronous `exit` handler that no async teardown can outrun.
 * Both are idempotent; running the reap twice costs nothing and skipping it
 * costs a port.
 */
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { envVar } from "./config.js";

/** How long teardown gets before we stop being polite. */
export const SHUTDOWN_GRACE_MS = 20_000;

/**
 * How long the shell reap gets before the rest of teardown starts anyway.
 *
 * Deliberately a fraction of the grace window: this is a `taskkill` per shell
 * plus a flush of buffered output, all local, and the point of moving it to the
 * front is that it finishes long before anything slow. A reap that somehow
 * wedges must not become the new reason teardown is cut off — the `exit`
 * backstop covers whatever it didn't reach.
 */
export const REAP_BUDGET_MS = 5_000;

export interface ShutdownOptions {
  graceMs?: number;
  /** Injected for tests so nothing actually exits the process. */
  exit?: (code: number) => void;
  /**
   * Injected for tests. Real implementation tree-kills SYNCHRONOUSLY — see
   * {@link syncKillTree} for why an `exit` handler leaves no other option.
   */
  killTreeSync?: (pid: number) => void;
}

/**
 * Tree-kill a pid with a BLOCKING call.
 *
 * `tree-kill` (what everything else in the app uses) spawns `taskkill` and
 * reports back through a callback — so from inside a `process.on("exit")`
 * handler it never runs at all: the event loop is finished, and the process is
 * gone before the spawn is serviced. `execFileSync` is the only shape that
 * completes there, which is exactly why this duplicates a primitive that
 * already exists rather than reusing it.
 */
function syncKillTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // `/T` is the whole point: without it this kills the shell and leaves the
      // dev server it started holding the port.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 2_000,
      });
    } else {
      // Negative pid = the process GROUP, the POSIX equivalent of `/T`.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already dead, never existed, or not ours — nothing better to try */
  }
}

/**
 * Wire signal + stdin shutdown onto `app`. Idempotent per call: the first
 * trigger wins and later ones are ignored, so a SIGINT during teardown can't
 * re-enter `app.close()`.
 */
export function installShutdown(
  app: FastifyInstance,
  opts: ShutdownOptions = {},
): () => Promise<void> {
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const killTreeSync = opts.killTreeSync ?? syncKillTree;
  let closing: Promise<void> | undefined;

  /**
   * Flush every shell's buffered output and kill it — the first thing teardown
   * does, and bounded so it can never be the step that eats the grace window.
   * A server built without services (the unit tests) simply has nothing to reap.
   */
  const reapTerminals = async (): Promise<void> => {
    const terminals = app.services?.terminals;
    if (!terminals) return;
    // The catch goes on the reap ITSELF, not around the race. If the budget
    // wins, the race stops looking at this promise but the promise keeps
    // running — and a rejection arriving after that is an unhandled rejection,
    // which `installCrashNet` records as a crash. A shutdown that reports
    // itself as a crash is worse than the slow reap it was reporting.
    const reaped = terminals.reap().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[dispatch] error reaping shells:", err);
    });
    await Promise.race([
      reaped,
      new Promise((r) => setTimeout(r, REAP_BUDGET_MS).unref?.()),
    ]);
  };

  /**
   * The last line of defence: whatever pids the service still reports LIVE when
   * this process is on its way out, killed synchronously.
   *
   * Registered unconditionally because the paths that reach here are the ones
   * that skipped everything else — the grace timer's `exit(1)`, a `process.exit`
   * from elsewhere, a normal end after teardown already ran (where this finds an
   * empty list and does nothing).
   */
  process.on("exit", () => {
    const live = app.services?.terminals?.livePids?.() ?? [];
    for (const { pid } of live) killTreeSync(pid);
  });

  const close = (reason: string): Promise<void> => {
    if (closing) return closing;
    // eslint-disable-next-line no-console
    console.log(`[dispatch] shutting down (${reason})…`);
    // Tell every connected client FIRST, while the sockets are still up. A tab
    // that only sees its socket die can't tell a deliberate stop from a crash,
    // and would reconnect-loop forever — which in host mode means someone's
    // phone across the house spinning at a server that isn't coming back.
    // Guarded because `installShutdown` is also called on apps built for tests.
    try {
      app.services?.bus?.publish({ type: "server-shutdown", reason });
    } catch {
      /* no bus (or a listener threw) — teardown matters more than the notice */
    }
    closing = (async () => {
      // A wedged dispose (a hung `git`, a docker compose that won't stop) must
      // not strand the process forever — the shell would tree-kill us anyway,
      // and exiting on our own terms at least lets the rest of teardown land.
      const timer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.error(`[dispatch] teardown exceeded ${graceMs}ms; exiting anyway`);
        exit(1);
      }, graceMs);
      timer.unref();
      // BEFORE `app.close()`, deliberately. Inside it, this is the last step of
      // `services.dispose()` and the first casualty of the timer above.
      await reapTerminals();
      try {
        await app.close();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[dispatch] error during teardown:", err);
      }
      clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.log("[dispatch] shutdown complete");
      exit(0);
    })();
    return closing;
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  // The in-app Stop button's only route to teardown (see routes/shutdown.ts).
  // Decorated here rather than in `buildApp` so that a server which was never
  // wired for shutdown can't be asked to perform one.
  //
  // Guarded because this function's real contract is "anything with close()" —
  // the unit tests hand it a two-line stand-in, and requiring a whole Fastify
  // instance just to test signal handling would be a worse trade than this `if`.
  if (typeof app.decorate === "function") {
    app.decorate("requestShutdown", (reason: string) => close(reason));
  }

  // Only when a parent process owns us (the desktop shell sets this). Reading
  // stdin unconditionally would hold the event loop open for a plain terminal run.
  if (envVar(process.env, "IPC") === "1") {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (String(chunk).includes("shutdown")) void close("desktop request");
    });
    // Parent vanished (crash / force-quit) — tear down rather than linger and
    // keep holding the port and every subApp it spawned.
    process.stdin.on("end", () => void close("stdin closed"));
    process.stdin.on("error", () => void close("stdin error"));
    process.stdin.resume();
  }

  return () => close("programmatic");
}
