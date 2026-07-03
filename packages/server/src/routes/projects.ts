/**
 * REST CRUD for projects. A project = one repo with many subApps.
 *   GET    /api/projects            → Project[]
 *   POST   /api/projects            → create (id/createdAt/subApps defaulted)
 *   GET    /api/projects/:id        → Project | 404
 *   PUT    /api/projects/:id        → replace/merge
 *   DELETE /api/projects/:id        → 204
 *   GET    /api/projects/:id/worktrees → WorktreeInfo[] (live `git worktree list`)
 */
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { ProjectSchema, type Project } from "@cm/shared";

export function registerProjectRoutes(app: FastifyInstance): void {
  const { store, bus } = app.cm;
  const { worktrees } = app.services;

  app.get("/api/projects", async () => store.listProjects());

  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const draft = {
      subApps: [],
      ...body,
      id: (body.id as string) || nanoid(),
      createdAt: (body.createdAt as number) ?? Date.now(),
    };
    const parsed = ProjectSchema.safeParse(draft);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const saved = await store.saveProject(parsed.data);
    bus.publish({ type: "project-update", project: saved });
    return reply.code(201).send(saved);
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const project = await store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "not found" });
      return project;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const existing = await store.getProject(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = {
        subApps: [],
        createdAt: existing?.createdAt ?? Date.now(),
        ...existing,
        ...body,
        id: req.params.id,
      };
      const parsed = ProjectSchema.safeParse(merged);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const saved = await store.saveProject(parsed.data);
      bus.publish({ type: "project-update", project: saved });
      return saved;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      await store.deleteProject(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/worktrees",
    async (req, reply) => {
      const project: Project | null = await store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "not found" });
      try {
        return await worktrees.list(project);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
