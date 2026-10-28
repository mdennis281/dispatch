/**
 * REST for stopping the app from inside the app.
 *   POST /api/shutdown → { ok: true }, then teardown begins
 *   GET  /api/restart  → { supported, error? }
 *   POST /api/restart  { resumeAgents? } → { ok: true }, then the same teardown,
 *                       ending in the exit code the launcher relaunches on
 *
 * Until this existed the only stop verb was the literal string `shutdown` on the
 * process's stdin, which only the Python launcher can write — so "quit Dispatch"
 * meant leaving Dispatch, finding a terminal and running `pnpm app:stop`. The
 * UI's Stop button posts here instead.
 *
 * It is the SAME teardown as every other path (`installShutdown`'s closer), not
 * a second implementation: `services.dispose()` → `runner.stopAll()`, so subApps
 * and shells die with the server instead of orphaning themselves onto the ports
 * they hold. Nothing here kills anything directly.
 *
 * Two orderings matter and are enforced rather than hoped for:
 *   1. The `server-shutdown` bus event goes out before teardown, from inside the
 *      closer — so every client learns this was deliberate while its socket is
 *      still open.
 *   2. This response is fully flushed before the closer runs. Shutting down
 *      inside the handler would race `app.close()` against the reply and the
 *      caller would see a dropped connection instead of its `{ ok: true }`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * Breathing room after the response is on the wire, before teardown starts.
 * Covers the WS frame from ordering rule 1 reaching sockets that are slower than
 * the poster's own — a remote phone in host mode, say. Teardown takes seconds;
 * this costs nothing.
 */
const SETTLE_MS = 150;

export function registerShutdownRoutes(app: FastifyInstance): void {
  app.post("/api/shutdown", async (_req, reply) => {
    const closer = app.requestShutdown;
    if (!closer) {
      // Built but never wired for shutdown (tests, embedded use). Say so plainly
      // rather than 200-ing on a stop that is never going to happen.
      reply.code(503);
      return {
        ok: false,
        error:
          "this server was not started with shutdown wiring — stop it from the terminal (pnpm app:stop, or Ctrl-C)",
      };
    }

    reply.raw.once("finish", () => {
      setTimeout(() => void closer("api request"), SETTLE_MS).unref?.();
    });
    return { ok: true };
  });

  /**
   * Can this process restart itself? Asked by the Settings pane before it
   * offers the button, so `pnpm dev` shows why it can't rather than a button
   * that fails.
   */
  app.get("/api/restart", async () =>
    app.requestRestart ? { supported: true } : { supported: false, error: RESTART_UNSUPPORTED },
  );

  /**
   * Stop, then let the launcher start us again. Reloading a plugin's in-memory
   * settings after a hand edit to config.json used to mean Stop, then finding
   * the Start-menu shortcut.
   *
   * `resumeAgents: false` skips the restart-resume capture, so chats that were
   * mid-turn come back idle rather than carrying on. It defaults to TRUE
   * because that is what every other graceful stop already does, and a body
   * that forgot the field shouldn't quietly change it.
   */
  app.post("/api/restart", async (req, reply) => {
    const restart = app.requestRestart;
    if (!restart) {
      reply.code(503);
      return { ok: false, error: RESTART_UNSUPPORTED };
    }
    const parsed = RestartBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "resumeAgents must be a boolean" };
    }
    if (parsed.data.resumeAgents === false) app.services.restartResume.skipNextCapture();

    reply.raw.once("finish", () => {
      setTimeout(() => void restart("restart requested"), SETTLE_MS).unref?.();
    });
    return { ok: true };
  });
}

const RestartBody = z.object({ resumeAgents: z.boolean().optional() });

const RESTART_UNSUPPORTED =
  "this server wasn't started by the Dispatch launcher, so nothing would start it again. " +
  "Under pnpm dev, restart the dev process yourself";
