/**
 * MCP catalog endpoint — visualize every MCP tool a project's agents can call,
 * and switch any of them off.
 *
 *   GET /api/projects/:projectId/mcp[?fresh=1]        → McpCatalog
 *   PUT /api/projects/:projectId/mcp/:name/enabled    → McpCatalog
 *
 * The catalog returns the in-process "manager" server (its tools enumerated from
 * the same definitions the SDK registers), the BUNDLED servers Dispatch injects
 * on the project's behalf (the browser pair), and every external server on the
 * project's `mcpServers` config — each spawnable one probed over a short-timeout
 * `tools/list`. A bad server is reported `status:"error"`, never failing the
 * endpoint.
 *
 * The external probe SPAWNS a subprocess / opens a socket per server, so the
 * assembled catalog is cached per-project with a short TTL — repeatedly opening
 * the view doesn't re-spawn every configured server. `?fresh=1` bypasses the
 * cache (the UI's Refresh button), and a toggle write invalidates it, since the
 * whole point of the write is that the next read says something different.
 */
import type { FastifyInstance } from "fastify";
import { setServerEnabled } from "@dispatch/cli/core";
import type {
  McpCatalog,
  McpEnablementLayers,
  McpServerConfig,
  SubApp,
} from "@dispatch/shared";
import { BROWSER_MCP_SERVERS, isAlwaysOnMcpServer, resolveWorkflow } from "@dispatch/shared";
import {
  buildProjectMcpCatalog,
  type BundledCatalogServer,
} from "../services/mcp/mcp-catalog.js";
import {
  ManagerToolBinding,
  buildBrowserMcpServers,
  browserServerDefault,
  browserServerDefaultReason,
  effectiveSubApps,
} from "../services/mcp/browser-mcp.js";

import { resolveMcpServers } from "../services/mcp-session.js";

/** How long an assembled catalog is reused before a re-probe. */
const CACHE_TTL_MS = 15_000;

