/**
 * Route test for the subApp runner: `POST /api/runners` must resolve the subApp
 * from the repo's `.claude-manager/` config (the SOURCE OF TRUTH), so a
 * config-declared app — with its config-sourced dev/ports/docker — is runnable
 * even when the `.data` project record never listed it. The RunnerService is a
 * capturing fake here, so nothing is actually spawned.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { RunnerInstance, SubApp } from "@cm/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import type { RunnerService } from "../services/runner.js";

let dataDir: string;
let repoDir: string;
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

/** A RunnerService fake that records the `start()` inputs instead of spawning. */
function captureRunner(): {
  runner: RunnerService;
  started: { worktreePath: string; subApp: SubApp }[];
} {
  const started: { worktreePath: string; subApp: SubApp }[] = [];
  const runner = {
    list: async (): Promise<RunnerInstance[]> => [],
    start: async (worktreePath: string, subApp: SubApp): Promise<RunnerInstance> => {
      started.push({ worktreePath, subApp });
      return {
        id: "r1",
        worktreePath,
        subAppId: subApp.id,
        kind: "process",
        status: "running",
        startedAt: 0,
      };
    },
    stop: async () => {},
    stopAll: async () => {},
    logs: () => [],
    reconcile: async () => {},
  } as unknown as RunnerService;
  return { runner, started };
}

describe("POST /api/runners — config-sourced subApps", () => {
  it("resolves + starts a subApp declared only in the repo's .claude-manager/ config", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cm-runner-route-"));
    repoDir = await mkdtemp(join(tmpdir(), "cm-runner-repo-"));
    // A managed repo whose config declares a `game` sub-app (dev/ports/docker).
    await mkdir(join(repoDir, ".claude-manager"), { recursive: true });
    await writeFile(
      join(repoDir, ".claude-manager", "project.yaml"),
      [
        "name: Configured",
        "subApps:",
        "  - id: game",
        "    name: Game",
        "    cwd: apps/game",
        "    dev: pnpm dev",
        "    ports: [5173]",
        "    docker: docker-compose.yml",
      ].join("\n"),
      "utf8",
    );

    const store = new Store(dataDir);
    await store.init();
    const bus = new EventBus();
    const config = { ...loadConfig(), dataDir };
    const { runner, started } = captureRunner();
    app = await buildApp({ config, store, bus, serviceOverrides: { runner } });

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Configured", repoPath: repoDir, worktreeRoot: "wt" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;

    // Load the config into the ProjectConfigService cache (also syncs the store).
    const reload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/config/reload`,
    });
    expect(reload.statusCode).toBe(200);

    // Start the config-declared subApp — the `.data` project never listed it.
    const res = await app.inject({
      method: "POST",
      url: "/api/runners",
      payload: { worktreePath: repoDir, subAppId: "game", projectId },
    });
    expect(res.statusCode).toBe(201);

    // The runner was handed the CONFIG sub-app (its dev/ports/docker).
    expect(started).toHaveLength(1);
    expect(started[0]!.subApp).toMatchObject({
      id: "game",
      path: "apps/game",
      dev: "pnpm dev",
      ports: [5173],
      dockerCompose: "docker-compose.yml",
    });
  });
});
