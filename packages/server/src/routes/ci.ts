/**
 * REST for the project-level CI/CD page. One endpoint per section of the page,
 * so the client can load them independently and a failure in one (a run whose
 * artifacts 500, a log that isn't ready) never blanks the others.
 *
 *   GET  /api/projects/:projectId/ci                          → CiSummary
 *   GET  /api/projects/:projectId/ci/workflows                → CiWorkflow[]
 *   GET  /api/projects/:projectId/ci/workflows/:id/dispatch   → CiDispatchInfo
 *   POST /api/projects/:projectId/ci/workflows/:id/dispatch   { ref, inputs? } → 202
 *   GET  /api/projects/:projectId/ci/runs?workflowId&branch&event&status&page&perPage → CiRunPage
 *   GET  /api/projects/:projectId/ci/runs/:runId              → CiRun
 *   GET  /api/projects/:projectId/ci/runs/:runId/jobs         → CiJob[]
 *   GET  /api/projects/:projectId/ci/runs/:runId/artifacts    → CiArtifact[]
 *   POST /api/projects/:projectId/ci/runs/:runId/rerun        { failedOnly? } → 202
 *   POST /api/projects/:projectId/ci/runs/:runId/cancel       → 202
 *   GET  /api/projects/:projectId/ci/jobs/:jobId/logs         → CiJobLog
 *   POST /api/projects/:projectId/ci/jobs/:jobId/rerun        → 202
 *
 * Status codes carry the distinction the page renders differently: 404 the
 * project or the thing is gone, 409 the project has no CI to speak of (no
 * GitHub remote — an empty state, not an error), 502 the provider failed.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import * as z from "zod";
import type { Project } from "@dispatch/shared";
import { CiNotFoundError, CiUnavailableError } from "../services/ci.js";

const DispatchBodySchema = z.object({
  ref: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
});

const RerunBodySchema = z.object({ failedOnly: z.boolean().optional() }).default({});

/** Optional positive int from a query string; `undefined` when absent. */
function intParam(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
}

export function registerCiRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { ci } = app.services;

  /**
   * Resolve the project and run `fn`, mapping failures onto the status codes
   * above. Every route goes through here, so none of them can forget a case.
   */
  async function withProject<T>(
    projectId: string,
    reply: FastifyReply,
    fn: (project: Project) => Promise<T>,
  ): Promise<T | FastifyReply> {
    const project = await store.getProject(projectId).catch(() => null);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      return await fn(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof CiUnavailableError) return reply.code(409).send({ error: msg });
      if (err instanceof CiNotFoundError) return reply.code(404).send({ error: msg });
      if (/^invalid .* id/.test(msg)) return reply.code(400).send({ error: msg });
      return reply.code(502).send({ error: msg });
    }
  }

  type P = { projectId: string };

  app.get<{ Params: P }>("/api/projects/:projectId/ci", (req, reply) =>
    withProject(req.params.projectId, reply, (p) => ci.summary(p)),
  );

  app.get<{ Params: P }>("/api/projects/:projectId/ci/workflows", (req, reply) =>
    withProject(req.params.projectId, reply, (p) => ci.workflows(p)),
  );

  app.get<{ Params: P & { id: string } }>(
    "/api/projects/:projectId/ci/workflows/:id/dispatch",
    (req, reply) =>
      withProject(req.params.projectId, reply, (p) => ci.dispatchInfo(p, Number(req.params.id))),
  );

  app.post<{ Params: P & { id: string } }>(
    "/api/projects/:projectId/ci/workflows/:id/dispatch",
    async (req, reply) => {
      const body = DispatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      return withProject(req.params.projectId, reply, async (p) => {
        await ci.dispatch(p, Number(req.params.id), body.data.ref, body.data.inputs);
        return reply.code(202).send({ ok: true });
      });
    },
  );

  app.get<{
    Params: P;
    Querystring: {
      workflowId?: string;
      branch?: string;
      event?: string;
      status?: string;
      page?: string;
      perPage?: string;
    };
  }>("/api/projects/:projectId/ci/runs", (req, reply) => {
    const q = req.query;
    const workflowId = intParam(q.workflowId);
    const page = intParam(q.page);
    const perPage = intParam(q.perPage);
    if ([workflowId, page, perPage].some((n) => Number.isNaN(n))) {
      return reply.code(400).send({ error: "workflowId, page and perPage must be positive integers" });
    }
    return withProject(req.params.projectId, reply, (p) =>
      ci.runs(p, {
        workflowId,
        branch: q.branch || undefined,
        event: q.event || undefined,
        status: q.status || undefined,
        page,
        perPage,
      }),
    );
  });

  app.get<{ Params: P & { runId: string } }>(
    "/api/projects/:projectId/ci/runs/:runId",
    (req, reply) =>
      withProject(req.params.projectId, reply, (p) => ci.run(p, Number(req.params.runId))),
  );

  app.get<{ Params: P & { runId: string } }>(
    "/api/projects/:projectId/ci/runs/:runId/jobs",
    (req, reply) =>
      withProject(req.params.projectId, reply, (p) => ci.jobs(p, Number(req.params.runId))),
  );

  app.get<{ Params: P & { runId: string } }>(
    "/api/projects/:projectId/ci/runs/:runId/artifacts",
    (req, reply) =>
      withProject(req.params.projectId, reply, (p) => ci.artifacts(p, Number(req.params.runId))),
  );

  app.post<{ Params: P & { runId: string } }>(
    "/api/projects/:projectId/ci/runs/:runId/rerun",
    async (req, reply) => {
      const body = RerunBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.message });
      return withProject(req.params.projectId, reply, async (p) => {
        await ci.rerun(p, Number(req.params.runId), { failedOnly: body.data.failedOnly });
        return reply.code(202).send({ ok: true });
      });
    },
  );

  app.post<{ Params: P & { runId: string } }>(
    "/api/projects/:projectId/ci/runs/:runId/cancel",
    (req, reply) =>
      withProject(req.params.projectId, reply, async (p) => {
        await ci.cancel(p, Number(req.params.runId));
        return reply.code(202).send({ ok: true });
      }),
  );

  app.get<{ Params: P & { jobId: string } }>(
    "/api/projects/:projectId/ci/jobs/:jobId/logs",
    (req, reply) =>
      withProject(req.params.projectId, reply, (p) => ci.jobLog(p, Number(req.params.jobId))),
  );

  app.post<{ Params: P & { jobId: string } }>(
    "/api/projects/:projectId/ci/jobs/:jobId/rerun",
    (req, reply) =>
      withProject(req.params.projectId, reply, async (p) => {
        await ci.rerunJob(p, Number(req.params.jobId));
        return reply.code(202).send({ ok: true });
      }),
  );
}
