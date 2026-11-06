import { describe, it, expect, vi } from "vitest";
import type { SubApp } from "@dispatch/shared";
import { SecretRefresher, type SecretRefresherDeps } from "./secret-refresh.js";

/** Two projects: p1 uses LINEAR in an MCP server and STRIPE in a sub-app; p2 uses LINEAR too. */
function harness() {
  const order: string[] = [];
  const refs: Record<string, Record<string, string[]>> = {
    p1: { LINEAR: ["mcp:linear"], STRIPE: ["subapp:web"] },
    p2: { LINEAR: ["mcp:linear"] },
  };
  const web: SubApp = { id: "web", name: "web", path: "apps/web", dev: "pnpm dev" } as SubApp;
  const deps: SecretRefresherDeps = {
    projectConfig: {
      reload: vi.fn(async (id: string) => {
        order.push(`reload:${id}`);
        return { sourceDir: null, config: null, errors: [] };
      }),
      secretConsumers: (p: string, n: string) => refs[p]?.[n] ?? [],
      projectsReferencingSecret: (n: string) => Object.keys(refs).filter((p) => refs[p]![n]),
      getSubApps: () => [web],
    },
    broker: {
      refreshMcpServers: vi.fn(async (projectId: string, names: string[]) => {
        order.push(`mcp:${projectId}:${names.join(",")}`);
        return { refreshed: [`chat-${projectId}`], nextSession: [] };
      }),
    },
    runner: {
      runningFor: vi.fn((p: string, id: string) => (p === "p1" && id === "web" ? ["inst-1"] : [])),
      restart: vi.fn(async (instanceId: string) => {
        order.push(`restart:${instanceId}`);
        return { id: "inst-2" } as never;
      }),
    },
  };
  return { deps, order, web };
}

describe("SecretRefresher", () => {
  it("reloads config BEFORE reconnecting chats, so they pick up the new expansion", async () => {
    const { deps, order } = harness();
    const report = await new SecretRefresher(deps).refresh([{ name: "LINEAR", scope: "global" }]);
    // Projects run concurrently, so only the order WITHIN each one is fixed.
    for (const p of ["p1", "p2"]) {
      expect(order.indexOf(`reload:${p}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`reload:${p}`)).toBeLessThan(order.indexOf(`mcp:${p}:linear`));
    }
    // ...but the report still reads in project order.
    expect(report.mcpServers).toEqual(["p1/linear", "p2/linear"]);
    expect(report.chatsRefreshed).toEqual(["chat-p1", "chat-p2"]);
  });

  it("refreshes projects in parallel, so one slow reconnect per project doesn't add up to a 504", async () => {
    const { deps } = harness();
    let inFlight = 0;
    let peak = 0;
    deps.broker.refreshMcpServers = vi.fn(async (projectId: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { refreshed: [`chat-${projectId}`], nextSession: [] };
    });
    await new SecretRefresher(deps).refresh([{ name: "LINEAR", scope: "global" }]);
    expect(peak).toBe(2);
  });

  it("confines a project secret to its own project", async () => {
    const { deps, order } = harness();
    await new SecretRefresher(deps).refresh([{ name: "LINEAR", scope: "project", projectId: "p2" }]);
    expect(order).toEqual(["reload:p2", "mcp:p2:linear"]);
  });

  it("restarts running sub-apps onto the freshly loaded definition", async () => {
    const { deps, web } = harness();
    const report = await new SecretRefresher(deps).refresh([{ name: "STRIPE", scope: "global" }]);
    expect(deps.runner.restart).toHaveBeenCalledWith("inst-1", web);
    expect(report.subAppsRestarted).toEqual(["p1/web"]);
    expect(deps.broker.refreshMcpServers).not.toHaveBeenCalled();
  });

  it("reconnects plugin MCP servers that expand a GLOBAL secret, in every project with a live session", async () => {
    const { deps, order } = harness();
    deps.broker.liveProjectIds = () => ["p1", "p3"];
    deps.pluginMcpServersUsing = (n) => (n === "HOST_KEY_mac" ? ["remote-browser"] : []);
    const report = await new SecretRefresher(deps).refresh([{ name: "HOST_KEY_mac", scope: "global" }]);
    // No project references it, so no config reload — the plugin servers are reconnected directly.
    expect(order).toEqual(["mcp:p1:remote-browser", "mcp:p3:remote-browser"]);
    expect(report.mcpServers).toEqual(["p1/remote-browser", "p3/remote-browser"]);
    expect(report.chatsRefreshed).toEqual(["chat-p1", "chat-p3"]);
    // A project secret never reaches a plugin server: they expand from the global store only.
    order.length = 0;
    await new SecretRefresher(deps).refresh([{ name: "HOST_KEY_mac", scope: "project", projectId: "p1" }]);
    expect(order).toEqual([]);
  });

  it("touches nothing for a secret nobody references, and remembers the report", async () => {
    const { deps } = harness();
    const refresher = new SecretRefresher(deps);
    const key = { name: "UNUSED", scope: "global" as const };
    const report = await refresher.refresh([key]);
    expect(deps.projectConfig.reload).not.toHaveBeenCalled();
    expect(report.projects).toEqual([]);
    expect(refresher.lastReport(key)).toBe(report);
  });
});
