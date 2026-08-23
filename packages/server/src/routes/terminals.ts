/**
 * REST for persistent terminals (named shells).
 *   GET    /api/terminals?scope=&projectId=&chatId=&q= → TerminalInfo[] (catalog)
 *   GET    /api/terminals/:id/output?tail=&since=&q=&stream= → TerminalLine[]
 *   POST   /api/terminals               → open an empty named shell
 *   POST   /api/terminals/run           → run a command in one
 *   POST   /api/terminals/kill-all      → kill every live shell a query selects
 *   DELETE /api/terminals/:id?purge=1   → kill one (purge also drops its transcript)
 *
 * The GETs are read-only snapshots so a (re)connecting client re-materializes the
 * live Terminals view; live output rides the `terminal-output` / `terminal-update`
 * bus events, so the write routes return the command result and let the stream
 * do the narration.
 *
 * The write routes exist because the shells were originally agent-only: the only
 * way to get one was `mcp__dispatch-workspace__terminal`, so for anyone who had never had an
 * agent open a shell the Terminals tab was empty forever and the feature was
 * indistinguishable from missing. They are a thin wrapper over exactly what the
 * MCP tool calls — same TerminalService, same per-chat cap, same cwd rule (the
 * chat's worktree, else the project checkout) — so a UI-opened shell and an
 * agent-opened one are the same object, visible to both.
 */
import type { FastifyInstance } from "fastify";
import { parseRegistryQuery, RegistryQueryError } from "@dispatch/shared";
import { chatRoot } from "./files.js";

/** Resolve the chat + its default shell cwd, or an HTTP-shaped failure. */
async function resolveCwd(
  app: FastifyInstance,
  chatId: string | undefined,
): Promise<{ cwd: string; projectId: string } | { code: number; error: string }> {
  if (!chatId) return { code: 400, error: "chatId required" };
  const chat = await app.cm.store.getChat(chatId);
  if (!chat) return { code: 404, error: "chat not found" };
  const project = await app.cm.store.getProject(chat.projectId);
  if (!project) return { code: 404, error: "project not found" };
  return { cwd: chatRoot(chat, project), projectId: project.id };
}

export function registerTerminalRoutes(app: FastifyInstance): void {
  const { terminals } = app.services;

  // The catalog read. `?chatId=` keeps its old meaning; with no ids it sweeps
  // app-wide, and it includes ARCHIVED shells — ones whose process is gone but
  // whose transcript is still readable, which is the point of persisting them.
  app.get("/api/terminals", async (req, reply) => {
    try {
      return terminals.catalog(parseRegistryQuery(req.query as Record<string, unknown>));
    } catch (err) {
      // A filter we can't parse is the CALLER's mistake, not a server fault.
      if (err instanceof RegistryQueryError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { tail?: string; since?: string; q?: string; stream?: string };
  }>("/api/terminals/:id/output", async (req) => {
    const num = (v?: string): number | undefined => {
      const n = Number(v);
      return v !== undefined && Number.isFinite(n) ? n : undefined;
    };
    const stream = req.query.stream;
    return terminals.scrollback(req.params.id, {
      tail: num(req.query.tail),
      since: num(req.query.since),
      q: req.query.q || undefined,
      stream:
        stream === "stdout" || stream === "stderr" || stream === "command"
          ? stream
          : undefined,
    });
  });

  app.post<{ Body: { chatId?: string; name?: string } }>(
    "/api/terminals",
    async (req, reply) => {
      const resolved = await resolveCwd(app, req.body?.chatId);
      if ("error" in resolved) return reply.code(resolved.code).send({ error: resolved.error });
      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "name required" });

      const { terminal, error } = terminals.create(req.body!.chatId!, name, resolved.cwd, {
        projectId: resolved.projectId,
        origin: "ui",
      });
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
      projectId: resolved.projectId,
      origin: "ui",
      name,
      command,
      cwd: resolved.cwd,
      timeoutMs: typeof req.body?.timeoutMs === "number" ? req.body.timeoutMs : undefined,
      background: req.body?.background === true,
    });
  });

  /**
   * Bulk close, scoped by the SAME query the catalog is read with — so the
   * button says "kill what I am looking at" and means it.
   *
   * Deliberately not on the MCP surface. A human pressing this in the Workspace
   * modal can see the rows it will take; an agent asking for `scope: "all"`
   * cannot, and would be one argument away from stopping another chat's dev
   * server. Agents close their own shells one at a time, through DELETE below.
   *
   * The query's scope invariants carry over unchanged: `scope=chat` with no
   * `chatId` kills NOTHING rather than widening to the whole machine — the one
   * mistake a bulk kill really must not make.
   */
  app.post("/api/terminals/kill-all", async (req, reply) => {
    try {
      const query = parseRegistryQuery((req.body ?? {}) as Record<string, unknown>);
      return terminals.killMatching(query);
    } catch (err) {
      if (err instanceof RegistryQueryError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Closing a shell keeps its transcript (retention will take it eventually);
  // `?purge=1` is the explicit "and forget what it said", for a human who means
  // both. Conflating them is how a failed build's output used to become
  // unrecoverable the moment someone tidied up the tab.
  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    "/api/terminals/:id",
    async (req, reply) => {
      if (req.query.purge === "1" || req.query.purge === "true") {
        await terminals.purge(req.params.id);
        return { ok: true };
      }
      if (!terminals.kill(req.params.id)) {
        return reply.code(404).send({ error: "terminal not found" });
      }
      return { ok: true };
    },
  );
}
