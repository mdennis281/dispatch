/**
 * The artifact viewer's REST surface, on a real Fastify app over a temp
 * dataDir. Artifacts are written through the same service the MCP tools use.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("serves an asset blob as inert bytes, immutable, and nothing that is not a hash", async () => {
    const chatId = await makeChat();
    const file = join(dir, "page-asset.html");
    await writeFile(file, "<script>alert(1)</script>");
    await app.services.artifacts.create(chatId, {
      title: "G",
      type: "html",
      content: "p",
      assets: [{ path: "evil.html", file }],
    });
    const sha = createHash("sha256").update("<script>alert(1)</script>").digest("hex");
    const res = await app.inject({ url: `/api/chats/${chatId}/artifact-blobs/${sha}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<script>alert(1)</script>");
    // Opened straight from this URL, an html asset must not run on Dispatch's origin.
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/^sandbox/);
    expect(res.headers["cache-control"]).toMatch(/immutable/);

    expect((await app.inject({ url: `/api/chats/${chatId}/artifact-blobs/${"0".repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/chats/${chatId}/artifact-blobs/..%2F..%2Fstate.db` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/chats/nochat/artifact-blobs/${sha}` })).statusCode).toBe(404);
  });

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

  it("serves and patches the page's storage, refusing malformed and oversized writes", async () => {
    const chatId = await makeChat();
    const meta = await app.services.artifacts.create(chatId, { title: "Game", type: "html", content: "x" });
    const url = `/api/chats/${chatId}/artifacts/${meta.id}/storage`;

    const patched = await app.inject({ method: "PATCH", url, payload: { set: { save: "lvl2" } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ chars: 8 });

    const got = await app.inject({ url });
    expect(got.json()).toEqual({ entries: { save: "lvl2" }, chars: 8 });
    expect(got.headers["cache-control"]).toBe("no-store");

    // A body past Fastify's 1 MB default but inside the page's quota is accepted.
    const big = await app.inject({ method: "PATCH", url, payload: { set: { blob: "y".repeat(2_000_000) } } });
    expect(big.statusCode).toBe(200);
    const over = await app.inject({ method: "PATCH", url, payload: { set: { more: "z".repeat(4_000_000) } } });
    expect(over.statusCode).toBe(413);

    expect((await app.inject({ method: "PATCH", url, payload: { set: { k: 5 } } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: `/api/chats/${chatId}/artifacts/nope/storage`, payload: { set: {} } }))
        .statusCode,
    ).toBe(404);
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
