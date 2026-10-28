/**
 * The integration surface end to end: the auth gate's two identity kinds, scope
 * refusals, the per-token rate limit, the WS-ticket refusal, the REST routes,
 * the external MCP mount's tool set, and the channel attribution a send leaves
 * behind.
 *
 * Real Fastify app over a temp store with auth bootstrapped; the broker's
 * runtime is never started (no chat gets a session), which is enough for
 * everything here except the send — that one asserts on the messenger's
 * ADMISSION (the hold while a chat has no live status is what the real broker
 * does too) rather than on a subprocess.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { INTEGRATION_RATE_LIMIT_PER_MINUTE, externalManagerTools } from "@dispatch/shared";
import { INTEGRATION_MCP_PATH, isManagerBridgePath, isIntegrationBridgePath } from "../services/mcp/manager-http.js";
import { seedDefaultProvider } from "../harness/registry.testkit.js";

const dirs: string[] = [];
const sessionHeaders = { "x-dispatch-session": "refresh" } as const;
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function app() {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-integration-"));
  dirs.push(dir);
  const store = new Store(dir);
  const instance = await buildApp({
    store,
    bus: new EventBus(),
    config: { port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1, idleSessionMinutes: 30 },
  });
  // After the build, not before: a second `init()` would turn this fresh
  // install into an "upgrade" and change what first-run auth offers.
  await seedDefaultProvider(store);
  return { instance, store, dir };
}

/** Bootstrap the owner and return their bearer. */
async function owner(instance: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await instance.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    headers: { "user-agent": "Mozilla/5.0 Chrome/126.0 Windows NT 10.0", ...sessionHeaders },
    payload: { username: "Owner", password: "correct horse battery staple", canonicalUrl: "http://localhost" },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
}

