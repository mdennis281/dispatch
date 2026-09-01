import { describe, expect, it } from "vitest";
import type { RunnerInstance } from "@dispatch/shared";
import { sortSubAppRuns } from "./SubAppRunsPopover.js";

const run = (
  id: string,
  status: RunnerInstance["status"],
  startedAt: number,
  projectId = "p1",
  subAppId = "web",
): RunnerInstance => ({
  id,
  projectId,
  subAppId,
  worktreePath: `C:/wt/${id}`,
  kind: "process",
  status,
  startedAt,
});

describe("sortSubAppRuns", () => {
  it("scopes by project/app, puts active runs first, then newest history", () => {
    const result = sortSubAppRuns(
      [
        run("old", "crashed", 1),
        run("other-project", "running", 9, "p2"),
        run("new", "exited", 3),
        run("active", "running", 2),
        run("other-app", "running", 10, "p1", "api"),
      ],
      "p1",
      "web",
    );

    expect(result.map((item) => item.id)).toEqual(["active", "new", "old"]);
  });
});
