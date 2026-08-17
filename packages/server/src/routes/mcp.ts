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
import { resolveMcpServers } from "../services/mcp-session.js";

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
      // Resolved the same way a session resolves them, against the PRIMARY
      // checkout — this catalog is project-scoped, so the primary is the only
      // checkout it can honestly describe. Without resolving, a server whose
      // port is written `{mcpPort}` would be probed with the placeholder still
      // in its env and report a startup failure that no session would ever hit.
      const mcpServers = await resolveMcpServers(
        {
          ...(project.mcpServers ?? {}),
          ...services.projectConfig.getMcpServers(project.id),
        },
        {
          projectId: project.id,
          cwd: project.repoPath,
          repoRoot: project.repoPath,
          branch: project.defaultBranch ?? "main",
        },
        services.broker.mcpPorts,
      );
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
          // …and `create_pr` exists wherever change ships through a PR, which is
          // the same condition the broker binds on AND the same one under which
          // the trunk guard refuses a raw `gh pr create`.
          prCreate: !!services.github && resolveWorkflow(project).requirePr,
          // `spawn_chat` is wired for every session in production (the container
          // sets the broker's spawn hook unconditionally) — what varies is
          // whether the human is ASKED, not whether the tool exists.
          chats: !!services.broker.spawnChat,
          // The MCP-config tools only need the project's repo path, which every
          // project has — so they're offered wherever the catalog is viewable.
          mcpConfig: !!project.repoPath,
          // Prewarm exists wherever the broker could build one, which needs the
          // project config that names each server's `prewarm` command.
          prewarm: !!services.broker.mcpPrewarm,
          // `request_exemption` exists only where a guard actually REFUSES
          // things — the same condition the broker binds on. On `warn`/`off`
          // nothing is blocked, so there is nothing to ask to have lifted.
          exemptions: resolveWorkflow(project).guard === "deny",
        },
        mcpServers,
      });
      cache.set(project.id, { at: now, catalog });
      return catalog;
    },
  );
}
