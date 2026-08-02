/**
 * Core MCP-config tests. Every case runs against a REAL temp directory rather
 * than a mocked fs, because the behaviour most worth protecting here is the
 * on-disk result: that a hand-authored `project.yaml` survives an edit with its
 * comments intact, and that we never write a manifest the server can't load.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  addServer,
  getServer,
  importServers,
  listServers,
  mcpJsonEntryToTransport,
  removeServer,
} from "./mcp.js";
import { CmError, resolveProjectPaths } from "./manifest.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-mcp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a `.claude-manager/project.yaml` with the given body. */
async function seedManifest(body: string, root = dir): Promise<string> {
  const configDir = join(root, ".claude-manager");
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, "project.yaml");
  await writeFile(path, body, "utf8");
  return path;
}

const manifestPath = (root = dir): string => join(root, ".claude-manager", "project.yaml");

describe("addServer", () => {
  it("scaffolds project.yaml when the project has no config yet", async () => {
    const result = await addServer(dir, {
      name: "ripgrep",
      transport: { type: "stdio", command: "npx", args: ["-y", "mcp-ripgrep"] },
    });

    expect(result.outcome).toBe("added");
    const doc = parseDocument(await readFile(manifestPath(), "utf8")).toJS();
    expect(doc.name).toBe(dir.split(/[\\/]/).pop());
    expect(doc.mcpServers).toEqual([
      { name: "ripgrep", transport: { type: "stdio", command: "npx", args: ["-y", "mcp-ripgrep"] } },
    ]);
  });

  it("appends to an existing manifest without disturbing its comments", async () => {
    await seedManifest(
      [
        "# The Hivebreak project config.",
        "name: hivebreak",
        "",
        "# Servers the whole team relies on.",
        "mcpServers:",
        "  # Reads the design system.",
        "  - name: figma",
        "    transport:",
        "      type: http",
        "      url: https://figma.example/mcp",
        "",
        "worktreeRoot: ../trees",
      ].join("\n"),
    );

    await addServer(dir, {
      name: "linear",
      transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    });

    const text = await readFile(manifestPath(), "utf8");
    expect(text).toContain("# The Hivebreak project config.");
    expect(text).toContain("# Servers the whole team relies on.");
    expect(text).toContain("# Reads the design system.");
    expect(text).toContain("worktreeRoot: ../trees");

    const js = parseDocument(text).toJS();
    expect(js.mcpServers.map((s: { name: string }) => s.name)).toEqual(["figma", "linear"]);
  });

  it("refuses to clobber an existing name unless forced", async () => {
    await addServer(dir, { name: "linear", transport: { type: "http", url: "https://a.example/mcp" } });

    await expect(
      addServer(dir, { name: "linear", transport: { type: "http", url: "https://b.example/mcp" } }),
    ).rejects.toBeInstanceOf(CmError);

    // The rejected add must not have written anything.
    expect((await getServer(dir, "linear"))?.transport).toMatchObject({ url: "https://a.example/mcp" });

    const forced = await addServer(
      dir,
      { name: "linear", transport: { type: "http", url: "https://b.example/mcp" } },
      { force: true },
    );
    expect(forced.outcome).toBe("replaced");
    expect((await getServer(dir, "linear"))?.transport).toMatchObject({ url: "https://b.example/mcp" });
    // Replacing must not duplicate the entry.
    expect((await listServers(dir)).servers).toHaveLength(1);
  });

  it("rejects a server name that can't be addressed as mcp__<name>__<tool>", async () => {
    await expect(
      addServer(dir, { name: "my server!", transport: { type: "stdio", command: "npx" } }),
    ).rejects.toThrow(/Invalid server name/);
  });

  it("preserves ${VAR} placeholders verbatim rather than expanding at write time", async () => {
    await addServer(dir, {
      name: "linear",
      transport: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
      },
    });
    const text = await readFile(manifestPath(), "utf8");
    expect(text).toContain("${LINEAR_API_KEY}");
  });
});

describe("removeServer", () => {
  it("removes one server and reports it", async () => {
    await addServer(dir, { name: "a", transport: { type: "stdio", command: "a" } });
    await addServer(dir, { name: "b", transport: { type: "stdio", command: "b" } });

    expect(await removeServer(dir, "a")).toMatchObject({ removed: true });
    expect((await listServers(dir)).servers.map((s) => s.name)).toEqual(["b"]);
  });

  it("drops the mcpServers key entirely once the last server goes", async () => {
    await addServer(dir, { name: "only", transport: { type: "stdio", command: "x" } });
    await removeServer(dir, "only");
    const text = await readFile(manifestPath(), "utf8");
    expect(text).not.toContain("mcpServers");
  });

  it("reports a miss instead of throwing", async () => {
    await addServer(dir, { name: "a", transport: { type: "stdio", command: "a" } });
    expect(await removeServer(dir, "nope")).toMatchObject({ removed: false });
  });

  it("is a no-op when the project has no config at all", async () => {
    expect(await removeServer(dir, "anything")).toMatchObject({ removed: false });
  });
});

