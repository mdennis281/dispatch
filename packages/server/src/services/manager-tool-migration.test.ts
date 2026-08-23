import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_MANAGER_TOOL_PREFIX, type AgentConfig } from "@dispatch/shared";
import {
  findForeignStaleToolNames,
  migrateManagerToolNames,
  migrateStoredAgentTools,
  type ManagerToolMigrationStore,
} from "./manager-tool-migration.js";

const legacy = (tool: string) => `${LEGACY_MANAGER_TOOL_PREFIX}${tool}`;

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "Agent",
    instructions: "",
    permissionMode: "default",
    scope: "global",
    ...over,
  } as AgentConfig;
}

function fakeStore(agents: AgentConfig[]): ManagerToolMigrationStore & { saved: AgentConfig[] } {
  const saved: AgentConfig[] = [];
  return {
    saved,
    listAgents: async () => agents,
    saveAgent: async (a) => {
      saved.push(a);
      return a;
    },
  };
}

describe("migrating stored agent tool lists", () => {
  it("rewrites both allow and deny lists", () => {
    const store = fakeStore([
      agent({ allowedTools: [legacy("terminal"), "Read"], disallowedTools: [legacy("approve_pr")] }),
    ]);
    return migrateStoredAgentTools(store).then((changed) => {
      expect(store.saved[0]!.allowedTools).toEqual(["mcp__dispatch-workspace__terminal", "Read"]);
      expect(store.saved[0]!.disallowedTools).toEqual(["mcp__dispatch-github__approve_pr"]);
      expect(changed).toHaveLength(2);
      expect(changed[0]).toContain("a1: ");
    });
  });

  it("writes nothing when a list is already current", async () => {
    // This runs on EVERY boot. A write per boot would churn the config dir's
    // mtimes and set the file watcher off for no reason.
    const store = fakeStore([agent({ allowedTools: ["mcp__dispatch-workspace__terminal"] })]);
    const changed = await migrateStoredAgentTools(store);
    expect(store.saved).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("leaves an agent with no tool lists alone", async () => {
    const store = fakeStore([agent()]);
    expect(await migrateStoredAgentTools(store)).toEqual([]);
    expect(store.saved).toEqual([]);
  });

  it("does not turn an absent list into an empty one", async () => {
    // An empty `allowedTools` is a profile that permits NOTHING, which is a very
    // different agent from one that never pinned a list at all.
    const store = fakeStore([agent({ disallowedTools: [legacy("terminal")] })]);
    await migrateStoredAgentTools(store);
    expect(store.saved[0]!.allowedTools).toBeUndefined();
  });

  it("is idempotent across two runs", async () => {
    const one = agent({ allowedTools: [legacy("recall")] });
    const store = fakeStore([one]);
    await migrateStoredAgentTools(store);
    const second = fakeStore([store.saved[0]!]);
    expect(await migrateStoredAgentTools(second)).toEqual([]);
    expect(second.saved).toEqual([]);
  });
});

describe("warning about config we do not own", () => {
  let dir: string;

  it("names the file and the exact stale entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mig-"));
    try {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: [legacy("terminal"), legacy("worktree")] } }),
      );
      const warnings = await findForeignStaleToolNames([dir]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(legacy("terminal"));
      expect(warnings[0]).toContain(legacy("worktree"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never rewrites the file it warns about", async () => {
    // `.claude/settings.json` is Claude Code's, and it is usually committed —
    // silently dirtying a working tree would land in whatever commit came next.
    dir = await mkdtemp(join(tmpdir(), "cm-mig-"));
    try {
      const file = join(dir, ".claude", "settings.json");
      await mkdir(join(dir, ".claude"), { recursive: true });
      const before = JSON.stringify({ permissions: { allow: [legacy("terminal")] } });
      await writeFile(file, before);
      await migrateManagerToolNames(fakeStore([]), [dir], () => {});
      expect(await (await import("node:fs/promises")).readFile(file, "utf8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a repo with no such files", async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mig-"));
    try {
      expect(await findForeignStaleToolNames([dir])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a file that is already current", async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mig-"));
    try {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__dispatch-workspace__terminal"] } }),
      );
      expect(await findForeignStaleToolNames([dir])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the boot pass", () => {
  it("never throws when the store is broken", async () => {
    // A migration failure must not stop the server booting: the worst case if it
    // is skipped is the permission prompt it exists to prevent.
    const broken: ManagerToolMigrationStore = {
      listAgents: async () => {
        throw new Error("db is on fire");
      },
      saveAgent: async (a) => a,
    };
    const logged: string[] = [];
    const res = await migrateManagerToolNames(broken, [], (m) => logged.push(m));
    expect(res.rewritten).toEqual([]);
    expect(logged.join("\n")).toContain("db is on fire");
  });

  it("logs each rewrite so an upgrade says what it changed", async () => {
    const store = fakeStore([agent({ allowedTools: [legacy("terminal")] })]);
    const logged: string[] = [];
    await migrateManagerToolNames(store, [], (m) => logged.push(m));
    expect(logged.join("\n")).toContain("mcp__dispatch-workspace__terminal");
  });
});
