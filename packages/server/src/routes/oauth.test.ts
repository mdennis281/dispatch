/**
 * OAuth, both roles, end to end over a real Fastify app with auth bootstrapped
 * on a loopback canonical URL (the one non-TLS origin the server advertises on).
 *
 *   AUTHORIZATION SERVER: the metadata documents and the 401 challenge,
 *   registration (and its address rate limit), authorize validation and PKCE
 *   enforcement, the consent nonce (owner-only, single-use, ten-minute),
 *   the token endpoint's two grants and RFC 6749 error shapes, code reuse,
 *   refresh rotation with reuse detection, revocation, and — the one that
 *   matters most — that a token minted this way is fenced exactly like a
 *   hand-minted one.
 *
 *   PLUGIN CLIENT FLOW: a plugin declaring `oauth.clients.fake` against an
 *   in-process fake provider: Connect → callback → stored → `ctx.oauth.token`
 *   → refreshed before expiry → disconnect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { OAUTH_AUTHORIZE_NONCE_MS, OAUTH_CODE_MS, type PluginInfo } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { OAuthServer } from "../services/oauth-server.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const servers: Server[] = [];
const sessionHeaders = { "x-dispatch-session": "refresh" } as const;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function app(opts: { withConfigDir?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "dispatch-oauth-"));
  dirs.push(base);
  const dataDir = join(base, "data");
  const configDir = join(base, "config");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(configDir, "plugins"), { recursive: true });
  const store = new Store(dataDir, opts.withConfigDir ? configDir : undefined);
  const instance = await buildApp({
    store,
    bus: new EventBus(),
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir,
      ...(opts.withConfigDir ? { configDir } : {}),
      maxActiveSessions: 1,
      idleSessionMinutes: 30,
    },
  });
  apps.push(instance);
  return { instance, store, dataDir, configDir };
}

/** Bootstrap the owner on a loopback canonical URL and return their bearer. */
async function owner(instance: FastifyInstance, canonicalUrl = "http://localhost:4399"): Promise<string> {
  const response = await instance.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    headers: { "user-agent": "Mozilla/5.0 Chrome/126.0 Windows NT 10.0", ...sessionHeaders },
    payload: { username: "Owner", password: "correct horse battery staple", canonicalUrl },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const REDIRECT = "http://localhost:6274/oauth/callback";

async function register(instance: FastifyInstance, extra: Record<string, unknown> = {}, ip?: string) {
  const res = await instance.inject({
    method: "POST",
    url: "/api/oauth/register",
    ...(ip ? { remoteAddress: ip } : {}),
    payload: { client_name: "Inspector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra },
  });
  return res;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "chats:read projects:read",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  });
  return `/oauth/authorize?${q.toString()}`;
}

/** Walk a client through authorize → consent → code; return the code and the verifier. */
async function consent(instance: FastifyInstance, access: string, clientId: string) {
  const { verifier, challenge } = pkce();
  const auth = await instance.inject({ url: authorizeUrl(clientId, challenge) });
  expect(auth.statusCode).toBe(302);
  const nonce = decodeURIComponent(auth.headers.location!.split("#oauth=")[1]!);
  const decision = await instance.inject({
    method: "POST",
    url: `/api/oauth/requests/${nonce}/decision`,
    headers: bearer(access),
    payload: { approve: true },
  });
  expect(decision.statusCode, decision.body).toBe(200);
  const redirect = new URL((decision.json() as { redirectUrl: string }).redirectUrl);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("xyz");
  return { code: redirect.searchParams.get("code")!, verifier, nonce };
}

/** Form-encoded, the way every OAuth client library sends it. */
async function tokenRequest(instance: FastifyInstance, form: Record<string, string>, headers: Record<string, string> = {}) {
  return instance.inject({
    method: "POST",
    url: "/api/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(form).toString(),
  });
}

type TokenResponse = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };

