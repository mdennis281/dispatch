import { describe, it, expect } from "vitest";
import { classifyTool } from "./metrics-classify.js";

describe("classifyTool", () => {
  it("files a built-in tool under its own name", () => {
    expect(classifyTool("Read", { file_path: "/x" })).toEqual({
      category: "tool",
      identifier: "Read",
    });
  });

  it("splits an MCP call into server + endpoint, and keeps both addressable", () => {
    expect(classifyTool("mcp__proxmox__pve_nodes")).toEqual({
      category: "mcp",
      identifier: "proxmox/pve_nodes",
      detail: "proxmox",
    });
  });

  it("gives the manager's own endpoints their own category, not `mcp`", () => {
    // Counting these as ordinary MCP calls would bury Dispatch's own surface in
    // whatever third-party server happened to be noisiest.
    expect(classifyTool("mcp__manager__create_pr")).toEqual({
      category: "manager",
      identifier: "create_pr",
      detail: "manager",
    });
  });

  it("handles a server name that itself contains underscores", () => {
    expect(classifyTool("mcp__ssh_hass_hub__run-command")).toMatchObject({
      identifier: "ssh_hass_hub/run-command",
      detail: "ssh_hass_hub",
    });
  });

  it("treats a malformed `mcp__foo` as MCP rather than as a built-in tool", () => {
    expect(classifyTool("mcp__foo")).toMatchObject({ category: "mcp", detail: "foo" });
  });

  it("names a skill by the SKILL, not by the tool that carried it", () => {
    // "Skill was called 400 times" answers nothing; "code-review ran 400 times"
    // is the question — which is the whole reason this category exists.
    expect(classifyTool("Skill", { skill: "code-review" })).toEqual({
      category: "skill",
      identifier: "code-review",
      detail: "Skill",
    });
  });

  it("names a subagent by its type, across both spawning tools", () => {
    expect(classifyTool("Agent", { subagent_type: "Explore" })).toMatchObject({
      category: "subagent",
      identifier: "Explore",
      detail: "Agent",
    });
    // `Task` is the older name and still appears in transcripts the import reads.
    expect(classifyTool("Task", { subagent_type: "Explore" })).toMatchObject({
      category: "subagent",
      identifier: "Explore",
      detail: "Task",
    });
  });

  it("reads an un-typed spawn as the general-purpose agent it actually runs", () => {
    expect(classifyTool("Agent", { prompt: "go" }).identifier).toBe("general-purpose");
  });

  it("still classifies a carrier whose input was dropped", () => {
    // A lean/hydrated transcript row can legitimately have no input at all.
    expect(classifyTool("Skill")).toMatchObject({ category: "skill", identifier: "(unnamed)" });
    expect(classifyTool("Skill", { skill: "  " })).toMatchObject({ identifier: "(unnamed)" });
  });

  it("assigns exactly one category, so summing them can't double-count", () => {
    const all = [
      classifyTool("Read"),
      classifyTool("Skill", { skill: "s" }),
      classifyTool("Agent", { subagent_type: "a" }),
      classifyTool("mcp__manager__wait"),
      classifyTool("mcp__other__thing"),
    ];
    expect(new Set(all.map((c) => c.category)).size).toBe(5);
  });
});
