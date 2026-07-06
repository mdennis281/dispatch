/**
 * REST for a project's self-contained `.claude-manager/` config.
 *
 *   GET  /api/projects/:id/config          → { sourceDir, config, errors }
 *   POST /api/projects/:id/config/reload    → re-read from disk (sync + emit)
 *   POST /api/projects/:id/config/scaffold  → derive a `.claude-manager/` from .data
 *   GET  /api/projects/:id/config/export    → the `.cm` zip (binary download)
 *   POST /api/projects/:id/config/import     → import a `.cm` (base64 body) → reload
 *
 * `GET` returns the cached load if present, else loads fresh; `POST …/reload`
 * always re-reads disk, re-syncs the store, and broadcasts `project-config-update`.
 * A project with no `.claude-manager/` yields `{ sourceDir: null, config: null }`
 * (back-compat) rather than a 404. Export/import round-trip the portable `.cm`
 * format; scaffold writes a starter config from the project's `.data` record.
 */
import type { FastifyInstance } from "fastify";

export function registerProjectConfigRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { projectConfig, projectConfigArchive } = app.services;

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

  // Scaffold a `.claude-manager/` from the project's `.data` record. `force`
  // rewrites an existing one; otherwise an existing dir is left untouched
  // (`created: false`) and just reloaded.
  app.post<{ Params: { id: string }; Body?: { force?: boolean } }>(
    "/api/projects/:id/config/scaffold",
    async (req, reply) => {
      const force = !!(req.body as { force?: boolean } | undefined)?.force;
      const out = await projectConfigArchive.scaffold(req.params.id, { force });
      if (!out) return reply.code(404).send({ error: "project not found" });
      return out;
    },
  );

  // Export the project's `.claude-manager/` as a `.cm` zip (binary download).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/config/export",
    async (req, reply) => {
      const out = await projectConfigArchive.exportArchive(req.params.id);
      if (!out) return reply.code(404).send({ error: "project not found" });
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="${out.filename}"`,
      );
      return reply.send(out.buffer);
    },
  );

  // Import a `.cm` archive (base64 in the JSON body) into the project's
  // `.claude-manager/`, then reload. Overlays existing files; path-guarded.
  app.post<{ Params: { id: string }; Body?: { data?: string } }>(
    "/api/projects/:id/config/import",
    async (req, reply) => {
      const data = (req.body as { data?: string } | undefined)?.data;
      if (typeof data !== "string" || !data) {
        return reply.code(400).send({ error: "data (base64 .cm archive) required" });
      }
      const b64 = /^data:[^;,]*;base64,(.*)$/s.exec(data)?.[1] ?? data;
      let buffer: Buffer;
      try {
        buffer = Buffer.from(b64, "base64");
      } catch {
        return reply.code(400).send({ error: "invalid base64 payload" });
      }
      if (!buffer.length) return reply.code(400).send({ error: "empty archive" });
      try {
        const out = await projectConfigArchive.importArchive(req.params.id, buffer);
        if (!out) return reply.code(404).send({ error: "project not found" });
        return out;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