async function mint(
  instance: Awaited<ReturnType<typeof buildApp>>,
  access: string,
  body: Record<string, unknown>,
): Promise<{ token: string; id: string }> {
  const response = await instance.inject({
    method: "POST",
    url: "/api/auth/tokens",
    headers: { authorization: `Bearer ${access}` },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  const json = response.json() as { token: string; summary: { id: string } };
  return { token: json.token, id: json.summary.id };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A project and a chat in it, through the same routes the SPA uses. */
async function project(instance: Awaited<ReturnType<typeof buildApp>>, access: string, name: string, repoPath: string) {
  const res = await instance.inject({ method: "POST", url: "/api/projects", headers: bearer(access), payload: { name, repoPath, worktreeRoot: "wt" } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}
async function chat(instance: Awaited<ReturnType<typeof buildApp>>, access: string, projectId: string, title: string) {
  const res = await instance.inject({ method: "POST", url: "/api/chats", headers: bearer(access), payload: { projectId, title } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

describe("minting", () => {
  it("refuses while authentication is disabled", async () => {
    const { instance } = await app();
    // Auth off: no identity at all, so the route sees no person.
    const response = await instance.inject({ method: "POST", url: "/api/auth/tokens", payload: { name: "x", scopes: ["chats:read"] } });
    expect(response.statusCode).toBe(401);
    await instance.close();
  });

  it("shows the value exactly once and lists it hashed", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token, id } = await mint(instance, access, { name: "grok", scopes: ["chats:read"] });
    const list = await instance.inject({ url: "/api/auth/tokens", headers: bearer(access) });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect((list.json() as { tokens: { id: string; name: string }[] }).tokens).toMatchObject([{ id, name: "grok" }]);
    await instance.close();
  });

  it("refuses an unknown scope", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const response = await instance.inject({
      method: "POST", url: "/api/auth/tokens", headers: bearer(access),
      payload: { name: "x", scopes: ["chats:everything"] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("chats:everything");
    await instance.close();
  });

  it("cannot be done BY a token", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "x", scopes: ["chats:read", "projects:read"] });
    const response = await instance.inject({
      method: "POST", url: "/api/auth/tokens", headers: bearer(token),
      payload: { name: "escalate", scopes: ["chats:write"] },
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });
});

describe("the gate", () => {
  it("resolves a dsp_ bearer to an integration identity and a session to a user", async () => {
    const { instance } = await app();
    // Before the first inject: Fastify refuses a hook once it is ready.
    let seen: unknown;
    instance.addHook("preHandler", async (req) => { seen = req.authIdentity; });
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["projects:read"] });

    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(token) })).statusCode).toBe(200);
    expect(seen).toMatchObject({ kind: "integration", name: "grok", scopes: ["projects:read"] });

    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(access) })).statusCode).toBe(200);
    expect(seen).toMatchObject({ kind: "user" });
    await instance.close();
  });

  it("401s a bad, revoked, or expired token with a token-shaped message", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token, id } = await mint(instance, access, { name: "grok", scopes: ["projects:read"] });
    const bad = await instance.inject({ url: "/api/integration/projects", headers: bearer("dsp_nope") });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain("integration token");

    expect((await instance.inject({ method: "DELETE", url: `/api/auth/tokens/${id}`, headers: bearer(access) })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(token) })).statusCode).toBe(401);

    const short = await mint(instance, access, { name: "short", scopes: ["projects:read"], expiresAt: Date.now() + 50 });
    await new Promise((r) => setTimeout(r, 80));
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(short.token) })).statusCode).toBe(401);
    await instance.close();
  });

  it("403s a missing scope and names it", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["projects:read"] });
    const response = await instance.inject({ url: "/api/integration/chats", headers: bearer(token) });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ scope: "chats:read" });
    await instance.close();
  });

  it("403s a token on every route outside the integration surface", async () => {
    // The gate is the only thing most SPA routes check. Without this fence a
    // `chats:read` token could open a terminal or rewrite settings.
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read", "tools:chat"] });
    for (const url of ["/api/settings", "/api/projects", "/api/chats", "/api/terminals"]) {
      const res = await instance.inject({ url, headers: bearer(token) });
      expect(res.statusCode, url).toBe(403);
    }
    // The PER-CHAT bridge is gate-exempt and checks its own ephemeral grants;
    // a token is not one of those, so it refuses on its own terms (401).
    expect((await instance.inject({ method: "POST", url: "/api/mcp/manager/chat", headers: bearer(token), payload: {} })).statusCode).toBe(401);
    expect((await instance.inject({ method: "PUT", url: "/api/settings", headers: bearer(token), payload: {} })).statusCode).toBe(403);
    // …while the surface itself still answers.
    expect((await instance.inject({ url: "/api/integration/chats", headers: bearer(token) })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/integration/openapi.json", headers: bearer(token) })).statusCode).toBe(200);
    await instance.close();
  });

  it("refuses a WS ticket to an integration", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read"] });
    const response = await instance.inject({ method: "POST", url: "/api/auth/ws-ticket", headers: bearer(token) });
    expect(response.statusCode).toBe(403);
    // …and every other account route, for the same reason.
    expect((await instance.inject({ url: "/api/auth/security", headers: bearer(token) })).statusCode).toBe(403);
    await instance.close();
  });

  it("rate-limits per token with Retry-After", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["projects:read"] });
    const other = await mint(instance, access, { name: "other", scopes: ["projects:read"] });
    for (let i = 0; i < INTEGRATION_RATE_LIMIT_PER_MINUTE; i++) {
      expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(token) })).statusCode).toBe(200);
    }
    const limited = await instance.inject({ url: "/api/integration/projects", headers: bearer(token) });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // The other token's budget is its own.
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(other.token) })).statusCode).toBe(200);
    await instance.close();
  });

  it("revokes every token when authentication is turned off", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["projects:read"] });
    expect((await instance.inject({ method: "POST", url: "/api/auth/disable", headers: { ...bearer(access), ...sessionHeaders } })).statusCode).toBe(200);
    // Auth is off, so the gate is dormant and the route answers for anybody —
    // but the token itself is dead: re-enable and it must not work.
    const list = await instance.auth.tokens.list();
    expect(list.every((t) => t.revokedAt !== undefined)).toBe(true);
    expect(await instance.auth.authenticateIntegration(token)).toBeNull();
    await instance.close();
  });
});

