/**
 * REST for the composer's model picker.
 *   GET /api/models → ModelOption[]
 *
 * Live from the Anthropic Models API when an ANTHROPIC_API_KEY is set, otherwise
 * a curated static fallback. See services/models.ts.
 */
import type { FastifyInstance } from "fastify";
import { listAvailableModels } from "../services/models.js";

export function registerModelRoutes(app: FastifyInstance): void {
  app.get("/api/models", async () => listAvailableModels());
}