export function registerMcpRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const services = app.services;
  const cache = new Map<string, { at: number; catalog: McpCatalog }>();

  /**
   * The bundled browser servers as catalog inputs — ALL of them, switched off or
   * not, because a toggle you can't see is a toggle you can't undo. Their
   * enablement is resolved downstream; what's computed here is the DEFAULT each
   * would have with neither layer pinning it, i.e. what `browser:` alone says.
   */
  function bundledServers(
    projectId: string,
    apps: readonly SubApp[],
  ): BundledCatalogServer[] {
    const browserConfig = services.projectConfig?.getBrowserConfig?.(projectId);
    const unavailable = new Map<string, string>();
    const built = buildBrowserMcpServers({
      config: browserConfig,
      // Every one of them: the catalog describes what COULD run here, and the
      // toggle beside a disabled row is how it starts running.
      servers: BROWSER_MCP_SERVERS,
      onUnavailable: (name, pkg) =>
        unavailable.set(name, `${pkg} is not installed — reinstall Dispatch's dependencies.`),
    });
    return BROWSER_MCP_SERVERS.map((name) => ({
      name,
      config: (built[name] ?? {}) as McpServerConfig,
      byDefault: browserServerDefault(name, browserConfig, apps),
      defaultReason: browserServerDefaultReason(browserConfig, apps),
      ...(unavailable.has(name) ? { unavailable: unavailable.get(name)! } : {}),
    }));
  }

  /** The app + project `mcpEnabled` layers for one project. */
  async function enablementLayers(projectId: string): Promise<McpEnablementLayers> {
    const settings = await store.getSettings().catch(() => undefined);
    return {
      app: settings?.mcpEnabled,
      project: services.projectConfig?.getMcpEnabled?.(projectId),
    };
  }

  async function buildCatalog(projectId: string): Promise<McpCatalog | null> {
    const project = await store.getProject(projectId).catch(() => null);
    if (!project) return null;

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
    // Config-first for the same reason the broker is: a live manifest edit that
    // added a sub-app should move the browser auto-gate on the next READ, not
    // only after the store re-syncs. See `effectiveSubApps` for why the fallback
    // is on empty rather than on nullish.
    const subApps = effectiveSubApps(
      services.projectConfig?.getSubApps?.(project.id),
      project.subApps,
    );
    return buildProjectMcpCatalog(project, {
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
      bundled: bundledServers(project.id, subApps),
      enablement: await enablementLayers(project.id),
    });
  }

  app.get<{ Params: { projectId: string }; Querystring: { fresh?: string } }>(
    "/api/projects/:projectId/mcp",
    async (req, reply) => {
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      const now = Date.now();
      const hit = cache.get(req.params.projectId);
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
      // terminal/memory/github are all wired in production, so their manager
      // tools show as available; a missing binding flips the tool to unavailable.
      //
      // Typed as the COMPLETE record rather than the partial the builder takes:
      // an omitted key reads as `false`, so a gate added to `MANAGER_TOOL_GATE`
      // without a line here would silently report a working tool as unavailable
      // — which is exactly how `worktree`/`chat_find`/`chat_read`/`project_info`
      // came to show an "unavailable" chip while every session could call them.
      // Spelling the record out makes that a compile error instead.
      const bindings: Record<ManagerToolBinding, boolean> = {
        github: !!services.github,
        terminals: !!services.terminals,
        memory: !!services.memory,
        runner: !!services.runner,
        // Worktrees and cross-chat inspection are constructed unconditionally by
        // the container, and the broker binds both for every session — so they
        // are available wherever this catalog is viewable at all.
        worktrees: !!services.worktrees,
        inspect: !!services.inspect,
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
      };
      const catalog = await buildProjectMcpCatalog(project, { bindings, mcpServers });
      if (!catalog) return reply.code(404).send({ error: "project not found" });
      cache.set(project.id, { at: now, catalog });

      return catalog;
    },
  );

  /**
   * Pin one server on or off, at one of the two scopes.
   *
   *   { scope: "app",     enabled: false }  → this install, every project
   *   { scope: "project", enabled: true  }  → committed to `.dispatch/project.yaml`
   *   { scope: …,         enabled: null  }  → clear the pin, inherit again
   *
   * Returns the freshly rebuilt catalog rather than an ack: the write changes
   * which servers get probed, so the client would have to re-fetch immediately
   * anyway — and a toggle that flips back on the next poll because the two
   * round-trips raced is exactly the bug this avoids.
   */
  app.put<{
    Params: { projectId: string; name: string };
    Body: { scope?: string; enabled?: boolean | null };
  }>("/api/projects/:projectId/mcp/:name/enabled", async (req, reply) => {
    const { projectId, name } = req.params;
    const project = await store.getProject(projectId).catch(() => null);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const scope = req.body?.scope;
    if (scope !== "app" && scope !== "project") {
      return reply.code(400).send({ error: 'scope must be "app" or "project"' });
    }
    const enabled = req.body?.enabled ?? null;
    if (enabled !== null && typeof enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be true, false or null" });
    }
    // Refused rather than silently ignored: `manager` is how an agent writes this
    // very setting, and a request to switch it off is a misunderstanding worth
    // reporting back instead of a no-op the caller reads as success.
    if (isAlwaysOnMcpServer(name)) {
      return reply.code(400).send({ error: `"${name}" cannot be disabled` });
    }

    try {
      if (scope === "app") {
        const settings = await store.getSettings();
        const next = { ...(settings.mcpEnabled ?? {}) };
        if (enabled === null) delete next[name];
        else next[name] = enabled;
        // Targeted patch, NOT the full-replace PUT /api/settings takes: this
        // caller holds one toggle, not a complete settings draft, and sending a
        // partial one there would clear every field it didn't know about.
        await store.saveSettings({
          ...settings,
          ...(Object.keys(next).length ? { mcpEnabled: next } : { mcpEnabled: undefined }),
        });
      } else {
        // The PRIMARY checkout: `.dispatch/` is committed config, and an edit
        // made in a throwaway worktree would be discarded with it.
        await setServerEnabled(project.repoPath, name, enabled);
        // The `.dispatch/` watcher would pick this up on its own, but only after
        // a debounce — and the catalog rebuilt below reads through the config
        // cache. Without this the response would report the value we just
        // replaced, and the switch would visibly snap back.
        await services.projectConfig.reload(projectId).catch(() => {});
      }
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }

    cache.delete(projectId);
    const catalog = await buildCatalog(projectId);
    if (!catalog) return reply.code(404).send({ error: "project not found" });
    cache.set(projectId, { at: Date.now(), catalog });
    return catalog;
  });
}
