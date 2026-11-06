/**
 * `ctx.tools` (E8): a plugin's agent tools, served as `dispatch-plugin-<id>`
 * through the same channel as Dispatch's own servers. Driven through a real MCP
 * client, in-process, so what is pinned is what a runtime sees.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PluginTool, PluginToolCall } from "@dispatch/shared";
import { PluginToolRegistry } from "./tools.js";
import { createManagerMcpServers, type ManagerMcpContext } from "../services/mcp/manager-mcp.js";
import { EventBus } from "../bus.js";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

const echo = (over: Partial<PluginTool> = {}): PluginTool => ({
  name: "machine_status",
  description: "Report the machine's status.",
  inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
  handler: (args) => `up: ${String(args.host)}`,
  ...over,
});

describe("PluginToolRegistry — what a session is served", () => {
  it("serves a plugin's tools as dispatch-plugin-<id>, JSON Schema as written", async () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo());
    const servers = reg.bind({ chatId: "c1" }).servers();
    expect(Object.keys(servers)).toEqual(["dispatch-plugin-remote-host"]);

    const client = await connect(servers["dispatch-plugin-remote-host"]!);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      {
        name: "machine_status",
        description: "Report the machine's status.",
        inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
      },
    ]);
    const r = (await client.callTool({ name: "machine_status", arguments: { host: "cvx-mac" } })) as CallToolResult;
    expect(r).toEqual({ content: [{ type: "text", text: "up: cvx-mac" }] });
  });

  it("tells the handler which chat called, its project and cwd, with a live signal", async () => {
    const reg = new PluginToolRegistry();
    let seen: PluginToolCall | undefined;
    reg.register("remote-host", "Remote host", echo({ handler: (_a, call) => ((seen = call), "ok") }));
    const server = reg.bind({ chatId: "c7", projectId: "p1", cwd: "C:/w/x" }).server("dispatch-plugin-remote-host")!;
    await (await connect(server)).callTool({ name: "machine_status", arguments: { host: "h" } });
    expect(seen).toMatchObject({ chatId: "c7", projectId: "p1", cwd: "C:/w/x" });
    expect(seen?.signal.aborted).toBe(false);
  });

  it("aborts the handler's signal when the session ends", async () => {
    const reg = new PluginToolRegistry();
    const session = new AbortController();
    let aborted = false;
    reg.register(
      "remote-host",
      "Remote host",
      echo({
        handler: (_a, call) =>
          new Promise((resolve) => {
            call.signal.addEventListener("abort", () => {
              aborted = true;
              resolve("stopped");
            });
          }),
      }),
    );
    const server = reg.bind({ chatId: "c1", signal: session.signal }).server("dispatch-plugin-remote-host")!;
    const pending = (await connect(server)).callTool({ name: "machine_status", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));
    session.abort();
    expect(await pending).toEqual({ content: [{ type: "text", text: "stopped" }] });
    expect(aborted).toBe(true);
  });

  it("omits a plugin with no tool the session may call, rather than serving it empty", () => {
    const reg = new PluginToolRegistry();
    expect(reg.bind({ chatId: "c1" }).servers()).toEqual({});
    reg.register("remote-host", "Remote host", echo());
    const denied = reg.bind({
      chatId: "c1",
      toolPolicy: { disallowedTools: ["mcp__dispatch-plugin-remote-host__machine_status"] },
    });
    expect(denied.servers()).toEqual({});
    expect(denied.server("dispatch-plugin-remote-host")).toBeUndefined();
  });

  it("lists only what the mode allows, and refuses a denied name even when called blind", async () => {
    const reg = new PluginToolRegistry();
    let ran = 0;
    reg.register("remote-host", "Remote host", echo());
    reg.register("remote-host", "Remote host", echo({ name: "remote_fetch", handler: () => (ran++, "fetched") }));
    const server = reg
      .bind({ chatId: "c1", toolPolicy: { disallowedTools: ["mcp__dispatch-plugin-remote-host__remote_fetch"] } })
      .server("dispatch-plugin-remote-host")!;
    const client = await connect(server);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["machine_status"]);
    // A runtime with a cached list, or a guess, can still send the name.
    const r = (await client.callTool({ name: "remote_fetch", arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(ran).toBe(0);
  });

  it("runs the CURRENT registration: a deactivated plugin answers 'no longer available', an update runs its new code", async () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo({ handler: () => "v1" }));
    // Built once, as a Claude session holds its in-process server for its life.
    const client = await connect(reg.bind({ chatId: "c1" }).server("dispatch-plugin-remote-host")!);
    expect(await client.callTool({ name: "machine_status", arguments: {} })).toEqual({
      content: [{ type: "text", text: "v1" }],
    });

    reg.unregisterAll("remote-host");
    const gone = (await client.callTool({ name: "machine_status", arguments: {} })) as CallToolResult;
    expect(gone.isError).toBe(true);
    expect((gone.content[0] as { text: string }).text).toMatch(/no longer available/);

    reg.register("remote-host", "Remote host", echo({ handler: () => "v2" }));
    expect(await client.callTool({ name: "machine_status", arguments: {} })).toEqual({
      content: [{ type: "text", text: "v2" }],
    });
  });

  it("an unregister from an earlier activation does not remove the tool a later one registered", () => {
    const reg = new PluginToolRegistry();
    const stale = reg.register("remote-host", "Remote host", echo());
    reg.unregisterAll("remote-host");
    reg.register("remote-host", "Remote host", echo());
    stale();
    expect(reg.list("remote-host")).toEqual(["machine_status"]);
  });

  it("turns a throw into an error RESULT naming the plugin, not a protocol error", async () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo({ handler: () => Promise.reject(new Error("machine offline")) }));
    const client = await connect(reg.bind({ chatId: "c1" }).server("dispatch-plugin-remote-host")!);
    expect(await client.callTool({ name: "machine_status", arguments: {} })).toEqual({
      content: [{ type: "text", text: "Remote host: machine offline" }],
      isError: true,
    });
  });

  it("passes images through, and refuses a malformed or oversized one", async () => {
    const reg = new PluginToolRegistry();
    let result: unknown = { content: [{ type: "text", text: "shot" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
    reg.register("remote-host", "Remote host", echo({ handler: () => result as never }));
    const client = await connect(reg.bind({ chatId: "c1" }).server("dispatch-plugin-remote-host")!);
    const call = () => client.callTool({ name: "machine_status", arguments: {} }) as Promise<CallToolResult>;
    expect(await call()).toEqual(result);

    for (const bad of [
      { type: "image", data: "data:image/png;base64,AAA", mimeType: "image/png" },
      { type: "image", data: "AAA", mimeType: "image/tiff" },
      { type: "image", data: "A".repeat(5_000_001), mimeType: "image/png" },
      { type: "resource", uri: "file:///etc/passwd" },
    ]) {
      result = { content: [bad] };
      expect((await call()).isError, JSON.stringify(bad).slice(0, 60)).toBe(true);
    }
  });

  it("cuts over-long text and says so, rather than failing a call that answered", async () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo({ handler: () => "x".repeat(250_000) }));
    const client = await connect(reg.bind({ chatId: "c1" }).server("dispatch-plugin-remote-host")!);
    const r = (await client.callTool({ name: "machine_status", arguments: {} })) as CallToolResult;
    const text = (r.content[0] as { text: string }).text;
    expect(r.isError).toBeUndefined();
    expect(text.length).toBeLessThan(201_000);
    expect(text).toMatch(/cut: the result was 250000 characters/);
  });

  it("does not resolve a server name outside its prefix", () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo());
    const b = reg.bind({ chatId: "c1" });
    expect(b.server("remote-host")).toBeUndefined();
    expect(b.server("dispatch-chat")).toBeUndefined();
  });
});

describe("PluginToolRegistry.register — refused where the author sees it", () => {
  const reg = new PluginToolRegistry();
  it.each<[string, Partial<PluginTool>, RegExp]>([
    ["a camelCase name", { name: "machineStatus" }, /lower snake case/],
    ["a name with a dash", { name: "machine-status" }, /lower snake case/],
    ["no description", { description: "  " }, /needs a description/],
    ["no handler", { handler: undefined as never }, /needs a handler/],
    ["a non-object schema", { inputSchema: { type: "string" } as never }, /type "object"/],
  ])("%s", (_label, over, msg) => {
    expect(() => reg.register("remote-host", "Remote host", echo(over))).toThrow(msg);
  });

  it("an agent-facing name over 64 characters, naming the limit", () => {
    // mcp__dispatch-plugin-<40-char id>__<tool> is past 64 at once.
    const id = "a".repeat(40);
    expect(() => reg.register(id, "Long", echo({ name: "status" }))).toThrow(/at most 64 \(Codex refuses longer\)/);
  });

  it("the same name twice, and more than 32 tools", () => {
    const r = new PluginToolRegistry();
    r.register("p", "P", echo({ name: "t0" }));
    expect(() => r.register("p", "P", echo({ name: "t0" }))).toThrow(/already registered/);
    for (let i = 1; i < 32; i++) r.register("p", "P", echo({ name: `t${i}` }));
    expect(() => r.register("p", "P", echo({ name: "t32" }))).toThrow(/at most 32/);
  });
});

describe("createManagerMcpServers", () => {
  it("serves plugin servers beside Dispatch's own, and none without a binding", () => {
    const reg = new PluginToolRegistry();
    reg.register("remote-host", "Remote host", echo());
    const base = { chatId: "c1", bus: new EventBus(), broker: {} as ManagerMcpContext["broker"] };
    const withPlugins = createManagerMcpServers({ ...base, pluginTools: reg.bind({ chatId: "c1" }) });
    expect(Object.keys(withPlugins)).toContain("dispatch-plugin-remote-host");
    expect(Object.keys(createManagerMcpServers(base))).not.toContain("dispatch-plugin-remote-host");
  });
});
