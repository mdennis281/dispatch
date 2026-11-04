/**
 * Scheduled chats — list, author, delete, and run now.
 *
 *   GET    /api/projects/:id/schedules            → SchedulesResponse
 *   PUT    /api/projects/:id/schedules/:sid       → write `.dispatch/schedules/<sid>.md`
 *   DELETE /api/projects/:id/schedules/:sid       → remove it (and this instance's run state)
 *   POST   /api/projects/:id/schedules/:sid/run   → start a run now → { chatId }
 *
 * The file is the source of truth. Every write reloads the project's config
 * right away so the response (and the runner's next tick) reflects it, rather
 * than waiting on the file watcher to notice.
 */
import type { FastifyInstance } from "fastify";
import {
  checkCron,
  ScheduleInputSchema,
  SCHEDULE_ID_RE,
  serverTimeZone,
  type SchedulesResponse,
} from "@dispatch/shared";
import { configPathsFor } from "../services/config-location.js";
import { deleteScheduleFile, writeScheduleFile } from "../services/schedule-files.js";

export function registerScheduleRoutes(app: FastifyInstance): void {
  const list = async (projectId: string): Promise<SchedulesResponse> => {
    const { scheduleRunner, projectConfig } = app.services;
    const loaded = projectConfig.get(projectId) ?? (await projectConfig.reload(projectId).catch(() => null));
    return {
      schedules: await scheduleRunner.list(projectId),
      active: scheduleRunner.active,
      serverTimeZone: serverTimeZone(),
      errors: (loaded?.errors ?? [])
        .filter((e) => e.scope === "schedule")
        .map((e) => ({ ...(e.file ? { file: e.file } : {}), message: e.message })),
    };
  };

  /** The project's config paths, or the status code that says why there are none. */
  const pathsOf = async (projectId: string) => {
    const project = await app.cm.store.getProject(projectId).catch(() => null);
    if (!project) return { code: 404 as const, error: "Project not found" };
    const paths = configPathsFor(project, app.cm.store.projectConfigDir(project.id));
    return paths
      ? { paths }
      : { code: 400 as const, error: "This project's repo path is not usable, so there is nowhere to write its config." };
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/schedules", async (req, reply) => {
    if (!(await app.cm.store.getProject(req.params.id).catch(() => null))) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return list(req.params.id);
  });

  app.put<{ Params: { id: string; sid: string } }>("/api/projects/:id/schedules/:sid", async (req, reply) => {
    const { sid } = req.params;
    if (!SCHEDULE_ID_RE.test(sid)) {
      return reply.code(400).send({ error: "Schedule id must be lowercase letters, digits and dashes." });
    }
    const parsed = ScheduleInputSchema.safeParse({ ...((req.body as object | null) ?? {}), id: sid });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    // Checked here as well as at load, so a bad cron is a 400 on save rather
    // than a config error discovered after the human has walked away.
    const cron = checkCron(parsed.data.cron, parsed.data.timezone);
    if (!cron.ok) return reply.code(400).send({ error: `cron "${parsed.data.cron}": ${cron.error}` });

    const target = await pathsOf(req.params.id);
    if (!target.paths) return reply.code(target.code).send({ error: target.error });
    await writeScheduleFile(target.paths, parsed.data);
    await app.services.projectConfig.reload(req.params.id);
    return list(req.params.id);
  });

  app.delete<{ Params: { id: string; sid: string } }>("/api/projects/:id/schedules/:sid", async (req, reply) => {
    const { sid } = req.params;
    if (!SCHEDULE_ID_RE.test(sid)) return reply.code(400).send({ error: "Invalid schedule id." });
    const target = await pathsOf(req.params.id);
    if (!target.paths) return reply.code(target.code).send({ error: target.error });
    if (!(await deleteScheduleFile(target.paths, sid))) {
      return reply.code(404).send({ error: "Schedule not found" });
    }
    // Past runs are left alone: they are ordinary chats now, and deleting a
    // schedule is not asking to lose what it found.
    await app.cm.store.deleteScheduleState(req.params.id, sid).catch(() => {});
    await app.services.projectConfig.reload(req.params.id);
    return list(req.params.id);
  });

  app.post<{ Params: { id: string; sid: string } }>("/api/projects/:id/schedules/:sid/run", async (req, reply) => {
    try {
      return await app.services.scheduleRunner.runNow(req.params.id, req.params.sid);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
