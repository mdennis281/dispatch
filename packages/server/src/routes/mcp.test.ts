/**
 * Tests for the MCP catalog: the pure builder (`buildProjectMcpCatalog`) and the
 * live `GET /api/projects/:projectId/mcp` route.
 *
 * The custom "manager" server must enumerate its full tool set (incl `wait_for_pr`)
 * with non-empty input schemas + flattened params, and an external server that
 * fails to connect must surface as `status:"error"` WITHOUT failing the endpoint
 * (the external probe is injected here, so nothing is ever spawned).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { McpCatalog, Project } from "@cm/shared";
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

/* ---------------------------------------------------------------- builder */

describe("mcp-catalog — builder", () => {
  it("enumerates the manager server with the full tool set + schemas/params", async () => {
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: true, terminals: true, memory: true },
    });

    expect(catalog.servers).toHaveLength(1);
    const manager = catalog.servers[0]!;
    expect(manager.name).toBe("manager");
    expect(manager.kind).toBe("custom");
    expect(manager.status).toBe("ok");
    expect(manager.transport).toEqual({ type: "sdk" });

    const names = manager.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "wait",
        "wait_for_chat",
        "wait_for_pr",
        "terminal",
        "remember",
        "recall",
        "forget",
      ]),
    );

    // Every manager tool carries a non-empty input schema + flattened params.
    for (const tool of manager.tools) {
      expect(tool.qualifiedName).toBe(`mcp__manager__${tool.name}`);
      expect(tool.description.length).toBeGreaterThan(0);
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(props && Object.keys(props).length).toBeGreaterThan(0);
      expect(tool.params.length).toBeGreaterThan(0);
      // All bindings present → all tools available.
      expect(tool.available).toBe(true);
    }

    // Spot-check wait_for_pr's derived params (number required, repo optional).
    const waitForPr = manager.tools.find((t) => t.name === "wait_for_pr")!;
    const number = waitForPr.params.find((p) => p.name === "number")!;
    expect(number.required).toBe(true);
    expect(number.type).toBe("number");
    expect(waitForPr.params.find((p) => p.name === "repo")!.required).toBe(false);
  });

  it("marks a manager tool unavailable when its backing service is unbound", async () => {
    const catalog = await buildProjectMcpCatalog(makeProject(), {
      bindings: { github: false, terminals: true, memory: true },
    });
    const manager = catalog.servers[0]!;
    // wait_for_pr is gated on the github binding → unavailable when unbound…
    expect(manager.tools.find((t) => t.name === "wait_for_pr")!.available).toBe(false);
    // …while ungated tools stay available.
    expect(manager.tools.find((t) => t.name === "wait")!.available).toBe(true);
  });

  it("reports an external server that fails to connect as status:error (endpoint intact)", async () => {
    const failingProbe: McpProbe = async () => {
      throw new Error("spawn boom: ENOENT");
    };
    const catalog = await buildProjectMcpCatalog(
      makeProject({ broken: { command: "does-not-exist" } }),
      { probe: failingProbe },
    );

    // Manager server still enumerated — one bad external never fails the whole thing.
    expect(catalog.servers[0]!.name).toBe("manager");
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
    const manager = catalog.servers.find((s) => s.name === "manager")!;
    expect(manager.kind).toBe("custom");
    expect(manager.tools.map((t) => t.name)).toContain("wait_for_pr");
    expect(manager.tools.every((t) => t.params.length > 0)).toBe(true);

    const missing = await app.inject({ method: "GET", url: "/api/projects/nope/mcp" });
    expect(missing.statusCode).toBe(404);
  });
});
