/**
 * Tests for the MCP catalog: the pure builder (`buildProjectMcpCatalog`) and the
 * live `GET /api/projects/:projectId/mcp` route.
 *
 * Dispatch's own category servers must enumerate their full tool set (incl `watch_pr`)
 * with non-empty input schemas + flattened params, and an external server that
 * fails to connect must surface as `status:"error"` WITHOUT failing the endpoint
 * (the external probe is injected here, so nothing is ever spawned).
 *
 * The toggle endpoint is covered against a REAL temp repo rather than a mock,
 * because the two halves worth protecting are both on-disk: a project pin has to
 * land in `.dispatch/project.yaml`, and an app pin has to land in settings and
 * NOT in the repo — a leak in either direction commits somebody's local
 * preference or strands a team decision on one machine.
 */
import { MANAGER_SERVER_NAMES } from "@dispatch/shared";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { McpCatalog, Project } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import {
  buildProjectMcpCatalog,
  paramsFromJsonSchema,
  type McpProbe,
} from "../services/mcp/mcp-catalog.js";

/* ------------------------------------------------------------------ helpers */

function makeProject(mcpServers?: Project["mcpServers"]): Project {
  return {
    id: "p1",
    name: "Widget",
    repoPath: "/tmp/widget",
    worktreeRoot: "/tmp/widget-wt",
    subApps: [],
    createdAt: 0,
    ...(mcpServers ? { mcpServers } : {}),
  };
}

/**
 * One tool from a catalog, found across ALL of Dispatch's category servers.
 *
 * The toolbox is partitioned across eight entries now, so `servers[0].tools`
 * answers a question about `dispatch-github` rather than about the toolbox —
 * and a lookup that misses returns `undefined` and throws on the next line,
 * which reads as an unrelated crash rather than as "wrong server".
 */
const dispatchTool = (catalog: McpCatalog, name: string) => {
  const found = catalog.servers
    .filter((s) => MANAGER_SERVER_NAMES.includes(s.name))
    .flatMap((s) => s.tools)
    .find((t) => t.name === name);
  if (!found) throw new Error(`no Dispatch tool named ${name} in the catalog`);
  return found;
};

/** Every tool across Dispatch's own servers. */
const dispatchTools = (catalog: McpCatalog) =>
  catalog.servers.filter((s) => MANAGER_SERVER_NAMES.includes(s.name)).flatMap((s) => s.tools);

/* ---------------------------------------------------------------- builder */

