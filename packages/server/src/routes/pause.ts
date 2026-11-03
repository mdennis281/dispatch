/**
 * REST for the global pause.
 *   GET  /api/scheduler       → SchedulerSnapshot (running, queued, pause state)
 *   POST /api/pause           → interrupt every live turn and hold the queue
 *   POST /api/pause/kill      → kill every chat's processes (paused only)
 *   POST /api/pause/resume    → note each interrupted chat, then re-open the queue
 *   POST /api/pause/projects/:projectId        → pause one project's chats
 *   POST /api/pause/projects/:projectId/resume → lift that project's pause
 *   POST /api/pause/chats/:chatId              → pause one chat
 *   POST /api/pause/chats/:chatId/resume       → lift that chat's pause
 *   POST /api/pause/scoped/resume-all          → lift every project and chat pause
 *   POST /api/scheduler/run/:chatId → admit one queued chat now, past the cap
 *
 * The snapshot is also pushed as a `scheduler` bus event on every change, so
 * this GET is only the initial load.
 */
import type { FastifyInstance } from "fastify";

export function registerPauseRoutes(app: FastifyInstance): void {
  const { pause } = app.services;

  app.get("/api/scheduler", async () => pause.snapshot());

  app.post("/api/pause", async () => ({ paused: await pause.pause() }));

  app.post("/api/pause/kill", async (_req, reply) => {
    try {
      return await pause.killProcesses();
    } catch {
      return reply.code(409).send({ error: "Pause all chats before killing their processes." });
    }
  });

  app.post("/api/pause/resume", async () => pause.resume());

  app.post("/api/pause/scoped/resume-all", async () => pause.resumeAllScoped());

  app.post<{ Params: { chatId: string } }>("/api/pause/chats/:chatId", async (req, reply) => {
    const chat = await app.cm.store.getChat(req.params.chatId).catch(() => null);
    if (!chat) return reply.code(404).send({ error: "No such chat." });
    return { paused: await pause.pauseChat(chat.id) };
  });

  app.post<{ Params: { chatId: string } }>("/api/pause/chats/:chatId/resume", async (req) =>
    pause.resumeChat(req.params.chatId),
  );

  app.post<{ Params: { projectId: string } }>("/api/pause/projects/:projectId", async (req, reply) => {
    const project = await app.cm.store.getProject(req.params.projectId).catch(() => null);
    if (!project) return reply.code(404).send({ error: "No such project." });
    return { paused: await pause.pauseProject(project.id) };
  });

  app.post<{ Params: { projectId: string } }>("/api/pause/projects/:projectId/resume", async (req) =>
    pause.resumeProject(req.params.projectId),
  );

  app.post<{ Params: { chatId: string } }>("/api/scheduler/run/:chatId", async (req, reply) => {
    if (pause.runNow(req.params.chatId)) return { ok: true };
    // Not queued (it already started, or never was) or the app is paused.
    return reply.code(409).send({ error: "That chat is not waiting in the queue — or everything is paused." });
  });
}
