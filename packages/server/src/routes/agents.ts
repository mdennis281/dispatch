/**
 * REST CRUD for agent configs (custom instructions + permission profile).
 *   GET    /api/agents        → AgentConfig[]
 *   POST   /api/agents        → create (id defaulted)
 *   GET    /api/agents/:id     → AgentConfig | 404
 *   PUT    /api/agents/:id     → merge
 *   DELETE /api/agents/:id     → 204
 */
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { AgentConfigSchema } from "@cm/shared";
import { mergeById } from "../services/project-config.js";

export function registerAgentRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { projectConfig } = app.services;

  // Merge config-sourced agents (from any project's `.claude-manager/agents/`)
  // OVER the `.data` store — the repo config wins on id collision — so the
  // composer's agent picker (and the broker) see the config-authored ones.
  app.get("/api/agents", async () =>
    mergeById(projectConfig.configAgents(), await store.listAgents()),
  );

  app.post("/api/agents", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = AgentConfigSchema.safeParse({
      scope: "global",
      ...body,
      id: (body.id as string) || nanoid(),
      createdAt: (body.createdAt as number) ?? Date.now(),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    return reply.code(201).send(await store.saveAgent(parsed.data));
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent) return reply.code(404).send({ error: "not found" });
    return agent;
  });

  app.put<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const existing = await store.getAgent(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = AgentConfigSchema.safeParse({
      scope: "global",
      ...existing,
      ...body,
      id: req.params.id,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    return store.saveAgent(parsed.data);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/agents/:id",
    async (req, reply) => {
      await store.deleteAgent(req.params.id);
      return reply.code(204).send();
    },
  );
}
