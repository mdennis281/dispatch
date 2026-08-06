import { describe, it, expect } from "vitest";
import { AUTHORABLE_SECTIONS, type ProjectConfig } from "@dispatch/shared";
import { buildAuthorPrompt } from "./config-author.js";

/** A loaded config with the DEFAULT dir names. */
function config(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    sourceDir: "/repo/.dispatch",
    name: "Repo",
    instructions: [],
    subApps: [],
    mcpServers: {},
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

const prompt = (section: (typeof AUTHORABLE_SECTIONS)[number], cfg = config()) =>
  buildAuthorPrompt({
    section,
    description: "audit our SQL migrations before they ship",
    config: cfg,
    projectName: "Repo",
  });

describe("buildAuthorPrompt", () => {
  it("carries the user's request verbatim", () => {
    expect(prompt("agents")).toContain("audit our SQL migrations before they ship");
  });

  it("tells the agent where the file goes, per section", () => {
    expect(prompt("agents")).toContain(".dispatch/agents/<id>.md");
    expect(prompt("skills")).toContain(".dispatch/skills/<name>/SKILL.md");
    expect(prompt("modes")).toContain(".dispatch/modes/<id>.yaml");
    expect(prompt("instructions")).toContain(".dispatch/instructions/<name>.md");
    expect(prompt("mcp")).toContain("project.yaml");
    expect(prompt("subApps")).toContain("project.yaml");
  });

  it("honours manifest dir overrides instead of hardcoding defaults", () => {
    // A repo that renamed its dirs must not be told to write to `agents/`.
    const custom = config({
      sourceDir: "/repo/.claude-manager",
      agentsDir: "/repo/.claude-manager/subagents",
    });
    const out = prompt("agents", custom);
    expect(out).toContain(".claude-manager/subagents/<id>.md");
    expect(out).not.toContain(".dispatch/agents");
  });

  it("falls back to the default layout when nothing is loaded yet", () => {
    const out = buildAuthorPrompt({
      section: "agents",
      description: "x",
      config: null,
      projectName: "Repo",
    });
    expect(out).toContain(".dispatch/agents/<id>.md");
  });

  it("routes MCP work through the tool + skill rather than hand-editing", () => {
    // The recurring failure: an agent writes `.mcp.json`, which nothing reads.
    const out = prompt("mcp");
    expect(out).toContain("mcp__manager__mcp_add");
    expect(out).toContain("mcp-setup");
    expect(out).toMatch(/do not hand-edit/i);
    expect(out).toContain("${VAR}");
  });

  it("tells skill authors the description is a trigger, not a summary", () => {
    expect(prompt("skills")).toMatch(/trigger conditions/i);
  });

  it("reminds instruction authors to register the file in the manifest", () => {
    // A file that isn't listed under `instructions:` is silently never loaded.
    const out = prompt("instructions");
    expect(out).toContain("instructions:");
    expect(out).toMatch(/NOT loaded/);
  });

  it("gives every authorable section a non-trivial briefing", () => {
    for (const section of AUTHORABLE_SECTIONS) {
      const out = prompt(section);
      expect(out.length, section).toBeGreaterThan(400);
      expect(out, section).toContain("**How this config works**");
      // Grounding beats boilerplate — every section says so.
      expect(out, section).toContain("match its conventions");
    }
  });
});
