/**
 * REST for stopping the app from inside the app.
 *   POST /api/shutdown → { ok: true }, then teardown begins
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
}
