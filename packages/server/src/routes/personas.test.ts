import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { AuthoredConfigService } from "../services/authored-config.js";
import { SessionBroker } from "../services/session-broker.js";
import { registerPersonaRoutes } from "./personas.js";

let root: string;
let store: Store;
let broker: SessionBroker;
let app: FastifyInstance;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dispatch-persona-route-"));
  store = new Store(root);
  await store.init();
  const bus = new EventBus();
  const authored = new AuthoredConfigService({ globalRoot: join(root, "global") });
  broker = new SessionBroker({ store, bus, authored });
  app = Fastify();
  app.decorate("cm", { store, bus } as FastifyInstance["cm"]);
  app.decorate("services", { store, bus, broker, authored } as FastifyInstance["services"]);
  registerPersonaRoutes(app);
  await store.saveProject({ id: "p1", name: "P", repoPath: root, worktreeRoot: join(root, "wt"), subApps: [], createdAt: 1 });
  await store.saveChat({ id: "c1", projectId: "p1", title: "C", modeId: "default", effort: "medium", harness: "codex", worktrees: [], prs: [], createdAt: 1 });
});
afterEach(async () => {
  await broker.dispose();
  await app.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

it("lists the shipped persona and round-trips selection without starting a provider", async () => {
  const list = await app.inject({ method: "GET", url: "/api/projects/p1/personas" });
  expect(list.json()).toEqual([expect.objectContaining({ id: "product-owner", scope: "shipped" })]);
  const selected = await app.inject({ method: "PUT", url: "/api/chats/c1/persona", payload: { personaId: "product-owner" } });
  expect(selected.statusCode).toBe(200);
  expect(selected.json()).toMatchObject({ personaId: "product-owner", harness: "codex" });
  expect(broker.list().find((s) => s.chatId === "c1")?.started).toBe(false);
  const off = await app.inject({ method: "PUT", url: "/api/chats/c1/persona", payload: { personaId: null } });
  expect(off.statusCode).toBe(200);
  expect(off.json().personaId).toBeUndefined();
  expect((await store.getChat("c1"))!.personaId).toBeUndefined();
});

it("rejects unknown or malformed selections without changing the chat", async () => {
  for (const personaId of ["missing", "../escape", 42, ""]) {
    const response = await app.inject({ method: "PUT", url: "/api/chats/c1/persona", payload: { personaId } });
    expect(response.statusCode).toBe(400);
  }
  expect((await store.getChat("c1"))!.personaId).toBeUndefined();
});
