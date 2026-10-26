import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventBus } from "../../bus.js";
import { createManagerMcpServers, type ManagerMcpBroker } from "../../services/mcp/manager-mcp.js";
import { claudeSdkMcpServers } from "./manager-servers.js";

describe("claudeSdkMcpServers", () => {
  const servers = () =>
    createManagerMcpServers({
      chatId: "c1",
      bus: new EventBus(),
      broker: { has: () => false, getStatus: () => undefined } as unknown as ManagerMcpBroker,
    });

  it("wraps each neutral server in the shape the Agent SDK mounts in-process", () => {
    const neutral = servers();
    const wrapped = claudeSdkMcpServers(neutral);
    expect(Object.keys(wrapped)).toEqual(Object.keys(neutral));
    for (const [name, config] of Object.entries(wrapped)) {
      // `name` must equal the key: it is what the CLI prefixes the tools with,
      // `mcp__<name>__<tool>`, and every Dispatch guard matches on that.
      expect(config).toEqual({ type: "sdk", name, instance: neutral[name] });
    }
  });

  it("hands over a live server the Agent SDK can connect its own transport to", async () => {
    // The Agent SDK bundles its own MCP copy and only ever calls
    // `instance.connect(transport)` on ours — any working transport proves it.
    const { instance } = claudeSdkMcpServers(servers())["dispatch-session"]!;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("wait");
    await client.close();
  });
});
