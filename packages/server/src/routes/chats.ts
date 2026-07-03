/**
 * REST CRUD for chats + their transcript.
 *   GET    /api/chats?projectId=    → Chat[]
 *   POST   /api/chats               → create (registers a broker session)
 *   GET    /api/chats/:id           → Chat | 404
 *   PUT    /api/chats/:id           → merge metadata (title/mode/agent/effort…)
 *   DELETE /api/chats/:id           → stop + drop session, clear attention, delete
 *                                     record, broadcast chat-deleted
 *   GET    /api/chats/:id/messages?limit=&afterId= → ChatMessage[]
 *   GET    /api/chats/:id/checkpoints → Checkpoint[] (rollback anchors)
 */
import type { FastifyInstance } from "fastify";
import { ChatSchema } from "@cm/shared";
import { createChat } from "./dispatch.js";

export function registerChatRoutes(app: FastifyInstance): void {
  const { store, bus } = app.cm;
  const { broker, attention } = app.services;

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/chats",
    async (req) => store.listChats(req.query.projectId),
  );

  app.post("/api/chats", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== "string" || !body.projectId) {
      return reply.code(400).send({ error: "projectId required" });
    }
    try {
      const chat = await createChat(app.services, {
        projectId: body.projectId,
        title: typeof body.title === "string" ? body.title : undefined,
        modeId: typeof body.modeId === "string" ? body.modeId : undefined,
        agentId: typeof body.agentId === "string" ? body.agentId : undefined,
        effort: body.effort as never,
      });
      return reply.code(201).send(chat);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/chats/:id",
    async (req, reply) => {
      const chat = await store.getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "not found" });
      return chat;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/chats/:id",
    async (req, reply) => {
      const existing = await store.getChat(req.params.id);
      if (!existing) return reply.code(404).send({ error: "not found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = ChatSchema.safeParse({
        ...existing,
        ...body,
        id: req.params.id,
        projectId: existing.projectId,
        updatedAt: Date.now(),
      });
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const saved = await store.saveChat(parsed.data);
      bus.publish({ type: "chat-update", chat: saved });
      return saved;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/chats/:id",
    async (req, reply) => {
      const id = req.params.id;
      const existing = await store.getChat(id);
      // Tear the subprocess down, THEN forget the session so it can't leak.
      await broker.stop(id).catch(() => {});
      broker.drop(id);
      // Authoritatively resolve every attention item this chat published — incl.
      // the "Session ended" one `stop()`→`onDone` just emitted — so no connected
      // client strands a phantom entry pointing at a now-deleted chat.
      for (const attId of attention.clearChat(id)) {
        bus.publish({ type: "attention-resolve", id: attId, chatId: id });
      }
      await store.deleteChat(id);
      // Broadcast the deletion so EVERY client drops the chat (a second tab has no
      // other signal; the initiator's local purge only cleans itself).
      bus.publish({ type: "chat-deleted", chatId: id, projectId: existing?.projectId });
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; afterId?: string };
  }>("/api/chats/:id/messages", async (req) => {
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    return store.readMessages(req.params.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      afterId: req.query.afterId,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/checkpoints",
    async (req) => store.getCheckpoints(req.params.id),
  );
}
