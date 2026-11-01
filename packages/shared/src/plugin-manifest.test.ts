import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PluginManifestSchema,
  PluginMcpServersFileSchema,
  PluginProcessSchema,
  PluginProcessesFileSchema,
  manifestPathDir,
  pluginRangeAccepts,
  pluginSecretAllowed,
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

  it("accepts secrets:write only alongside secrets", () => {
    const write = (capabilities: string[]) => PluginManifestSchema.safeParse({ ...base, secrets: ["K"], capabilities });
    expect(write(["secrets", "secrets:write"]).success).toBe(true);
    const alone = write(["secrets:write"]);
    expect(alone.success).toBe(false);
    expect(alone.error?.issues[0]?.message).toMatch(/declare both/);
  });

  it("accepts a trailing-* prefix under secrets:, and nothing else with a *", () => {
    const secrets = (list: string[]) => PluginManifestSchema.safeParse({ ...base, secrets: list }).success;
    expect(secrets(["REMOTE_HOST_KEY_*", "PLAIN"])).toBe(true);
    expect(secrets(["K*"])).toBe(true);
    // A bare `*` would be every secret in the store.
    expect(secrets(["*"])).toBe(false);
    expect(secrets(["A*B"])).toBe(false);
    expect(secrets(["A**"])).toBe(false);
    expect(secrets(["MY-KEY_*"])).toBe(false);
    // Exact entries keep the old, lenient rule: a manifest that loaded before still loads.
    expect(secrets(["lower-case-name"])).toBe(true);
  });
});

describe("pluginSecretAllowed", () => {
  it("matches exact entries exactly and prefix entries by prefix", () => {
    const declared = ["API_KEY", "REMOTE_HOST_KEY_*"];
    expect(pluginSecretAllowed(declared, "API_KEY")).toBe(true);
    expect(pluginSecretAllowed(declared, "API_KEY_2")).toBe(false);
    expect(pluginSecretAllowed(declared, "REMOTE_HOST_KEY_cvx_mac")).toBe(true);
    expect(pluginSecretAllowed(declared, "REMOTE_HOST_KEY_")).toBe(true);
    expect(pluginSecretAllowed(declared, "REMOTE_HOST_KE")).toBe(false);
    expect(pluginSecretAllowed(declared, "GITHUB_TOKEN")).toBe(false);
    expect(pluginSecretAllowed(undefined, "API_KEY")).toBe(false);
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
