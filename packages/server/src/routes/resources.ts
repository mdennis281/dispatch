/**
 * Resource routes — what Dispatch is costing, at three levels of detail.
 *
 * SPLIT INTO THREE ENDPOINTS ON PURPOSE, because they cost wildly different
 * amounts and the client polls them at wildly different rates:
 *
 *   GET /api/resources/system   ~0.2 ms  — no subprocess at all. The header
 *                                          widget, every few seconds.
 *   GET /api/resources          ~800 ms  — needs the process table (shared and
 *                                          cached, so usually free). The
 *                                          Resources page, while it is open.
 *   GET /api/resources/chat/:id            — the per-process drill-down, only
 *                                          when a row is expanded.
 *
 * Folding the first into the second would make the cheap glance pay the
 * expensive scan's price, which is the specific mistake this feature exists to
 * avoid: a resource monitor must not be a meaningful consumer of resources.
 */
import type { FastifyInstance } from "fastify";

export function registerResourceRoutes(app: FastifyInstance): void {
  const { resources } = app.services;

  // The whole machine. Deliberately reads NOTHING from the process table, so
  // it is safe to poll on a human-visible cadence.
  app.get("/api/resources/system", async () => resources.system());

  // System + Dispatch's tree + every chat.
  app.get("/api/resources", async () => resources.snapshot());

  // Every process one chat holds. Separate from the snapshot because it is
  // per-row detail nobody needs until they open a row, and returning it for
  // every chat would mean shipping the whole process table to the browser.
  app.get<{ Params: { id: string } }>(
    "/api/resources/chat/:id",
    async (req) => resources.chatDetail(req.params.id),
  );
}
