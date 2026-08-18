import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { StateDb } from "../store/db.js";
import { normalizeUserAgent, verifyTotp } from "../services/auth.js";

const dirs: string[] = [];
const sessionHeaders = { "x-dispatch-session": "refresh" } as const;
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function app() {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-"));
  dirs.push(dir);
  const store = new Store(dir);
  const instance = await buildApp({ store, bus: new EventBus(), config: {
    port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1,
  }});
  return { instance, store, dir };
}

async function pairedApps() {
  const root = await mkdtemp(join(tmpdir(), "dispatch-auth-paired-"));
  dirs.push(root);
  const configDir = join(root, "config");
  const dataOne = join(root, "stable-data");
  const dataTwo = join(root, "dev-data");
  await Promise.all([mkdir(configDir), mkdir(dataOne), mkdir(dataTwo)]);
  const make = async (dataDir: string) => {
    const store = new Store(dataDir, configDir);
    const instance = await buildApp({ store, bus: new EventBus(), config: {
      port: 0, host: "127.0.0.1", dataDir, configDir, maxActiveSessions: 1,
    }});
    return { store, instance };
  };
  const one = await make(dataOne);
  const two = await make(dataTwo);
  return { one, two, configDir };
}

async function bootstrap(instance: Awaited<ReturnType<typeof buildApp>>, ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0") {
  const response = await instance.inject({ method: "POST", url: "/api/auth/bootstrap",
    headers: { "user-agent": ua, ...sessionHeaders }, payload: {
      username: "Owner", password: "correct horse battery staple", canonicalUrl: "http://localhost",
    }});
  expect(response.statusCode).toBe(200);
  return { body: response.json() as { accessToken: string }, cookie: response.headers["set-cookie"] as string };
}

function rawCookie(header: string): string {
  return decodeURIComponent(header.split(";", 1)[0]!.split("=").slice(1).join("="));
}

