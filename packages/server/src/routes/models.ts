/**
 * REST for the composer's model picker.
 *   GET /api/models            → ModelOption[]  (cached ~5min)
 *   GET /api/models?refresh=1  → ModelOption[]  (re-probe the runtime now)
 *
 * Live from the Claude Code runtime's own model list, which works on
 * subscription auth with no API key. See services/models.ts.
 */
import type { FastifyInstance } from "fastify";
import { HarnessKindSchema } from "@dispatch/shared";

export function registerModelRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { refresh?: string; harness?: string } }>("/api/models", async (req) => {
    const parsed = HarnessKindSchema.safeParse(req.query.harness ?? "claude");
    const kind = parsed.success ? parsed.data : "claude";
    const harness = app.services.harnesses.find(kind)!;
    return harness.listModels({ refresh: req.query.refresh === "1" });
  });

  app.get("/api/harnesses", async () =>
    app.services.harnesses.list().map((harness) => ({
      kind: harness.kind,
      runtime: harness.runtime(),
      capabilities: harness.capabilities,
    })),
  );
}
