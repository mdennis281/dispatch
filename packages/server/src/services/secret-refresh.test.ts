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
    expect(order).toEqual(["reload:p1", "mcp:p1:linear", "reload:p2", "mcp:p2:linear"]);
    expect(report.mcpServers).toEqual(["p1/linear", "p2/linear"]);
    expect(report.chatsRefreshed).toEqual(["chat-p1", "chat-p2"]);
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
