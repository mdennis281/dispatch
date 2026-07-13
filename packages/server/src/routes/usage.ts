/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
 * The server polls this on a timer too and pushes `usage-update` over the bus;
 * these routes cover initial load + manual refresh.
 */
import type { FastifyInstance } from "fastify";

export function registerUsageRoutes(app: FastifyInstance): void {
  const { usage } = app.services;

  app.get("/api/usage", async () => usage.get());

  app.post("/api/usage/refresh", async () => usage.refresh());
}
