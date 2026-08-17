/**
 * REST for the composer's file-path picker and the command palette's file search.
 *   GET /api/files?chatId=&q=&limit=    → { root, files: IndexedFile[] }
 *   GET /api/files?projectId=&q=&limit= → same, rooted at the project checkout
 *
 * A browser page can never learn a real filesystem path (the OS file dialog and
 * drag-and-drop both hand back a bare basename), so "insert the path to a file"
 * has to be answered by the server, which can actually see the disk.
 *
 * With `chatId` the search root is that chat's own working directory — its
 * worktree when it has one, else the project checkout — so the paths handed back
 * are the paths the agent for THAT chat will resolve.
 *
 * `projectId` exists for the command palette, which is reachable with no chat
 * open at all (and is the FIRST thing you touch after switching projects). It
 * searches the primary checkout, which is the only working directory a project
 * is guaranteed to have.
 *
 * Both go through the git-backed, cached {@link FileIndexService} rather than
 * the explorer's walker: this is a keystroke-latency path over a repo, which is
 * exactly what `git ls-files` plus a 10s cache is good at. `/api/fs/search` is
 * the one that can look outside a checkout.
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

  app.get<{ Querystring: { chatId?: string; projectId?: string; q?: string; limit?: string } }>(
    "/api/files",
    async (req, reply) => {
      let root: string;
      if (req.query.chatId) {
        const chat = await store.getChat(req.query.chatId);
        if (!chat) return reply.code(404).send({ error: "chat not found" });
        const project = await store.getProject(chat.projectId);
        if (!project) return reply.code(404).send({ error: "project not found" });
        root = chatRoot(chat, project);
      } else if (req.query.projectId) {
        const project = await store.getProject(req.query.projectId);
        if (!project) return reply.code(404).send({ error: "project not found" });
        if (!project.repoPath) {
          return reply.code(409).send({ error: "project has no checkout to search" });
        }
        root = project.repoPath;
      } else {
        return reply.code(400).send({ error: "chatId or projectId required" });
      }

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
