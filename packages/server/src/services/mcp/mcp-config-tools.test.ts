/**
 * Tests for the `mcp_list` / `mcp_add` / `mcp_remove` manager tools and the
 * editor that binds them to a project.
 *
 * The editor half runs against a REAL temp repo rather than a stub, because the
 * point of routing these tools through `@dispatch/cli/core` is that an agent's edit and
 * a `dispatch mcp add` produce the same file — a stubbed binding would test nothing
 * about that.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listServers } from "@dispatch/cli/core";
import { EventBus } from "../../bus.js";
import {
  createManagerTools,
  createManagerMcpServer,
  managerToolDescriptors,
  type ManagerMcpBroker,
  type ManagerMcpConfig,
} from "./manager-mcp.js";
import { createMcpConfigEditor } from "./mcp-config-editor.js";

const broker: ManagerMcpBroker = {
  has: () => false,
  getStatus: () => undefined,
  getContextUsage: async () => null,
  compact: () => {},
  markPrWatched: () => {},
};

function ctx(mcpConfig?: ManagerMcpConfig) {
  return { chatId: "c1", bus: new EventBus(), broker, mcpConfig };
}

function text(res: CallToolResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

/**
 * Invoke a tool handler with a PARTIAL argument object. The SDK derives the
 * handler's parameter type from the full zod shape (every declared key present,
 * optionals as `T | undefined`), but the agent really sends only the keys it
 * chose — which is exactly what each test wants to exercise.
 */
function call(
  handler: unknown,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (handler as (a: never, extra: never) => Promise<CallToolResult>)(
    args as never,
    {} as never,
  );
}

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cm-mcp-tools-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ gating */

