/**
 * REST CRUD for chats + their transcript.
 *   GET    /api/chats?projectId=    → Chat[]
 *   POST   /api/chats               → create (registers a broker session)
 *   GET    /api/chats/:id           → Chat | 404
 *   PUT    /api/chats/:id           → merge metadata (title/mode/agent/effort…)
 *   DELETE /api/chats/:id           → stop + drop session, clear attention, delete
 *                                     record, broadcast chat-deleted
 *   GET    /api/chats/:id/messages?limit=&afterId=&beforeId=&full=
 *                                   → ChatMessage[] (a window; lean unless full=1)
 *   GET    /api/chats/:id/messages/full?ids=a,b → ChatMessage[] (verbatim rows)
 *   GET    /api/chats/:id/checkpoints → Checkpoint[] (rollback anchors)
 *   GET    /api/chats/:id/exemptions → WorkflowExemption[] (live guard lifts)
 *   DELETE /api/chats/:id/exemptions/:exemptionId → revoke one
 */
import type { FastifyInstance } from "fastify";
import { ChatSchema } from "@dispatch/shared";
import { createChat } from "./dispatch.js";
import { leanRows } from "../services/transcript-lean.js";

/** Cap on one hydrate request (a card needs 2 — its tool_use + tool_result). */
const MAX_HYDRATE_IDS = 50;

/** Query-flag truthiness: `?full`, `?full=1`, `?full=true` all count. */
function isTruthyFlag(v: string | undefined): boolean {
  return v !== undefined && v !== "0" && v !== "false";
}

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
        harness: body.harness as never,
        model: typeof body.model === "string" ? body.model : undefined,
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
      const merged = { ...existing, ...body } as Record<string, unknown>;
      // JSON cannot carry `undefined`; null is the explicit "inherit" command.
      if (body.shellFilter === null) delete merged.shellFilter;
      const parsed = ChatSchema.safeParse({
        ...merged,
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

  /**
   * A WINDOW of the transcript, LEAN by default (see services/transcript-lean.ts):
   * bulky `tool_use.input` / `tool_result.content` payloads the collapsed cards
   * never show are clipped to a preview and flagged, so opening a long chat ships
   * ~200 KB instead of ~10 MB. Pass `full=1` for verbatim rows.
   *
   *   limit    — newest N rows (client pages backwards from there)
   *   beforeId — rows strictly older than this id (the previous page)
   *   afterId  — rows strictly newer than this id (forward tail)
   */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; afterId?: string; beforeId?: string; full?: string };
  }>("/api/chats/:id/messages", async (req) => {
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const rows = await store.readMessages(req.params.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      afterId: req.query.afterId,
      beforeId: req.query.beforeId,
    });
    return isTruthyFlag(req.query.full) ? rows : leanRows(rows);
  });

  /**
   * Full (un-clipped) rows by id — hydrate-on-expand for the lean transcript. A
   * ToolCallCard built from a clipped row fetches its `tool_use` + `tool_result`
   * here the first time the user opens it.
   */
  app.get<{
    Params: { id: string };
    Querystring: { ids?: string };
  }>("/api/chats/:id/messages/full", async (req, reply) => {
    const ids = (req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return reply.code(400).send({ error: "ids required" });
    if (ids.length > MAX_HYDRATE_IDS) {
      return reply.code(400).send({ error: `at most ${MAX_HYDRATE_IDS} ids` });
    }
    return store.readMessagesByIds(req.params.id, ids);
  });

  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/checkpoints",
    async (req) => store.getCheckpoints(req.params.id),
  );

  /**
   * Cancel a scheduled auto-resume (the chat stays paused until you send).
   * 404 when the chat is gone; 409 when there is nothing pending to cancel —
   * an already-fired or already-cancelled plan must not read as success.
   */
  app.post<{ Params: { id: string } }>(
    "/api/chats/:id/resume/cancel",
    async (req, reply) => {
      const chat = await store.getChat(req.params.id);
      if (!chat) return reply.code(404).send({ error: "not found" });
      const saved = await app.services.resume.cancel(req.params.id);
      if (!saved) return reply.code(409).send({ error: "no pending auto-resume" });
      return saved;
    },
  );

  /**
   * This chat's live guard exemptions, and the revoke behind the header chip.
   *
   * Live-session state, so it comes from the broker rather than the store — same
   * shape as `context-usage` above, and for the same reason: an exemption
   * deliberately has nowhere persistent to live (see `LiveSession.exemptions`).
   * A chat that isn't live answers `[]`, which is the truth — nothing is being
   * let through.
   *
   * There is deliberately no POST. Granting happens only through the agent's
   * `request_exemption` and the card it raises; an endpoint that minted one
   * would be a second consent path with none of the first one's record.
   */
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/exemptions",
    async (req) => broker.listExemptions(req.params.id),
  );

  app.delete<{ Params: { id: string; exemptionId: string } }>(
    "/api/chats/:id/exemptions/:exemptionId",
    async (req, reply) => {
      const revoked = broker.revokeExemption(req.params.id, req.params.exemptionId);
      // 404 rather than a cheerful no-op: "revoke" reporting success for a grant
      // that was never dropped is the one wrong answer this endpoint can give.
      if (!revoked) return reply.code(404).send({ error: "no such exemption" });
      return reply.code(204).send();
    },
  );

  // Live context-window breakdown (tokens by category + authoritative window),
  // for the composer meter's dropup. `usage` is null when the chat's subprocess
  // isn't live this process — the client falls back to the last result row's
  // stamped tokens/window in that case.
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/context-usage",
    async (req) => ({ usage: await broker.getContextUsage(req.params.id) }),
  );
}
