/**
 * REST for a project's issue tracker and the watcher that polls it.
 *
 *   GET  /api/projects/:id/issues/source  → { configured, detected, remote, effective }
 *   GET  /api/projects/:id/issues/status  → { policy, watch, claims, active, globalEnabled }
 *   POST /api/projects/:id/issues/poll    → IssuePollResult (ignores the interval, nothing else)
 *   PUT  /api/projects/:id/config/issues  → save the `issues:` block to project.yaml
 *
 * `source` exists for the config pane's autofill: it shows what `origin`
 * implies next to what the manifest authored, so the human can accept the
 * guess or override it (a fork whose issues live upstream, an Enterprise host
 * the guess can't name). `remote` is credential-redacted by the service.
 */
import type { FastifyInstance } from "fastify";
import { IssueConfigSchema, resolveIssuePolicy } from "@dispatch/shared";
import { saveProjectIssues } from "../services/workflow-writer.js";

export function registerIssueRoutes(app: FastifyInstance): void {
  const { issues, issueWatcher, store, projectConfig } = app.services;

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

  app.get<{ Params: { id: string } }>("/api/projects/:id/issues/status", async (req, reply) => {
    const project = await store.getProject(req.params.id).catch(() => null);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const [status, settings] = await Promise.all([
      issueWatcher.status(project.id),
      store.getSettings().catch(() => null),
    ]);
    return {
      config: projectConfig.getIssues(project.id),
      policy: resolveIssuePolicy(projectConfig.getIssues(project.id)),
      globalEnabled: settings?.issueWatcher?.enabled ?? true,
      ...status,
    };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/issues/poll", async (req, reply) => {
    const project = await store.getProject(req.params.id).catch(() => null);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return issueWatcher.pollNow(project.id);
  });

  // `null` removes the block (the project stops being enrolled and loses its
  // authored source/filters); a value replaces it whole. Manifest-only, like
  // `defaults`: the block is read from the loaded config and nowhere else.
  app.put<{ Params: { id: string } }>("/api/projects/:id/config/issues", async (req, reply) => {
    const body = req.body === null ? null : IssueConfigSchema.safeParse(req.body ?? {});
    if (body && !body.success) return reply.code(400).send({ error: body.error.message });
    try {
      const out = await saveProjectIssues({ store, projectConfig }, req.params.id, body ? body.data : null);
      if (!out) return reply.code(404).send({ error: "project not found" });
      app.services.bus.publish({ type: "project-update", project: out.project });
      return out;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
