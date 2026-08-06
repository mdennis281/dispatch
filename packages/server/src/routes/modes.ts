/**
 * REST CRUD for mode configs (a named permission posture + instruction overlay).
 *   GET    /api/modes        → ModeConfig[]
 *   POST   /api/modes        → create (id defaulted)
 *   GET    /api/modes/:id     → ModeConfig | 404
 *   PUT    /api/modes/:id     → merge
 *   DELETE /api/modes/:id     → 204
 */
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { ModeConfigSchema } from "@dispatch/shared";
import { mergeById } from "../services/project-config.js";

export function registerModeRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { projectConfig } = app.services;

  // Merge config-sourced modes (from any project's `.dispatch/modes/`)
  // OVER the `.data` store — the repo config wins on id collision — so the
  // composer's mode picker (and the broker) see the config-authored postures.
  app.get("/api/modes", async () =>
    mergeById(projectConfig.configModes(), await store.listModes()),
  );

  app.post("/api/modes", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = ModeConfigSchema.safeParse({
      scope: "global",
      ...body,
      id: (body.id as string) || nanoid(),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    return reply.code(201).send(await store.saveMode(parsed.data));
  });

  app.get<{ Params: { id: string } }>("/api/modes/:id", async (req, reply) => {
    const mode = await store.getMode(req.params.id);
    if (!mode) return reply.code(404).send({ error: "not found" });
    return mode;
  });

  app.put<{ Params: { id: string } }>("/api/modes/:id", async (req, reply) => {
    const existing = await store.getMode(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = ModeConfigSchema.safeParse({
      scope: "global",
      ...existing,
      ...body,
      id: req.params.id,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    return store.saveMode(parsed.data);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/modes/:id",
    async (req, reply) => {
      await store.deleteMode(req.params.id);
      return reply.code(204).send();
    },
  );
}