describe("REST", () => {
  it("lists chats, reads one, and sends into it as a channel", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const proj = await project(instance, access, "demo", dirs[0]!);
    const target = await chat(instance, access, proj.id, "Hello");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read", "chats:write"] });

    const list = await instance.inject({ url: `/api/integration/chats?projectId=${proj.id}`, headers: bearer(token) });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { chats: { id: string }[] }).chats.map((c) => c.id)).toEqual([target.id]);

    const digest = await instance.inject({ url: `/api/integration/chats/${target.id}`, headers: bearer(token) });
    expect(digest.statusCode, digest.body).toBe(200);
    expect(digest.json()).toMatchObject({ view: "digest", chat: { id: target.id } });

    const messages = await instance.inject({ url: `/api/integration/chats/${target.id}/messages?kinds=user&limit=5`, headers: bearer(token) });
    expect(messages.statusCode, messages.body).toBe(200);
    expect(messages.json()).toMatchObject({ rows: [] });

    // The send goes through the messenger with a channel sender: it is admitted
    // (a chat with no live session is woken, which here means the broker is
    // asked to start one) and attributed to the token's name.
    const sends: unknown[] = [];
    const messenger = instance.services.chatMessenger as unknown as {
      sendFn: (chatId: string, text: string, opts: unknown) => Promise<void>;
      ensureSession: (chatId: string) => Promise<void>;
    };
    messenger.ensureSession = async () => {};
    messenger.sendFn = async (chatId, text, opts) => { sends.push({ chatId, text, opts }); };
    const sent = await instance.inject({
      method: "POST", url: `/api/integration/chats/${target.id}/messages`, headers: bearer(token),
      payload: { text: "deploy is green" },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sends).toEqual([{ chatId: target.id, text: "deploy is green", opts: { channel: { name: "grok" } } }]);
    await instance.close();
  });

  it("creates a chat only with chats:create, as the integration, and never in a bypass mode", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "a", join(dirs[0]!, "a"));
    const b = await project(instance, access, "b", join(dirs[0]!, "b"));
    // No runtime in this suite: the session start is a no-op, and the first
    // message is captured at the messenger the way the send test does.
    const sends: unknown[] = [];
    const messenger = instance.services.chatMessenger as unknown as {
      sendFn: (chatId: string, text: string, opts: unknown) => Promise<void>;
      ensureSession: (chatId: string) => Promise<void>;
    };
    messenger.ensureSession = async () => {};
    messenger.sendFn = async (chatId, text, opts) => { sends.push({ chatId, text, opts }); };
    (instance.services.channelChats as unknown as { deps: { ensureSession: () => Promise<void> } }).deps.ensureSession = async () => {};

    const { token: writer } = await mint(instance, access, { name: "writer", scopes: ["chats:write"] });
    const refused = await instance.inject({ method: "POST", url: "/api/integration/chats", headers: bearer(writer), payload: { projectId: a.id, text: "go" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("chats:create");

    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:create"], projectIds: [a.id] });
    const made = await instance.inject({
      method: "POST", url: "/api/integration/chats", headers: bearer(token),
      payload: { projectId: a.id, text: "fix the flaky test", title: "Flaky test" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const created = made.json() as { chatId: string; projectId: string; title: string };
    expect(created).toMatchObject({ projectId: a.id, title: "Flaky test" });
    expect(sends).toEqual([{ chatId: created.chatId, text: "fix the flaky test", opts: { channel: { name: "grok" } } }]);
    expect((await store.getChat(created.chatId))?.purpose).toMatchObject({ kind: "channel", label: "Started by grok" });

    // A mode that turns prompts off is refused before any chat exists.
    const before = (await store.listChats()).length;
    const bypass = await instance.inject({ method: "POST", url: "/api/integration/chats", headers: bearer(token), payload: { projectId: a.id, text: "go", modeId: "yolo" } });
    expect(bypass.statusCode, bypass.body).toBe(403);
    expect((await store.listChats()).length).toBe(before);

    // Outside the allowlist reads exactly like a project that does not exist.
    const outside = await instance.inject({ method: "POST", url: "/api/integration/chats", headers: bearer(token), payload: { projectId: b.id, text: "go" } });
    expect(outside.statusCode).toBe(404);
    const unknown = await instance.inject({ method: "POST", url: "/api/integration/chats", headers: bearer(token), payload: { projectId: "nope", text: "go" } });
    expect(unknown.statusCode).toBe(404);
    await instance.close();
  });

  it("summarizes a visible chat, and hides the rest", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "a", join(dirs[0]!, "a"));
    const b = await project(instance, access, "b", join(dirs[0]!, "b"));
    const inA = await chat(instance, access, a.id, "in a");
    const inB = await chat(instance, access, b.id, "in b");
    (instance.services.chatSummaries as unknown as { generate: () => Promise<string> }).generate = async () => "a summary";
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read"], projectIds: [a.id] });

    const ok = await instance.inject({ url: `/api/integration/chats/${inA.id}/summary`, headers: bearer(token) });
    expect(ok.statusCode, ok.body).toBe(200);
    // An empty chat never reaches the model.
    expect(ok.json()).toMatchObject({ chatId: inA.id, cached: false, summary: "Nothing has been said in this chat yet." });
    expect((await instance.inject({ url: `/api/integration/chats/${inB.id}/summary`, headers: bearer(token) })).statusCode).toBe(404);
    const { token: blind } = await mint(instance, access, { name: "blind", scopes: ["chats:write"] });
    expect((await instance.inject({ url: `/api/integration/chats/${inA.id}/summary`, headers: bearer(blind) })).statusCode).toBe(403);
    await instance.close();
  });

  it("hides chats outside the token's project allowlist", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "a", join(dirs[0]!, "a"));
    const b = await project(instance, access, "b", join(dirs[0]!, "b"));
    const inA = await chat(instance, access, a.id, "in a");
    const inB = await chat(instance, access, b.id, "in b");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read", "projects:read"], projectIds: [a.id] });

    const list = await instance.inject({ url: "/api/integration/chats", headers: bearer(token) });
    expect((list.json() as { chats: { id: string }[] }).chats.map((c) => c.id)).toEqual([inA.id]);
    expect((await instance.inject({ url: `/api/integration/chats/${inB.id}`, headers: bearer(token) })).statusCode).toBe(404);
    expect((await instance.inject({ url: `/api/integration/chats?projectId=${b.id}`, headers: bearer(token) })).statusCode).toBe(403);
    const projects = await instance.inject({ url: "/api/integration/projects", headers: bearer(token) });
    expect((projects.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toEqual([a.id]);
    await instance.close();
  });

  it("lists attention and refuses to answer anything but a pending question", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["attention:read", "attention:answer"] });
    instance.services.attention.add({ id: "att1", chatId: "c1", kind: "idle", summary: "idle", createdAt: 1 });
    instance.services.attention.add({ id: "att2", chatId: "c1", kind: "question", summary: "which?", permissionRequestId: "req-gone", createdAt: 2 });
    const list = await instance.inject({ url: "/api/integration/attention", headers: bearer(token) });
    expect((list.json() as { items: { id: string }[] }).items.map((i) => i.id).sort()).toEqual(["att1", "att2"]);
    expect((await instance.inject({ method: "POST", url: "/api/integration/attention/att1/answer", headers: bearer(token), payload: { answer: "x" } })).statusCode).toBe(409);
    // A question whose request is no longer pending in the broker is a 409 too,
    // not a 200 that pretends.
    expect((await instance.inject({ method: "POST", url: "/api/integration/attention/att2/answer", headers: bearer(token), payload: { answer: "x" } })).statusCode).toBe(409);
    expect((await instance.inject({ method: "POST", url: "/api/integration/attention/nope/answer", headers: bearer(token), payload: { answer: "x" } })).statusCode).toBe(404);
    await instance.close();
  });

  it("serves the OpenAPI document to any scope", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["memory:read"] });
    const response = await instance.inject({ url: "/api/integration/openapi.json", headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    const doc = response.json() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/api/integration/chats/{id}/messages");
    await instance.close();
  });
});

