import { describe, expect, it } from "vitest";
import type { Project } from "@dispatch/shared";
import { projectLastTouched, rankProjects } from "./projectRanking.js";

function project(id: string, name: string, createdAt = 0, repoPath = `C:/repos/${id}`): Project {
  return { id, name, repoPath, worktreeRoot: "", subApps: [], createdAt } as Project;
}

describe("projectLastTouched", () => {
  it("takes the newest user message, not the newest write", () => {
    const touched = projectLastTouched(
      [project("a", "A", 1), project("b", "B", 1)],
      [
        { projectId: "a", lastUserMessageAt: 100, createdAt: 5 },
        { projectId: "a", lastUserMessageAt: 300, createdAt: 6 },
        { projectId: "b", createdAt: 200 }, // legacy chat: falls back to createdAt
      ],
    );
    expect(touched).toEqual({ a: 300, b: 200 });
  });

  it("falls back to the project's own createdAt and ignores unknown projects", () => {
    const touched = projectLastTouched(
      [project("a", "A", 50)],
      [{ projectId: "__global__", lastUserMessageAt: 999, createdAt: 1 }],
    );
    expect(touched).toEqual({ a: 50 });
  });
});

describe("rankProjects", () => {
  const ps = [project("z", "zeta"), project("d", "dispatch"), project("h", "hivebreak")];
  const lastTouched = { z: 300, d: 100, h: 200 };

  it("orders by last touch, or by name", () => {
    expect(rankProjects(ps, { query: "", sort: "recent", lastTouched }).map((r) => r.project.id)).toEqual([
      "z",
      "h",
      "d",
    ]);
    expect(rankProjects(ps, { query: "", sort: "name", lastTouched }).map((r) => r.project.id)).toEqual([
      "d",
      "h",
      "z",
    ]);
  });

  it("lets match quality beat recency when searching", () => {
    // "di" is a subsequence of nothing but dispatch; "e" hits zeta and hivebreak.
    const r = rankProjects(ps, { query: "dis", sort: "recent", lastTouched });
    expect(r.map((x) => x.project.id)).toEqual(["d"]);
    expect(r[0]!.nameHits).toEqual([0, 1, 2]);
  });

  it("falls back to the repo path, flagged so the row can show it", () => {
    const withPath = [project("m", "manager", 0, "C:/Users/me/projects/claude-manager")];
    const r = rankProjects(withPath, { query: "claude", sort: "recent", lastTouched: {} });
    expect(r).toHaveLength(1);
    expect(r[0]!.pathOnly).toBe(true);
    expect(r[0]!.nameHits).toEqual([]);
  });

  it("does not subsequence-match paths — every path shares C:/Users/…", () => {
    const withPath = [project("h", "homelab", 0, "C:/Users/me/projects/homelab")];
    // s…t is a subsequence of "Users/me/projects" but not a substring of it.
    expect(rankProjects(withPath, { query: "st", sort: "recent", lastTouched: {} })).toEqual([]);
  });
});
