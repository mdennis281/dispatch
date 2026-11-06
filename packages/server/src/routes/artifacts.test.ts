/**
 * The artifact viewer's REST surface, on a real Fastify app over a temp
 * dataDir. Artifacts are written through the same service the MCP tools use.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { seedDefaultProvider } from "../harness/registry.testkit.js";

let dir: string;
let app: FastifyInstance;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-artifacts-"));
  store = new Store(dir);
  await store.init();
  await seedDefaultProvider(store);
  app = await buildApp({ config: { ...loadConfig(), dataDir: dir }, store, bus: new EventBus() });
});

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeChat(): Promise<string> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
  });
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { projectId: project.json().id as string, title: "Artifacts" },
  });
  return chat.json().id as string;
}

describe("artifact routes", () => {
  it("lists, reads latest and pinned versions, and records viewer errors", async () => {
    const chatId = await makeChat();
    const { artifacts } = app.services;
    const meta = await artifacts.create(chatId, { title: "Page", type: "html", content: "<p>1</p>" });
    await artifacts.update(chatId, meta.id, { content: "<p>2</p>" });

    const list = await app.inject({ url: `/api/chats/${chatId}/artifacts` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const latest = await app.inject({ url: `/api/chats/${chatId}/artifacts/${meta.id}` });
    expect(latest.json()).toMatchObject({ version: 2, content: "<p>2</p>" });
    expect(latest.headers["cache-control"]).toBe("no-store");
    // JSON, never the document itself — the HTML must only reach a sandbox.
    expect(latest.headers["content-type"]).toMatch(/application\/json/);

    const pinned = await app.inject({ url: `/api/chats/${chatId}/artifacts/${meta.id}?version=1` });
    expect(pinned.json()).toMatchObject({ version: 1, content: "<p>1</p>" });

    const posted = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/artifacts/${meta.id}/errors`,
      payload: { version: 2, errors: ["TypeError: boom"] },
    });
    expect(posted.statusCode).toBe(204);
    expect(artifacts.errorsFor(chatId, meta.id, 2)).toEqual(["TypeError: boom"]);
  });

  it("answers 410 for an expired artifact and 404/400 for bad requests", async () => {
    const chatId = await makeChat();
    const { artifacts } = app.services;
    const meta = await artifacts.create(chatId, { title: "Old", type: "svg", content: "<svg/>" });
    await artifacts.sweep([chatId], -1);

    const gone = await app.inject({ url: `/api/chats/${chatId}/artifacts/${meta.id}` });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ error: "expired" });

    expect((await app.inject({ url: `/api/chats/${chatId}/artifacts/nope` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/chats/${chatId}/artifacts/..%2F..` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/chats/${chatId}/artifacts/${meta.id}?version=0` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/chats/nochat/artifacts` })).statusCode).toBe(404);
  });
});
