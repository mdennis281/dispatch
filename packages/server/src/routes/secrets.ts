/**
 * REST for the secret store.
 *
 *   GET    /api/secrets[?projectId]  → { secrets: (SecretSummary & { usedBy })[], missing }
 *   PUT    /api/secrets              → SecretPut → { secret: SecretSummary, refresh }
 *   DELETE /api/secrets              → SecretDelete → { deleted, refresh }
 *
 * WRITE-ONLY. A value goes in on a PUT and nothing ever returns it — not this
 * route, not the MCP tools — so a hijacked browser session can replace a key but
 * never read one it didn't already have. Same stance as `/api/reviewer`.
 *
 * A save or delete REFRESHES before answering, so the report the caller gets is
 * what actually happened, and a `secret_request` card that saved through here
 * can hand the agent the same report (see `SecretRefresher.lastReport`).
 */
import type { FastifyInstance } from "fastify";
import {
  SecretDeleteSchema,
  SecretPutSchema,
  type SecretSummary,
} from "@dispatch/shared";
import type { SecretKey } from "../services/secrets.js";

function keyOf(body: { name: string; scope: "project" | "global"; projectId?: string }): SecretKey | string {
  if (body.scope === "project") {
    return body.projectId
      ? { name: body.name, scope: "project", projectId: body.projectId }
      : "projectId is required for a project secret";
  }
  return { name: body.name, scope: "global" };
}

export function registerSecretRoutes(app: FastifyInstance): void {
  const { secrets, secretRefresher, projectConfig } = app.services;

  app.get<{ Querystring: { projectId?: string } }>("/api/secrets", async (req) => {
    const projectId = req.query.projectId || undefined;
    const rows = await secrets.list(projectId);
    // Usage is per project; without one, attribute across every loaded project.
    const usedBy = (s: SecretSummary): string[] => {
      const projects = s.scope === "project" ? [s.projectId!] : projectId ? [projectId] : projectConfig.projectsReferencingSecret(s.name);
      return projects.flatMap((p) => projectConfig.secretConsumers(p, s.name).map((c) => `${p}:${c}`));
    };
    const have = new Set(rows.map((r) => r.name));
    const refs = projectId ? projectConfig.secretReferences(projectId) : {};
    return {
      secrets: rows.map((r) => ({ ...r, usedBy: usedBy(r) })),
      missing: Object.entries(refs)
        .filter(([name]) => !have.has(name))
        .map(([name, consumers]) => ({ name, usedBy: consumers.map((c) => `${projectId}:${c}`) })),
    };
  });

  app.put("/api/secrets", async (req, reply) => {
    const parsed = SecretPutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const key = keyOf(parsed.data);
    if (typeof key === "string") return reply.code(400).send({ error: key });
    const secret = await secrets.set(key, parsed.data.value);
    const refresh = await secretRefresher.refresh([key]);
    return { secret, refresh };
  });

  app.delete("/api/secrets", async (req, reply) => {
    const parsed = SecretDeleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const key = keyOf(parsed.data);
    if (typeof key === "string") return reply.code(400).send({ error: key });
    const deleted = await secrets.delete(key);
    const refresh = deleted ? await secretRefresher.refresh([key]) : null;
    return { deleted, refresh };
  });
}
