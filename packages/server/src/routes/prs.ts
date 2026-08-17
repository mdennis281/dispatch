/**
 * REST for the tracked-PR catalog.
 *   GET  /api/prs?scope=&projectId=&chatId=&q=&since=&limit= → PrRecord[]
 *   POST /api/prs/refresh {key}                              → PrRecord (poll now)
 *
 * The GET is a pure read of `.data/prs.json` — no GitHub call, ever. That is the
 * point of the catalog: the old project overlay ran `gh pr list` on every open
 * and so could not render until the network answered. Clients hydrate from this
 * ONCE and then follow `pr-record-update` on the socket.
 *
 * Filtering goes through the same `RegistryQuery` predicate as `/api/worktrees`
 * and `/api/terminals`, so what a human filters for in the Workspace view and
 * what a programmatic caller asks for are the same question.
 */
import type { FastifyInstance } from "fastify";
import { parseRegistryQuery, RegistryQueryError } from "@dispatch/shared";

export function registerPrRoutes(app: FastifyInstance): void {
  const { prRegistry } = app.services;

  app.get("/api/prs", async (req, reply) => {
    try {
      // Inside the try: a filter we can't parse is a 400, not the 500 an escaped
      // zod error would produce.
      const query = parseRegistryQuery(req.query as Record<string, unknown>);
      return await prRegistry.list(query);
    } catch (err) {
      if (err instanceof RegistryQueryError) {
        return reply.code(400).send({ error: err.message });
      }
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Poll ONE row on demand — the catalog's per-row "check now". Without it the
  // only way to force a refresh is to wait out the adaptive cadence, which for a
  // parked PR is ten minutes; a roster you can't refresh is a roster you stop
  // trusting.
  app.post("/api/prs/refresh", async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string };
    if (!body.key) return reply.code(400).send({ error: "key required" });
    try {
      const rec = await prRegistry.refresh(body.key);
      if (!rec) return reply.code(404).send({ error: "PR not tracked" });
      return rec;
    } catch (err) {
      // A gh/GitHub failure is upstream's, not the caller's.
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
