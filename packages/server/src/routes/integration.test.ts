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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("trust", () => {
  /** Capture what the messenger hands the broker, without a live session. */
  function capture(instance: Awaited<ReturnType<typeof buildApp>>) {
    const sends: { chatId: string; text: string; opts: unknown }[] = [];
    const messenger = instance.services.chatMessenger as unknown as {
      sendFn: (chatId: string, text: string, opts: unknown) => Promise<void>;
      ensureSession: (chatId: string) => Promise<void>;
    };
    messenger.ensureSession = async () => {};
    messenger.sendFn = async (chatId, text, opts) => { sends.push({ chatId, text, opts }); };
    return sends;
  }

  it("stamps the TOKEN's trust on a send, whatever name the caller relays under", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const proj = await project(instance, access, "demo", dirs[0]!);
    const target = await chat(instance, access, proj.id, "Hello");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:write"], trust: "owner" });
    const sends = capture(instance);
    const sent = await instance.inject({
      method: "POST", url: `/api/integration/chats/${target.id}/messages`, headers: bearer(token),
      payload: { text: "ship it", sender: "Michael via Grok" },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sends[0]!.opts).toEqual({ channel: { name: "Michael via Grok", trust: "owner" } });
    await instance.close();
  });

  it("changes a live token's trust in place, and only the owner can", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const proj = await project(instance, access, "demo", dirs[0]!);
    const target = await chat(instance, access, proj.id, "Hello");
    const { token, id } = await mint(instance, access, { name: "grok", scopes: ["chats:write"] });

    // The token itself cannot raise its own level: the route is outside the
    // integration fence, so the gate refuses it before the handler runs.
    const self = await instance.inject({
      method: "PATCH", url: `/api/auth/tokens/${id}`, headers: bearer(token), payload: { trust: "owner" },
    });
    expect(self.statusCode).toBe(403);

    const bad = await instance.inject({
      method: "PATCH", url: `/api/auth/tokens/${id}`, headers: bearer(access), payload: { trust: "root" },
    });
    expect(bad.statusCode).toBe(400);

    const raised = await instance.inject({
      method: "PATCH", url: `/api/auth/tokens/${id}`, headers: bearer(access), payload: { trust: "owner" },
    });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json()).toMatchObject({ token: { id, trust: "owner" } });

    // Takes effect on the very next message — the bot keeps its token.
    const sends = capture(instance);
    await instance.inject({
      method: "POST", url: `/api/integration/chats/${target.id}/messages`, headers: bearer(token), payload: { text: "go" },
    });
    expect(sends[0]!.opts).toEqual({ channel: { name: "grok", trust: "owner" } });

    const missing = await instance.inject({
      method: "PATCH", url: "/api/auth/tokens/nope", headers: bearer(access), payload: { trust: "owner" },
    });
    expect(missing.statusCode).toBe(404);
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
    expect(list.json()).toMatchObject({ truncated: false, unscanned: 0 });
    expect(list.json()).not.toHaveProperty("nextCursor");
    // A cursor the caller mangled is their mistake — a 400 that says so, not a 500.
    const badCursor = await instance.inject({ url: `/api/integration/chats?q=x&cursor=nope`, headers: bearer(token) });
    expect(badCursor.statusCode, badCursor.body).toBe(400);
    expect(badCursor.body).toContain("cursor");

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

    const { token, id: grokId } = await mint(instance, access, { name: "grok", scopes: ["chats:create"], projectIds: [a.id] });
    const made = await instance.inject({
      method: "POST", url: "/api/integration/chats", headers: bearer(token),
      payload: { projectId: a.id, text: "fix the flaky test", title: "Flaky test" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const created = made.json() as { chatId: string; projectId: string; title: string };
    expect(created).toMatchObject({ projectId: a.id, title: "Flaky test" });
    expect(sends).toEqual([{ chatId: created.chatId, text: "fix the flaky test", opts: { channel: { name: "grok" } } }]);
    expect((await store.getChat(created.chatId))?.purpose).toMatchObject({ kind: "channel", label: "Started by grok" });
    expect((await store.getChat(created.chatId))?.startedBy).toEqual({ tokenId: grokId, name: "grok" });

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

  it("stops any visible chat, but archives only the ones this integration started", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "a", join(dirs[0]!, "a"));
    const b = await project(instance, access, "b", join(dirs[0]!, "b"));
    const owners = await chat(instance, access, a.id, "the owner's own");
    const inB = await chat(instance, access, b.id, "in b");
    // What the integration's own spawn leaves behind — see ChannelChatService.create.
    const mine = await chat(instance, access, a.id, "grok's duplicate");
    // No runtime in this suite, so the broker half is recorded rather than run.
    const calls: string[] = [];
    const deps = (instance.services.channelChats as unknown as {
      deps: { interrupt: (id: string) => Promise<boolean>; release: (id: string) => Promise<void> };
    }).deps;
    deps.interrupt = async (id) => { calls.push(`interrupt:${id}`); return id === mine.id; };
    deps.release = async (id) => { calls.push(`release:${id}`); };

    const { token, id: tokenId } = await mint(instance, access, { name: "grok", scopes: ["chats:write"], projectIds: [a.id] });
    // What the integration's own spawn leaves behind — see ChannelChatService.create.
    await store.patchChat(mine.id, { startedBy: { tokenId, name: "grok" } });
    const stop = (id: string, payload: Record<string, unknown> = {}) =>
      instance.inject({ method: "POST", url: `/api/integration/chats/${id}/stop`, headers: bearer(token), payload });

    // Interrupting is open on any visible chat, and leaves it where it was.
    const plain = await stop(owners.id);
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toMatchObject({ chatId: owners.id, interrupted: false, archived: false });

    // Archiving the owner's chat is refused BEFORE it is interrupted.
    calls.length = 0;
    const hide = await stop(owners.id, { archive: true });
    expect(hide.statusCode, hide.body).toBe(403);
    expect(calls).toEqual([]);
    expect((await store.getChat(owners.id))?.archived).toBeUndefined();

    // Ownership is the token, not its name: another token ALSO called "grok"
    // (names are not unique) cannot archive the first one's chat.
    const { token: namesake } = await mint(instance, access, { name: "grok", scopes: ["chats:write"] });
    const spoof = await instance.inject({
      method: "POST", url: `/api/integration/chats/${mine.id}/stop`, headers: bearer(namesake), payload: { archive: true },
    });
    expect(spoof.statusCode, spoof.body).toBe(403);

    // Its own duplicate: interrupted, released and archived.
    calls.length = 0;
    const undo = await stop(mine.id, { archive: true });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json()).toMatchObject({ chatId: mine.id, interrupted: true, archived: true });
    expect(calls).toEqual([`interrupt:${mine.id}`, `release:${mine.id}`]);
    expect((await store.getChat(mine.id))?.archived).toBe(true);

    // `archive` is the flag alone: restore and re-archive touch no session.
    const archive = (id: string, archived: boolean) =>
      instance.inject({ method: "POST", url: `/api/integration/chats/${id}/archive`, headers: bearer(token), payload: { archived } });
    calls.length = 0;
    const back = await archive(mine.id, false);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ chatId: mine.id, archived: false, changed: true });
    expect((await archive(mine.id, true)).json()).toMatchObject({ archived: true, changed: true });
    expect(calls).toEqual([]);
    expect((await archive(owners.id, true)).statusCode).toBe(403);
    await store.patchChat(owners.id, { archived: true });
    expect((await archive(owners.id, false)).json()).toMatchObject({ archived: false, changed: true });
    expect((await archive(inB.id, false)).statusCode).toBe(404);
    expect((await instance.inject({ method: "POST", url: `/api/integration/chats/${mine.id}/archive`, headers: bearer(token), payload: {} })).statusCode).toBe(400);

    // Outside the allowlist, and without the scope.
    expect((await stop(inB.id)).statusCode).toBe(404);
    const { token: reader } = await mint(instance, access, { name: "reader", scopes: ["chats:read"] });
    expect((await instance.inject({ method: "POST", url: `/api/integration/chats/${mine.id}/stop`, headers: bearer(reader), payload: {} })).statusCode).toBe(403);
    await instance.close();
  });

  it("lists a project's personas over REST, behind projects:read and the allowlist", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const personasDir = join(store.projectConfigDir(a.id), "personas");
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, "grump.md"), "# The Grump\n");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["projects:read"], projectIds: [a.id] });

    const ok = await instance.inject({ url: `/api/integration/projects/${a.id}/personas`, headers: bearer(token) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { personas: unknown[] }).personas).toContainEqual({ id: "grump", name: "The Grump", scope: "project" });
    expect((await instance.inject({ url: `/api/integration/projects/${b.id}/personas`, headers: bearer(token) })).statusCode).toBe(404);
    const { token: blind } = await mint(instance, access, { name: "blind", scopes: ["chats:read"] });
    expect((await instance.inject({ url: `/api/integration/projects/${a.id}/personas`, headers: bearer(blind) })).statusCode).toBe(403);
    await instance.close();
  });

  it("polls the event feed over REST, each type behind its read scope, inside the allowlist", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const feed = instance.services.eventFeed;
    feed.append("chat.settled", { chatId: "ca", projectId: a.id }, { status: "idle" });
    feed.append("attention.raised", { chatId: "ca", projectId: a.id }, { kind: "question" });
    feed.append("chat.settled", { chatId: "cb", projectId: b.id }, { status: "idle" });
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read"], projectIds: [a.id] });

    const page = await instance.inject({ url: "/api/integration/events?cursor=0", headers: bearer(token) });
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json() as { events: { type: string; projectId: string; tsLocal: string }[]; nextCursor: string };
    expect(body.events.map((e) => [e.type, e.projectId])).toEqual([["chat.settled", a.id]]);
    expect(body.nextCursor).toBe("3");

    const bad = async (qs: string) => (await instance.inject({ url: `/api/integration/events?${qs}`, headers: bearer(token) }));
    expect((await bad("types=chat.done")).body).toContain("Valid: chat.settled");
    expect((await bad("since=yesterday")).statusCode).toBe(400);
    expect((await bad("cursor=42")).body).toContain("ahead of this feed");
    expect((await bad(`projectId=${b.id}`)).statusCode).toBe(404);
    const { token: blind } = await mint(instance, access, { name: "blind", scopes: ["memory:read"] });
    expect((await instance.inject({ url: "/api/integration/events", headers: bearer(blind) })).statusCode).toBe(403);
    await instance.close();
  });

  it("lists chats with strict filters: unknown status is a 400 naming the valid ones, booleans parse", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const live = await chat(instance, access, a.id, "live");
    const stuck = await chat(instance, access, a.id, "stuck");
    const gone = await chat(instance, access, a.id, "gone");
    await store.patchChat(stuck.id, { status: "awaiting-input" });
    await store.patchChat(gone.id, { archived: true });
    const { token } = await mint(instance, access, { name: "grok", scopes: ["chats:read"] });
    const ids = async (qs: string) =>
      ((await instance.inject({ url: `/api/integration/chats?${qs}`, headers: bearer(token) })).json() as { chats: { id: string }[] }).chats.map((c) => c.id).sort();

    expect(await ids("blockedOnHuman=true")).toEqual([stuck.id]);
    expect(await ids("blockedOnHuman=false")).toEqual([live.id]);
    // `?archived=false` used to coerce to TRUE and include archived chats.
    expect(await ids("archived=false")).toEqual([live.id, stuck.id].sort());
    expect(await ids("archived=true")).toEqual([live.id, stuck.id, gone.id].sort());
    const bad = await instance.inject({ url: "/api/integration/chats?status=finished", headers: bearer(token) });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("Valid statuses: idle, queued, running");
    expect((await instance.inject({ url: "/api/integration/chats?blockedOnHuman=maybe", headers: bearer(token) })).statusCode).toBe(400);
    expect((await instance.inject({ url: "/api/integration/chats?since=200&before=100", headers: bearer(token) })).statusCode).toBe(400);
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
    // Enriched like attention_list: dismissibility and local time ride along.
    expect((list.json() as { items: { id: string; dismissible: boolean; createdAtLocal: string }[] }).items
      .map((i) => [i.id, i.dismissible, typeof i.createdAtLocal]).sort()).toEqual([["att1", true, "string"], ["att2", false, "string"]]);
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
      const stopped = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_stop", arguments: { chatId: inB.id } }));
      expect(stopped.isError).toBe(true);
      expect(stopped.content[0]!.text).toContain("No chat");
      // …and A's chat still answers.
      const okState = text(await rpc(origin, token, "chat", "tools/call", { name: "chat_state", arguments: { chatId: inA.id } }));
      expect(okState.isError ?? false).toBe(false);
    } finally {
      await instance.close();
    }
  });

  it("chat_find over the mount: blockedOnHuman filters, bad filter values are errors that say why", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    await chat(instance, access, a.id, "calm");
    const stuck = await chat(instance, access, a.id, "stuck on a question");
    await store.patchChat(stuck.id, { status: "awaiting-input" });
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat"] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const find = async (args: Record<string, unknown>) =>
      ((await rpc(origin, token, "chat", "tools/call", { name: "chat_find", arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
    try {
      const blocked = await find({ blockedOnHuman: true });
      expect(blocked.content[0]!.text).toContain("stuck on a question");
      expect(blocked.content[0]!.text).toContain("waiting on the human");
      expect(blocked.content[0]!.text).not.toContain("calm");
      const status = await find({ status: "finished" });
      expect(status.isError).toBe(true);
      expect(status.content[0]!.text).toContain("Valid statuses: idle, queued, running, waiting, awaiting-input, done, failed, error.");
      const since = await find({ since: "yesterday" });
      expect(since.isError).toBe(true);
      expect(since.content[0]!.text).toContain(`since "yesterday" is not a time`);
      expect((await find({ since: "1d", before: "2d" })).content[0]!.text).toContain("`before` is not after `since`");
    } finally {
      await instance.close();
    }
  });

  it("chat_tree and chat_state show a parent's children, inside the allowlist", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const parent = await chat(instance, access, a.id, "the parent");
    const kids = [await chat(instance, access, a.id, "kid one"), await chat(instance, access, a.id, "kid two")];
    for (const k of kids) await store.patchChat(k.id, { parentChatId: parent.id });
    const hidden = await chat(instance, access, b.id, "elsewhere");
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat"], projectIds: [a.id] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await rpc(origin, token, "chat", "tools/call", { name, arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
    try {
      const tree = await call("chat_tree", { chatId: kids[0]!.id });
      expect(tree.isError ?? false, tree.content[0]!.text).toBe(false);
      expect(tree.content[0]!.text).toContain(`${parent.id} "the parent"`);
      expect(tree.content[0]!.text).toContain(`▶ ${kids[0]!.id} "kid one"`);
      const fromTop = await call("chat_tree", { chatId: parent.id });
      expect(fromTop.content[0]!.text).toContain("kid two");
      expect((await call("chat_tree", { chatId: hidden.id })).isError).toBe(true);

      const state = await call("chat_state", { chatId: parent.id });
      expect(state.content[0]!.text).toContain("children (2):");
      expect(state.content[0]!.text).toContain(`${kids[1]!.id} "kid two"`);
      const kidState = await call("chat_state", { chatId: kids[1]!.id });
      expect(kidState.content[0]!.text).toContain(`parent: ${parent.id} "the parent"`);
    } finally {
      await instance.close();
    }
  });

  it("chat_archive flips only the flag: own chats archive, any visible chat restores", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const theirs = await chat(instance, access, a.id, "the owner's work");
    const { token, id: tokenId } = await mint(instance, access, { name: "grok", scopes: ["tools:chat"] });
    const mine = await chat(instance, access, a.id, "grok's chat");
    await store.patchChat(mine.id, { startedBy: { tokenId, name: "grok" }, status: "running" });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await rpc(origin, token, "chat", "tools/call", { name, arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
    try {
      const archived = await call("chat_archive", { chatId: mine.id, archived: true });
      expect(archived.isError ?? false, archived.content[0]!.text).toBe(false);
      // Hidden, not halted: the running turn was never interrupted.
      expect((await store.getChat(mine.id))?.archived).toBe(true);
      expect((await store.getChat(mine.id))?.status).toBe("running");
      const state = await call("chat_state", { chatId: mine.id });
      expect(state.content[0]!.text).toContain("ARCHIVED");
      expect(state.content[0]!.text).toMatch(/last updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/);
      expect((await call("chat_archive", { chatId: mine.id, archived: false })).content[0]!.text).toContain("restored");
      expect((await store.getChat(mine.id))?.archived).toBe(false);

      // Not its chat: archiving is refused, restoring is not.
      const refused = await call("chat_archive", { chatId: theirs.id, archived: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain("was not started by grok");
      expect((await store.getChat(theirs.id))?.archived).toBeFalsy();
      await store.patchChat(theirs.id, { archived: true });
      expect((await call("chat_archive", { chatId: theirs.id, archived: false })).isError ?? false).toBe(false);
      expect((await store.getChat(theirs.id))?.archived).toBe(false);
      expect((await call("chat_archive", { chatId: theirs.id, archived: false })).content[0]!.text).toContain("Already restored");
    } finally {
      await instance.close();
    }
  });

  it("spawn_chat's unknown-project refusal lists only the projects the token may see", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "alpha"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "beta"));
    // `tools:chat` without `tools:project`: the connector that had no project_list.
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "chats:create"], projectIds: [a.id] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    try {
      // B by NAME: resolving it must not leak it, and the listing must not either.
      const r = await rpc(origin, token, "chat", "tools/call", {
        name: "spawn_chat",
        arguments: { prompt: "go", projectId: "beta" },
      });
      const result = (r.json as { result: { content: { text: string }[]; isError?: boolean } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`- alpha (id: ${a.id})`);
      expect(result.content[0]!.text).not.toContain(b.id);
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
      // `chats:create`: starting an agent is its own grant. `events_poll` is
      // unbound without a read scope any event type falls under.
      expect(names).toEqual(
        externalManagerTools("chat")
          .filter((n) => !["spawn_chat", "events_poll", "attention_list", "attention_dismiss", "attention_answer"].includes(n))
          .sort(),
      );
      expect(names).toContain("chat_summarize");
      expect(names).toContain("chat_stop");
      expect(names).not.toContain("chat_set_mode");

      const { token: creator } = await mint(instance, access, { name: "creator", scopes: ["tools:chat", "chats:create"] });
      const withCreate = await rpc(origin, creator, "chat", "tools/list");
      expect((withCreate.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain("spawn_chat");
      const { token: reader } = await mint(instance, access, { name: "reader", scopes: ["tools:chat", "chats:read"] });
      const withRead = await rpc(origin, reader, "chat", "tools/list");
      expect((withRead.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain("events_poll");

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

  it("lists the personas a spawn can name, a project's own included", async () => {
    const { instance, store } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    // A persona only alpha defines — exactly the kind config_list cannot show
    // on the mount, which has no project config dir.
    const personasDir = join(store.projectConfigDir(a.id), "personas");
    await mkdir(personasDir, { recursive: true });
    await writeFile(join(personasDir, "grump.md"), "# The Grump\n\nDisagree first.\n");

    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "projects:read"], projectIds: [a.id] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const call = async (args: Record<string, unknown>) =>
      (await rpc(origin, token, "chat", "tools/call", { name: "persona_list", arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      };
    try {
      // By name, and by default for a single-project token.
      for (const args of [{ project: "Alpha" }, {}]) {
        const res = (await call(args)).result;
        expect(res.isError ?? false, res.content[0]!.text).toBe(false);
        expect(res.content[0]!.text).toContain("grump — The Grump (project)");
        expect(res.content[0]!.text).toContain("product-owner"); // shipped
      }
      // Outside the allowlist reads as unknown, and the refusal names what IS visible.
      const outside = (await call({ project: b.id })).result;
      expect(outside.isError).toBe(true);
      expect(outside.content[0]!.text).toContain(`alpha (${a.id})`);
      expect(outside.content[0]!.text).not.toContain("beta");
    } finally {
      await instance.close();
    }
  });

  it("attention_list reads the queue inside the allowlist, behind attention:read", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const inA = await chat(instance, access, a.id, "Fix the build");
    const inB = await chat(instance, access, b.id, "Secret work");
    instance.services.attention.add({ id: "att-a", chatId: inA.id, projectId: a.id, kind: "review", summary: "CI failed", prNumber: 9, createdAt: 2 });
    instance.services.attention.add({ id: "att-b", chatId: inB.id, projectId: b.id, kind: "done", summary: "finished", createdAt: 1 });
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "attention:read"], projectIds: [a.id] });
    const { token: blind } = await mint(instance, access, { name: "blind", scopes: ["tools:chat", "chats:read"] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    try {
      const res = ((await rpc(origin, token, "chat", "tools/call", { name: "attention_list", arguments: {} })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
      expect(res.isError ?? false, res.content[0]!.text).toBe(false);
      const text = res.content[0]!.text;
      expect(text).toContain(`att-a [review]`);
      expect(text).toContain(`"Fix the build" — CI failed (PR #9)`);
      expect(text).not.toContain("att-b");
      const names = ((await rpc(origin, blind, "chat", "tools/list")).json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(names).not.toContain("attention_list");
    } finally {
      await instance.close();
    }
  });

  it("attention_dismiss clears retrospective items, blocking ones only by name, behind attention:answer", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const ca = (await chat(instance, access, a.id, "in a")).id;
    const cb = (await chat(instance, access, b.id, "in b")).id;
    const q = instance.services.attention;
    q.add({ id: "done-a", chatId: ca, projectId: a.id, kind: "done", summary: "finished", createdAt: 1 });
    q.add({ id: "ask-a", chatId: ca, projectId: a.id, kind: "question", summary: "which?", createdAt: 2 });
    q.add({ id: "done-b", chatId: cb, projectId: b.id, kind: "done", summary: "theirs", createdAt: 3 });
    const resolved: string[] = [];
    instance.cm.bus.on("attention-resolve", (e) => resolved.push(e.id));
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "attention:read", "attention:answer"], projectIds: [a.id] });
    const { token: reader } = await mint(instance, access, { name: "reader", scopes: ["tools:chat", "attention:read"] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const call = async (args: Record<string, unknown>) =>
      ((await rpc(origin, token, "chat", "tools/call", { name: "attention_dismiss", arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
    try {
      // The default sweep takes the done item in reach — not the question, not beta's.
      expect((await call({})).content[0]!.text).toContain("Dismissed 1 item.");
      expect(q.list().map((i) => i.id).sort()).toEqual(["ask-a", "done-b"]);
      // Another project's item is "missing", not dismissed.
      expect((await call({ ids: ["done-b"] })).content[0]!.text).toContain("Not in the queue (already resolved, or unknown): done-b");
      // A question goes when named.
      expect((await call({ ids: ["ask-a"] })).content[0]!.text).toContain("ask-a [question]");
      expect((await call({ ids: ["x"], kinds: ["done"] })).isError).toBe(true);
      // Named nothing: refused, and nothing was swept.
      const blank = await call({ ids: [" "] });
      expect(blank.isError).toBe(true);
      expect(blank.content[0]!.text).toContain("names no item");
      expect(resolved.sort()).toEqual(["ask-a", "done-a"]);
      const names = ((await rpc(origin, reader, "chat", "tools/list")).json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(names).toContain("attention_list");
      expect(names).not.toContain("attention_dismiss");
      expect(names).not.toContain("attention_answer");

      // attention_answer refuses a permission card by name, and a non-question.
      q.add({ id: "perm-a", chatId: ca, projectId: a.id, kind: "permission", summary: "Bash", permissionRequestId: "r1", createdAt: 4 });
      const answer = async (args: Record<string, unknown>) =>
        ((await rpc(origin, token, "chat", "tools/call", { name: "attention_answer", arguments: args })).json as {
          result: { content: { text: string }[]; isError?: boolean };
        }).result;
      const perm = await answer({ id: "perm-a", answer: "allow" });
      expect(perm.isError).toBe(true);
      expect(perm.content[0]!.text).toContain("Permission items can't be answered");
      expect((await answer({ id: "done-b", answer: "x" })).content[0]!.text).toContain("No attention item");

      // A question reaches the broker exactly as the SPA's click would; no runtime here, so record it.
      const broker = instance.services.broker as unknown as {
        answerQuestion: (requestId: string, a: unknown) => boolean;
        declineQuestion: (requestId: string) => boolean;
      };
      const sent: unknown[] = [];
      broker.answerQuestion = (requestId, a) => { sent.push([requestId, a]); return true; };
      broker.declineQuestion = (requestId) => { sent.push([requestId, "declined"]); return requestId !== "gone"; };
      q.add({ id: "ask-2", chatId: ca, projectId: a.id, kind: "question", summary: "which db?", permissionRequestId: "r2", createdAt: 5 });
      q.add({ id: "ask-3", chatId: ca, projectId: a.id, kind: "question", summary: "go on?", permissionRequestId: "gone", createdAt: 6 });
      const ok = await answer({ id: "ask-2", answer: "Postgres", notes: "use v16" });
      expect(ok.isError ?? false, ok.content[0]!.text).toBe(false);
      expect(ok.content[0]!.text).toContain(`Answered ask-2 — chat ${ca} continues.`);
      expect(sent).toEqual([["r2", { optionId: undefined, answer: "Postgres", notes: "use v16", answers: undefined }]]);
      expect((await answer({ id: "ask-2" })).content[0]!.text).toContain("Give an answer");
      // Declining a question the turn already moved past is a clear 409, not a silent success.
      const stale = await answer({ id: "ask-3", decline: true });
      expect(stale.isError).toBe(true);
      expect(stale.content[0]!.text).toContain("no longer pending");
      expect(sent).toHaveLength(2);

      // REST twin.
      const rest = await instance.inject({ method: "POST", url: "/api/integration/attention/dismiss", headers: bearer(token), payload: { ids: ["done-b"] } });
      expect(rest.json()).toEqual({ dismissed: [], missing: ["done-b"] });
      expect((await instance.inject({ method: "POST", url: "/api/integration/attention/dismiss", headers: bearer(token), payload: { ids: [] } })).statusCode).toBe(400);
      expect(q.list().map((i) => i.id)).toContain("done-b");
      // An item outside the allowlist 404s exactly like an unknown id — no `kind` to tell them apart.
      const answerRest = (id: string) =>
        instance.inject({ method: "POST", url: `/api/integration/attention/${id}/answer`, headers: bearer(token), payload: { answer: "x" } });
      const foreign = await answerRest("done-b");
      const unknown = await answerRest("no-such-item");
      expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
      expect(Object.keys(foreign.json() as object)).toEqual(Object.keys(unknown.json() as object));
      expect((await answerRest("perm-a")).json()).toMatchObject({ kind: "permission" });

      // `attention:answer` alone offers dismiss without list — the REST split.
      const { token: answerOnly } = await mint(instance, access, { name: "answerer", scopes: ["tools:chat", "attention:answer"] });
      const answerNames = ((await rpc(origin, answerOnly, "chat", "tools/list")).json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
      expect(answerNames).toContain("attention_dismiss");
      expect(answerNames).not.toContain("attention_list");
      expect((await instance.inject({ method: "POST", url: "/api/integration/attention/dismiss", headers: bearer(reader), payload: {} })).statusCode).toBe(403);
    } finally {
      await instance.close();
    }
  });

  it("events_poll pages the feed from a cursor with no chat of its own", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const a = await project(instance, access, "alpha", join(dirs[0]!, "a"));
    const b = await project(instance, access, "beta", join(dirs[0]!, "b"));
    const feed = instance.services.eventFeed;
    feed.append("pr.merged", { chatId: "ca", projectId: a.id }, { repo: "o/r", number: 12, title: "Ship it" });
    feed.append("pr.merged", { chatId: "cb", projectId: b.id }, { repo: "o/r", number: 13, title: "Hidden" });
    feed.append("attention.raised", { chatId: "ca", projectId: a.id }, { kind: "question", summary: "Which?" });
    const { token } = await mint(instance, access, { name: "grok", scopes: ["tools:chat", "projects:read"], projectIds: [a.id] });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const origin = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
    const call = async (args: Record<string, unknown>) =>
      ((await rpc(origin, token, "chat", "tools/call", { name: "events_poll", arguments: args })).json as {
        result: { content: { text: string }[]; isError?: boolean };
      }).result;
    try {
      const first = await call({ cursor: "0" });
      expect(first.isError ?? false, first.content[0]!.text).toBe(false);
      const text = first.content[0]!.text;
      expect(text).toContain("pr.merged chat=ca — o/r#12 Ship it");
      // Another project's PR, and a type this token has no scope for.
      expect(text).not.toContain("Hidden");
      expect(text).not.toContain("attention.raised");
      expect(text).toContain("nextCursor: 3");
      expect((await call({ cursor: "3" })).content[0]!.text).toMatch(/^0 events/);
      expect((await call({ cursor: "nope" })).isError).toBe(true);
      expect((await call({ since: "not a time" })).isError).toBe(true);
      expect((await call({ project: b.id })).content[0]!.text).toContain(`No project "${b.id}"`);
    } finally {
      await instance.close();
    }
  });

});
