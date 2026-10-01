/**
 * The global chat's two load-bearing claims, as tests.
 *
 * 1. The pseudo-project is filtered out of anywhere a real repo is expected —
 *    the predictable failure of the reserved-id approach is a leak into one
 *    picker, so the filter is pinned here rather than only at its call sites.
 * 2. The posture actually denies what it says it denies. A denylist that has
 *    quietly lost its shell entry still reads fine; this is what notices.
 */
import { describe, it, expect } from "vitest";
import {
  GLOBAL_MODE,
  GLOBAL_MODE_DISALLOWED_TOOLS,
  GLOBAL_MODE_ID,
  GLOBAL_PROJECT_ID,
  buildGlobalProjectIndex,
  deniedToolRefusal,
  globalProject,
  isGlobalProject,
  isToolDenied,
  realProjects,
} from "./global-chat.js";

describe("the reserved pseudo-project", () => {
  it("is recognised only by its own id", () => {
    expect(isGlobalProject(GLOBAL_PROJECT_ID)).toBe(true);
    expect(isGlobalProject("global")).toBe(false);
    expect(isGlobalProject("__global")).toBe(false);
    expect(isGlobalProject(null)).toBe(false);
    expect(isGlobalProject(undefined)).toBe(false);
  });

  it("survives the store's entity-id allowlist, because it becomes a path", () => {
    // Mirrors `ENTITY_ID` in server/src/store/index.ts. An id this rejects
    // would blow up the moment a chat or a memory dir was written under it.
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(GLOBAL_PROJECT_ID)).toBe(true);
  });

  it("drops only itself from a project list, order preserved", () => {
    const list = [{ id: "alpha" }, { id: GLOBAL_PROJECT_ID }, { id: "beta" }];
    expect(realProjects(list).map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("synthesizes a record with no workflow — there is nothing here to ship", () => {
    const p = globalProject("C:/data/global");
    expect(p.id).toBe(GLOBAL_PROJECT_ID);
    expect(p.repoPath).toBe("C:/data/global");
    expect(p.workflow?.profile).toBe("none");
    expect(p.subApps).toEqual([]);
  });
});

describe("the always-on index", () => {
  it("lists one line per real project and never the pseudo-project", () => {
    const out = buildGlobalProjectIndex([
      { id: "dispatch", name: "Dispatch", repoPath: "C:/p/dispatch" },
      { id: GLOBAL_PROJECT_ID, name: "Global", repoPath: "C:/data/global" },
    ]);
    expect(out).toContain("- Dispatch `dispatch` — C:/p/dispatch");
    expect(out).not.toContain(GLOBAL_PROJECT_ID);
  });

  it("stays small as projects are added — the whole reason it is an index", () => {
    // ~4 chars/token. Twenty projects must still cost well under a thousand
    // tokens of STANDING context, because this block is on every turn forever.
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `project-${i}`,
      name: `Project ${i}`,
      repoPath: `C:/Users/someone/projects/project-${i}`,
    }));
    expect(buildGlobalProjectIndex(many).length / 4).toBeLessThan(500);
  });

  it("says so rather than rendering an empty list", () => {
    expect(buildGlobalProjectIndex([])).toContain("No projects yet");
  });
});

describe("the global posture", () => {
  it("denies every route to landing a change", () => {
    for (const tool of [
      // A shell is the complete bypass; if any of these come off the list the
      // rest of the posture is decoration.
      "Bash",
      "PowerShell",
      "mcp__dispatch-workspace__terminal",
      // …and the direct routes.
      "Edit",
      "Write",
      "mcp__dispatch-workspace__worktree",
      "mcp__dispatch-github__approve_pr",
      "mcp__dispatch-github__create_pr",
      "mcp__dispatch-config__config_write",
    ]) {
      expect(isToolDenied(tool, GLOBAL_MODE.disallowedTools)).toBe(true);
    }
  });

  it("leaves the observe-and-spawn surface alone", () => {
    for (const tool of [
      "Read",
      "Grep",
      "Glob",
      "mcp__dispatch-chat__spawn_chat",
      "mcp__dispatch-chat__chat_find",
      "mcp__dispatch-project__project_list",
      "mcp__dispatch-project__project_info",
      "mcp__dispatch-github__watch_pr",
      "mcp__dispatch-memory__recall",
      "mcp__dispatch-memory__remember",
    ]) {
      expect(isToolDenied(tool, GLOBAL_MODE.disallowedTools)).toBe(false);
    }
  });

  it("matches exactly — no accidental prefix matching in either direction", () => {
    expect(isToolDenied("BashOutput", GLOBAL_MODE_DISALLOWED_TOOLS)).toBe(false);
    expect(isToolDenied("Bas", GLOBAL_MODE_DISALLOWED_TOOLS)).toBe(false);
    expect(isToolDenied("Bash", undefined)).toBe(false);
  });

  it("is a mode, with the overlay that explains itself", () => {
    expect(GLOBAL_MODE.id).toBe(GLOBAL_MODE_ID);
    expect(GLOBAL_MODE.scope).toBe("global");
    expect(GLOBAL_MODE.instructions).toContain("spawn_chat");
  });

  it("points a refusal at the sanctioned path instead of just saying no", () => {
    const text = deniedToolRefusal("Edit", "Global");
    expect(text).toContain("`Edit`");
    expect(text).toContain("spawn_chat");
  });
});
