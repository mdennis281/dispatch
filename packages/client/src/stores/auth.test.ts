import { beforeEach, describe, expect, it, vi } from "vitest";
import { authPost, initializeAuth, isSameOrigin, sessionFetch, useAuth } from "./auth.js";

describe("auth bootstrap state", () => {
  beforeEach(() => {
    useAuth.setState({ ready: false, status: null, accessToken: null, user: null });
    vi.restoreAllMocks();
    // The client suite runs under node, which has no `location`; `sessionFetch`
    // treats that as foreign and would withhold the token these tests expect.
    vi.stubGlobal("location", new URL("http://127.0.0.1:4318/chat/abc"));
  });

  it("keeps an upgraded install open when the server reports missing auth config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: false, configured: false, firstRunDismissed: true, user: null,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await initializeAuth();
    expect(useAuth.getState()).toMatchObject({ ready: true, accessToken: null,
      status: { enabled: false, configured: false } });
  });

  it("silently refreshes an enabled session without persisting the access token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true, user: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "memory-only", expiresIn: 600,
        user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
          createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true,
        user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
          createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await initializeAuth();
    expect(useAuth.getState().accessToken).toBe("memory-only");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "x-dispatch-session": "refresh" } });
  });

  it("never publishes a signed-out answer while the cookie refresh is still running", async () => {
    // The boot splash lifts on the FIRST moment `isBootReady` is true and never
    // reconsiders, and "auth enabled, nobody signed in" is one of those moments
    // — correctly, because the sign-in form is a finished screen with no
    // snapshot coming. The trap is that a returning user passes THROUGH that
    // exact state: `/api/auth/status` is asked with no bearer, so it answers
    // `user: null` for the two round trips it takes the refresh to prove
    // otherwise. Publishing it made every authenticated load uncover an empty
    // shell — invisible on loopback, seconds of it over a slow link.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true, user: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "memory-only", expiresIn: 600,
        user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
          createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true,
        user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
          createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const signedOutWhileReady: unknown[] = [];
    const stop = useAuth.subscribe((s) => {
      if (s.ready && s.status?.enabled && !s.user) signedOutWhileReady.push(s.status);
    });
    await initializeAuth();
    stop();

    expect(signedOutWhileReady).toEqual([]);
    expect(useAuth.getState()).toMatchObject({ ready: true, user: { username: "owner" } });
  });

  it("falls back to the sign-in form when the refresh really has expired", async () => {
    // The other side of the branch above: once the refresh says no, the first
    // answer was right and withholding it would hang the splash on a login that
    // is never coming.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true, user: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await initializeAuth();
    expect(useAuth.getState()).toMatchObject({ ready: true, user: null, status: { enabled: true } });
  });

  it("keeps the session when the refresh succeeds but the re-ask fails", async () => {
    // The refresh is the call that decides whether there IS a session, and it
    // said yes — `applySession` has already installed the token and the user.
    // Falling back to the anonymous first answer here would show a signed-in
    // user the sign-in form while holding a valid token, and `main.tsx` would
    // never start the live app.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, configured: true, firstRunDismissed: true, user: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "memory-only", expiresIn: 600,
        user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
          createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await initializeAuth();
    expect(useAuth.getState()).toMatchObject({
      ready: true, accessToken: "memory-only", user: { username: "owner" },
      status: { enabled: true, configured: true, user: { username: "owner" } },
    });
  });

  it("adds the non-simple CSRF header to public authentication posts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await authPost("/api/auth/login", { username: "owner", password: "password" });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-dispatch-session")).toBe("refresh");
  });

  it("declares a JSON body only when it sends one, so bodyless posts survive Fastify", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await authPost("/api/auth/totp/begin");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-dispatch-session")).toBe("refresh");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    await authPost("/api/auth/totp/confirm", { code: "123456" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("content-type")).toBe("application/json");
  });

  it("single-flights same-tab refresh when requests fail together", async () => {
    useAuth.setState({ ready: true, accessToken: null, user: null,
      status: { enabled: true, configured: true, firstRunDismissed: true, user: null } });
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/refresh") {
        refreshCalls++;
        await Promise.resolve();
        return new Response(JSON.stringify({ accessToken: "shared-token", expiresIn: 600,
          user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
            createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      return new Response("{}", { status: headers.get("authorization") ? 200 : 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const responses = await Promise.all([sessionFetch("/api/protected"), sessionFetch("/api/protected")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(refreshCalls).toBe(1);
  });
});

describe("sessionFetch only hands the bearer token to its own origin", () => {
  const signedIn = { enabled: true, configured: true, firstRunDismissed: true, user: null };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("location", new URL("http://127.0.0.1:4318/chat/abc"));
    useAuth.setState({ ready: true, status: signedIn, accessToken: "secret-token", user: null });
  });

  function authOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string | null {
    return new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("authorization");
  }

  it.each([
    ["a relative path", "/api/chats"],
    ["a path relative to the page", "assets/shot.png"],
    ["an absolute same-origin string", "http://127.0.0.1:4318/api/chats"],
    ["a same-origin URL", new URL("/api/chats", "http://127.0.0.1:4318")],
    ["a same-origin Request", new Request("http://127.0.0.1:4318/api/chats")],
  ])("attaches it for %s", async (_label, input) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sessionFetch(input);
    expect(authOf(fetchMock)).toBe("Bearer secret-token");
  });

  it.each([
    ["a foreign string", "https://evil.example/collect"],
    ["a protocol-relative string", "//evil.example/collect"],
    ["another port on the same host", "http://127.0.0.1:4319/api/chats"],
    ["a foreign URL", new URL("https://evil.example/collect")],
    ["a foreign Request", new Request("https://evil.example/collect")],
  ])("withholds it for %s", async (_label, input) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sessionFetch(input);
    expect(authOf(fetchMock)).toBeNull();
  });

  it("does not refresh-and-retry on a foreign 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await sessionFetch("https://evil.example/collect");
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still refreshes and retries a same-origin 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/refresh") {
        return new Response(JSON.stringify({ accessToken: "fresh-token", expiresIn: 600,
          user: { id: "u1", username: "owner", displayName: "Owner", owner: true, disabled: false,
            createdAt: 1, hasPassword: true, passkeyCount: 0, totpEnabled: false } }), { status: 200 });
      }
      return new Response("{}", { status: fetchMock.mock.calls.length === 1 ? 401 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await sessionFetch("/api/protected");
    expect(response.status).toBe(200);
    expect(authOf(fetchMock, fetchMock.mock.calls.length - 1)).toBe("Bearer fresh-token");
  });

  it("fails closed without a location or on an unparsable input", () => {
    expect(isSameOrigin("http://[bad")).toBe(false);
    vi.stubGlobal("location", undefined);
    expect(isSameOrigin("/api/chats")).toBe(false);
  });
});
