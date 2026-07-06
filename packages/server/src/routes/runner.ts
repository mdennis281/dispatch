/**
 * REST for subApp runners (per-worktree process/docker manager).
 *   GET    /api/runners                → RunnerInstance[]
 *   POST   /api/runners {worktreePath,subAppId,projectId?,chatId?} → start
 *   DELETE /api/runners/:id            → stop (tree-kill)
 *   GET    /api/runners/:id/logs       → RunnerLogLine[]
 */
import type { FastifyInstance } from "fastify";
import { mergeById } from "../services/project-config.js";

export function registerRunnerRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { runner, projectConfig } = app.services;

  app.get("/api/runners", async () => runner.list());

  app.post("/api/runners", async (req, reply) => {
    const body = (req.body ?? {}) as {
      worktreePath?: string;
      subAppId?: string;
      projectId?: string;
      chatId?: string;
    };
    if (!body.worktreePath || !body.subAppId) {
      return reply
        .code(400)
        .send({ error: "worktreePath and subAppId required" });
    }
    // Resolve the subApp from its project (by id, or via the owning chat).
    let projectId = body.projectId;
    if (!projectId && body.chatId) {
      const chat = await store.getChat(body.chatId);
      projectId = chat?.projectId;
    }
    if (!projectId) {
      return reply.code(400).send({ error: "projectId or chatId required" });
    }
    const project = await store.getProject(projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    // Resolve against the effective sub-app set a session sees: the repo's
    // `.claude-manager/` config-sourced sub-apps layered over the `.data` record
    // (config wins on id; a `.data`-only sub-app survives). The config carries
    // the dev/ports/docker the runner spawns.
    const subApps = mergeById(projectConfig.getSubApps(project.id), project.subApps);
    const subApp = subApps.find((s) => s.id === body.subAppId);
    if (!subApp) return reply.code(404).send({ error: "subApp not found" });
    try {
      const instance = await runner.start(body.worktreePath, subApp, {
        projectId: project.id,
        chatId: body.chatId,
      });
      return reply.code(201).send(instance);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/runners/:id",
    async (req, reply) => {
      await runner.stop(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/runners/:id/logs",
    async (req) => runner.logs(req.params.id),
  );
}
