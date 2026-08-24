/**
 * REST for the composer's `/` command menu.
 *
 *   GET /api/chats/:chatId/commands → SlashCommandCatalog
 *
 * Per-CHAT rather than per-project because the answer depends on the chat's
 * working directory: a chat in a worktree gets that tree's `.claude/skills/` and
 * `.claude/commands/`, which is where a repo's own commands live and which can
 * differ from the primary checkout mid-branch.
 *
 * Cheap enough to call on every composer focus — a few `readdir`s over dirs with
 * a handful of entries — so there's no cache and no invalidation to get wrong. A
 * skill authored a second ago shows up immediately, which is the behaviour the
 * `config_write` → "run it as /name" promise depends on.
 */
import type { FastifyInstance } from "fastify";
import { chatRoot } from "@dispatch/shared";

export function registerCommandRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { slashCommands } = app.services;

  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/commands",
    async (req, reply) => {
      const chat = await store.getChat(req.params.chatId).catch(() => null);
      if (!chat) return reply.code(404).send({ error: "chat not found" });
      const project = chat.projectId
        ? await store.getProject(chat.projectId).catch(() => null)
        : null;
      const cwd = project ? chatRoot(chat, project) : (chat.worktrees[0] ?? null);
      return slashCommands.catalog(cwd ?? null, chat.projectId ?? null);
    },
  );
}
