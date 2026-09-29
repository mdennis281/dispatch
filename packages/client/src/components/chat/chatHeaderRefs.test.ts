import { describe, expect, it } from "vitest";
import type { Chat, PRInfo, WorktreeInfo } from "@dispatch/shared";
import { branchFromPath, chatPrRefs, chatWorktreeRefs, rosterRows } from "./chatHeaderRefs.js";

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

  // PR numbers restart at 1 per repo, so a chat that shipped to two of them can
  // hold two #3s — and a number-only match hands both rows the same catalog PR.
  it("matches on repo#number when both sides name a repo", () => {
    const c = chat({
      prs: [
        { number: 3, url: "u", branch: "b", repo: "org/a", state: "open" },
        { number: 3, url: "u", branch: "b", repo: "org/b", state: "open" },
      ],
    });
    const refs = chatPrRefs(c, [
      pr(3, { repo: "org/b", state: "merged", title: "b's" }),
      pr(3, { repo: "org/a", state: "closed", title: "a's" }),
    ]);
    expect(refs.map((p) => p.state)).toEqual(["closed", "merged"]);
  });

  it("leaves a PR alone when only the other repo's same number is tracked", () => {
    const c = chat({ prs: [{ number: 3, url: "u", branch: "b", repo: "org/a", state: "open" }] });
    expect(chatPrRefs(c, [pr(3, { repo: "org/b", state: "merged" })])[0]?.state).toBe("open");
  });

  it("still refreshes when either side has no repo to match on", () => {
    const c = chat({ prs: [{ number: 3, url: "u", branch: "b", state: "open" }] });
    expect(chatPrRefs(c, [pr(3, { repo: "org/a", state: "merged" })])[0]?.state).toBe("merged");
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

describe("rosterRows", () => {
  const ref = (branch: string, path = `/w/${branch}`) => ({
    branch,
    path,
    live: true,
    merged: false,
  });
  const prRef = (number: number, branch: string) => ({ number, url: `u${number}`, branch });

  it("hangs a PR off the worktree it was cut from", () => {
    const { rows, orphans } = rosterRows(
      [ref("feat/a"), ref("feat/b")],
      [prRef(2, "feat/b"), prRef(1, "feat/a")],
    );
    expect(rows.map((r) => r.prs.map((p) => p.number))).toEqual([[1], [2]]);
    expect(orphans).toEqual([]);
  });

  it("keeps a PR whose branch has no worktree row", () => {
    const { rows, orphans } = rosterRows([ref("feat/a")], [prRef(1, "feat/gone")]);
    expect(rows[0]?.prs).toEqual([]);
    expect(orphans.map((p) => p.number)).toEqual([1]);
  });

  // Two worktrees CAN sit on one branch; listing the PR under both would be the
  // same double-count the header's "+1" used to have.
  it("attaches to the first worktree on a shared branch only", () => {
    const { rows } = rosterRows(
      [ref("feat/a", "/w/one"), ref("feat/a", "/w/two")],
      [prRef(1, "feat/a")],
    );
    expect(rows.map((r) => r.prs.length)).toEqual([1, 0]);
  });

  it("keeps every PR on one branch in the order it was given", () => {
    const { rows } = rosterRows([ref("feat/a")], [prRef(9, "feat/a"), prRef(4, "feat/a")]);
    expect(rows[0]?.prs.map((p) => p.number)).toEqual([9, 4]);
  });
});
