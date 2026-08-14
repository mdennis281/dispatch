import { beforeEach, describe, expect, it, vi } from "vitest";
import { authPost, initializeAuth, sessionFetch, useAuth } from "./auth.js";

describe("auth bootstrap state", () => {
  beforeEach(() => {
    useAuth.setState({ ready: false, status: null, accessToken: null, user: null });
    vi.restoreAllMocks();
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
