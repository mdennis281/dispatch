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
 */
import type { FastifyInstance } from "fastify";
import { envVar } from "./config.js";

/** How long teardown gets before we stop being polite. */
export const SHUTDOWN_GRACE_MS = 20_000;

export interface ShutdownOptions {
  graceMs?: number;
  /** Injected for tests so nothing actually exits the process. */
  exit?: (code: number) => void;
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
  let closing: Promise<void> | undefined;

  const close = (reason: string): Promise<void> => {
    if (closing) return closing;
    // eslint-disable-next-line no-console
    console.log(`[dispatch] shutting down (${reason})…`);
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
