/**
 * REST for persistent terminals (agent-driven named shells).
 *   GET /api/terminals?chatId=       → TerminalInfo[] (all, or one chat's)
 *   GET /api/terminals/:id/output    → TerminalLine[] (retained scrollback)
 *
 * These are read-only snapshots so a (re)connecting client re-materializes the
 * live Terminals view; the agent drives shells via `mcp__manager__terminal`, and
 * live output rides the `terminal-output` / `terminal-update` bus events.
 */
import type { FastifyInstance } from "fastify";

export function registerTerminalRoutes(app: FastifyInstance): void {
  const { terminals } = app.services;

  app.get<{ Querystring: { chatId?: string } }>(
    "/api/terminals",
    async (req) =>
      req.query.chatId ? terminals.listChat(req.query.chatId) : terminals.list(),
  );

  app.get<{ Params: { id: string } }>(
    "/api/terminals/:id/output",
    async (req) => terminals.scrollback(req.params.id),
  );
}
