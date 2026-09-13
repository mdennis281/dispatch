/**
 * REST for a project's issue source.
 *
 *   GET /api/projects/:id/issues/source → { configured, detected, remote, effective }
 *
 * Exists for the config pane's autofill: it shows what `origin` implies next to
 * what the manifest authored, so the human can accept the guess or override it
 * (a fork whose issues live upstream, an Enterprise host the guess can't name).
 * `remote` is credential-redacted by the service before it gets here.
 */
import type { FastifyInstance } from "fastify";

export function registerIssueRoutes(app: FastifyInstance): void {
  const { issues, store, projectConfig } = app.services;

  app.get<{ Params: { id: string } }>("/api/projects/:id/issues/source", async (req, reply) => {
    const project = await store.getProject(req.params.id).catch(() => null);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const configured = projectConfig.getIssues(project.id)?.source ?? null;
    const { remote, source: detected } = await issues.detect(project.repoPath);
    const effective = configured
      ? { source: configured, from: "config" as const }
      : detected
        ? { source: detected, from: "origin" as const }
        : null;
    return { configured, detected, remote, effective };
  });
}
