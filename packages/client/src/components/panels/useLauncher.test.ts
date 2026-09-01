import { describe, expect, it } from "vitest";
import type { RunnerInstance } from "@dispatch/shared";
import { findRunner } from "./useLauncher.js";

const run = (
  id: string,
  status: RunnerInstance["status"],
  startedAt: number,
): RunnerInstance => ({
  id,
  subAppId: "web",
  worktreePath: "C:/wt/web",
  branch: "feature",
  kind: "process",
  status,
  startedAt,
});

describe("findRunner", () => {
  it("returns the active run, then the newest completed run", () => {
    const old = run("old", "crashed", 1);
    const newest = run("newest", "crashed", 3);
    const active = run("active", "running", 2);

    expect(
      findRunner({ old, newest, active }, { subAppId: "web", branch: "feature" })?.id,
    ).toBe("active");
    expect(
      findRunner({ old, newest }, { subAppId: "web", branch: "feature" })?.id,
    ).toBe("newest");
  });
});
