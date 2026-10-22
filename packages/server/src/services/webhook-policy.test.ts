import { describe, expect, it } from "vitest";
import {
  WebhookError,
  assertMayManage,
  assertPublicUrl,
  boundFilterFor,
  callerFromIdentity,
  isPrivateAddress,
  mayAccess,
  type WebhookCaller,
} from "./webhook-policy.js";

const token = (over: Partial<Extract<WebhookCaller, { kind: "integration" }>> = {}): WebhookCaller => ({
  kind: "integration",
  tokenId: "tok_1",
  scopes: ["webhooks:manage", "chats:read"],
  ...over,
});

describe("callerFromIdentity", () => {
  it("treats today's session identity (no kind) as a browser session", () => {
    expect(callerFromIdentity({ user: { id: "u" }, sessionId: "s" })).toEqual({ kind: "user" });
    expect(callerFromIdentity(undefined)).toEqual({ kind: "user" });
  });
  it("reads an integration identity the way workstream B shapes it", () => {
    expect(
      callerFromIdentity({ kind: "integration", tokenId: "t1", scopes: ["chats:read"], projectIds: ["p1"] }),
    ).toEqual({ kind: "integration", tokenId: "t1", scopes: ["chats:read"], projectIds: ["p1"] });
  });
});

describe("management and ownership", () => {
  it("lets a session manage; a token needs webhooks:manage", () => {
    expect(() => assertMayManage({ kind: "user" })).not.toThrow();
    expect(() => assertMayManage(token())).not.toThrow();
    expect(() => assertMayManage(token({ scopes: ["chats:read"] }))).toThrow(WebhookError);
  });
  it("a token touches only its own subscriptions", () => {
    expect(mayAccess({ kind: "user" }, { createdBy: "tok_2" })).toBe(true);
    expect(mayAccess(token(), { createdBy: "tok_1" })).toBe(true);
    expect(mayAccess(token(), { createdBy: "tok_2" })).toBe(false);
    expect(mayAccess(token(), { createdBy: "user" })).toBe(false);
  });
});

describe("boundFilterFor", () => {
  it("is the identity for a session, including unset = all", () => {
    expect(boundFilterFor({ kind: "user" }, {})).toEqual({});
  });
  it("an unset events list becomes what the token's read scopes cover", () => {
    const f = boundFilterFor(token({ scopes: ["webhooks:manage", "attention:read"] }), {});
    expect(f.events).toEqual(["attention-add", "attention-resolve", "permission-request"]);
  });
  it("refuses an event the token's scopes do not cover, naming the scope", () => {
    expect(() => boundFilterFor(token(), { events: ["attention-add"] })).toThrow(/attention:read/);
    expect(() => boundFilterFor(token(), { events: ["usage-update"] })).toThrow(/not available/);
    expect(boundFilterFor(token(), { events: ["chat-settled"] }).events).toEqual(["chat-settled"]);
  });
  it("refuses a token with no read scope at all", () => {
    expect(() => boundFilterFor(token({ scopes: ["webhooks:manage"] }), {})).toThrow(WebhookError);
  });
  it("intersects projects with the token's grant; unset becomes the grant, never all", () => {
    const t = token({ projectIds: ["p1", "p2"] });
    expect(boundFilterFor(t, {}).projectIds).toEqual(["p1", "p2"]);
    expect(boundFilterFor(t, { projectIds: ["p2", "p3"] }).projectIds).toEqual(["p2"]);
    expect(() => boundFilterFor(t, { projectIds: ["p3"] })).toThrow(/within this token/);
    // An unbounded token leaves the project filter alone.
    expect(boundFilterFor(token(), {}).projectIds).toBeUndefined();
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.0.1",
    "not-an-ip",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "%s is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("assertPublicUrl", () => {
  const table: Record<string, string[]> = {
    "hooks.example": ["203.0.113.9"],
    "rebind.example": ["203.0.113.9", "127.0.0.1"],
    "lan.example": ["192.168.1.20"],
  };
  const resolve = async (host: string) => table[host] ?? [];

  it("accepts https to a public host", async () => {
    await expect(assertPublicUrl("https://hooks.example/x", resolve)).resolves.toBeUndefined();
    await expect(assertPublicUrl("https://203.0.113.9/x", resolve)).resolves.toBeUndefined();
  });
  it("refuses plain http", async () => {
    await expect(assertPublicUrl("http://hooks.example/x", resolve)).rejects.toThrow(/https/);
  });
  it("refuses loopback, LAN and localhost however spelled", async () => {
    await expect(assertPublicUrl("https://127.0.0.1/x", resolve)).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://[::1]/x", resolve)).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://localhost/x", resolve)).rejects.toThrow(/this machine/);
    await expect(assertPublicUrl("https://lan.example/x", resolve)).rejects.toThrow(/private/);
  });
  it("refuses a host with ANY private address in its answer", async () => {
    await expect(assertPublicUrl("https://rebind.example/x", resolve)).rejects.toThrow(/private/);
  });
  it("refuses a host that does not resolve", async () => {
    await expect(assertPublicUrl("https://nope.example/x", resolve)).rejects.toThrow(/did not resolve/);
  });
});
