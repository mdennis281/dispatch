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
import { BUILTIN_MODE_CONFIGS, ModeConfigSchema, isProtectedMode } from "@dispatch/shared";
import { mergeById } from "../services/project-config.js";

export function registerModeRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { projectConfig } = app.services;

  // Merge config-sourced modes (from any project's `.dispatch/modes/`)
  // OVER the `.data` store — the repo config wins on id collision — so the
  // composer's mode picker (and the broker) see the config-authored postures.
  /**
   * A PROTECTED id is reported as its built-in self and never as a stored or
   * project-authored row — the same rule `mode-editor` applies to the MCP
   * surface, for the same reason. The broker resolves those ids from the
   * built-in record before it looks at either authored layer, so returning an
   * authored copy here would have the client labelling and offering to edit a
   * policy that is not the one being enforced.
   */
  app.get("/api/modes", async () => {
    const merged = mergeById(projectConfig.configModes(), await store.listModes());
    return [
      ...merged.filter((m) => !isProtectedMode(m.id)),
      ...Object.values(BUILTIN_MODE_CONFIGS),
    ];
  });

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
    if (isProtectedMode(parsed.data.id)) return reply.code(400).send({ error: reservedMode(parsed.data.id) });
    return reply.code(201).send(await store.saveMode(parsed.data));
  });

  app.get<{ Params: { id: string } }>("/api/modes/:id", async (req, reply) => {
    const builtin = BUILTIN_MODE_CONFIGS[req.params.id];
    if (isProtectedMode(req.params.id) && builtin) return builtin;
    const mode = await store.getMode(req.params.id);
    if (!mode) return reply.code(404).send({ error: "not found" });
    return mode;
  });

  app.put<{ Params: { id: string } }>("/api/modes/:id", async (req, reply) => {
    if (isProtectedMode(req.params.id)) {
      return reply.code(400).send({ error: reservedMode(req.params.id) });
    }
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
      if (isProtectedMode(req.params.id)) {
        return reply.code(400).send({ error: reservedMode(req.params.id) });
      }
      await store.deleteMode(req.params.id);
      return reply.code(204).send();
    },
  );
}

/** Why a write to a protected id fails — the same answer the MCP editor gives. */
function reservedMode(id: string): string {
  return (
    `"${id}" is a built-in posture and cannot be created, edited or deleted. The broker ` +
    "resolves it from the built-in record, so a stored copy would be a policy nobody enforces."
  );
}
