/**
 * REST for git worktrees.
 *   GET    /api/worktrees?projectId=              → WorktreeInfo[]
 *   GET    /api/branches?projectId=               → BranchInfo[] (launch picker)
 *   POST   /api/worktrees {projectId,branch,chatId?} → create
 *   DELETE /api/worktrees {worktreePath,chatId?,force?} → remove
 *   GET    /api/worktrees/diff?worktreePath=&base= → WorktreeDiff
 *   GET    /api/worktrees/file?worktreePath=&relPath=&ref= → WorktreeFile (Monaco)
 *   PUT    /api/worktrees/file {worktreePath,relPath,content} → write (Monaco save)
 *   GET    /api/worktrees/refresh?projectId=      → force a detection pass
 * Mutations run through the same service the WS `create-worktree`/`remove-worktree`
 * actions use (publishing `worktree-update` / `chat-update` / `notice`).
 */
import type { FastifyInstance } from "fastify";

export function registerWorktreeRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { worktrees, worktreeDetector } = app.services;

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/worktrees",
    async (req, reply) => {
      if (!req.query.projectId) {
        return reply.code(400).send({ error: "projectId required" });
      }
      const project = await store.getProject(req.query.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      try {
        return await worktrees.list(project);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/branches",
    async (req, reply) => {
      if (!req.query.projectId) {
        return reply.code(400).send({ error: "projectId required" });
      }
      const project = await store.getProject(req.query.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      try {
        return await worktrees.listBranches(project);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post("/api/worktrees", async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      branch?: string;
      chatId?: string;
      base?: string;
    };
    if (!body.projectId || !body.branch) {
      return reply.code(400).send({ error: "projectId and branch required" });
    }
    const project = await store.getProject(body.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      const info = await worktrees.create(project, body.branch, {
        chatId: body.chatId,
        base: body.base,
      });
      return reply.code(201).send(info);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/worktrees", async (req, reply) => {
    const body = (req.body ?? {}) as {
      worktreePath?: string;
      chatId?: string;
      force?: boolean;
    };
    if (!body.worktreePath) {
      return reply.code(400).send({ error: "worktreePath required" });
    }
    try {
      await worktrees.remove(body.worktreePath, {
        force: body.force,
        chatId: body.chatId,
      });
      return reply.code(204).send();
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{
    Querystring: { worktreePath?: string; relPath?: string; ref?: string };
  }>("/api/worktrees/file", async (req, reply) => {
    const { worktreePath, relPath, ref } = req.query;
    if (!worktreePath || !relPath) {
      return reply
        .code(400)
        .send({ error: "worktreePath and relPath required" });
    }
    try {
      return await worktrees.readFile(worktreePath, relPath, {
        ref: ref || undefined,
      });
    } catch (err) {
      // relPath/ref guard failures are client errors; surface as 400.
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Save edited file content back to the working tree (editable Monaco config
  // editor). Path-guarded inside the service; the fs watcher on `.dispatch/`
  // picks up a project.yaml edit and re-syncs the project without a manual reload.
  app.put("/api/worktrees/file", async (req, reply) => {
    const body = (req.body ?? {}) as {
      worktreePath?: string;
      relPath?: string;
      content?: string;
    };
    if (!body.worktreePath || !body.relPath || typeof body.content !== "string") {
      return reply
        .code(400)
        .send({ error: "worktreePath, relPath and content required" });
    }
    try {
      return await worktrees.writeFile(
        body.worktreePath,
        body.relPath,
        body.content,
      );
    } catch (err) {
      // relPath guard / size-cap failures are client errors.
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Force a detection pass for a project (client "Refresh" button). Runs the same
  // attribution the poll/turn-complete triggers use, so a just-created worktree
  // shows up on demand without waiting for the ~4s poll or the turn to end.
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/worktrees/refresh",
    async (req, reply) => {
      if (!req.query.projectId) {
        return reply.code(400).send({ error: "projectId required" });
      }
      const project = await store.getProject(req.query.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const results = await worktreeDetector.refreshProject(project.id);
      return {
        projectId: project.id,
        attached: results.flatMap((r) => r.attached),
        removed: results.flatMap((r) => r.removed),
      };
    },
  );

  app.get<{ Querystring: { worktreePath?: string; base?: string } }>(
    "/api/worktrees/diff",
    async (req, reply) => {
      if (!req.query.worktreePath) {
        return reply.code(400).send({ error: "worktreePath required" });
      }
      try {
        return await worktrees.diffVsMain(
          req.query.worktreePath,
          req.query.base || "main",
        );
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