async function fullGrant(instance: FastifyInstance, access: string) {
  const reg = await register(instance);
  const clientId = (reg.json() as { client_id: string }).client_id;
  const { code, verifier } = await consent(instance, access, clientId);
  const res = await tokenRequest(instance, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { clientId, tokens: res.json() as TokenResponse };
}

/* ======================================================= discovery */

describe("discovery", () => {
  it("is not offered while authentication is off", async () => {
    const { instance } = await app();
    const meta = await instance.inject({ url: "/.well-known/oauth-authorization-server" });
    expect(meta.statusCode).toBe(404);
    expect((meta.json() as { error_description: string }).error_description).toMatch(/Authentication is off/);
    expect((await instance.inject({ method: "POST", url: "/api/oauth/register", payload: { redirect_uris: [REDIRECT] } })).statusCode).toBe(404);
  });

  it("is not offered on a non-loopback http canonical URL", async () => {
    // The passkey setup already refuses to STORE such a URL, so this can only
    // arise from a hand-edited config.json — which is exactly why the server
    // checks it itself rather than trusting what bootstrap validated.
    const { instance, store } = await app();
    const fakeAuth = {
      enabled: async () => true,
      settings: async () => ({ enabled: true, firstRunDismissed: true, canonicalUrl: "http://dispatch.lan:4318" }),
    };
    const server = new OAuthServer({ store, auth: fakeAuth as unknown as FastifyInstance["auth"] });
    expect(await server.availability()).toMatchObject({ ok: false, reason: expect.stringMatching(/https/) });
    expect(await instance.oauthServer.availability()).toMatchObject({ ok: false, reason: expect.stringMatching(/Authentication is off/) });
  });

  it("serves RFC 8414 and RFC 9728 documents off the canonical URL, with CORS", async () => {
    const { instance } = await app();
    await owner(instance);
    const meta = await instance.inject({ url: "/.well-known/oauth-authorization-server" });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers["access-control-allow-origin"]).toBe("*");
    expect(meta.json()).toMatchObject({
      issuer: "http://localhost:4399",
      authorization_endpoint: "http://localhost:4399/oauth/authorize",
      token_endpoint: "http://localhost:4399/api/oauth/token",
      registration_endpoint: "http://localhost:4399/api/oauth/register",
      revocation_endpoint: "http://localhost:4399/api/oauth/revoke",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect((meta.json() as { scopes_supported: string[] }).scopes_supported).toContain("tools:chat");

    const resource = await instance.inject({ url: "/.well-known/oauth-protected-resource" });
    expect(resource.json()).toMatchObject({
      resource: "http://localhost:4399/api/mcp/integration",
      authorization_servers: ["http://localhost:4399"],
    });
    const suffixed = await instance.inject({ url: "/.well-known/oauth-protected-resource/api/mcp/integration/chat" });
    expect((suffixed.json() as { resource: string }).resource).toBe("http://localhost:4399/api/mcp/integration/chat");
    expect((await instance.inject({ method: "OPTIONS", url: "/api/oauth/token" })).statusCode).toBe(204);
  });

  it("challenges an unauthenticated request on the integration MCP mount with resource_metadata", async () => {
    const { instance } = await app();
    await owner(instance);
    const res = await instance.inject({ method: "POST", url: "/api/mcp/integration/chat", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe(
      'Bearer realm="dispatch", resource_metadata="http://localhost:4399/.well-known/oauth-protected-resource/api/mcp/integration/chat"',
    );
    // Not on the SPA's routes: a connector that lands there is not being invited in.
    const spa = await instance.inject({ url: "/api/projects" });
    expect(spa.statusCode).toBe(401);
    expect(spa.headers["www-authenticate"]).toBeUndefined();
  });
});

/* =================================================== registration */

describe("registration", () => {
  it("registers a public client and shows no secret", async () => {
    const { instance } = await app();
    await owner(instance);
    const res = await register(instance);
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const json = res.json() as Record<string, unknown>;
    expect(json).toMatchObject({ client_name: "Inspector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(json.client_secret).toBeUndefined();
    expect(typeof json.client_id).toBe("string");
  });

  it("issues a secret to a confidential client, once", async () => {
    const { instance } = await app();
    await owner(instance);
    const res = await register(instance, { token_endpoint_auth_method: "client_secret_basic" });
    expect(res.statusCode).toBe(201);
    expect(typeof (res.json() as { client_secret: string }).client_secret).toBe("string");
  });

  it("refuses a cleartext redirect to a non-loopback host, a fragment, and an unknown scope", async () => {
    const { instance } = await app();
    await owner(instance);
    for (const [body, pattern] of [
      [{ redirect_uris: ["http://evil.example/cb"] }, /invalid_redirect_uri/],
      [{ redirect_uris: ["https://ok.example/cb#frag"] }, /invalid_redirect_uri/],
      [{ scope: "chats:read everything" }, /everything/],
      [{ redirect_uris: [] }, /invalid_client_metadata/],
    ] as const) {
      const res = await register(instance, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatch(pattern);
    }
    // Custom schemes are native-app targets and fine.
    expect((await register(instance, { redirect_uris: ["cursor://anysphere.cursor-mcp/callback"] })).statusCode).toBe(201);
  });

  it("rate-limits one address", async () => {
    const { instance } = await app();
    await owner(instance);
    for (let i = 0; i < 20; i++) expect((await register(instance, {}, "10.9.8.7")).statusCode).toBe(201);
    expect((await register(instance, {}, "10.9.8.7")).statusCode).toBe(429);
    expect((await register(instance, {}, "10.9.8.8")).statusCode).toBe(201);
  });
});

/* ====================================================== authorize */

describe("authorize", () => {
  it("shows (never redirects) an unknown client or an unregistered redirect_uri", async () => {
    const { instance } = await app();
    await owner(instance);
    const { challenge } = pkce();
    const unknown = await instance.inject({ url: authorizeUrl("nope", challenge) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.headers["content-type"]).toMatch(/text\/html/);
    expect(unknown.headers.location).toBeUndefined();

    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const wrongUri = await instance.inject({ url: authorizeUrl(clientId, challenge, { redirect_uri: "http://localhost:6274/other" }) });
    expect(wrongUri.statusCode).toBe(400);
    expect(wrongUri.headers.location).toBeUndefined();
    expect(wrongUri.body).toMatch(/redirect_uri/);
  });

  it("sends every other refusal back to the client with the state, and PKCE S256 is mandatory", async () => {
    const { instance } = await app();
    await owner(instance);
    const clientId = ((await register(instance, { scope: "chats:read" })).json() as { client_id: string }).client_id;
    const { challenge } = pkce();
    const cases: Array<[Record<string, string>, string]> = [
      [{ code_challenge: "", code_challenge_method: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ scope: "chats:read projects:read" }, "invalid_scope"],
      [{ scope: "chats:everything" }, "invalid_scope"],
    ];
    for (const [extra, error] of cases) {
      const res = await instance.inject({ url: authorizeUrl(clientId, challenge, extra) });
      expect(res.statusCode, JSON.stringify(extra)).toBe(302);
      const to = new URL(res.headers.location!);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get("error")).toBe(error);
      expect(to.searchParams.get("state")).toBe("xyz");
    }
  });

  it("parks a valid request and redirects into the SPA consent page", async () => {
    const { instance } = await app();
    await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const res = await instance.inject({ url: authorizeUrl(clientId, pkce().challenge) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/#oauth=[A-Za-z0-9_-]{40,}$/);
  });
});

/* ======================================================== consent */

describe("consent", () => {
  it("is the owner's session's to see and decide; a token cannot", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const auth = await instance.inject({ url: authorizeUrl(clientId, pkce().challenge) });
    const nonce = decodeURIComponent(auth.headers.location!.split("#oauth=")[1]!);

    expect((await instance.inject({ url: `/api/oauth/requests/${nonce}` })).statusCode).toBe(401);
    const view = await instance.inject({ url: `/api/oauth/requests/${nonce}`, headers: bearer(access) });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      nonce,
      client: { id: clientId, name: "Inspector", redirectHost: "localhost:6274" },
      scopes: ["chats:read", "projects:read"],
    });

    // A dsp_ token is fenced away from the consent routes by the gate itself.
    const { tokens } = await fullGrant(instance, access);
    const byToken = await instance.inject({ url: `/api/oauth/requests/${nonce}`, headers: bearer(tokens.access_token) });
    expect(byToken.statusCode).toBe(403);
  });

  it("denial sends access_denied and consumes the nonce", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const auth = await instance.inject({ url: authorizeUrl(clientId, pkce().challenge) });
    const nonce = decodeURIComponent(auth.headers.location!.split("#oauth=")[1]!);
    const deny = await instance.inject({ method: "POST", url: `/api/oauth/requests/${nonce}/decision`, headers: bearer(access), payload: { approve: false } });
    expect(deny.statusCode).toBe(200);
    const to = new URL((deny.json() as { redirectUrl: string }).redirectUrl);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    const again = await instance.inject({ method: "POST", url: `/api/oauth/requests/${nonce}/decision`, headers: bearer(access), payload: { approve: true } });
    expect(again.statusCode).toBe(404);
  });

  it("a nonce expires after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { instance } = await app();
    const access = await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const auth = await instance.inject({ url: authorizeUrl(clientId, pkce().challenge) });
    const nonce = decodeURIComponent(auth.headers.location!.split("#oauth=")[1]!);
    vi.setSystemTime(Date.now() + OAUTH_AUTHORIZE_NONCE_MS + 1);
    // Ten minutes also outlives the session's access token; sign in again so
    // the 404 below is the nonce's, not the bearer's.
    const login = await instance.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "user-agent": "Mozilla/5.0 Chrome/126.0 Windows NT 10.0", ...sessionHeaders },
      payload: { username: "Owner", password: "correct horse battery staple" },
    });
    expect(login.statusCode, login.body).toBe(200);
    const fresh = (login.json() as { accessToken: string }).accessToken;
    expect((await instance.inject({ url: `/api/oauth/requests/${nonce}`, headers: bearer(fresh) })).statusCode).toBe(404);
    void access;
  });
});

/* ========================================================== token */

describe("token endpoint", () => {
  it("exchanges a code with the right verifier for an integration token and a refresh token", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "chats:read projects:read" });
    expect(tokens.access_token).toMatch(/^dsp_/);
    expect(tokens.refresh_token).toMatch(/^dsr_/);

    // It is an ordinary integration token: works on the surface, fenced off everything else.
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(tokens.access_token) })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/projects", headers: bearer(tokens.access_token) })).statusCode).toBe(403);
    expect((await instance.inject({ url: "/api/integration/chats/x/messages", method: "POST", headers: bearer(tokens.access_token), payload: { text: "hi" } })).statusCode).toBe(403);

    // …and it shows in the owner's token list with the client stamped on it.
    const list = (await instance.inject({ url: "/api/auth/tokens", headers: bearer(access) })).json() as { tokens: Array<{ name: string; clientId?: string }> };
    expect(list.tokens).toMatchObject([{ name: "Inspector", clientId }]);
  });

  it("answers RFC 6749 error shapes: bad verifier, unknown code, unknown client, unsupported grant, 415-free form parsing", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const { code } = await consent(instance, access, clientId);

    const bad = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: "not-the-one", client_id: clientId });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_grant" });
    expect(bad.headers["cache-control"]).toBe("no-store");

    expect((await tokenRequest(instance, { grant_type: "authorization_code", code: "nope", code_verifier: "x", client_id: clientId })).json()).toMatchObject({ error: "invalid_grant" });
    const noClient = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: "x", client_id: "ghost" });
    expect(noClient.statusCode).toBe(401);
    expect(noClient.json()).toMatchObject({ error: "invalid_client" });
    expect((await tokenRequest(instance, { grant_type: "password", client_id: clientId })).json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("a confidential client must present its secret, by Basic or in the body", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const reg = (await register(instance, { token_endpoint_auth_method: "client_secret_basic" })).json() as { client_id: string; client_secret: string };
    const { code, verifier } = await consent(instance, access, reg.client_id);
    const basic = `Basic ${Buffer.from(`${reg.client_id}:wrong`).toString("base64")}`;
    const refused = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: verifier }, { authorization: basic });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers["www-authenticate"]).toMatch(/^Basic/);
    const ok = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, client_secret: reg.client_secret });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("a code is single-use, expires in a minute, and reuse revokes the grant it produced", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { instance } = await app();
    const access = await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const { code, verifier } = await consent(instance, access, clientId);
    const first = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
    expect(first.statusCode).toBe(200);
    const { access_token } = first.json() as TokenResponse;
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(access_token) })).statusCode).toBe(200);

    const again = await tokenRequest(instance, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
    expect(again.json()).toMatchObject({ error: "invalid_grant" });
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(access_token) })).statusCode).toBe(401);

    const fresh = await consent(instance, access, clientId);
    vi.setSystemTime(Date.now() + OAUTH_CODE_MS + 1);
    const late = await tokenRequest(instance, { grant_type: "authorization_code", code: fresh.code, code_verifier: fresh.verifier, client_id: clientId });
    expect(late.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rotates the refresh token, removes the old access token, and reuse past the grace window revokes the family", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);

    const r1 = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(r1.statusCode, r1.body).toBe(200);
    const t2 = r1.json() as TokenResponse;
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    expect(t2.access_token).not.toBe(tokens.access_token);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(t2.access_token) })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(tokens.access_token) })).statusCode).toBe(401);
    // The superseded token is gone from the file, not kept as a "revoked" row:
    // a connector rotating hourly must not grow the Tokens list by 24 a day.
    const afterRotate = (await instance.inject({ url: "/api/auth/tokens", headers: bearer(access) })).json() as { tokens: unknown[] };
    expect(afterRotate.tokens).toHaveLength(1);

    // Within the grace window a replay is refused but nothing is revoked —
    // that is a client retrying a response it lost, not a thief.
    const soon = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(soon.json()).toMatchObject({ error: "invalid_grant" });
    expect(soon.body).not.toMatch(/has been revoked/);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(t2.access_token) })).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 31_000);

    // Narrowing on refresh is allowed; widening is not.
    const narrowed = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId, scope: "projects:read" });
    expect(narrowed.statusCode).toBe(200);
    const t3 = narrowed.json() as TokenResponse;
    expect(t3.scope).toBe("projects:read");
    expect((await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: t3.refresh_token, client_id: clientId, scope: "chats:write" })).json()).toMatchObject({ error: "invalid_scope" });

    // The original refresh token comes back: replay. The whole family dies.
    const replay = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(replay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: t3.refresh_token, client_id: clientId })).json()).toMatchObject({ error: "invalid_grant" });
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(t3.access_token) })).statusCode).toBe(401);
    const grants = (await instance.inject({ url: "/api/auth/oauth/grants", headers: bearer(access) })).json() as { grants: Array<{ revokedAt?: number }> };
    expect(grants.grants).toHaveLength(1);
    expect(grants.grants[0]!.revokedAt).toBeTypeOf("number");
  });

  it("two concurrent refreshes of one token: exactly one rotates, the grant survives, and one chain remains", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);
    const form = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId };
    const results = await Promise.all([tokenRequest(instance, form), tokenRequest(instance, form), tokenRequest(instance, form)]);
    const ok = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => r.statusCode === 400);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.json()).toMatchObject({ error: "invalid_grant" });
    const winner = ok[0]!.json() as TokenResponse;
    // The one chain that exists keeps working, and the grant is not revoked.
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(winner.access_token) })).statusCode).toBe(200);
    const next = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: winner.refresh_token, client_id: clientId });
    expect(next.statusCode, next.body).toBe(200);
    const grants = (await instance.inject({ url: "/api/auth/oauth/grants", headers: bearer(access) })).json() as { grants: Array<{ revokedAt?: number }> };
    expect(grants.grants[0]!.revokedAt).toBeUndefined();
    // Exactly one live access token in the file: the losers minted nothing.
    const list = (await instance.inject({ url: "/api/auth/tokens", headers: bearer(access) })).json() as { tokens: Array<{ revokedAt?: number }> };
    expect(list.tokens.filter((t) => t.revokedAt === undefined)).toHaveLength(1);
  });

  it("rate-limits authorization requests per address", async () => {
    const { instance } = await app();
    await owner(instance);
    const clientId = ((await register(instance)).json() as { client_id: string }).client_id;
    const { challenge } = pkce();
    for (let i = 0; i < 30; i++) {
      expect((await instance.inject({ url: authorizeUrl(clientId, challenge), remoteAddress: "10.1.1.1" })).statusCode).toBe(302);
    }
    const flooded = await instance.inject({ url: authorizeUrl(clientId, challenge), remoteAddress: "10.1.1.1" });
    expect(flooded.statusCode).toBe(429);
    expect((await instance.inject({ url: authorizeUrl(clientId, challenge), remoteAddress: "10.1.1.2" })).statusCode).toBe(302);
  });

  it("a refresh token belongs to its client", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { tokens } = await fullGrant(instance, access);
    const other = ((await register(instance, { client_name: "Other" })).json() as { client_id: string }).client_id;
    const res = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other });
    expect(res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("revoking the oauth access token in the Tokens list ends the grant at its next refresh", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);
    const list = (await instance.inject({ url: "/api/auth/tokens", headers: bearer(access) })).json() as { tokens: Array<{ id: string }> };
    expect((await instance.inject({ method: "DELETE", url: `/api/auth/tokens/${list.tokens[0]!.id}`, headers: bearer(access) })).statusCode).toBe(200);
    const res = await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(res.json()).toMatchObject({ error: "invalid_grant" });
  });
});

