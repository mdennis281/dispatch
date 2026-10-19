/**
 * REST for the global pause.
 *   GET  /api/scheduler       → SchedulerSnapshot (running, queued, pause state)
 *   POST /api/pause           → interrupt every live turn and hold the queue
 *   POST /api/pause/kill      → kill every chat's processes (paused only)
 *   POST /api/pause/resume    → note each interrupted chat, then re-open the queue
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

  app.post<{ Params: { chatId: string } }>("/api/scheduler/run/:chatId", async (req, reply) => {
    if (pause.runNow(req.params.chatId)) return { ok: true };
    // Not queued (it already started, or never was) or the app is paused.
    return reply.code(409).send({ error: "That chat is not waiting in the queue — or everything is paused." });
  });
}