describe("mcp-catalog — builder", () => {
  it("enumerates Dispatch's category servers with the full tool set + schemas/params", async () => {
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      bindings: {
        github: true,
        prApproval: true,
        prCreate: true,
        terminals: true,
        worktrees: true,
        memory: true,
        runner: true,
        chats: true,
        mcpConfig: true,
        inspect: true,
        prewarm: true,
        exemptions: true,
      },
    });

    // Fully bound → every category is present, and nothing else.
    expect(catalog.servers.map((s) => s.name)).toEqual([...MANAGER_SERVER_NAMES]);
    for (const server of catalog.servers) {
      expect(server.kind).toBe("custom");
      expect(server.status).toBe("ok");
      expect(server.transport).toEqual({ type: "sdk" });
    }
    // The assertions below are about the toolbox as a whole, not about one
    // server, so they run over the union — the partition is asserted separately.
    const manager = {
      name: "dispatch",
      tools: catalog.servers.flatMap((s) => s.tools),
    };
    const names = manager.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "wait",
        "wait_for_chat",
        "watch_pr",
        "create_pr",
        "approve_pr",
        "terminal",
        "worktree",
        "remember",
        "recall",
        "forget",
        "run_subapp",
        "prewarm_mcp",
        "spawn_chat",
        "mcp_list",
        "mcp_add",
        "mcp_remove",
        "chat_find",
        "chat_read",
        "project_info",
      ]),
    );

    // Tools that legitimately take no arguments (they act on the calling chat's
    // own state, or on the project's config as a whole) carry an empty schema;
    // every other tool has flattened params.
    const NO_ARG_TOOLS = new Set([
      "context_usage",
      "compact_context",
      "mcp_list",
      "prewarm_mcp",
    ]);
    for (const server of catalog.servers) {
      for (const tool of server.tools) {
        expect(tool.qualifiedName).toBe(`mcp__${server.name}__${tool.name}`);
      }
    }
    for (const tool of manager.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      if (!NO_ARG_TOOLS.has(tool.name)) {
        const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
        expect(props && Object.keys(props).length).toBeGreaterThan(0);
        expect(tool.params.length).toBeGreaterThan(0);
      }
      // All bindings present → all tools available.
      expect(tool.available).toBe(true);
    }

    // Spot-check watch_pr's derived params (number required, repo optional).
    const watchPr = manager.tools.find((t) => t.name === "watch_pr")!;
    const number = watchPr.params.find((p) => p.name === "number")!;
    expect(number.required).toBe(true);
    expect(number.type).toBe("number");
    expect(watchPr.params.find((p) => p.name === "repo")!.required).toBe(false);
  });

  it("marks a manager tool unavailable when its backing service is unbound", async () => {
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: false, terminals: true, memory: true },
    });
    const manager = { tools: catalog.servers.flatMap((s) => s.tools) };
    // watch_pr is gated on the github binding → unavailable when unbound…
    expect(manager.tools.find((t) => t.name === "watch_pr")!.available).toBe(false);
    // …as is approve_pr on its own (auto-merge) binding, which this project
    // hasn't opted into…
    expect(manager.tools.find((t) => t.name === "approve_pr")!.available).toBe(false);
    // …while ungated tools stay available.
    expect(manager.tools.find((t) => t.name === "wait")!.available).toBe(true);
  });

  it("offers approve_pr only when the project opted into auto-merge", async () => {
    // The catalog mirrors what a session gets: the tool is bound off the
    // project's resolved workflow, not off GitHub being wired up.
    const off = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: true, prApproval: false },
    });
    expect(dispatchTool(off, "approve_pr").available).toBe(false);
    const on = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: true, prApproval: true },
    });
    expect(dispatchTool(on, "approve_pr").available).toBe(true);
  });

  it("offers request_exemption only where a guard actually refuses things", async () => {
    // On `warn`/`off` nothing is blocked, so a tool for asking to have a guard
    // lifted would be an invitation to seek permission nobody needed to give.
    const off = await buildProjectMcpCatalog(makeProject(), { bindings: { exemptions: false } });
    expect(dispatchTool(off, "request_exemption").available).toBe(
      false,
    );
    const on = await buildProjectMcpCatalog(makeProject(), { bindings: { exemptions: true } });
    expect(dispatchTool(on, "request_exemption").available).toBe(true);
  });

  it("offers create_pr only where change ships through a PR", async () => {
    // Same rule the trunk guard uses to refuse a raw `gh pr create`, so a
    // refusal never points at a tool the session doesn't have.
    const off = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: true, prCreate: false },
    });
    expect(dispatchTool(off, "create_pr").available).toBe(false);
    const on = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: true, prCreate: true },
    });
    expect(dispatchTool(on, "create_pr").available).toBe(true);
  });

  it("reports an external server that fails to connect as status:error (endpoint intact)", async () => {
    const failingProbe: McpProbe = async () => {
      throw new Error("spawn boom: ENOENT");
    };
    const catalog = await buildProjectMcpCatalog(
      makeProject({ broken: { command: "does-not-exist" } }),
      { probe: failingProbe },
    );

    // Dispatch's own servers still enumerated — one bad external never fails the whole thing.
    expect(catalog.servers[0]!.name).toBe(MANAGER_SERVER_NAMES[0]);
    const broken = catalog.servers.find((s) => s.name === "broken")!;
    expect(broken.kind).toBe("external");
    expect(broken.status).toBe("error");
    expect(broken.error).toContain("ENOENT");
    expect(broken.transport).toEqual({ type: "stdio", command: "does-not-exist", args: undefined });
    expect(broken.tools).toEqual([]);
  });

  it("lists an external server's tools on a successful probe", async () => {
    const okProbe: McpProbe = async () => ({
      status: "ok",
      tools: [
        {
          name: "search",
          description: "Search the web",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "the query" } },
            required: ["query"],
          },
        },
      ],
    });
    const catalog = await buildProjectMcpCatalog(
      makeProject({ web: { url: "https://example.com/mcp" } }),
      { probe: okProbe },
    );
    const web = catalog.servers.find((s) => s.name === "web")!;
    expect(web.status).toBe("ok");
    expect(web.transport).toEqual({ type: "http", url: "https://example.com/mcp" });
    expect(web.tools[0]!.qualifiedName).toBe("mcp__web__search");
    expect(web.tools[0]!.params).toEqual([
      { name: "query", type: "string", required: true, description: "the query" },
    ]);
  });

  it("enumerates the `mcpServers` override (config-sourced set) instead of project.mcpServers", async () => {
    const okProbe: McpProbe = async () => ({
      status: "ok",
      tools: [
        {
          name: "screenshot",
          description: "Capture the active tab",
          inputSchema: { type: "object", properties: { tab: { type: "string" } } },
        },
      ],
    });
    // The project record has no external servers, but the config supplies one —
    // exactly the merged set the route hands in. The catalog must list it.
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      mcpServers: { "claude-in-chrome": { type: "sse", url: "http://127.0.0.1:9999/sse" } },
      probe: okProbe,
    });
    // Dispatch's own come first; the config server shows up probed + ok.
    expect(catalog.servers[0]!.name).toBe(MANAGER_SERVER_NAMES[0]);
    const chrome = catalog.servers.find((s) => s.name === "claude-in-chrome")!;
    expect(chrome.kind).toBe("external");
    expect(chrome.status).toBe("ok");
    expect(chrome.transport).toEqual({ type: "sse", url: "http://127.0.0.1:9999/sse" });
    expect(chrome.tools[0]!.qualifiedName).toBe("mcp__claude-in-chrome__screenshot");
  });

  it("marks a transport-less external server unconfigured and never probes it", async () => {
    let probed = false;
    const probe: McpProbe = async () => {
      probed = true;
      return { status: "ok", tools: [] };
    };
    const catalog = await buildProjectMcpCatalog(makeProject({ empty: {} }), { probe });
    const empty = catalog.servers.find((s) => s.name === "empty")!;
    expect(empty.status).toBe("unconfigured");
    expect(probed).toBe(false);
  });

  it("probes a stdio server in the project repo, so relative args resolve", async () => {
    // Regression: without a cwd the child inherits the MANAGER's cwd, and a
    // config like `node ./tools/sim-mcp/index.mjs` dies with "Connection closed".
    const seen: Array<string | undefined> = [];
    const probe: McpProbe = async (_n, _c, _t, cwd) => {
      seen.push(cwd);
      return { status: "ok", tools: [] };
    };
    await buildProjectMcpCatalog(
      makeProject({ sim: { command: "node", args: ["./tools/sim-mcp/index.mjs"] } }),
      { probe },
    );
    expect(seen).toEqual(["/tmp/widget"]);
  });

  it("lets a server override the spawn cwd", async () => {
    let seen: string | undefined;
    const probe: McpProbe = async (_n, config, _t, cwd) => {
      seen = config.cwd ?? cwd;
      return { status: "ok", tools: [] };
    };
    await buildProjectMcpCatalog(
      makeProject({ sim: { command: "node", args: ["x.mjs"], cwd: "/tmp/elsewhere" } }),
      { probe },
    );
    expect(seen).toBe("/tmp/elsewhere");
  });

  it("lists a bundled server under its own kind, probed like any other", async () => {
    // The gap this closes: the browser pair was injected into every session and
    // named nowhere in the one view that claims to list everything available.
    const probe: McpProbe = async () => ({
      status: "ok",
      tools: [{ name: "browser_navigate", description: "go", inputSchema: {} }],
    });
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      probe,
      bundled: [
        {
          name: "playwright",
          config: { type: "stdio", command: "node", args: ["cli.js"] },
          byDefault: true,
          defaultReason: "on automatically — this project has a sub-app with a url",
        },
      ],
    });
    const pw = catalog.servers.find((s) => s.name === "playwright")!;
    expect(pw.kind).toBe("bundled");
    expect(pw.status).toBe("ok");
    expect(pw.enablement).toMatchObject({ effective: true, source: "default", byDefault: true });
    expect(pw.defaultReason).toMatch(/sub-app/);
    expect(pw.tools[0]!.qualifiedName).toBe("mcp__playwright__browser_navigate");
  });

  it("lists a disabled server WITHOUT probing it", async () => {
    // The point of switching one off is that it never runs — so spawning it to
    // enumerate tools nobody can call would defeat the feature it implements.
    let probed = false;
    const probe: McpProbe = async () => {
      probed = true;
      return { status: "ok", tools: [] };
    };
    const catalog = await buildProjectMcpCatalog(makeProject({ sim: { command: "node" } }), {
      probe,
      enablement: { project: { sim: false } },
    });
    const sim = catalog.servers.find((s) => s.name === "sim")!;
    expect(sim.status).toBe("disabled");
    expect(sim.tools).toEqual([]);
    expect(sim.enablement).toMatchObject({ effective: false, source: "project" });
    expect(probed).toBe(false);
  });

  it("reports EVERY Dispatch server as always-on whatever the layers say", async () => {
    // Off at BOTH layers and by every name: a category that could be switched
    // off is a category whose tools vanish with no way to bring them back.
    const off = Object.fromEntries(MANAGER_SERVER_NAMES.map((n) => [n, false]));
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      enablement: { app: off, project: off },
    });
    for (const name of MANAGER_SERVER_NAMES) {
      const server = catalog.servers.find((s) => s.name === name)!;
      expect(server, name).toBeDefined();
      expect(server.enablement).toMatchObject({ effective: true, alwaysOn: true });
      expect(server.status).toBe("ok");
    }
  });

  it("drops a bundled server the project declares itself, so only one row wins", async () => {
    // The broker's merge lets a project's own `mcpServers` entry override the
    // bundled one outright; listing both would show a row no session gets.
    const probe: McpProbe = async () => ({ status: "ok", tools: [] });
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      probe,
      mcpServers: { playwright: { command: "my-own-playwright" } },
      bundled: [{ name: "playwright", config: { command: "node" }, byDefault: true }],
    });
    const rows = catalog.servers.filter((s) => s.name === "playwright");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("external");
    expect(rows[0]!.transport).toMatchObject({ command: "my-own-playwright" });
  });

  it("surfaces an unresolvable bundled package as an error rather than a silent absence", async () => {
    let probed = false;
    const probe: McpProbe = async () => {
      probed = true;
      return { status: "ok", tools: [] };
    };
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      probe,
      bundled: [
        {
          name: "chrome-devtools",
          config: {},
          byDefault: true,
          unavailable: "chrome-devtools-mcp is not installed",
        },
      ],
    });
    const cdt = catalog.servers.find((s) => s.name === "chrome-devtools")!;
    expect(cdt.status).toBe("error");
    expect(cdt.error).toMatch(/not installed/);
    expect(probed).toBe(false);
  });
});

