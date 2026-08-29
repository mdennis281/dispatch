/**
 * REST for auto-resume after a deliberate restart.
 *   GET  /api/restart-resume          → RestartResumeStatus | null
 *   POST /api/restart-resume/stop     → the undo: interrupt every resumed turn
 *   POST /api/restart-resume/dismiss  → hide the banner for this process
 *
 * The status is in-memory and describes THIS boot, so there is nothing to page
 * or filter — a client either arrives while the banner is live or it does not.
 * The bus event carries the same payload, so a tab that was already open when
 * the resumes landed gets it pushed rather than having to poll for it.
 */
import type { FastifyInstance } from "fastify";

export function registerRestartResumeRoutes(app: FastifyInstance): void {
  const { restartResume } = app.services;

  app.get("/api/restart-resume", async () => restartResume.status());

  /**
   * Stop every turn this boot started on its own.
   *
   * Returns the ids it interrupted rather than the (now null) status, because
   * "which chats did that just touch" is the one thing the caller cannot work
   * out afterwards — the banner it was rendering is gone by then.
   */
  app.post("/api/restart-resume/stop", async () => ({
    stopped: await restartResume.stopResumed(),
  }));

  app.post("/api/restart-resume/dismiss", async () => {
    restartResume.dismiss();
    return { ok: true };
  });
}