describe("listServers", () => {
  it("returns an empty list for a project with no config", async () => {
    const { servers } = await listServers(dir);
    expect(servers).toEqual([]);
  });

  it("surfaces a malformed manifest as a CmError naming the file", async () => {
    await seedManifest("name: ok\nmcpServers: not-a-list\n");
    await expect(listServers(dir)).rejects.toThrow(/not a valid project manifest/);
  });

  it("rejects unparseable YAML", async () => {
    await seedManifest("name: [unclosed\n");
    await expect(listServers(dir)).rejects.toThrow(/not valid YAML/);
  });
});

describe("resolveProjectPaths", () => {
  it("walks up to an existing .claude-manager from a nested directory", async () => {
    await seedManifest("name: root\n");
    const nested = join(dir, "packages", "web", "src");
    await mkdir(nested, { recursive: true });
    expect(resolveProjectPaths(nested).manifestPath).toBe(manifestPath());
  });

  it("falls back to the nearest git root when no config exists yet", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const nested = join(dir, "packages", "web");
    await mkdir(nested, { recursive: true });
    expect(resolveProjectPaths(nested).root).toBe(dir);
  });
});

describe("mcpJsonEntryToTransport", () => {
  it("infers stdio from a bare command", () => {
    expect(mcpJsonEntryToTransport({ command: "npx", args: ["-y", "pkg"] })).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
    });
  });

  it("infers http from a bare url", () => {
    expect(mcpJsonEntryToTransport({ url: "https://x.example/mcp" })).toEqual({
      type: "http",
      url: "https://x.example/mcp",
    });
  });

  it("honours an explicit sse type", () => {
    expect(mcpJsonEntryToTransport({ type: "sse", url: "https://x.example/sse" })).toMatchObject({
      type: "sse",
    });
  });

  it("rejects an entry with neither command nor url", () => {
    expect(() => mcpJsonEntryToTransport({ foo: 1 })).toThrow(/unrecognized transport/);
  });
});

describe("importServers", () => {
  it("imports a .mcp.json-shaped object, skipping names already configured", async () => {
    await addServer(dir, { name: "existing", transport: { type: "stdio", command: "old" } });

    const { entries } = await importServers(dir, {
      mcpServers: {
        existing: { command: "new" },
        ripgrep: { command: "npx", args: ["-y", "mcp-ripgrep"] },
        sentry: { type: "sse", url: "https://mcp.sentry.dev/sse" },
        broken: { nonsense: true },
      },
    });

    expect(entries).toEqual([
      { name: "existing", status: "skipped", reason: "already configured" },
      { name: "ripgrep", status: "added" },
      { name: "sentry", status: "added" },
      { name: "broken", status: "invalid", reason: expect.stringContaining("unrecognized") },
    ]);

    const names = (await listServers(dir)).servers.map((s) => s.name);
    expect(names).toEqual(["existing", "ripgrep", "sentry"]);
    // The skipped entry must keep its ORIGINAL definition.
    expect((await getServer(dir, "existing"))?.transport).toMatchObject({ command: "old" });
  });

  it("overwrites existing names with --force", async () => {
    await addServer(dir, { name: "existing", transport: { type: "stdio", command: "old" } });
    const { entries } = await importServers(
      dir,
      { mcpServers: { existing: { command: "new" } } },
      { force: true },
    );
    expect(entries).toEqual([{ name: "existing", status: "replaced" }]);
    expect((await getServer(dir, "existing"))?.transport).toMatchObject({ command: "new" });
  });

  it("rejects a file with no mcpServers object", async () => {
    await expect(importServers(dir, {} as never)).rejects.toThrow(/No "mcpServers" object/);
  });

  it("writes nothing when every entry is skipped or invalid", async () => {
    await seedManifest("name: p\n");
    const before = await readFile(manifestPath(), "utf8");
    await importServers(dir, { mcpServers: { bad: { nope: 1 } } });
    expect(await readFile(manifestPath(), "utf8")).toBe(before);
  });
});
