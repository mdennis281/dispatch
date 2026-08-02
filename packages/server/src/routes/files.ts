/**
 * REST for the composer's file-path picker.
 *   GET /api/files?chatId=&q=&limit=  → { root, files: IndexedFile[] }
 *
 * A browser page can never learn a real filesystem path (the OS file dialog and
 * drag-and-drop both hand back a bare basename), so "insert the path to a file"
 * has to be answered by the server, which can actually see the disk.
 *
 * The search root is the chat's own working directory — its worktree when it has
 * one, else the project checkout — so the paths handed back are the paths the
 * agent for THAT chat will resolve.
 */
import type { FastifyInstance } from "fastify";

/** Where a chat's agent actually runs: its worktree, else the project repo. */
export function chatRoot(
  chat: { worktrees: string[] },
  project: { repoPath: string },
): string {
  return chat.worktrees[0] ?? project.repoPath;
}

export function registerFileRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { fileIndex } = app.services;

  app.get<{ Querystring: { chatId?: string; q?: string; limit?: string } }>(
    "/api/files",
    async (req, reply) => {
      if (!req.query.chatId) {
        return reply.code(400).send({ error: "chatId required" });
      }
      const chat = await store.getChat(req.query.chatId);
      if (!chat) return reply.code(404).send({ error: "chat not found" });
      const project = await store.getProject(chat.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });

      const root = chatRoot(chat, project);
      const limit = Number(req.query.limit);
      const files = await fileIndex.search(
        root,
        req.query.q ?? "",
        Number.isFinite(limit) && limit > 0 ? limit : 50,
      );
      return { root, files };
    },
  );
}
