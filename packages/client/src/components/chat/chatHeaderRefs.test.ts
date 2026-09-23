import { describe, expect, it } from "vitest";
import type { Chat, PRInfo, WorktreeInfo } from "@dispatch/shared";
import { branchFromPath, chatPrRefs, chatWorktreeRefs } from "./chatHeaderRefs.js";

const chat = (over: Partial<Chat> = {}): Chat =>
  ({
    id: "c1",
    projectId: "p1",
    title: "t",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    worktrees: [],
    prs: [],
    ...over,
  }) as Chat;

const wt = (path: string, branch: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo =>
  ({ path, branch, ...over }) as WorktreeInfo;

const pr = (number: number, over: Partial<PRInfo> = {}): PRInfo =>
  ({
    number,
    url: `u${number}`,
    title: `pr ${number}`,
    state: "open",
    branch: `b${number}`,
    baseBranch: "main",
    isDraft: false,
    checks: [],
    ...over,
  }) as PRInfo;

const merged = (...branches: string[]) => (b: string) => branches.includes(b);

describe("branchFromPath", () => {
  it("reads the flattened separator back", () => {
    expect(branchFromPath("C:/wt/dispatch/feat-header-roster")).toBe("feat/header-roster");
  });

  it("has nothing to say about nothing", () => {
    expect(branchFromPath(undefined)).toBeNull();
  });
});

describe("chatWorktreeRefs", () => {
  it("leads with the first live, unmerged worktree", () => {
    const c = chat({ worktrees: ["/w/a", "/w/b"] });
    const refs = chatWorktreeRefs(c, [wt("/w/a", "feat/a"), wt("/w/b", "feat/b")], merged("feat/a"));
    expect(refs.map((r) => r.branch)).toEqual(["feat/b", "feat/a"]);
    expect(refs.map((r) => r.merged)).toEqual([false, true]);
    expect(refs.every((r) => r.live)).toBe(true);
  });

  it("keeps the first when every worktree has merged", () => {
    const c = chat({ worktrees: ["/w/a", "/w/b"] });
    const refs = chatWorktreeRefs(
      c,
      [wt("/w/a", "feat/a"), wt("/w/b", "feat/b")],
      merged("feat/a", "feat/b"),
    );
    expect(refs.map((r) => r.branch)).toEqual(["feat/a", "feat/b"]);
  });

  it("keeps a worktree the catalog no longer has, marked not-live", () => {
    const c = chat({ worktrees: ["/w/gone", "/w/live"] });
    const refs = chatWorktreeRefs(c, [wt("/w/live", "feat/live")], merged());
    expect(refs).toEqual([
      { branch: "feat/live", path: "/w/live", live: true, merged: false },
      { branch: "gone", path: "/w/gone", live: false, merged: false },
    ]);
  });

  // The bug the old `+N` had: one worktree, counted twice — once as the chip's
  // branch and once as a "pending" path that was the same directory.
  it("counts a single worktree once, whatever the path separators look like", () => {
    const c = chat({ worktrees: ["C:\\w\\a\\"] });
    const refs = chatWorktreeRefs(c, [wt("C:/w/a", "feat/a")], merged());
    expect(refs).toHaveLength(1);
    expect(refs[0]?.live).toBe(true);
  });

  it("marks a removed worktree merged when its branch landed", () => {
    const c = chat({ worktrees: ["/w/feat-shipped"] });
    const refs = chatWorktreeRefs(c, [], merged("feat/shipped"));
    expect(refs[0]).toMatchObject({ branch: "feat/shipped", live: false, merged: true });
  });

  it("includes a worktree tagged to the chat that the chat never recorded", () => {
    const refs = chatWorktreeRefs(chat(), [wt("/w/a", "feat/a", { chatId: "c1" })], merged());
    expect(refs.map((r) => r.branch)).toEqual(["feat/a"]);
  });
});

describe("chatPrRefs", () => {
  it("keeps every PR in the chat's own order", () => {
    const c = chat({
      prs: [
        { number: 9, url: "u9", branch: "b9", state: "open" },
        { number: 4, url: "u4", branch: "b4", state: "merged" },
      ],
    });
    expect(chatPrRefs(c, []).map((p) => p.number)).toEqual([9, 4]);
  });

  it("refreshes a stale state from the live catalog", () => {
    const c = chat({ prs: [{ number: 9, url: "u9", branch: "b9", state: "open" }] });
    expect(chatPrRefs(c, [pr(9, { state: "merged" })])[0]?.state).toBe("merged");
  });

  it("fills a missing title from the catalog and keeps its own when it has one", () => {
    const c = chat({
      prs: [
        { number: 9, url: "u9", branch: "b9" },
        { number: 8, url: "u8", branch: "b8", title: "mine" },
      ],
    });
    const refs = chatPrRefs(c, [pr(9, { title: "tracked" }), pr(8, { title: "theirs" })]);
    expect(refs.map((p) => p.title)).toEqual(["tracked", "mine"]);
  });
});
