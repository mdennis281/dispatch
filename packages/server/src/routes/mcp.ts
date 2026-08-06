/**
 * MCP catalog endpoint — visualize every MCP tool a project's agents can call.
 *
 *   GET /api/projects/:projectId/mcp[?fresh=1] → McpCatalog
 *
 * Returns the in-process "manager" server (its tools enumerated from the same
 * definitions the SDK registers) plus every external server on the project's
 * `mcpServers` config (each probed over a short-timeout `tools/list`). A bad
 * external server is reported `status:"error"`, never failing the endpoint.
 *
 * The external probe SPAWNS a subprocess / opens a socket per server, so the
 * assembled catalog is cached per-project with a short TTL — repeatedly opening
 * the view doesn't re-spawn every configured server. `?fresh=1` bypasses the
 * cache (the UI's Refresh button).
 */
import type { FastifyInstance } from "fastify";
import type { McpCatalog } from "@dispatch/shared";
import { resolveWorkflow } from "@dispatch/shared";
import { buildProjectMcpCatalog } from "../services/mcp/mcp-catalog.js";

/** How long an assembled catalog is reused before a re-probe. */
const CACHE_TTL_MS = 15_000;

export function registerMcpRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const services = app.services;
  const cache = new Map<string, { at: number; catalog: McpCatalog }>();

  app.get<{ Params: { projectId: string }; Querystring: { fresh?: string } }>(
    "/api/projects/:projectId/mcp",
    async (req, reply) => {
      const project = await store.getProject(req.params.projectId).catch(() => null);
      if (!project) return reply.code(404).send({ error: "project not found" });

      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      const now = Date.now();
      const hit = cache.get(project.id);
      if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return hit.catalog;

      // The effective set a session gets: the `.data` record layered with the
      // repo's `.dispatch/` config-sourced servers (config wins per-name),
      // mirroring the broker's `buildOptions` merge — so a config-declared server
      // shows up here with its live probe status.
      const mcpServers = {
        ...(project.mcpServers ?? {}),
        ...services.projectConfig.getMcpServers(project.id),
      };
      const catalog = await buildProjectMcpCatalog(project, {
        // terminal/memory/github are all wired in production, so their manager
        // tools show as available; a missing binding flips the tool to unavailable.
        bindings: {
          github: !!services.github,
          terminals: !!services.terminals,
          memory: !!services.memory,
          runner: !!services.runner,
          // `approve_pr` exists only where the project opted into auto-merge —
          // the same condition the broker binds on, so the catalog shows the
          // tool as unavailable on every project that hasn't turned it on.
          prApproval: !!services.github && resolveWorkflow(project).autoMerge === "on-green",
          // The MCP-config tools only need the project's repo path, which every
          // project has — so they're offered wherever the catalog is viewable.
          mcpConfig: !!project.repoPath,
        },
        mcpServers,
      });
      cache.set(project.id, { at: now, catalog });
      return catalog;
    },
  );
}
