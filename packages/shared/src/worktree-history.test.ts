import { describe, expect, it } from "vitest";
import {
  mergeWorktreeHistory,
  worktreeKey,
  type ChatWorktreeRecord,
} from "./worktree-history.js";

const rec = (over: Partial<ChatWorktreeRecord> = {}): ChatWorktreeRecord => ({
  path: "C:/wt/feat-a",
  branch: "feat/a",
  createdAt: 100,
  ...over,
});

describe("worktreeKey", () => {
  it("reads git's spelling and a native join() as one path", () => {
    expect(worktreeKey("C:\\wt\\Feat-A\\")).toBe(worktreeKey("c:/wt/feat-a"));
  });
});

describe("mergeWorktreeHistory", () => {
  it("records a worktree it has never seen", () => {
    const out = mergeWorktreeHistory([], [{ path: "C:/wt/feat-a", branch: "feat/a" }], 500);
    expect(out).toEqual([{ path: "C:/wt/feat-a", branch: "feat/a", createdAt: 500 }]);
  });

  // The whole point: the reaper takes the directory, the record stays.
  it("stamps a record the live set has dropped instead of deleting it", () => {
    const out = mergeWorktreeHistory([rec()], [], 500);
    expect(out).toEqual([rec({ removedAt: 500 })]);
  });

  it("leaves an already-stamped record's timestamp alone", () => {
    const out = mergeWorktreeHistory([rec({ removedAt: 200 })], [], 500);
    expect(out[0]?.removedAt).toBe(200);
  });

  it("does not re-record a path it already holds, whatever the spelling", () => {
    const out = mergeWorktreeHistory([rec()], [{ path: "c:\\wt\\feat-a", branch: "feat/a" }], 500);
    expect(out).toHaveLength(1);
    expect(out[0]?.createdAt).toBe(100);
  });

  it("revives a record whose path was cut again, and takes the new branch name", () => {
    const out = mergeWorktreeHistory(
      [rec({ removedAt: 200 })],
      [{ path: "C:/wt/feat-a", branch: "feat/a-renamed" }],
      500,
    );
    expect(out[0]).toEqual({ path: "C:/wt/feat-a", branch: "feat/a-renamed", createdAt: 100 });
  });

  // A nameless row could never be hung a PR off, which is what it exists for.
  it("refuses to record a live worktree whose branch is unknown", () => {
    expect(mergeWorktreeHistory([], [{ path: "C:/wt/x", branch: "" }], 500)).toEqual([]);
  });

  it("keeps a record the live set never mentioned from being resurrected", () => {
    const out = mergeWorktreeHistory(
      [rec({ path: "C:/wt/feat-a", removedAt: 200 }), rec({ path: "C:/wt/feat-b", branch: "feat/b" })],
      [{ path: "C:/wt/feat-b", branch: "feat/b" }],
      500,
    );
    expect(out.map((r) => r.removedAt)).toEqual([200, undefined]);
  });
});
