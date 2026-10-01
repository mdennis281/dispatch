/**
 * REST for the global Attention Queue — the cross-chat "needs input" inbox.
 *   GET    /api/attention           → AttentionItem[] (most-urgent first)
 *   GET    /api/attention?chatId=   → items for one chat
 *   DELETE /api/attention           → dismiss outstanding items
 * The live feed is the WS stream (`attention-add` / `attention-resolve`); this is
 * the snapshot a freshly-connected client reads to prime its triage list.
 */
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { AttentionItemSchema } from "@dispatch/shared";

const ClearQuery = z.object({
  // `min(1)`, so `?chatId=` is a 400 rather than a global clear. An empty value
  // is what a half-built scoped request looks like, and the one thing it must
  // not silently become is the destructive unscoped one.
  chatId: z.string().min(1).optional(),
  /**
   * Comma-separated kinds to dismiss. Omitted = the retrospective ones only
   * (`DISMISSIBLE_ATTENTION_KINDS`), because a permission/question item is a blocked agent
   * rather than clutter — see `AttentionQueue.clear`.
   */
  kinds: z.string().optional(),
});

export function registerAttentionRoutes(app: FastifyInstance): void {
  const { attention, broker } = app.services;
  const { bus } = app.cm;

  app.get<{ Querystring: { chatId?: string } }>("/api/attention", async (req) => {
    return req.query.chatId
      ? attention.listForChat(req.query.chatId)
      : attention.list();
  });

  /**
   * Clear the queue. Server-side rather than a client-local hide, for two
   * reasons: the queue is one list every connected device reads, and a client
   * that only dropped the rows from its own store would get all of them straight
   * back from `GET /api/attention` on the next reload.
   */
  app.delete("/api/attention", async (req, reply) => {
    const parsed = ClearQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const kindList = parsed.data.kinds
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const kinds = kindList?.length
      ? z.array(AttentionItemSchema.shape.kind).safeParse(kindList)
      : null;
    if (kinds && !kinds.success) {
      return reply.code(400).send({ error: `unknown attention kind in ${parsed.data.kinds}` });
    }
    const removed = attention.clear({
      ...(parsed.data.chatId ? { chatId: parsed.data.chatId } : {}),
      ...(kinds?.success ? { kinds: kinds.data } : {}),
    });
    // One authoritative resolve per id, exactly as chat deletion does: every
    // client already holds these from their `attention-add`, so without the
    // broadcast the rows survive the clear on every screen but this one.
    for (const { id, chatId } of removed) {
      bus.publish({ type: "attention-resolve", id, chatId });
    }
    return { cleared: removed.length, ids: removed.map((r) => r.id) };
  });

  // Snapshot of every still-open permission/question request. A reconnecting
  // client re-materializes its inline cards from this (they're only persisted on
  // resolution) so a mid-tool reconnect never strands an unanswerable badge.
  app.get("/api/attention/permissions", async () => broker.pendingPermissionSnapshot());
}
