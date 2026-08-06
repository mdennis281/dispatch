/**
 * REST CRUD for per-project agent memory (durable, cross-chat facts). The Memory
 * panel drives these; the agent's `mcp__manager__remember|recall|forget` tools
 * hit the same MemoryService, and every mutation publishes a `memory-update` /
 * `memory-deleted` bus event so open UIs live-update.
 *
 *   GET    /api/projects/:projectId/memory         → ProjectMemory[]
 *   GET    /api/projects/:projectId/memory/stats   → { entries, pruneCandidates }
 *   GET    /api/projects/:projectId/memory/:name   → ProjectMemory | 404
 *   POST   /api/projects/:projectId/memory         → create/update (dedupe by name)
 *   PUT    /api/projects/:projectId/memory/:name   → update (name from the path)
 *   DELETE /api/projects/:projectId/memory/:name   → 204 | 404
 */
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { MemoryTypeSchema } from "@dispatch/shared";

const MemoryBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().default(""),
  type: MemoryTypeSchema.default("project"),
  body: z.string().default(""),
});

export function registerMemoryRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { memory } = app.services;

  /** 404 unless the project entity exists (also guards a stray projectId). */
  async function ensureProject(projectId: string): Promise<boolean> {
    const project = await store.getProject(projectId).catch(() => null);
    return !!project;
  }

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/memory",
    async (req, reply) => {
      if (!(await ensureProject(req.params.projectId))) {
        return reply.code(404).send({ error: "project not found" });
      }
      return memory.list(req.params.projectId);
    },
  );

  /**
   * Access telemetry for a project's memories — usefulness counts (how often each
   * was recalled/surfaced) plus the current prune candidates. Read-only curation
   * data for the Memory panel. Registered before `/memory/:name` so "stats" isn't
   * swallowed as a memory name.
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/memory/stats",
    async (req, reply) => {
      if (!(await ensureProject(req.params.projectId))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const [entries, prunable] = await Promise.all([
        memory.accessStats(req.params.projectId),
        memory.pruneCandidates(req.params.projectId),
      ]);
      return { entries, pruneCandidates: prunable.map((m) => m.name) };
    },
  );

  app.get<{ Params: { projectId: string; name: string } }>(
    "/api/projects/:projectId/memory/:name",
    async (req, reply) => {
      const found = await memory.read(req.params.projectId, req.params.name);
      if (!found) return reply.code(404).send({ error: "not found" });
      return found;
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/memory",
    async (req, reply) => {
      if (!(await ensureProject(req.params.projectId))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const parsed = MemoryBodySchema.safeParse(req.body ?? {});
      if (!parsed.success || !parsed.data.name?.trim()) {
        return reply
          .code(400)
          .send({ error: parsed.success ? "name is required" : parsed.error.message });
      }
      try {
        const saved = await memory.write(req.params.projectId, {
          name: parsed.data.name,
          description: parsed.data.description,
          type: parsed.data.type,
          body: parsed.data.body,
        });
        return reply.code(201).send(saved);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put<{ Params: { projectId: string; name: string } }>(
    "/api/projects/:projectId/memory/:name",
    async (req, reply) => {
      if (!(await ensureProject(req.params.projectId))) {
        return reply.code(404).send({ error: "project not found" });
      }
      const parsed = MemoryBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      try {
        const saved = await memory.write(req.params.projectId, {
          name: req.params.name,
          description: parsed.data.description,
          type: parsed.data.type,
          body: parsed.data.body,
        });
        return saved;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete<{ Params: { projectId: string; name: string } }>(
    "/api/projects/:projectId/memory/:name",
    async (req, reply) => {
      const removed = await memory.delete(req.params.projectId, req.params.name);
      if (!removed) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );
}