/* ========================================================= revoke */

describe("revocation", () => {
  it("POST /api/oauth/revoke retires a grant by either token and always answers 200", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);
    const res = await instance.inject({
      method: "POST",
      url: "/api/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: tokens.access_token, client_id: clientId }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(tokens.access_token) })).statusCode).toBe(401);
    expect((await tokenRequest(instance, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId })).json()).toMatchObject({ error: "invalid_grant" });
    // Unknown token: still 200, nothing to learn from it.
    const unknown = await instance.inject({
      method: "POST",
      url: "/api/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: "dsp_nothing", client_id: clientId }).toString(),
    });
    expect(unknown.statusCode).toBe(200);
  });

  it("Settings lists grants and the owner revokes one, which kills its access token", async () => {
    const { instance } = await app();
    const access = await owner(instance);
    const { clientId, tokens } = await fullGrant(instance, access);
    const list = (await instance.inject({ url: "/api/auth/oauth/grants", headers: bearer(access) })).json() as { grants: Array<{ id: string; clientId: string; clientName: string; scopes: string[]; refreshExpiresAt?: number }> };
    expect(list.grants).toMatchObject([{ clientId, clientName: "Inspector", scopes: ["chats:read", "projects:read"] }]);
    expect(list.grants[0]!.refreshExpiresAt).toBeGreaterThan(Date.now());
    expect((await instance.inject({ url: "/api/auth/oauth/grants", headers: bearer(tokens.access_token) })).statusCode).toBe(403);

    expect((await instance.inject({ method: "DELETE", url: `/api/auth/oauth/grants/${list.grants[0]!.id}`, headers: bearer(access) })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/integration/projects", headers: bearer(tokens.access_token) })).statusCode).toBe(401);
    expect((await instance.inject({ method: "DELETE", url: "/api/auth/oauth/grants/nope", headers: bearer(access) })).statusCode).toBe(404);
  });
});

/* ===================================================== plugin flow */

/** An in-process provider: a token endpoint that records what it was asked and hands out short-lived tokens. */
async function fakeProvider() {
  const calls: Array<Record<string, string>> = [];
  let issued = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      calls.push(form);
      if (req.url !== "/token" || form.client_id !== "fake-client-id" || form.client_secret !== "fake-secret") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      if (form.grant_type === "authorization_code" && form.code !== "good-code") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "bad code" }));
        return;
      }
      issued++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, token_type: "bearer", expires_in: 30, scope: "read write" }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { calls, base: `http://127.0.0.1:${port}` };
}

