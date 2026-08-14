import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { verifyTotp } from "../services/auth.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function app() {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-"));
  dirs.push(dir);
  const store = new Store(dir);
  const instance = await buildApp({ store, bus: new EventBus(), config: {
    port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1,
  }});
  return { instance, store, dir };
}

async function bootstrap(instance: Awaited<ReturnType<typeof buildApp>>, ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0") {
  const response = await instance.inject({ method: "POST", url: "/api/auth/bootstrap",
    headers: { "user-agent": ua }, payload: {
      username: "Owner", password: "correct horse battery staple", canonicalUrl: "http://localhost",
    }});
  expect(response.statusCode).toBe(200);
  return { body: response.json() as { accessToken: string }, cookie: response.headers["set-cookie"] as string };
}

function rawCookie(header: string): string {
  return decodeURIComponent(header.split(";", 1)[0]!.split("=").slice(1).join("="));
}

describe("optional authentication", () => {
  it("accepts RFC-compatible TOTP codes within the clock-skew window", () => {
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59_000)).toBe(true);
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "000000", 59_000)).toBe(false);
  });
  it("treats a missing auth config as disabled for backward-compatible upgrades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-upgrade-"));
    dirs.push(dir);
    await writeFile(join(dir, "config.json"), JSON.stringify({ theme: "dark" }));
    const store = new Store(dir);
    const instance = await buildApp({ store, bus: new EventBus(), config: {
      port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1,
    }});
    expect((await store.getSettings()).auth).toBeUndefined();
    expect((await instance.inject({ url: "/api/projects" })).statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/auth/status" })).json()).toMatchObject({
      enabled: false, configured: false, firstRunDismissed: true,
    });
    await instance.close();
  });

  it("offers the dismissible auth choice on a genuinely fresh install", async () => {
    const { instance } = await app();
    expect((await instance.inject({ url: "/api/auth/status" })).json()).toMatchObject({
      enabled: false, configured: false, firstRunDismissed: false,
    });
    await instance.close();
  });

  it("hashes owner passwords and protects REST, WS, and runner control when enabled", async () => {
    const { instance, dir } = await app();
    const session = await bootstrap(instance);
    const stored = await readFile(join(dir, "auth.json"), "utf8");
    expect(stored).toContain("$argon2id$");
    expect(stored).not.toContain("correct horse battery staple");
    expect((await instance.inject({ url: "/api/projects" })).statusCode).toBe(401);
    expect((await instance.inject({ url: "/ws" })).statusCode).toBe(401);
    expect((await instance.inject({ method: "POST", url: "/api/runners", payload: {} })).statusCode).toBe(401);
    expect((await instance.inject({ url: "/api/projects", headers: { authorization: `Bearer ${session.body.accessToken}` } })).statusCode).toBe(200);
    const ticket = await instance.inject({ method: "POST", url: "/api/auth/ws-ticket", headers: { authorization: `Bearer ${session.body.accessToken}` } });
    expect(ticket.statusCode).toBe(200);
    await instance.close();
  });

  it("rotates refresh tokens and revokes only a family on normalized UA mismatch", async () => {
    const { instance } = await app();
    const ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0";
    const session = await bootstrap(instance, ua);
    const first = await instance.inject({ method: "POST", url: "/api/auth/refresh",
      headers: { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(session.cookie))}`, "x-dispatch-session": "refresh", "user-agent": ua } });
    expect(first.statusCode).toBe(200);
    const nextCookie = first.headers["set-cookie"] as string;
    expect(rawCookie(nextCookie)).not.toBe(rawCookie(session.cookie));
    const mismatch = await instance.inject({ method: "POST", url: "/api/auth/refresh",
      headers: { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(nextCookie))}`, "x-dispatch-session": "refresh",
        "user-agent": "Mozilla/5.0 Firefox/127.0 Linux" } });
    expect(mismatch.statusCode).toBe(401);
    const afterRevoke = await instance.inject({ method: "POST", url: "/api/auth/refresh",
      headers: { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(nextCookie))}`, "x-dispatch-session": "refresh", "user-agent": ua } });
    expect(afterRevoke.statusCode).toBe(401);
    await instance.close();
  });

  it("detects reuse of an already-rotated refresh token and revokes its family", async () => {
    const { instance } = await app();
    const ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0";
    const session = await bootstrap(instance, ua);
    const headers = { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(session.cookie))}`,
      "x-dispatch-session": "refresh", "user-agent": ua };
    const first = await instance.inject({ method: "POST", url: "/api/auth/refresh", headers });
    expect(first.statusCode).toBe(200);
    expect((await instance.inject({ method: "POST", url: "/api/auth/refresh", headers })).statusCode).toBe(401);
    const rotated = rawCookie(first.headers["set-cookie"] as string);
    expect((await instance.inject({ method: "POST", url: "/api/auth/refresh", headers: {
      ...headers, cookie: `dispatch_refresh=${encodeURIComponent(rotated)}`,
    }})).statusCode).toBe(401);
    await instance.close();
  });

  it("preserves auth settings across old-client settings PUTs", async () => {
    const { instance, store } = await app();
    const session = await bootstrap(instance);
    const response = await instance.inject({ method: "PUT", url: "/api/settings",
      headers: { authorization: `Bearer ${session.body.accessToken}` }, payload: { theme: "light" } });
    expect(response.statusCode).toBe(200);
    expect((await store.getSettings()).auth).toMatchObject({ enabled: true });
    await instance.close();
  });

  it("lets the owner create a one-time onboarding link and rejects reuse", async () => {
    const { instance } = await app();
    const owner = await bootstrap(instance);
    const invite = await instance.inject({ method: "POST", url: "/api/auth/setup-codes",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    expect(invite.statusCode).toBe(200);
    expect((invite.json() as { url: string }).url).toMatch(/^http:\/\/localhost\/\?setup=/);
    const code = (invite.json() as { code: string }).code;
    const first = await instance.inject({ method: "POST", url: "/api/auth/setup/redeem",
      payload: { code, username: "teammate", password: "another correct horse password" } });
    expect(first.statusCode).toBe(200);
    const reuse = await instance.inject({ method: "POST", url: "/api/auth/setup/redeem",
      payload: { code, username: "other", password: "another correct horse password" } });
    expect(reuse.statusCode).toBe(400);
    const users = await instance.inject({ url: "/api/auth/users",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    expect(users.json()).toHaveLength(2);
    await instance.close();
  });

  it("creates discoverable, user-verifying passkey registration options", async () => {
    const { instance } = await app();
    const owner = await bootstrap(instance);
    const options = await instance.inject({ method: "POST", url: "/api/auth/passkeys/register/options",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({ rp: { id: "localhost" },
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    await instance.close();
  });

  it("turning auth off revokes sessions but preserves the owner for later re-enable", async () => {
    const { instance } = await app();
    const ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0";
    const session = await bootstrap(instance, ua);
    const disabled = await instance.inject({ method: "POST", url: "/api/auth/disable",
      headers: { authorization: `Bearer ${session.body.accessToken}`, "x-dispatch-session": "refresh" } });
    expect(disabled.statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/projects" })).statusCode).toBe(200);
    const enabled = await instance.inject({ method: "POST", url: "/api/auth/enable", headers: { "user-agent": ua },
      payload: { username: "owner", password: "correct horse battery staple" } });
    expect(enabled.statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/projects" })).statusCode).toBe(401);
    await instance.close();
  });
});
