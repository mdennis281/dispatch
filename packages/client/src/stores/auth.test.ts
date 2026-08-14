import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeAuth, useAuth } from "./auth.js";

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
});
