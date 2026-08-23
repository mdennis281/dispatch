/**
 * The bridge's PATH contract.
 *
 * These are cheap string assertions guarding an expensive failure: the global
 * auth gate exempts the bridge by path, and the bridge's path grew a category
 * segment. When the exemption was an exact match on the parent it silently
 * stopped matching, so on any install with auth enabled Codex dialled
 * `/api/mcp/manager/session` with its grant token, the gate tried to verify that
 * as an access JWT, and every Dispatch tool 401'd for the whole session.
 *
 * Nothing failed on an auth-DISABLED install, which is why no existing test
 * caught it and why these exist.
 */
import { describe, it, expect } from "vitest";
import { MANAGER_CATEGORIES, managerServerName } from "@dispatch/shared";
import { EventBus } from "../../bus.js";
import { createManagerMcpServers, managerMcpContextOf } from "./manager-mcp.js";
import {
  MANAGER_MCP_PATH,
  MANAGER_MCP_ROUTE,
  ManagerMcpBridge,
  isManagerBridgePath,
  managerCategoryFromPath,
} from "./manager-http.js";

describe("isManagerBridgePath", () => {
  it("matches every category endpoint the bridge actually serves", () => {
    const bridge = new ManagerMcpBridge("http://127.0.0.1:4319");
    const grant = bridge.mint("c1", () => ({}) as never);
    for (const category of MANAGER_CATEGORIES) {
      const url = new URL(grant.urlFor(managerServerName(category)));
      expect(isManagerBridgePath(url.pathname), category).toBe(true);
    }
  });

  it("still matches the parent path", () => {
    expect(isManagerBridgePath(MANAGER_MCP_PATH)).toBe(true);
  });

  it("does not exempt a neighbouring route", () => {
    // A `startsWith` without the separator would exempt `/api/mcp/managerX`,
    // opening a hole in the auth gate rather than closing one.
    expect(isManagerBridgePath(`${MANAGER_MCP_PATH}X`)).toBe(false);
    expect(isManagerBridgePath(`${MANAGER_MCP_PATH}-admin/secrets`)).toBe(false);
    expect(isManagerBridgePath("/api/mcp")).toBe(false);
    expect(isManagerBridgePath("/api/projects")).toBe(false);
  });
});

describe("the route and the URLs it must serve", () => {
  it("registers a pattern the minted URLs match", () => {
    // `urlFor` strips the `dispatch-` prefix and the route parses the bare
    // category. A mismatch between the two means Codex dials an endpoint that
    // does not exist and gets zero Dispatch tools, with no error anywhere.
    expect(MANAGER_MCP_ROUTE).toBe(`${MANAGER_MCP_PATH}/:category`);
    const bridge = new ManagerMcpBridge("http://127.0.0.1:4319");
    const grant = bridge.mint("c1", () => ({}) as never);
    for (const category of MANAGER_CATEGORIES) {
      const segment = new URL(grant.urlFor(managerServerName(category))).pathname
        .slice(`${MANAGER_MCP_PATH}/`.length);
      expect(managerCategoryFromPath(segment), category).toBe(category);
    }
  });

  it("rejects a segment that is not a category, including the prefixed form", () => {
    // The prefixed spelling is never emitted by `urlFor`, so accepting it would
    // mean two addresses for one server.
    expect(managerCategoryFromPath("dispatch-github")).toBeUndefined();
    expect(managerCategoryFromPath("nonsense")).toBeUndefined();
    expect(managerCategoryFromPath("")).toBeUndefined();
    expect(managerCategoryFromPath(undefined)).toBeUndefined();
  });

  it("pins a grant's URLs to the origin it was minted against", () => {
    // A `setOrigin` between mint and use would otherwise hand out URLs for a
    // port the grant was never issued against.
    const bridge = new ManagerMcpBridge("http://127.0.0.1:4319");
    const grant = bridge.mint("c1", () => ({}) as never);
    bridge.setOrigin("http://127.0.0.1:9999");
    expect(grant.urlFor("dispatch-session")).toBe(
      `http://127.0.0.1:4319${MANAGER_MCP_PATH}/session`,
    );
  });
});

describe("recovering the live context from a session's server map", () => {
  /** How `session-broker` picks the context to mint a Codex grant against. */
  const pick = (servers: Record<string, unknown>) =>
    Object.values(servers).map(managerMcpContextOf).find(Boolean);

  const real = () =>
    createManagerMcpServers({ chatId: "c1", bus: new EventBus(), broker: {} as never });

  it("finds the context even when a foreign entry sorts first", () => {
    // `allMcp` is `{ ...externalMcp, ...managerServers }` and the split filters
    // by NAME, so a project that hand-declared `dispatch-github` keeps that
    // earlier key position — and its plain `{url}` config sits there whenever
    // this session doesn't build that category. Taking `[0]` blind yielded
    // undefined and the Codex session came up with no Dispatch tools, silently.
    const servers = { "dispatch-github": { url: "https://example.com/mcp" }, ...real() };
    expect(Object.keys(servers)[0]).toBe("dispatch-github");
    expect(pick(servers)).toBeDefined();
  });

  it("is undefined when there is genuinely nothing of ours", () => {
    expect(pick({ "dispatch-github": { url: "https://example.com/mcp" } })).toBeUndefined();
    expect(pick({})).toBeUndefined();
  });

  it("recovers the SAME context from every category server", () => {
    // The grant is per-chat, not per-category, so any one of them must do.
    const servers = real();
    const contexts = Object.values(servers).map(managerMcpContextOf);
    expect(contexts.length).toBeGreaterThan(1);
    expect(new Set(contexts).size).toBe(1);
  });
});
