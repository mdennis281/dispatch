import type { FastifyInstance } from "fastify";
import { ChatSchema } from "@dispatch/shared";
import { configPathsFor } from "../services/config-location.js";
import { listPersonas } from "../services/personas.js";
import { ensureSession } from "./dispatch.js";

export function registerPersonaRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/personas", async (req, reply) => {
    const project = await app.cm.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const paths = configPathsFor(project, app.cm.store.projectConfigDir(project.id));
    return listPersonas(app.services.authored, paths?.configDir);
  });
  app.put<{ Params: { id: string } }>("/api/chats/:id/persona", async (req, reply) => {
    const parsed = ChatSchema.shape.personaId.unwrap().nullable().safeParse(
      (req.body as { personaId?: unknown } | null)?.personaId,
    );
    if (!parsed.success) return reply.code(400).send({ error: "personaId must be a persona name or null (off)." });
    if (!await app.cm.store.getChat(req.params.id)) return reply.code(404).send({ error: "Chat not found" });
    try {
      await ensureSession(app.services, req.params.id);
      await app.services.broker.setPersona(req.params.id, parsed.data);
      return app.cm.store.getChat(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