describe("MCP-config tool gating", () => {
  it("omits the mcp_* tools when no editor is bound", () => {
    const server = createManagerMcpServer(ctx()) as unknown as {
      instance: { _registeredTools?: Record<string, unknown> };
    };
    const names = Object.keys(server.instance._registeredTools ?? {});
    expect(names).not.toContain("mcp_add");
    expect(names).not.toContain("mcp_list");
    expect(names).not.toContain("mcp_remove");
  });

  it("registers them once an editor is bound", () => {
    const server = createManagerMcpServer(
      ctx(createMcpConfigEditor(repo)),
    ) as unknown as { instance: { _registeredTools?: Record<string, unknown> } };
    const names = Object.keys(server.instance._registeredTools ?? {});
    expect(names).toEqual(expect.arrayContaining(["mcp_list", "mcp_add", "mcp_remove"]));
  });

  it("marks them unavailable in the catalog without the binding", () => {
    const without = managerToolDescriptors({});
    expect(without.find((d) => d.name === "mcp_add")?.available).toBe(false);
    const with_ = managerToolDescriptors({ mcpConfig: true });
    expect(with_.find((d) => d.name === "mcp_add")?.available).toBe(true);
  });

  it("reports an error result instead of throwing when unbound", async () => {
    const { mcpAdd } = createManagerTools(ctx());
    const res = await call(mcpAdd.handler, { name: "x", command: "npx" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not available/i);
  });
});

/* -------------------------------------------------------------------- add */

describe("mcp_add", () => {
  it("writes a stdio server the CLI core can read back", async () => {
    const { mcpAdd } = createManagerTools(ctx(createMcpConfigEditor(repo)));
    const res = await call(mcpAdd.handler, {
      name: "ripgrep",
      command: "npx",
      args: ["-y", "mcp-ripgrep"],
    });

    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("mcp__ripgrep__");
    const { servers } = await listServers(repo);
    expect(servers).toEqual([
      {
        name: "ripgrep",
        transport: { type: "stdio", command: "npx", args: ["-y", "mcp-ripgrep"] },
      },
    ]);
  });

  it("infers http from a url and keeps ${VAR} placeholders literal", async () => {
    const { mcpAdd } = createManagerTools(ctx(createMcpConfigEditor(repo)));
    await call(mcpAdd.handler, {
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
    });

    const yaml = await readFile(join(repo, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("type: http");
    // The secret must reach disk as a placeholder, never expanded at write time.
    expect(yaml).toContain("${LINEAR_API_KEY}");
  });

  it("refuses a duplicate name unless force is set", async () => {
    const { mcpAdd } = createManagerTools(ctx(createMcpConfigEditor(repo)));
    await call(mcpAdd.handler, { name: "a", command: "one" });

    const dup = await call(mcpAdd.handler, { name: "a", command: "two" });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toMatch(/already exists/);
    expect((await listServers(repo)).servers[0]?.transport).toMatchObject({ command: "one" });

    const forced = await call(mcpAdd.handler, { name: "a", command: "two", force: true });
    expect(forced.isError).toBeFalsy();
    expect((await listServers(repo)).servers[0]?.transport).toMatchObject({ command: "two" });
  });

  it("explains what's missing instead of writing a broken server", async () => {
    const { mcpAdd } = createManagerTools(ctx(createMcpConfigEditor(repo)));

    const noCommand = await call(mcpAdd.handler, { name: "x" });
    expect(noCommand.isError).toBe(true);
    expect(text(noCommand)).toMatch(/needs a `command`/);

    const noUrl = await call(mcpAdd.handler, { name: "y", transport: "http" });
    expect(noUrl.isError).toBe(true);
    expect(text(noUrl)).toMatch(/needs a `url`/);

    expect((await listServers(repo)).servers).toEqual([]);
  });

  it("rejects a name that can't be addressed as mcp__<name>__<tool>", async () => {
    const { mcpAdd } = createManagerTools(ctx(createMcpConfigEditor(repo)));
    const res = await call(mcpAdd.handler, { name: "bad name", command: "npx" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Invalid server name/);
  });
});

/* ------------------------------------------------------------ list / remove */

describe("mcp_list and mcp_remove", () => {
  it("lists nothing helpfully, then lists what was added", async () => {
    const tools = createManagerTools(ctx(createMcpConfigEditor(repo)));

    expect(text(await call(tools.mcpList.handler, {}))).toMatch(/no MCP servers configured/i);

    await call(tools.mcpAdd.handler, { name: "rg", command: "npx", args: ["-y", "rg"] });
    await call(tools.mcpAdd.handler, { name: "linear", url: "https://mcp.linear.app/mcp" });

    const listed = text(await call(tools.mcpList.handler, {}));
    expect(listed).toContain("rg — stdio: npx -y rg");
    expect(listed).toContain("linear — http: https://mcp.linear.app/mcp");
  });

  it("removes a server and reports a miss as an error result", async () => {
    const tools = createManagerTools(ctx(createMcpConfigEditor(repo)));
    await call(tools.mcpAdd.handler, { name: "rg", command: "npx" });

    const ok = await call(tools.mcpRemove.handler, { name: "rg" });
    expect(ok.isError).toBeFalsy();
    expect((await listServers(repo)).servers).toEqual([]);

    const miss = await call(tools.mcpRemove.handler, { name: "rg" });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toMatch(/No MCP server named/);
  });
});

/* ---------------------------------------------------------------- editor */

describe("createMcpConfigEditor", () => {
  it("resolves the manifest from a nested path within the repo", async () => {
    await createMcpConfigEditor(repo).add(
      { name: "a", transport: { type: "stdio", command: "x" } },
      {},
    );
    const nested = join(repo, "packages", "web");
    // A session running in a subdirectory must still see the ONE project config.
    expect(await createMcpConfigEditor(nested).list()).toHaveLength(1);
  });

  it("reports the manifest path it wrote", async () => {
    const result = await createMcpConfigEditor(repo).add(
      { name: "a", transport: { type: "stdio", command: "x" } },
      {},
    );
    expect(result.outcome).toBe("added");
    expect(result.manifestPath).toBe(join(repo, ".dispatch", "project.yaml"));
  });
});
