/**
 * REST for the artifact viewer.
 *
 *   GET  /api/chats/:id/artifacts                 → ArtifactMeta[] (newest edit first)
 *   GET  /api/chats/:id/artifacts/:aid?version=n  → ArtifactContent (410 once expired)
 *   POST /api/chats/:id/artifacts/:aid/errors     → record runtime errors the viewer caught
 *
 * Content is returned as JSON, never served as a document. The client puts it in
 * an `<iframe sandbox="allow-scripts" srcdoc>` — an opaque origin — so
 * agent-written script can run without being able to read this origin's token
 * and drive the API. A route that served the HTML raw would be one "open in new
 * tab" away from running it same-origin.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import * as z from "zod";
import { ARTIFACT_ERROR_MAX_CHARS, ARTIFACT_MAX_ERRORS, type ArtifactContent } from "@dispatch/shared";
import { ArtifactError } from "../services/artifacts.js";

const ErrorsBody = z.object({
  version: z.number().int().positive(),
  errors: z.array(z.string().max(ARTIFACT_ERROR_MAX_CHARS * 2)).max(ARTIFACT_MAX_ERRORS),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ArtifactError) {
    if (err.code === "expired") return reply.code(410).send({ error: "expired", expiredAt: err.expiredAt });
    if (err.code === "not_found") return reply.code(404).send({ error: err.message });
    return reply.code(400).send({ error: err.message });
  }
  throw err;
}

export function registerArtifactRoutes(app: FastifyInstance): void {
  const { artifacts, store } = app.services;

  const chatExists = async (id: string) => !!(await store.getChat(id).catch(() => null));

  app.get<{ Params: { id: string } }>("/api/chats/:id/artifacts", async (req, reply) => {
    if (!(await chatExists(req.params.id))) return reply.code(404).send({ error: "chat not found" });
    return artifacts.list(req.params.id);
  });

  app.get<{ Params: { id: string; aid: string }; Querystring: { version?: string } }>(
    "/api/chats/:id/artifacts/:aid",
    async (req, reply) => {
      if (!(await chatExists(req.params.id))) return reply.code(404).send({ error: "chat not found" });
      const v = req.query.version !== undefined ? Number(req.query.version) : undefined;
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      try {
        const got: ArtifactContent = await artifacts.read(req.params.id, req.params.aid, v);
        // Versions are immutable, so a pinned one can be cached; "latest" cannot.
        reply.header("cache-control", v !== undefined ? "private, max-age=3600" : "no-store");
        return got;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; aid: string } }>(
    "/api/chats/:id/artifacts/:aid/errors",
    async (req, reply) => {
      const body = ErrorsBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      if (!(await chatExists(req.params.id))) return reply.code(404).send({ error: "chat not found" });
      artifacts.recordErrors(req.params.id, req.params.aid, body.data.version, body.data.errors);
      return reply.code(204).send();
    },
  );
}
