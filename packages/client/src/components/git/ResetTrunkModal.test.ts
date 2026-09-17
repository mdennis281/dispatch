import { describe, it, expect } from "vitest";
import type { GitStatus } from "@dispatch/shared";
import { resetPlan, summarize } from "./ResetTrunkModal.js";

const base: GitStatus = {
  repoPath: "C:/repo",
  branch: "main",
  ahead: 0,
  behind: 0,
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};
const f = (path: string) => ({ path, status: "modified" as const, staged: false });

describe("resetPlan", () => {
  it("says nothing for a clean, current trunk", () => {
    expect(resetPlan(base, "main")).toEqual([]);
  });

  it("counts edits and untracked files separately and reports the pull", () => {
    const s = { ...base, staged: [f("a")], unstaged: [f("b")], untracked: [f("c")], behind: 2 };
    expect(resetPlan(s, "main")).toEqual([
      "Throw away 2 uncommitted changes",
      "Delete 1 untracked file",
      "Pull 2 commits from origin/main",
    ]);
  });

  it("announces the branch switch and ignores that branch's behind count", () => {
    const s = { ...base, branch: "feat/x", behind: 5 };
    expect(resetPlan(s, "main")).toEqual(["Switch from feat/x to main"]);
    expect(resetPlan({ ...base, branch: undefined, detached: true }, "main")).toEqual([
      "Switch from a detached HEAD to main",
    ]);
  });
});

describe("summarize", () => {
  const zero = { branch: "main", discarded: 0, pulled: 0, dropped: 0, replayed: 0, kept: 0 };
  it("has a sentence for the no-op case", () => {
    expect(summarize(zero)).toMatch(/already clean/);
  });
  it("lists only what happened", () => {
    expect(summarize({ ...zero, discarded: 3, replayed: 1 })).toBe(
      "Discarded 3 changes, replayed 1 local commit.",
    );
  });
});
