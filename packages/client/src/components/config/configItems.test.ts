import { describe, it, expect } from "vitest";
import type { ProjectConfig, ProjectMemory } from "@dispatch/shared";
import { deleteTarget, dirName, sectionItems, type SectionItem } from "./configItems.js";

function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    sourceDir: "/repo/.dispatch",
    name: "Repo",
    instructions: [],
    subApps: [],
    mcpServers: {},
    mcpEnabled: {},
    agents: [],
    modes: [],
    skills: [],
    memoryDir: "/repo/.dispatch/memory",
    agentsDir: "/repo/.dispatch/agents",
    modesDir: "/repo/.dispatch/modes",
    skillsDir: "/repo/.dispatch/skills",
    instructionsDir: "/repo/.dispatch/instructions",
    ...over,
  };
}

const one = (items: SectionItem[]): SectionItem => {
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe("dirName", () => {
  it("takes the last segment of either separator style", () => {
    expect(dirName("/repo/.dispatch/agents", "x")).toBe("agents");
    expect(dirName("C:\\repo\\.dispatch\\subagents", "x")).toBe("subagents");
    expect(dirName("/repo/.dispatch/agents/", "x")).toBe("agents");
    expect(dirName(undefined, "agents")).toBe("agents");
  });
});

describe("sectionItems — resolving items to their files", () => {
  it("uses an agent's real filename, not its id", () => {
    // The id is a slug of the frontmatter name; deriving `<id>.md` would target
    // a file that doesn't exist (or worse, someone else's).
    const items = sectionItems(
      "agents",
      config({
        agents: [
          {
            id: "sql-auditor",
            name: "SQL Auditor",
            instructions: "",
            permissionMode: "plan",
            effort: undefined,
            scope: "project",
            file: "01-sql.md",
          },
        ],
      }),
      [],
    );
    expect(one(items).rel).toBe("agents/01-sql.md");
  });

  it("honours a renamed agents dir", () => {
    const items = sectionItems(
      "agents",
      config({
        agentsDir: "/repo/.dispatch/subagents",
        agents: [
          {
            id: "a",
            name: "A",
            instructions: "",
            permissionMode: "default",
            effort: undefined,
            scope: "project",
            file: "a.md",
          },
        ],
      }),
      [],
    );
    expect(one(items).rel).toBe("subagents/a.md");
  });

  it("marks an agent with no known file as non-deletable", () => {
    // A `.data`-defined agent has no file — offering Delete would be a lie.
    const items = sectionItems(
      "agents",
      config({
        agents: [
          {
            id: "a",
            name: "A",
            instructions: "",
            permissionMode: "default",
            effort: undefined,
            scope: "project",
          },
        ],
      }),
      [],
    );
    const item = one(items);
    expect(item.rel).toBeUndefined();
    expect(deleteTarget("agents", item)).toBeUndefined();
  });

  it("uses an instruction's RESOLVED path, not the authored one", () => {
    // The loader accepts `file` relative to the instructions dir OR the config
    // dir; only `rel` says which one it actually was.
    const items = sectionItems(
      "instructions",
      config({
        instructions: [
          { source: "file", file: "house.md", rel: "instructions/house.md", text: "hi" },
        ],
      }),
      [],
    );
    expect(one(items).rel).toBe("instructions/house.md");
  });

  it("gives inline instructions no file to open or delete", () => {
    const items = sectionItems(
      "instructions",
      config({ instructions: [{ source: "text", text: "be terse" }] }),
      [],
    );
    const item = one(items);
    expect(item.rel).toBeUndefined();
    expect(deleteTarget("instructions", item)).toBeUndefined();
  });

  it("points a dir-layout skill at SKILL.md but DELETES the directory", () => {
    // Removing only SKILL.md would strand the skill's scripts and references.
    const items = sectionItems(
      "skills",
      config({
        skills: [
          {
            id: "release",
            name: "release",
            dir: "release",
            path: "/repo/.dispatch/skills/release/SKILL.md",
            layout: "dir",
          },
        ],
      }),
      [],
    );
    const item = one(items);
    expect(item.rel).toBe("skills/release/SKILL.md");
    expect(deleteTarget("skills", item)).toBe("skills/release");
  });

  it("deletes a flat skill's file itself", () => {
    const items = sectionItems(
      "skills",
      config({
        skills: [
          {
            id: "tidy",
            name: "tidy",
            dir: "tidy",
            path: "/repo/.dispatch/skills/tidy.md",
            layout: "flat",
          },
        ],
      }),
      [],
    );
    const item = one(items);
    expect(item.rel).toBe("skills/tidy.md");
    expect(deleteTarget("skills", item)).toBe("skills/tidy.md");
  });

  it("sends manifest-backed kinds to project.yaml with no delete", () => {
    for (const [section, cfg] of [
      ["mcp", config({ mcpServers: { linear: { type: "sse", url: "http://x" } } })],
      [
        "subApps",
        config({ subApps: [{ id: "web", name: "Web", path: "apps/web", ports: [5173] }] }),
      ],
    ] as const) {
      const item = one(sectionItems(section, cfg, []));
      expect(item.rel, section).toBe("project.yaml");
      expect(deleteTarget(section, item), section).toBeUndefined();
    }
  });

  it("lists memories without any file affordance", () => {
    const memories = [
      { name: "m", description: "d", type: "project", body: "b" },
    ] as unknown as ProjectMemory[];
    const item = one(sectionItems("memory", config(), memories));
    expect(item.title).toBe("m");
    expect(item.rel).toBeUndefined();
  });

  it("returns nothing when no config is loaded", () => {
    expect(sectionItems("agents", null, [])).toEqual([]);
    expect(sectionItems("workflow", config(), [])).toEqual([]);
  });
});