describe("the external MCP mount", () => {
  /** One JSON-RPC call over streamable HTTP, parsing the SSE frame it answers with. */
  async function rpc(origin: string, token: string, category: string, method: string, params: unknown = {}) {
    const response = await fetch(`${origin}${INTEGRATION_MCP_PATH}/${category}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) return { status: response.status, json: await response.json().catch(() => null) };
    const text = await response.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return { status: response.status, json: data ? JSON.parse(data) : JSON.parse(text) };
  }

  it("is not exempt from the gate, unlike the per-chat mount", () => {
    // The past bug ran the other way (the per-chat mount dropped out of the
    // exemption and every Codex session 401'd). Here the hazard is the
    // reverse: the new mount must NOT ride the exemption, or a bearer-less
    // request would reach a tool server.
    for (const category of ["chat", "project"]) {
      const path = `${INTEGRATION_MCP_PATH}/${category}`;
      expect(isIntegrationBridgePath(path), path).toBe(true);
      expect(isManagerBridgePath(path), path).toBe(false);
    }
    expect(isIntegrationBridgePath("/api/mcp/manager/chat")).toBe(false);
    expect(isIntegrationBridgePath("/api/mcp/integrationX")).toBe(false);
  });

  it("applies the project allowlist on the mount, not just on REST", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "a", join(dirs[0]!, "a"));
    const b = await project(instance, access, "b", join(dirs[0]!, "b"));
    const inA = await chat(instance, access, a.id, "in a");
    const inB = await chat(instance, access, b.id, "in b");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "tools:project"], projectIds: [a.id] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const text = (r: { json: unknown }) =>
      (r.json as { result: { content: { text: string }[]; isError?: boolean } }).result;
    try {
      const projects = text(await rpc(origin, token, "project", "tools/call", { name: "project_list", arguments: {} }));
      expect(projects.content[0]!.text).toContain(a.id);
      expect(projects.content[0]!.text).not.toContain(b.id);

      const found = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_find", arguments: {} }));
      expect(found.content[0]!.text).toContain(inA.id);
      expect(found.content[0]!.text).not.toContain(inB.id);

      // B's chat is unknown to this token: not readable, not writable, not waitable.
      const read = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_read", arguments: { chatId: inB.id } }));
      expect(read.isError).toBe(true);
      const sent = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_send", arguments: { chatId: inB.id, message: "hi" } }));
      expect(sent.isError).toBe(true);
      expect(sent.content[0]!.text).toContain("unknown-chat");
      const state = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_state", arguments: { chatId: inB.id } }));
      expect(state.isError).toBe(true);
      const wait = text(await rpc(origin, token, "chat", "tools/call", { name: "wait_for_chat", arguments: { chatId: inB.id, timeoutSeconds: 5 } }));
      expect(wait.isError).toBe(true);
      expect(wait.content[0]!.text).toContain("Unknown chatId");
      // …and A's chat still answers.
      const okState = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_state", arguments: { chatId: inA.id } }));
      expect(okState.isError ?? false).toBe(false);
    } finally {
      await instance.close();
    }
  });

  it("lists exactly the external tools of a scoped category, and 403s the rest", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "tools:project"] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    try {
      const chat = await rpc(origin, token, "chat", "tools/list");
      expect(chat.status, JSON.stringify(chat.json)).toBe(200);
      const names = (chat.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
      // `spawn_chat` is external by the registry but unbound without
      // `chats:create`: starting an agent is its own grant.
      expect(names).toEqual(externalManagerTools("chat").filter((n) => n !== "spawn_chat").sort());
      expect(names).toContain("chat_summarize");
      expect(names).not.toContain("chat_set_mode");

      const { token: creator } = await mint(instance, access, { name: "creator", scopes: ["tools:chat", "chats:create"] });
      const withCreate = await rpc(origin, creator, "chat", "tools/list");
      expect((withCreate.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain("spawn_chat");

      const project = await rpc(origin, token, "project", "tools/list");
      expect((project.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()).toEqual(["project_info", "project_list"]);

      // A category the token lacks the scope for.
      expect((await rpc(origin, token, "memory", "tools/list")).status).toBe(403);
      // A category that is in scope but has nothing external in it.
      const { token: wide } = await mint(instance, access, { name: "wide", scopes: ["tools:workspace", "tools:session"] });
      expect((await rpc(origin, wide, "workspace", "tools/list")).status).toBe(404);
      expect((await rpc(origin, wide, "session", "tools/list")).status).toBe(404);
      // No token at all.
      const bare = await fetch(`${origin}${INTEGRATION_MCP_PATH}/chat`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(bare.status).toBe(401);
    } finally {
      await instance.close();
    }
  });
});