describe("mcp-catalog — paramsFromJsonSchema", () => {
  it("flattens properties, marks required, and labels array/enum types", () => {
    const params = paramsFromJsonSchema({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        mode: { enum: ["a", "b"] },
        count: { type: "number", description: "how many" },
      },
      required: ["count"],
    });
    expect(params).toEqual([
      { name: "tags", type: "array<string>", required: false, description: undefined },
      { name: "mode", type: "enum", required: false, description: undefined },
      { name: "count", type: "number", required: true, description: "how many" },
    ]);
  });
});

/* ------------------------------------------------------------------ route */

let dir: string;
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("GET /api/projects/:projectId/mcp", () => {
  it("returns the manager catalog for a project and 404s an unknown project", async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mcp-"));
    const store = new Store(dir);
    await store.init();
    const bus = new EventBus();
    const config = { ...loadConfig(), dataDir: dir };
    app = await buildApp({ config, store, bus });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/mcp` });
    expect(res.statusCode).toBe(200);
    const catalog = res.json() as McpCatalog;
    for (const name of MANAGER_SERVER_NAMES) {
      expect(catalog.servers.find((s) => s.name === name)?.kind, name).toBe("custom");
    }
    const manager = { tools: dispatchTools(catalog) };
    expect(manager.tools.map((t) => t.name)).toContain("watch_pr");
    // No-arg tools carry an empty param list: each acts on the calling chat's
    // own state (or the project's config as a whole), so there is nothing to ask for.
    expect(
      manager.tools.every(
        (t) =>
          t.params.length > 0 ||
          ["context_usage", "compact_context", "mcp_list", "prewarm_mcp"].includes(t.name),
      ),
    ).toBe(true);

    // Every tool whose backing service the container builds UNCONDITIONALLY must
    // come back available through the real route. The builder tests above pass
    // bindings by hand, so they cannot catch the route forgetting one — which is
    // how `worktree`/`chat_find`/`chat_read`/`project_info` shipped wearing an
    // "unavailable" chip while every session could call them perfectly well.
    for (const name of [
      "terminal",
      "terminal_output",
      "worktree",
      "remember",
      "recall",
      "spawn_chat",
      "mcp_list",
      "chat_find",
      "chat_read",
      "project_info",
    ]) {
      expect(manager.tools.find((t) => t.name === name)).toMatchObject({ name, available: true });
    }

    const missing = await app.inject({ method: "GET", url: "/api/projects/nope/mcp" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("PUT /api/projects/:projectId/mcp/:name/enabled", () => {
  /** A live app with one project rooted at a real temp dir. */
  async function setup(): Promise<{ projectId: string; repo: string }> {
    dir = await mkdtemp(join(tmpdir(), "cm-mcp-toggle-"));
    const store = new Store(dir);
    await store.init();
    const bus = new EventBus();
    const config = { ...loadConfig(), dataDir: dir };
    app = await buildApp({ config, store, bus });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
    });
    expect(created.statusCode).toBe(201);
    return { projectId: created.json().id as string, repo: dir };
  }

  /**
   * `payload` is typed rather than `unknown` on purpose: `inject`'s overloads
   * resolve to the callback (void-returning) form when the argument object
   * isn't fully known, and the result then has no `.statusCode` at all.
   */
  const toggle = (
    projectId: string,
    name: string,
    body: { scope?: string; enabled?: boolean | null },
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/mcp/${name}/enabled`,
      payload: body,
    });

  it("lists the bundled browser pair, off by default with no web sub-app", async () => {
    const { projectId } = await setup();
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/mcp` });
    const catalog = res.json() as McpCatalog;

    const bundled = catalog.servers.filter((s) => s.kind === "bundled").map((s) => s.name);
    expect(bundled).toEqual(["playwright", "chrome-devtools"]);
    const pw = catalog.servers.find((s) => s.name === "playwright")!;
    // The auto-gate: a project with nothing to point a browser at pays no context.
    expect(pw.status).toBe("disabled");
    expect(pw.enablement).toMatchObject({ effective: false, source: "default" });
    expect(pw.defaultReason).toMatch(/no sub-app/);
  });

  it("writes a project pin to .dispatch/project.yaml and returns the rebuilt catalog", async () => {
    const { projectId, repo } = await setup();
    const res = await toggle(projectId, "chrome-devtools", { scope: "project", enabled: false });
    expect(res.statusCode).toBe(200);

    const manifest = await readFile(join(repo, ".dispatch", "project.yaml"), "utf8");
    expect(manifest).toContain("mcpEnabled");
    expect(manifest).toContain("chrome-devtools: false");

    // The response must already reflect the write — the config watcher is
    // debounced, and a catalog built off the stale cache would snap the switch
    // straight back in the UI.
    const cdt = (res.json() as McpCatalog).servers.find((s) => s.name === "chrome-devtools")!;
    expect(cdt.enablement).toMatchObject({ project: false, effective: false, source: "project" });
  });

  it("writes an app pin to settings, not to the repo", async () => {
    const { projectId, repo } = await setup();
    const res = await toggle(projectId, "playwright", { scope: "app", enabled: true });
    expect(res.statusCode).toBe(200);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().mcpEnabled).toEqual({ playwright: true });
    // Never committed: an install-level preference has no business in the repo,
    // whose manifest project creation already scaffolded.
    const manifest = await readFile(join(repo, ".dispatch", "project.yaml"), "utf8");
    expect(manifest).not.toContain("mcpEnabled");

    // …and it takes effect: the auto-gate said off, the pin says on.
    const pw = (res.json() as McpCatalog).servers.find((s) => s.name === "playwright")!;
    expect(pw.enablement).toMatchObject({ app: true, byDefault: false, effective: true });
  });

  it("clears a pin with null and inherits again", async () => {
    const { projectId } = await setup();
    await toggle(projectId, "playwright", { scope: "app", enabled: true });
    const res = await toggle(projectId, "playwright", { scope: "app", enabled: null });

    const pw = (res.json() as McpCatalog).servers.find((s) => s.name === "playwright")!;
    expect(pw.enablement.app).toBeUndefined();
    expect(pw.enablement.source).toBe("default");
    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().mcpEnabled).toBeUndefined();
  });

  it("keeps an app pin through an unrelated full-replace settings save", async () => {
    // PUT /api/settings is a full replace and this pin is written elsewhere, so
    // the two paths have to be able to coexist without one erasing the other.
    const { projectId } = await setup();
    await toggle(projectId, "playwright", { scope: "app", enabled: false });
    const current = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { ...current, theme: "light" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().mcpEnabled).toEqual({ playwright: false });
  });

  it("refuses to disable any Dispatch server, and refuses a bad scope", async () => {
    const { projectId } = await setup();
    for (const name of MANAGER_SERVER_NAMES) {
      const res = await toggle(projectId, name, { scope: "app", enabled: false });
      expect(res.statusCode, name).toBe(400);
      expect(res.json().error).toMatch(/cannot be disabled/);
    }

    const scope = await toggle(projectId, "playwright", { scope: "chat", enabled: false });
    expect(scope.statusCode).toBe(400);

    const missing = await toggle("nope", "playwright", { scope: "app", enabled: false });
    expect(missing.statusCode).toBe(404);
  });
});