async function installOAuthPlugin(configDir: string, providerBase: string) {
  const dir = join(configDir, "plugins", "oauther");
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(
    join(dir, "plugin.yaml"),
    [
      "id: oauther",
      "name: OAuther",
      "version: 1.0.0",
      "dispatch: '>=1'",
      "server: ./server/index.js",
      "capabilities: [routes, oauth]",
      "secrets: [FAKE_SECRET]",
      "oauth:",
      "  clients:",
      "    fake:",
      `      authorizationUrl: ${providerBase}/authorize`,
      `      tokenUrl: ${providerBase}/token`,
      "      scopes: [read, write]",
      "      clientId: fake-client-id",
      "      clientSecret: ${secret:FAKE_SECRET}",
      "      extraParams: { access_type: offline }",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "server", "index.js"),
    // The test fixture is the one place a token value may be read back: it
    // asserts on what `ctx.oauth.token` hands the plugin.
    "export async function activate(ctx) { ctx.routes((r) => r.get('/token', async () => ({ token: await ctx.oauth.token('fake') }))); }\n",
  );
}

describe("plugin client flow", () => {
  it("connects through the callback, serves a live token, refreshes it before expiry, and disconnects", async () => {
    const provider = await fakeProvider();
    const { instance, configDir } = await app({ withConfigDir: true });
    await installOAuthPlugin(configDir, provider.base);
    await instance.services.plugins.load();
    await instance.services.plugins.activateAll();

    // Not set yet: the pane says so instead of letting Connect fail at the provider.
    let rows = (await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[];
    expect(rows[0]!.oauth).toMatchObject([{ name: "fake", connected: false, configError: expect.stringMatching(/FAKE_SECRET/) }]);
    expect((await instance.inject({ method: "POST", url: "/api/plugins/oauther/oauth/fake/connect" })).statusCode).toBe(409);

    await instance.services.secrets.set({ name: "FAKE_SECRET", scope: "global" }, "fake-secret");
    const connect = await instance.inject({ method: "POST", url: "/api/plugins/oauther/oauth/fake/connect", headers: { host: "localhost:4399" } });
    expect(connect.statusCode, connect.body).toBe(200);
    const url = new URL((connect.json() as { url: string }).url);
    expect(url.origin + url.pathname).toBe(`${provider.base}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("fake-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4399/oauth/callback/oauther/fake");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(connect.body).not.toContain("fake-secret");
    const state = url.searchParams.get("state")!;

    // Wrong state: nothing stored, the pane gets the reason.
    const forged = await instance.inject({ url: `/oauth/callback/oauther/fake?code=good-code&state=forged` });
    expect(forged.statusCode).toBe(302);
    expect(decodeURIComponent(forged.headers.location!)).toMatch(/#settings=plugins&oauthError=.*expired/);
    expect(provider.calls).toHaveLength(0);

    // The provider's refusal lands on the pane too, and consumes the state.
    const connect2 = await instance.inject({ method: "POST", url: "/api/plugins/oauther/oauth/fake/connect", headers: { host: "localhost:4399" } });
    const state2 = new URL((connect2.json() as { url: string }).url).searchParams.get("state")!;
    const refused = await instance.inject({ url: `/oauth/callback/oauther/fake?error=access_denied&state=${state2}` });
    expect(decodeURIComponent(refused.headers.location!)).toMatch(/oauthError=The\+provider\+refused/);

    // The real thing.
    const cb = await instance.inject({ url: `/oauth/callback/oauther/fake?code=good-code&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/#settings=plugins");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "good-code",
      redirect_uri: "http://localhost:4399/oauth/callback/oauther/fake",
      client_id: "fake-client-id",
      client_secret: "fake-secret",
    });
    expect(provider.calls[0]!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // State is single-use.
    expect(decodeURIComponent((await instance.inject({ url: `/oauth/callback/oauther/fake?code=good-code&state=${state}` })).headers.location!)).toMatch(/oauthError/);

    rows = (await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[];
    expect(rows[0]!.oauth).toMatchObject([{ name: "fake", connected: true, scopes: ["read", "write"] }]);
    expect(rows[0]!.oauth![0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(rows)).not.toContain("at-1");

    // 30 s to live is inside the refresh-ahead window: the plugin's first read already refreshes.
    const read = await instance.inject({ url: "/api/plugins/oauther/token" });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ token: "at-2" });
    expect(provider.calls[1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: "fake-client-id" });
    // Rotated: the next refresh uses the new refresh token.
    expect((await instance.inject({ url: "/api/plugins/oauther/token" })).json()).toEqual({ token: "at-3" });
    expect(provider.calls[2]).toMatchObject({ refresh_token: "rt-2" });

    const off = await instance.inject({ method: "DELETE", url: "/api/plugins/oauther/oauth/fake" });
    expect(off.statusCode).toBe(200);
    expect((off.json() as PluginInfo).oauth).toMatchObject([{ name: "fake", connected: false }]);
    expect((await instance.inject({ url: "/api/plugins/oauther/token" })).json()).toEqual({ token: undefined });
  });

  it("refuses a client the plugin did not declare and a plugin that is off", async () => {
    const provider = await fakeProvider();
    const { instance, configDir } = await app({ withConfigDir: true });
    await installOAuthPlugin(configDir, provider.base);
    await instance.services.plugins.load();
    expect((await instance.inject({ method: "POST", url: "/api/plugins/oauther/oauth/other/connect" })).statusCode).toBe(404);
    expect((await instance.inject({ method: "POST", url: "/api/plugins/nobody/oauth/fake/connect" })).statusCode).toBe(404);
    await instance.services.plugins.setEnabled("oauther", false);
    expect((await instance.inject({ method: "POST", url: "/api/plugins/oauther/oauth/fake/connect" })).statusCode).toBe(404);
  });
});