describe("optional authentication", () => {
  it("normalizes browser families without duplicating their major version", () => {
    expect(normalizeUserAgent("Mozilla/5.0 Windows NT 10.0 Chrome/126.0 Edg/126.0")).toBe("edge/126|windows|desktop");
    expect(normalizeUserAgent("Mozilla/5.0 iPhone Version/17.5 Mobile Safari/604.1")).toBe("safari/17|ios|mobile");
  });

  it("rejects cookie-issuing authentication requests without the CSRF header", async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: "POST", url: "/api/auth/bootstrap", payload: {
      username: "Owner", password: "correct horse battery staple", canonicalUrl: "http://localhost",
    }});
    expect(response.statusCode).toBe(403);
    expect((await instance.inject({ url: "/api/auth/status" })).json()).toMatchObject({ configured: false, enabled: false });
    await instance.close();
  });

  it("coalesces and briefly caches auth-setting reads used by request and socket guards", async () => {
    const { instance, store } = await app();
    const getSettings = vi.spyOn(store, "getSettings");
    await Promise.all([instance.auth.enabled(), instance.auth.enabled(), instance.auth.enabled()]);
    await instance.auth.enabled();
    expect(getSettings).toHaveBeenCalledTimes(1);
    await instance.close();
  });

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

  // A root holding only `runners.json` used to be the canonical "this is an
  // upgrade, not a fresh install" case. It is now ALSO the canonical un-migrated
  // store, so it has to answer both questions — hence the pair below.
  it("refuses to boot a legacy root that was never migrated to SQLite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-legacy-unmigrated-"));
    dirs.push(dir);
    await writeFile(join(dir, "runners.json"), "[]");
    const store = new Store(dir);
    // Refusing beats auto-migrating: this is a minute of work on data the user
    // has no second copy of, and a silent pause at boot is the worst way to
    // learn it happened. The message has to name the script that does it.
    await expect(
      buildApp({ store, bus: new EventBus(), config: {
        port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1,
      }}),
    ).rejects.toThrow(/app:migrate-store/);
  });

  it("treats a MIGRATED legacy root as an existing install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-auth-legacy-upgrade-"));
    dirs.push(dir);
    // What a migrated store looks like: the database exists, and the JSONL tree
    // is still there because it is the documented rollback path (`--prune` is
    // opt-in and separate).
    await writeFile(join(dir, "runners.json"), "[]");
    const db = new StateDb(dir);
    db.open();
    db.close();

    const store = new Store(dir);
    const instance = await buildApp({ store, bus: new EventBus(), config: {
      port: 0, host: "127.0.0.1", dataDir: dir, maxActiveSessions: 1,
    }});
    expect((await instance.inject({ url: "/api/auth/status" })).json()).toMatchObject({
      enabled: false, firstRunDismissed: true,
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

  it("serializes concurrent bootstrap attempts so exactly one owner exists", async () => {
    const { instance, dir } = await app();
    const attempt = (username: string) => instance.inject({ method: "POST", url: "/api/auth/bootstrap", headers: sessionHeaders, payload: {
      username, password: "correct horse battery staple", canonicalUrl: "http://localhost",
    }});
    const responses = await Promise.all([attempt("owner-one"), attempt("owner-two")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const stored = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as { users: Array<{ owner: boolean }> };
    expect(stored.users).toHaveLength(1);
    expect(stored.users.filter((user) => user.owner)).toHaveLength(1);
    await instance.close();
  });

  it("serializes bootstrap across stable and dev instances sharing config", async () => {
    const { one, two, configDir } = await pairedApps();
    const attempt = (instance: typeof one.instance, username: string) => instance.inject({
      method: "POST", url: "/api/auth/bootstrap", headers: sessionHeaders, payload: {
        username, password: "correct horse battery staple", canonicalUrl: "http://localhost",
      },
    });
    const responses = await Promise.all([attempt(one.instance, "stable-owner"), attempt(two.instance, "dev-owner")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const stored = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8")) as { users: Array<{ owner: boolean }> };
    expect(stored.users).toHaveLength(1);
    await Promise.all([one.instance.close(), two.instance.close()]);
  });

  it("reloads and preserves concurrent shared identity mutations across instances", async () => {
    const { one, two } = await pairedApps();
    const ownerOne = await bootstrap(one.instance);
    const ownerTwo = await two.instance.inject({ method: "POST", url: "/api/auth/login", headers: sessionHeaders, payload: {
      username: "owner", password: "correct horse battery staple",
    }});
    expect(ownerTwo.statusCode).toBe(200);
    const ownerTwoToken = (ownerTwo.json() as { accessToken: string }).accessToken;
    const [inviteOne, inviteTwo] = await Promise.all([
      one.instance.inject({ method: "POST", url: "/api/auth/setup-codes",
        headers: { authorization: `Bearer ${ownerOne.body.accessToken}` } }),
      two.instance.inject({ method: "POST", url: "/api/auth/setup-codes",
        headers: { authorization: `Bearer ${ownerTwoToken}` } }),
    ]);
    expect([inviteOne.statusCode, inviteTwo.statusCode]).toEqual([200, 200]);
    const [memberOne, memberTwo] = await Promise.all([
      one.instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders, payload: {
        code: (inviteOne.json() as { code: string }).code, username: "stable-member", password: "another correct horse password",
      }}),
      two.instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders, payload: {
        code: (inviteTwo.json() as { code: string }).code, username: "dev-member", password: "another correct horse password",
      }}),
    ]);
    expect([memberOne.statusCode, memberTwo.statusCode]).toEqual([200, 200]);
    const list = async (instance: typeof one.instance, token: string) => instance.inject({ url: "/api/auth/users",
      headers: { authorization: `Bearer ${token}` } });
    expect((await list(one.instance, ownerOne.body.accessToken)).json()).toHaveLength(3);
    expect((await list(two.instance, ownerTwoToken)).json()).toHaveLength(3);

    const memberTwoToken = (memberTwo.json() as { accessToken: string }).accessToken;
    const memberOneToken = (memberOne.json() as { accessToken: string }).accessToken;
    const resetIdentity = await two.instance.auth.authenticateAccess(memberTwoToken);
    const deleteIdentity = await one.instance.auth.authenticateAccess(memberOneToken);
    const users = (await list(one.instance, ownerOne.body.accessToken)).json() as Array<{ id: string; username: string }>;
    const resetTarget = users.find((user) => user.username === "dev-member")!;
    expect((await one.instance.inject({ method: "POST", url: `/api/auth/users/${resetTarget.id}/reset`,
      headers: { authorization: `Bearer ${ownerOne.body.accessToken}` },
      payload: { password: "a newly reset horse password" } })).statusCode).toBe(200);
    expect(await two.instance.auth.identityStillValid(resetIdentity!)).toBe(false);
    expect((await two.instance.inject({ url: "/api/projects",
      headers: { authorization: `Bearer ${memberTwoToken}` } })).statusCode).toBe(401);

    const deleteTarget = users.find((user) => user.username === "stable-member")!;
    expect((await one.instance.inject({ method: "DELETE", url: `/api/auth/users/${deleteTarget.id}`,
      headers: { authorization: `Bearer ${ownerOne.body.accessToken}` } })).statusCode).toBe(200);
    expect(await one.instance.auth.identityStillValid(deleteIdentity!)).toBe(false);

    expect((await one.instance.inject({ method: "POST", url: "/api/auth/disable",
      headers: { authorization: `Bearer ${ownerOne.body.accessToken}`, "x-dispatch-session": "refresh" } })).statusCode).toBe(200);
    expect((await one.instance.inject({ method: "POST", url: "/api/auth/enable", headers: sessionHeaders, payload: {
      username: "owner", password: "correct horse battery staple",
    }})).statusCode).toBe(200);
    expect((await two.instance.inject({ url: "/api/projects",
      headers: { authorization: `Bearer ${ownerTwoToken}` } })).statusCode).toBe(401);
    await Promise.all([one.instance.close(), two.instance.close()]);
  });

  it("hashes owner passwords and protects REST, WS, and runner control when enabled", async () => {
    const { instance, dir } = await app();
    const session = await bootstrap(instance);
    const stored = await readFile(join(dir, "auth.json"), "utf8");
    expect(stored).toContain("$argon2id$");
    expect(stored).not.toContain("correct horse battery staple");
    expect(session.cookie).toContain("HttpOnly");
    expect(session.cookie).toContain("SameSite=Strict");
    expect(session.cookie).not.toContain("Secure");
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

  it("treats narrowly concurrent refresh as retryable without killing the family", async () => {
    const { instance } = await app();
    const ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0";
    const session = await bootstrap(instance, ua);
    const headers = { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(session.cookie))}`,
      "x-dispatch-session": "refresh", "user-agent": ua };
    const responses = await Promise.all([
      instance.inject({ method: "POST", url: "/api/auth/refresh", headers }),
      instance.inject({ method: "POST", url: "/api/auth/refresh", headers }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const first = responses.find((response) => response.statusCode === 200)!;
    const rotated = rawCookie(first.headers["set-cookie"] as string);
    expect((await instance.inject({ method: "POST", url: "/api/auth/refresh", headers: {
      ...headers, cookie: `dispatch_refresh=${encodeURIComponent(rotated)}`,
    }})).statusCode).toBe(200);
    await instance.close();
  });

  it("revokes the family when a rotated token is reused after the concurrency grace", async () => {
    const { instance } = await app();
    const ua = "Mozilla/5.0 Chrome/126.0 Windows NT 10.0";
    const session = await bootstrap(instance, ua);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const headers = { cookie: `dispatch_refresh=${encodeURIComponent(rawCookie(session.cookie))}`,
      "x-dispatch-session": "refresh", "user-agent": ua };
    const first = await instance.inject({ method: "POST", url: "/api/auth/refresh", headers });
    expect(first.statusCode).toBe(200);
    now += 2_001;
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
    const first = await instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders,
      payload: { code, username: "teammate", password: "another correct horse password" } });
    expect(first.statusCode).toBe(200);
    const reuse = await instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders,
      payload: { code, username: "other", password: "another correct horse password" } });
    expect(reuse.statusCode).toBe(400);
    const users = await instance.inject({ url: "/api/auth/users",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    expect(users.json()).toHaveLength(2);
    await instance.close();
  });

  it("serializes concurrent setup redemption so a code creates only one account", async () => {
    const { instance } = await app();
    const owner = await bootstrap(instance);
    const invite = await instance.inject({ method: "POST", url: "/api/auth/setup-codes",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    const code = (invite.json() as { code: string }).code;
    const redeem = (username: string) => instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders,
      payload: { code, username, password: "another correct horse password" } });
    const responses = await Promise.all([redeem("member-one"), redeem("member-two")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    const users = await instance.inject({ url: "/api/auth/users",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    expect(users.json()).toHaveLength(2);
    await instance.close();
  });

  it("lets only the owner update a validated canonical passkey origin", async () => {
    const { instance } = await app();
    const owner = await bootstrap(instance);
    const invite = await instance.inject({ method: "POST", url: "/api/auth/setup-codes",
      headers: { authorization: `Bearer ${owner.body.accessToken}` } });
    const member = await instance.inject({ method: "POST", url: "/api/auth/setup/redeem", headers: sessionHeaders, payload: {
      code: (invite.json() as { code: string }).code, username: "member", password: "another correct horse password",
    }});
    const memberToken = (member.json() as { accessToken: string }).accessToken;
    expect((await instance.inject({ method: "PUT", url: "/api/auth/webauthn",
      headers: { authorization: `Bearer ${memberToken}` }, payload: { canonicalUrl: "https://dispatch.example.com" } })).statusCode).toBe(403);
    expect((await instance.inject({ method: "PUT", url: "/api/auth/webauthn",
      headers: { authorization: `Bearer ${owner.body.accessToken}` }, payload: { canonicalUrl: "http://dispatch.example.com" } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "PUT", url: "/api/auth/webauthn",
      headers: { authorization: `Bearer ${owner.body.accessToken}` }, payload: { canonicalUrl: "https://dispatch.example.com", rpId: "unrelated.test" } })).statusCode).toBe(400);
    const updated = await instance.inject({ method: "PUT", url: "/api/auth/webauthn",
      headers: { authorization: `Bearer ${owner.body.accessToken}` }, payload: { canonicalUrl: "https://dispatch.example.com", rpId: "example.com" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ canonicalUrl: "https://dispatch.example.com", rpId: "example.com" });
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

  it("serves bodyless posts that still carry a JSON content type", async () => {
    const { instance } = await app();
    const owner = await bootstrap(instance);
    const headers = { authorization: `Bearer ${owner.body.accessToken}`,
      "content-type": "application/json", ...sessionHeaders };
    const begin = await instance.inject({ method: "POST", url: "/api/auth/totp/begin", headers });
    expect(begin.statusCode).toBe(200);
    expect(begin.json()).toMatchObject({ secret: expect.any(String), uri: expect.stringContaining("otpauth://") });
    const options = await instance.inject({ method: "POST", url: "/api/auth/passkeys/register/options", headers });
    expect(options.statusCode).toBe(200);
    for (const payload of ["{not json", "   "]) {
      expect((await instance.inject({ method: "POST", url: "/api/auth/totp/confirm", headers, payload })).statusCode).toBe(400);
    }
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
    const enabled = await instance.inject({ method: "POST", url: "/api/auth/enable", headers: { "user-agent": ua, ...sessionHeaders },
      payload: { username: "owner", password: "correct horse battery staple" } });
    expect(enabled.statusCode).toBe(200);
    expect((await instance.inject({ url: "/api/projects" })).statusCode).toBe(401);
    await instance.close();
  });
});
