import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PluginManifestSchema,
  PluginMcpServersFileSchema,
  PluginProcessSchema,
  PluginProcessesFileSchema,
  manifestPathDir,
  pluginRangeAccepts,
} from "./plugin-manifest.js";

const base = { id: "voice", name: "Voice", version: "0.1.0", dispatch: ">=1" };

describe("PluginManifestSchema", () => {
  it("accepts the documented manifest", () => {
    const r = PluginManifestSchema.safeParse({
      ...base,
      server: "./server/index.js",
      client: "./client/index.js",
      settings: "./settings.schema.json",
      secrets: ["WHISPER_URL"],
      capabilities: ["events", "routes", "chats:write"],
      contributes: { modes: "./modes", mcpServers: "./mcp.yaml" },
    });
    expect(r.success).toBe(true);
  });

  it("refuses the reserved dispatch- prefix and malformed ids", () => {
    expect(PluginManifestSchema.safeParse({ ...base, id: "dispatch-voice" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, id: "Voice" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, id: "-voice" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, id: "a".repeat(41) }).success).toBe(false);
  });

  it("refuses paths that leave the plugin directory", () => {
    expect(PluginManifestSchema.safeParse({ ...base, server: "../other/index.js" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, server: "/abs/index.js" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, server: "C:\\abs\\index.js" }).success).toBe(false);
  });

  it("refuses a client at the plugin root or sharing a directory with the server", () => {
    // The client directory is served without authentication, whole.
    expect(PluginManifestSchema.safeParse({ ...base, client: "./index.js" }).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, client: "./dist/client.js", server: "./dist/server.js" }).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, client: "./client/index.js", settings: "./client/schema.json" }).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, client: "./client/index.js", contributes: { skills: "./client" } })
        .success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, client: "./client/index.js", server: "./server/index.js" }).success,
    ).toBe(true);
  });

  it("requires a dispatch range", () => {
    const { dispatch: _d, ...noRange } = base;
    expect(PluginManifestSchema.safeParse(noRange).success).toBe(false);
  });
});

describe("contribution files", () => {
  it("reads mcp.yaml as a bare list or wrapped in mcpServers, in the project server shape", () => {
    const one = [{ name: "echo", transport: { type: "stdio", command: "node", args: ["s.mjs"] } }];
    expect(PluginMcpServersFileSchema.parse(one)).toHaveLength(1);
    expect(PluginMcpServersFileSchema.parse({ mcpServers: one })).toHaveLength(1);
    expect(PluginMcpServersFileSchema.parse({})).toEqual([]);
    expect(PluginMcpServersFileSchema.safeParse([{ name: "x" }]).success).toBe(false);
  });

  it("reads processes.yaml either way and insists a singleton declares a port", () => {
    const p = { id: "hello-http", command: "node", args: ["s.mjs"], ports: [47311], singleton: true, autostart: true };
    expect(PluginProcessesFileSchema.parse([p])).toHaveLength(1);
    expect(PluginProcessesFileSchema.parse({ processes: [p] })).toHaveLength(1);
    // Without a port the second instance has nothing to find the first by.
    expect(PluginProcessSchema.safeParse({ id: "a", command: "node", singleton: true }).success).toBe(false);
    expect(PluginProcessSchema.safeParse({ id: "Bad Id", command: "node" }).success).toBe(false);
    expect(PluginProcessSchema.safeParse({ id: "ok", command: "node" }).success).toBe(true);
  });
});

describe("manifestPathDir", () => {
  it("normalises ./ and backslashes", () => {
    expect(manifestPathDir("./client/index.js")).toBe("client");
    expect(manifestPathDir("client\\sub\\index.js")).toBe("client/sub");
    expect(manifestPathDir("index.js")).toBe("");
  });
});

describe("pluginRangeAccepts", () => {
  it("reads the documented forms against the host major", () => {
    const v = PLUGIN_API_VERSION;
    expect(pluginRangeAccepts(">=1", v)).toBe(true);
    expect(pluginRangeAccepts("^1", v)).toBe(v === 1);
    expect(pluginRangeAccepts("1", v)).toBe(v === 1);
    expect(pluginRangeAccepts("1.x", v)).toBe(v === 1);
    expect(pluginRangeAccepts(">=1 <3", v)).toBe(v >= 1 && v < 3);
    expect(pluginRangeAccepts(">=2", 1)).toBe(false);
    expect(pluginRangeAccepts("<1", 1)).toBe(false);
  });

  it("admits nothing it cannot parse", () => {
    expect(pluginRangeAccepts("", 1)).toBe(false);
    expect(pluginRangeAccepts("latest", 1)).toBe(false);
    expect(pluginRangeAccepts(">=1 || 3", 1)).toBe(false);
  });
});
