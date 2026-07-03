/**
 * REST for the global Attention Queue — the cross-chat "needs input" inbox.
 *   GET /api/attention           → AttentionItem[] (most-urgent first)
 *   GET /api/attention?chatId=   → items for one chat
 * The live feed is the WS stream (`attention-add` / `attention-resolve`); this is
 * the snapshot a freshly-connected client reads to prime its triage list.
 */
import type { FastifyInstance } from "fastify";

export function registerAttentionRoutes(app: FastifyInstance): void {
  const { attention, broker } = app.services;

  app.get<{ Querystring: { chatId?: string } }>("/api/attention", async (req) => {
    return req.query.chatId
      ? attention.listForChat(req.query.chatId)
      : attention.list();
  });

  // Snapshot of every still-open permission/question request. A reconnecting
  // client re-materializes its inline cards from this (they're only persisted on
  // resolution) so a mid-tool reconnect never strands an unanswerable badge.
  app.get("/api/attention/permissions", async () => broker.pendingPermissionSnapshot());
}
