/**
 * Bundled-skill discovery. These assertions are deliberately about the REAL
 * shipped skills dir rather than a fixture: the failure this guards against is a
 * build/layout change silently making `packages/server/skills/` unreachable, at
 * which point sessions quietly lose the skill and nothing else breaks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { bundledSkills, resetBundledSkillsCache } from "./bundled-skills.js";

beforeEach(() => resetBundledSkillsCache());

describe("bundledSkills", () => {
  it("finds the shipped skills and points at real SKILL.md files", () => {
    const skills = bundledSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(existsSync(skill.path)).toBe(true);
      expect(skill.layout).toBe("dir");
      // `dir` is the name it materializes under, so it must be the identity a
      // repo would override — not a path.
      expect(skill.dir).not.toContain("/");
    }
  });

  it("ships the mcp-setup skill with frontmatter the SDK can match on", () => {
    const mcp = bundledSkills().find((s) => s.dir === "mcp-setup");
    expect(mcp).toBeDefined();
    expect(mcp!.name).toBe("mcp-setup");
    // The description is what makes the skill fire; an empty one makes the whole
    // mechanism a no-op.
    expect(mcp!.description).toBeTruthy();
    expect(mcp!.description!.length).toBeGreaterThan(40);
    expect(mcp!.description!.toLowerCase()).toContain("mcp");
  });

  it("memoizes so repeated session launches don't re-stat the dir", () => {
    expect(bundledSkills()).toBe(bundledSkills());
  });
});
