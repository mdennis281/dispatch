/**
 * REST for the GitHub control plane. Read endpoints resolve owner/repo from a
 * projectId; the single action endpoint reuses the exact `gh-action` dispatcher
 * the WS layer uses (ship/merge/hold/label/rerun/resolve-thread/review/dispatch/
 * refresh), so REST and WS never drift.
 *   GET  /api/github/prs?projectId=&state=      → PRInfo[]
 *   GET  /api/github/project-prs?projectId=     → PRInfo[] (all open, global view)
 *   GET  /api/github/pr/:number?projectId=      → PRInfo (enriched) | 404
 *   GET  /api/github/pr/:number/detail?projectId= → PRInfo (rich detail) | 404
 *   GET  /api/github/workflows?projectId=       → WorkflowDef[]
 *   GET  /api/github/workflows/status?projectId= → WorkflowWithLastRun[]
 *   GET  /api/github/workflows/inputs?projectId=&workflow= → WorkflowInput[]
 *   GET  /api/github/runs?projectId=&workflow=&branch= → WorkflowRun[]
 *   POST /api/github/action { GhAction body }   → 202 (events stream over WS)
 */
import type { FastifyInstance } from "fastify";
import { GhActionSchema } from "@dispatch/shared";
import { runGhAction } from "./dispatch.js";

async function repoFor(
  app: FastifyInstance,
  projectId: string | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  const project = await app.cm.store.getProject(projectId);
  if (!project) return null;
  return app.services.github.repoForProject(project);
}

export function registerGithubRoutes(app: FastifyInstance): void {
  const { github } = app.services;

  app.get<{
    Querystring: { projectId?: string; state?: string; base?: string; limit?: string };
  }>("/api/github/prs", async (req, reply) => {
    const repo = await repoFor(app, req.query.projectId);
    if (!repo) return reply.code(400).send({ error: "valid projectId required" });
    try {
      return await github.prList(repo, {
        state: (req.query.state as never) ?? "open",
        base: req.query.base,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ALL open PRs for the project — the global (not per-chat) PR view.
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/github/project-prs",
    async (req, reply) => {
      const repo = await repoFor(app, req.query.projectId);
      if (!repo) return reply.code(400).send({ error: "valid projectId required" });
      try {
        return await github.projectOpenPrs(repo);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{
    Params: { number: string };
    Querystring: { projectId?: string };
  }>("/api/github/pr/:number", async (req, reply) => {
    const repo = await repoFor(app, req.query.projectId);
    if (!repo) return reply.code(400).send({ error: "valid projectId required" });
    try {
      const pr = await github.refreshPr(repo, Number(req.params.number));
      if (!pr) return reply.code(404).send({ error: "PR not found" });
      return pr;
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Rich detail for one PR (checks rollup + review decision + threads + counts).
  app.get<{
    Params: { number: string };
    Querystring: { projectId?: string };
  }>("/api/github/pr/:number/detail", async (req, reply) => {
    const repo = await repoFor(app, req.query.projectId);
    if (!repo) return reply.code(400).send({ error: "valid projectId required" });
    try {
      const pr = await github.prDetail(repo, Number(req.params.number));
      if (!pr) return reply.code(404).send({ error: "PR not found" });
      return pr;
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/github/workflows",
    async (req, reply) => {
      const repo = await repoFor(app, req.query.projectId);
      if (!repo) {
        return reply.code(400).send({ error: "valid projectId required" });
      }
      try {
        return await github.listWorkflows(repo);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Each workflow + its latest run — the default Actions view.
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/github/workflows/status",
    async (req, reply) => {
      const repo = await repoFor(app, req.query.projectId);
      if (!repo) return reply.code(400).send({ error: "valid projectId required" });
      try {
        return await github.workflowsWithLastRun(repo);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // The workflow_dispatch input schema for a workflow (for the Run form).
  app.get<{ Querystring: { projectId?: string; workflow?: string } }>(
    "/api/github/workflows/inputs",
    async (req, reply) => {
      const repo = await repoFor(app, req.query.projectId);
      if (!repo) return reply.code(400).send({ error: "valid projectId required" });
      if (!req.query.workflow) {
        return reply.code(400).send({ error: "workflow required" });
      }
      try {
        return await github.workflowInputs(repo, req.query.workflow);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get<{
    Querystring: { projectId?: string; workflow?: string; branch?: string; limit?: string };
  }>("/api/github/runs", async (req, reply) => {
    const repo = await repoFor(app, req.query.projectId);
    if (!repo) return reply.code(400).send({ error: "valid projectId required" });
    try {
      return await github.listRuns(repo, req.query.workflow, {
        branch: req.query.branch,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/github/action", async (req, reply) => {
    const parsed = GhActionSchema.safeParse({ type: "gh-action", ...(req.body ?? {}) });
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    try {
      await runGhAction(app.services, parsed.data);
      return reply.code(202).send({ ok: true });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
