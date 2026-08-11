/**
 * REST for persistent terminals (named shells).
 *   GET    /api/terminals?chatId=       → TerminalInfo[] (all, or one chat's)
 *   GET    /api/terminals/:id/output    → TerminalLine[] (retained scrollback)
 *   POST   /api/terminals               → open an empty named shell
 *   POST   /api/terminals/run           → run a command in one
 *   DELETE /api/terminals/:id           → kill one
 *
 * The GETs are read-only snapshots so a (re)connecting client re-materializes the
 * live Terminals view; live output rides the `terminal-output` / `terminal-update`
 * bus events, so the write routes return the command result and let the stream
 * do the narration.
 *
 * The write routes exist because the shells were originally agent-only: the only
 * way to get one was `mcp__manager__terminal`, so for anyone who had never had an
 * agent open a shell the Terminals tab was empty forever and the feature was
 * indistinguishable from missing. They are a thin wrapper over exactly what the
 * MCP tool calls — same TerminalService, same per-chat cap, same cwd rule (the
 * chat's worktree, else the project checkout) — so a UI-opened shell and an
 * agent-opened one are the same object, visible to both.
 */
import type { FastifyInstance } from "fastify";
import { chatRoot } from "./files.js";

/** Resolve the chat + its default shell cwd, or an HTTP-shaped failure. */
async function resolveCwd(
  app: FastifyInstance,
  chatId: string | undefined,
): Promise<{ cwd: string } | { code: number; error: string }> {
  if (!chatId) return { code: 400, error: "chatId required" };
  const chat = await app.cm.store.getChat(chatId);
  if (!chat) return { code: 404, error: "chat not found" };
  const project = await app.cm.store.getProject(chat.projectId);
  if (!project) return { code: 404, error: "project not found" };
  return { cwd: chatRoot(chat, project) };
}

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

  app.post<{ Body: { chatId?: string; name?: string } }>(
    "/api/terminals",
    async (req, reply) => {
      const resolved = await resolveCwd(app, req.body?.chatId);
      if ("error" in resolved) return reply.code(resolved.code).send({ error: resolved.error });
      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "name required" });

      const { terminal, error } = terminals.create(req.body!.chatId!, name, resolved.cwd);
      // The cap is a 409, not a 500: nothing is broken, the caller just has to
      // close a shell first — and the UI shows the message verbatim.
      if (!terminal) return reply.code(409).send({ error: error ?? "could not open terminal" });
      return terminal;
    },
  );

  app.post<{
    Body: {
      chatId?: string;
      name?: string;
      command?: string;
      timeoutMs?: number;
      /**
       * Same escape hatch the agent's `terminal` tool has. Without it the panel's
       * command line could only run things that FINISH: a human typing `pnpm dev`
       * here would wedge that shell until the timeout, which is the exact trap
       * the background mode was added to remove.
       */
      background?: boolean;
    };
  }>("/api/terminals/run", async (req, reply) => {
    const resolved = await resolveCwd(app, req.body?.chatId);
    if ("error" in resolved) return reply.code(resolved.code).send({ error: resolved.error });
    const name = (req.body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const command = req.body?.command ?? "";
    if (!command.trim()) return reply.code(400).send({ error: "command required" });

    return terminals.run({
      chatId: req.body!.chatId!,
      name,
      command,
      cwd: resolved.cwd,
      timeoutMs: typeof req.body?.timeoutMs === "number" ? req.body.timeoutMs : undefined,
      background: req.body?.background === true,
    });
  });

  app.delete<{ Params: { id: string } }>("/api/terminals/:id", async (req, reply) => {
    if (!terminals.kill(req.params.id)) {
      return reply.code(404).send({ error: "terminal not found" });
    }
    return { ok: true };
  });
}
