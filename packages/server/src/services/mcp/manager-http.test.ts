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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MANAGER_CATEGORIES, managerServerName } from "@dispatch/shared";
import { EventBus } from "../../bus.js";
import type { IntegrationIdentity } from "../integration-tokens.js";
import {
  createManagerMcpServers,
  externalToolPolicy,
  type ManagerMcpBroker,
  type ManagerMcpContext,
} from "./manager-mcp.js";
import {
  INTEGRATION_MCP_PATH,
  INTEGRATION_MCP_ROUTE,
  MANAGER_MCP_PATH,
  MANAGER_MCP_ROUTE,
  ManagerMcpBridge,
  isIntegrationBridgePath,
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

  it("does NOT exempt the integration mount", () => {
    // The integration mount is authenticated by the global gate (a `dsp_`
    // bearer the gate resolves to an identity), so it must stay INSIDE the
    // gate. Had it been placed under the per-chat prefix it would have ridden
    // this exemption and answered tool calls to anybody.
    for (const category of MANAGER_CATEGORIES) {
      const path = `${INTEGRATION_MCP_PATH}/${category}`;
      expect(isManagerBridgePath(path), category).toBe(false);
      expect(isIntegrationBridgePath(path), category).toBe(true);
    }
    expect(INTEGRATION_MCP_ROUTE).toBe(`${INTEGRATION_MCP_PATH}/:category`);
    expect(isIntegrationBridgePath(`${INTEGRATION_MCP_PATH}X`)).toBe(false);
    expect(isIntegrationBridgePath(MANAGER_MCP_PATH)).toBe(false);
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

/*
 * The servers themselves, end to end, on every front door they have. The
 * factory used to build them with the Claude Agent SDK and hand the HTTP side
 * a context fished back off a hidden symbol; these pin that a plain MCP-SDK
 * server, given its context explicitly, serves the same tools to Codex/goose
 * (HTTP), to an integration, and in-process — with the context and the abort
 * reaching the handler on each.
 */
describe("serving the manager tools", () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close().catch(() => {})));
  });

  /** A broker that records which chat asked, and parks `onSteer` listeners. */
  function context(extra: Partial<ManagerMcpContext> = {}) {
    const asked: string[] = [];
    const steerListeners = new Set<() => void>();
    const broker = {
      has: () => false,
      getStatus: () => undefined,
      getContextUsage: async (chatId: string) => {
        asked.push(chatId);
        return null;
      },
      acquireSlot: async () => {},
      noteWaitingOn: () => {},
    } as unknown as ManagerMcpBroker;
    const ctx: ManagerMcpContext = {
      chatId: "c1",
      bus: new EventBus(),
      broker,
      onSteer: (listener) => {
        steerListeners.add(listener);
        return () => steerListeners.delete(listener);
      },
      ...extra,
    };
    return { ctx, asked, steerListeners };
  }

  /** Mount the bridge on a real loopback server, the way the Fastify route does. */
  async function listen(
    bridge: ManagerMcpBridge,
    mount: "chat" | "integration",
    identity?: IntegrationIdentity,
  ): Promise<string> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const category = req.url?.split("/").pop();
      if (mount === "chat") {
        await bridge.handle(req, res, body, req.headers.authorization, category);
      } else {
        await bridge.handleIntegration(req, res, body, identity, category);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function connect(url: string, token?: string): Promise<Client> {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
      }),
    );
    closers.push(() => client.close());
    return client;
  }

  const text = (result: unknown) =>
    ((result as CallToolResult).content[0] as { text: string }).text;

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };

  it("serves a chat's tools over HTTP against the context the grant was minted with", async () => {
    const { ctx, asked } = context();
    const bridge = new ManagerMcpBridge();
    bridge.setOrigin(await listen(bridge, "chat"));
    const grant = bridge.mint("c1", () => ctx);
    const client = await connect(grant.urlFor("dispatch-session"), grant.token);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["compact_context", "context_usage", "wait"]);
    // Parameter descriptions are what an agent reads to call a tool right. The
    // Claude SDK copied them into ITS zod registry by hand; they must survive
    // the plain MCP SDK's own schema conversion too.
    const wait = tools.find((t) => t.name === "wait")!;
    expect(wait.inputSchema.properties?.seconds).toMatchObject({
      type: "number",
      description: expect.stringContaining("How long to wait"),
    });

    const result = await client.callTool({ name: "context_usage", arguments: {} });
    expect(text(result)).toContain("Context usage is unavailable");
    expect(asked).toEqual(["c1"]);
  });

  it("refuses a request with no grant before building anything", async () => {
    const bridge = new ManagerMcpBridge();
    const origin = await listen(bridge, "chat");
    await expect(connect(`${origin}${MANAGER_MCP_PATH}/session`)).rejects.toThrow();
  });

  it("ends a tool blocked over HTTP when the owning session aborts", async () => {
    const stop = new AbortController();
    const { ctx, steerListeners } = context({ signal: stop.signal });
    const bridge = new ManagerMcpBridge();
    bridge.setOrigin(await listen(bridge, "chat"));
    const grant = bridge.mint("c1", () => ctx);
    const client = await connect(grant.urlFor("dispatch-session"), grant.token);

    const call = client.callTool({ name: "wait", arguments: { seconds: 60 } });
    // Parked inside the handler: it subscribes to steering before it sleeps.
    await until(() => steerListeners.size === 1);
    stop.abort();
    expect(text(await call)).toContain("Wait cancelled");
  });

  it("unwinds an in-process handler when the caller cancels the call", async () => {
    // The in-process path Claude uses: the runtime's cancel arrives as the MCP
    // `extra.signal`, not as a session abort.
    const { ctx, steerListeners } = context();
    const server = createManagerMcpServers(ctx)["dispatch-session"]!;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    closers.push(
      () => client.close(),
      () => server.close(),
    );

    const cancel = new AbortController();
    const call = client.callTool({ name: "wait", arguments: { seconds: 60 } }, undefined, {
      signal: cancel.signal,
    });
    await until(() => steerListeners.size === 1);
    cancel.abort();
    await expect(call).rejects.toThrow();
    // The handler drops its steer subscription on the way out — it really ended.
    await until(() => steerListeners.size === 0);
  });

  it("serves only external tools on the integration mount, by scope", async () => {
    const { ctx } = context({ chatId: "", toolPolicy: externalToolPolicy() });
    const bridge = new ManagerMcpBridge();
    bridge.setIntegrationContext(() => ctx);
    const identity: IntegrationIdentity = {
      kind: "integration",
      tokenId: "t1",
      name: "bot",
      scopes: ["tools:chat"],
    };
    const origin = await listen(bridge, "integration", identity);

    const client = await connect(`${origin}${INTEGRATION_MCP_PATH}/chat`);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["wait_for_chat"]);
    const result = await client.callTool({ name: "wait_for_chat", arguments: { chatId: "nope" } });
    expect((result as CallToolResult).isError).toBe(true);

    // No scope for it — and nothing external in it either way.
    await expect(connect(`${origin}${INTEGRATION_MCP_PATH}/session`)).rejects.toThrow();
  });
});

describe("ManagerMcpBridge.resolve", () => {
  it("reads the token however it is spaced, and only after the Bearer scheme", () => {
    const bridge = new ManagerMcpBridge();
    const { token } = bridge.mint("c1", () => ({}) as never);
    expect(bridge.resolve(`Bearer ${token}`)?.chatId).toBe("c1");
    expect(bridge.resolve(`bearer    ${token}  `)?.chatId).toBe("c1");
    expect(bridge.resolve(token)).toBeUndefined();
    expect(bridge.resolve("Bearer")).toBeUndefined();
  });

  it("answers a pathological run of spaces at once", () => {
    // The unauthenticated input a local process controls; `\s+(.+)$` took
    // polynomial time on exactly this shape.
    const started = performance.now();
    expect(new ManagerMcpBridge().resolve(`Bearer ${" ".repeat(50_000)}x`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
