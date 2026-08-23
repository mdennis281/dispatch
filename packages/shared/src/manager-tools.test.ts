import { describe, it, expect } from "vitest";
import {
  LEGACY_MANAGER_SERVER,
  LEGACY_MANAGER_TOOL_PREFIX,
  MANAGER_CATEGORIES,
  MANAGER_SERVER_NAMES,
  MANAGER_TOOL_CATEGORY,
  MANAGER_TOOL_NAMES,
  isManagerServer,
  isManagerToolName,
  managerServerName,
  managerToolQualifiedName,
  managerToolsInCategory,
  mentionsLegacyManagerServer,
  migrateManagerToolName,
  migrateToolList,
  parseMcpToolName,
} from "./manager-tools.js";

describe("the registry", () => {
  it("partitions every tool into exactly one category", () => {
    const counted = MANAGER_CATEGORIES.flatMap(managerToolsInCategory);
    expect(counted.sort()).toEqual([...MANAGER_TOOL_NAMES].sort());
    expect(new Set(counted).size).toBe(counted.length);
  });

  it("leaves no category empty", () => {
    // An empty category is a server that would be registered advertising nothing
    // — or, with the broker's skip, a name in the registry nothing ever serves.
    for (const category of MANAGER_CATEGORIES) {
      expect(managerToolsInCategory(category).length, category).toBeGreaterThan(0);
    }
  });

  it("namespaces every server so a project's own can never be shadowed", () => {
    // The manager servers are merged LAST and win every collision. Bare category
    // names would mean a project that configured `github` — the conventional name
    // for GitHub's own MCP server — silently lost its tools, with no error.
    for (const name of MANAGER_SERVER_NAMES) expect(name.startsWith("dispatch-")).toBe(true);
    expect(isManagerServer("github")).toBe(false);
    expect(isManagerServer("memory")).toBe(false);
    expect(isManagerServer("dispatch-github")).toBe(true);
  });

  it("does not recognise the retired server as one of its own", () => {
    expect(isManagerServer(LEGACY_MANAGER_SERVER)).toBe(false);
  });

  it("builds a qualified name that round-trips through the parser", () => {
    for (const tool of MANAGER_TOOL_NAMES) {
      const qualified = managerToolQualifiedName(tool);
      const parsed = parseMcpToolName(qualified)!;
      expect(parsed.tool).toBe(tool);
      expect(parsed.server).toBe(managerServerName(MANAGER_TOOL_CATEGORY[tool]));
      expect(isManagerServer(parsed.server)).toBe(true);
    }
  });
});

describe("parseMcpToolName", () => {
  it("returns undefined for a built-in tool", () => {
    expect(parseMcpToolName("Bash")).toBeUndefined();
  });

  it("keeps a server name that itself contains underscores whole", () => {
    expect(parseMcpToolName("mcp__ssh_hass_hub__run-command")).toEqual({
      server: "ssh_hass_hub",
      tool: "run-command",
    });
  });

  it("treats a malformed name as an MCP call rather than a built-in", () => {
    expect(parseMcpToolName("mcp__lonely")).toEqual({ server: "lonely", tool: "lonely" });
  });
});

describe("migrating an allowlist", () => {
  const legacy = (tool: string) => `${LEGACY_MANAGER_TOOL_PREFIX}${tool}`;

  it("rewrites a stale entry to its category server", () => {
    expect(migrateManagerToolName(legacy("terminal"))).toBe("mcp__dispatch-workspace__terminal");
    expect(migrateManagerToolName(legacy("create_pr"))).toBe("mcp__dispatch-github__create_pr");
  });

  it("leaves a current entry alone", () => {
    expect(migrateManagerToolName("mcp__dispatch-workspace__terminal")).toBeNull();
    expect(migrateManagerToolName("Bash")).toBeNull();
  });

  it("is idempotent — the whole point, since it runs on every boot", () => {
    const once = migrateToolList([legacy("terminal"), "Bash"]);
    const twice = migrateToolList(once.tools);
    expect(once.tools).toEqual(["mcp__dispatch-workspace__terminal", "Bash"]);
    expect(twice.tools).toEqual(once.tools);
    expect(twice.changed).toEqual([]);
  });

  it("keeps a scoped entry scoped", () => {
    // Dropping the argument pattern would silently WIDEN a permission the human
    // deliberately narrowed — the one migration bug worse than not migrating.
    expect(migrateManagerToolName(`${legacy("terminal")}(cd *)`)).toBe(
      "mcp__dispatch-workspace__terminal(cd *)",
    );
  });

  it("expands a whole-server wildcard across every category", () => {
    // The eight servers together are what the one server was. Collapsing the
    // wildcard to a single category would REVOKE seven eighths of a granted
    // permission — a silent narrowing nobody would connect to the upgrade.
    const out = migrateToolList([legacy("*")]);
    expect(out.tools).toEqual(MANAGER_SERVER_NAMES.map((n) => `mcp__${n}__*`));
    const bare = migrateToolList([legacy("")]);
    expect(bare.tools).toEqual(MANAGER_SERVER_NAMES.map((n) => `mcp__${n}__`));
  });

  it("leaves a legacy entry naming a tool that no longer exists untouched", () => {
    // Guessing at a dead name would invent a permission for a tool nobody has.
    const out = migrateToolList([legacy("teleport")]);
    expect(out.tools).toEqual([legacy("teleport")]);
    expect(out.unknown).toEqual([legacy("teleport")]);
    expect(out.changed).toEqual([]);
  });

  it("reports what it changed, for the log line that records it", () => {
    const out = migrateToolList([legacy("remember"), legacy("worktree")]);
    expect(out.changed).toEqual([
      { from: legacy("remember"), to: "mcp__dispatch-memory__remember" },
      { from: legacy("worktree"), to: "mcp__dispatch-workspace__worktree" },
    ]);
  });

  it("does not duplicate an entry that is already present under both names", () => {
    // A half-migrated list (someone renamed one entry by hand) must not end up
    // granting the same tool twice.
    const out = migrateToolList([legacy("terminal"), "mcp__dispatch-workspace__terminal"]);
    expect(out.tools).toEqual(["mcp__dispatch-workspace__terminal"]);
  });

  it("preserves order and non-manager entries verbatim", () => {
    const out = migrateToolList(["Read", legacy("recall"), "mcp__playwright__browser_click"]);
    expect(out.tools).toEqual([
      "Read",
      "mcp__dispatch-memory__recall",
      "mcp__playwright__browser_click",
    ]);
  });
});

describe("detecting stale config we do not own", () => {
  it("spots the retired prefix and nothing else", () => {
    expect(mentionsLegacyManagerServer(`{"allow":["${LEGACY_MANAGER_TOOL_PREFIX}terminal"]}`)).toBe(
      true,
    );
    expect(mentionsLegacyManagerServer('{"allow":["mcp__dispatch-workspace__terminal"]}')).toBe(
      false,
    );
  });
});

describe("isManagerToolName", () => {
  it("does not claim inherited Object properties as tools", () => {
    // A plain `name in MANAGER_TOOL_CATEGORY` would answer true for `toString`,
    // which would let a legacy `mcp__manager__toString` migrate to nonsense.
    expect(isManagerToolName("toString")).toBe(false);
    expect(isManagerToolName("constructor")).toBe(false);
    expect(isManagerToolName("terminal")).toBe(true);
  });
});
