/**
 * REST for a project's self-contained `.dispatch/` config.
 *
 *   GET  /api/projects/:id/config          → { sourceDir, config, errors }
 *   PUT  /api/projects/:id/config/workflow  → save the workflow block (manifest or .data)
 *   DELETE /api/projects/:id/config/item    → delete one config file (path-guarded)
 *   POST /api/projects/:id/config/reload    → re-read from disk (sync + emit)
 *   POST /api/projects/:id/config/scaffold  → derive a `.dispatch/` from .data
 *   GET  /api/projects/:id/config/export    → the `.dispatch` zip (binary download)
 *   POST /api/projects/:id/config/import     → import an archive (base64 body) → reload
 *
 * `GET` returns the cached load if present, else loads fresh; `POST …/reload`
 * always re-reads disk, re-syncs the store, and broadcasts `project-config-update`.
 * A project with no `.dispatch/` yields `{ sourceDir: null, config: null }`
 * (back-compat) rather than a 404. Export/import round-trip the portable `.dispatch`
 * format; scaffold writes a starter config from the project's `.data` record.
 */
import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ShellTranscriptFilterSchema, WorkflowConfigSchema } from "@dispatch/shared";
import { saveProjectShellFilter, saveProjectWorkflow } from "../services/workflow-writer.js";
import { safeArchivePath } from "../services/project-config-archive.js";

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

  // Save the project's workflow block. Routed to the manifest when the repo has
  // one (else `.data`) — see workflow-writer: writing a manifest-backed project
  // to `.data` reverts on the next config reload, which reads as "it didn't save".
  app.put<{ Params: { id: string } }>(
    "/api/projects/:id/config/workflow",
    async (req, reply) => {
      const parsed = WorkflowConfigSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      try {
        const out = await saveProjectWorkflow(
          { store, projectConfig },
          req.params.id,
          parsed.data,
        );
        if (!out) return reply.code(404).send({ error: "project not found" });
        app.services.bus.publish({ type: "project-update", project: out.project });
        return out;
      } catch (err) {
        // A hand-broken project.yaml surfaces here as a 400 with the real reason
        // (rather than a 500) — the user can fix the file and save again.
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/projects/:id/config/shell-filter",
    async (req, reply) => {
      const raw = (req.body as { shellFilter?: unknown } | undefined)?.shellFilter;
      const parsed = raw === null || raw === undefined
        ? { success: true as const, data: undefined }
        : ShellTranscriptFilterSchema.safeParse(raw);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      try {
        const out = await saveProjectShellFilter(
          { store, projectConfig },
          req.params.id,
          parsed.data,
        );
        if (!out) return reply.code(404).send({ error: "project not found" });
        app.services.bus.publish({ type: "project-update", project: out.project });
        return out;
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Delete one file (or skill directory) from the project's config dir. `rel` is
  // relative to that dir and traversal-guarded, so this endpoint can only ever
  // reach inside `.dispatch/` — never the rest of the repo.
  app.delete<{ Params: { id: string }; Querystring: { rel?: string } }>(
    "/api/projects/:id/config/item",
    async (req, reply) => {
      const project = await store.getProject(req.params.id).catch(() => null);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const sourceDir = projectConfig.get(req.params.id)?.sourceDir;
      if (!sourceDir) return reply.code(400).send({ error: "project has no config dir" });

      const rel = safeArchivePath(req.query.rel ?? "");
      if (!rel) return reply.code(400).send({ error: "invalid path" });
      // The manifest is the config — deleting it orphans everything else. Edit it
      // (or remove the whole dir) instead.
      if (rel === "project.yaml") {
        return reply.code(400).send({ error: "refusing to delete project.yaml" });
      }
      try {
        await rm(join(sourceDir, rel), { recursive: true, force: true });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
      return projectConfig.reload(req.params.id);
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

  // Scaffold a `.dispatch/` from the project's `.data` record. `force`
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

  // Export the project's `.dispatch/` as a `.dispatch` zip (binary download).
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

  // Import an archive (base64 in the JSON body) into the project's
  // `.dispatch/`, then reload. Overlays existing files; path-guarded.
  app.post<{ Params: { id: string }; Body?: { data?: string } }>(
    "/api/projects/:id/config/import",
    async (req, reply) => {
      const data = (req.body as { data?: string } | undefined)?.data;
      if (typeof data !== "string" || !data) {
        return reply.code(400).send({ error: "data (base64 archive) required" });
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
