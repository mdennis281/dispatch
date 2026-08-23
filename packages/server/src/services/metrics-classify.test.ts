import { describe, it, expect } from "vitest";
import { LEGACY_MANAGER_SERVER } from "@dispatch/shared";
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

  it("gives Dispatch's own endpoints their own category, not `mcp`", () => {
    // Counting these as ordinary MCP calls would bury Dispatch's own surface in
    // whatever third-party server happened to be noisiest.
    expect(classifyTool("mcp__dispatch-github__create_pr")).toEqual({
      category: "manager",
      identifier: "create_pr",
      detail: "github",
    });
  });

  it("files a pre-split call as the SAME row as its renamed twin", () => {
    // A row recorded under the retired single `manager` server has to land on
    // the identifier AND detail its post-rename twin does, or the Metrics view
    // shows `create_pr` as two disjoint series either side of the split. This
    // also runs in the transcript BACKFILL, which re-reads months-old sessions
    // long after any one-time database UPDATE would have finished.
    const legacy = classifyTool(`mcp__${LEGACY_MANAGER_SERVER}__create_pr`);
    expect(legacy).toEqual(classifyTool("mcp__dispatch-github__create_pr"));
  });

  it("does not claim a legacy name for a tool that no longer exists", () => {
    // Otherwise a third-party server that happened to be called `manager` would
    // have every one of its calls filed as Dispatch's own.
    expect(classifyTool(`mcp__${LEGACY_MANAGER_SERVER}__not_a_dispatch_tool`)).toEqual({
      category: "mcp",
      identifier: `${LEGACY_MANAGER_SERVER}/not_a_dispatch_tool`,
      detail: LEGACY_MANAGER_SERVER,
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
      classifyTool("mcp__dispatch-session__wait"),
      classifyTool("mcp__other__thing"),
    ];
    expect(new Set(all.map((c) => c.category)).size).toBe(5);
  });
});
