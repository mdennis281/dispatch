import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_ALLOW_TOOLS,
  autoAllowEntryMatches,
  canRememberAutoAllow,
  isAutoAllowed,
  withAutoAllowed,
} from "./auto-allow.js";
import { GLOBAL_MODE_DISALLOWED_TOOLS } from "./global-chat.js";

describe("autoAllowEntryMatches", () => {
  it("matches an exact name", () => {
    expect(autoAllowEntryMatches("Read", "Read")).toBe(true);
    expect(autoAllowEntryMatches("Read", "ReadMcpResourceTool")).toBe(false);
  });

  it("matches a trailing-* prefix", () => {
    expect(autoAllowEntryMatches("mcp__dispatch-chat__*", "mcp__dispatch-chat__chat_find")).toBe(
      true,
    );
    expect(autoAllowEntryMatches("mcp__dispatch-chat__*", "mcp__dispatch-github__watch_pr")).toBe(
      false,
    );
  });

  it("reads a bare MCP server as every tool it serves, and only that server", () => {
    expect(autoAllowEntryMatches("mcp__dispatch-chat", "mcp__dispatch-chat__chat_state")).toBe(true);
    // A server whose name merely starts the same must not ride along.
    expect(autoAllowEntryMatches("mcp__dispatch-chat", "mcp__dispatch-chatter__x")).toBe(false);
  });

  it("ignores blank entries", () => {
    expect(autoAllowEntryMatches("  ", "Read")).toBe(false);
  });
});

describe("isAutoAllowed", () => {
  it("uses the defaults when the app list is unset", () => {
    expect(isAutoAllowed("mcp__dispatch-chat__chat_state", {})).toBe(true);
    expect(isAutoAllowed("Bash", {})).toBe(false);
  });

  it("treats a stored list as the whole app layer — an empty one allows nothing", () => {
    expect(isAutoAllowed("mcp__dispatch-chat__chat_state", { app: [] })).toBe(false);
  });

  it("ADDS a mode's list to the app layer rather than replacing it", () => {
    const layers = { app: ["Read"], mode: ["mcp__dispatch-chat"] };
    expect(isAutoAllowed("Read", layers)).toBe(true);
    expect(isAutoAllowed("mcp__dispatch-chat__chat_find", layers)).toBe(true);
  });

  it("never answers AskUserQuestion, even under a wildcard", () => {
    expect(isAutoAllowed("AskUserQuestion", { app: ["*"] })).toBe(false);
  });

  it("keeps write tools asking in plan mode, and only there", () => {
    expect(isAutoAllowed("Edit", { app: ["Edit"], planning: true })).toBe(false);
    expect(isAutoAllowed("Edit", { app: ["Edit"] })).toBe(true);
    expect(isAutoAllowed("Read", { app: ["Read"], planning: true })).toBe(true);
  });

  it("defaults contain nothing the global posture denies", () => {
    // The guard would refuse them anyway, but a default that names a denied
    // tool reads as a claim that the global chat may use it.
    for (const tool of DEFAULT_AUTO_ALLOW_TOOLS) {
      expect(GLOBAL_MODE_DISALLOWED_TOOLS).not.toContain(tool);
    }
  });
});

describe("withAutoAllowed", () => {
  it("seeds from the defaults the first time, so one click doesn't revoke them", () => {
    const next = withAutoAllowed(undefined, "mcp__foo__bar");
    expect(next).toEqual([...DEFAULT_AUTO_ALLOW_TOOLS, "mcp__foo__bar"]);
  });

  it("is a no-op when an entry already covers the tool", () => {
    expect(withAutoAllowed(["mcp__foo"], "mcp__foo__bar")).toBeNull();
  });

  it("refuses shells and questions", () => {
    expect(withAutoAllowed([], "Bash")).toBeNull();
    expect(withAutoAllowed([], "mcp__dispatch-workspace__terminal")).toBeNull();
    expect(withAutoAllowed([], "AskUserQuestion")).toBeNull();
    expect(canRememberAutoAllow("Bash")).toBe(false);
    expect(canRememberAutoAllow("Edit")).toBe(true);
  });
});
