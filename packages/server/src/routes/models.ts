/**
 * REST for the composer's model picker.
 *   GET /api/models            → ModelOption[]  (cached ~5min)
 *   GET /api/models?refresh=1  → ModelOption[]  (re-probe the runtime now)
 *
 * Live from the Claude Code runtime's own model list, which works on
 * subscription auth with no API key. See services/models.ts.
 */
import type { FastifyInstance } from "fastify";
import { listAvailableModels } from "../services/models.js";

export function registerModelRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { refresh?: string } }>("/api/models", async (req) =>
    listAvailableModels({ refresh: req.query.refresh === "1" }),
  );
}
