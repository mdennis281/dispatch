/**
 * Claude Code's auto-memory routes follow the Claude provider: Claude is a
 * plugin (#428), and with it switched off nothing reads that directory, so the
 * editor over it must not be offered — by the client, or by these routes.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { HarnessRegistry } from "../harness/index.js";
import { claudeOnlyRegistry } from "../harness/registry.testkit.js";
import { ClaudeMemoryService } from "../services/claude-memory.js";
import { registerMemoryRoutes } from "./memory.js";

let root: string;
let store: Store;
let app: FastifyInstance;

async function boot(harnesses: HarnessRegistry): Promise<void> {
  app = Fastify();
  app.decorate("cm", { store, bus: new EventBus() } as FastifyInstance["cm"]);
  app.decorate("services", {
    harnesses,
    // Pointed at an empty dir of our own, never the real ~/.claude.
    claudeMemory: new ClaudeMemoryService({ claudeRoot: join(root, "claude-home") }),
  } as unknown as FastifyInstance["services"]);
  registerMemoryRoutes(app);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dispatch-claude-memory-route-"));
  store = new Store(root);
  await store.init();
  await store.saveProject({ id: "p1", name: "P", repoPath: root, worktreeRoot: join(root, "wt"), subApps: [], createdAt: 1 });
});
afterEach(async () => {
  await app?.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

it("serves the listing while Claude is registered", async () => {
  await boot(claudeOnlyRegistry());
  const res = await app.inject({ method: "GET", url: "/api/projects/p1/claude-memory" });
  expect(res.statusCode).toBe(200);
});

it("answers every route as absent while the Claude plugin is off", async () => {
  await boot(new HarnessRegistry());
  const list = await app.inject({ method: "GET", url: "/api/projects/p1/claude-memory" });
  const put = await app.inject({ method: "PUT", url: "/api/projects/p1/claude-memory/MEMORY.md", payload: { content: "x" } });
  const del = await app.inject({ method: "DELETE", url: "/api/projects/p1/claude-memory/MEMORY.md" });
  for (const res of [list, put, del]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "the Claude provider is not enabled" });
  }
});
