/**
 * REST for a project's self-contained `.claude-manager/` config.
 *
 *   GET  /api/projects/:id/config         → { sourceDir, config, errors }
 *   POST /api/projects/:id/config/reload  → re-read from disk (sync + emit)
 *
 * `GET` returns the cached load if present, else loads fresh; `POST …/reload`
 * always re-reads disk, re-syncs the store, and broadcasts `project-config-update`.
 * A project with no `.claude-manager/` yields `{ sourceDir: null, config: null }`
 * (back-compat) rather than a 404.
 */
import type { FastifyInstance } from "fastify";

export function registerProjectConfigRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { projectConfig } = app.services;

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/config",
    async (req, reply) => {
      const project = await store.getProject(req.params.id).catch(() => null);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const cached = projectConfig.get(req.params.id);
      return cached ?? (await projectConfig.reload(req.params.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/config/reload",
    async (req, reply) => {
      const project = await store.getProject(req.params.id).catch(() => null);
      if (!project) return reply.code(404).send({ error: "project not found" });
      return projectConfig.reload(req.params.id);
    },
  );
}
