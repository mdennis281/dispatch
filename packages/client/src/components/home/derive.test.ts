import { describe, expect, it } from "vitest";
import type { Chat, PrRecord } from "@dispatch/shared";
import { prRows, worktreeRows } from "./derive.js";

const chat = (over: Partial<Chat> & Pick<Chat, "id">): Chat =>
  ({
    projectId: "p1",
    title: "a chat",
    createdAt: 1_000,
    updatedAt: 1_000,
    worktrees: [],
    prs: [],
    ...over,
  }) as Chat;

const pr = (over: Partial<PrRecord> & Pick<PrRecord, "key">): PrRecord =>
  ({
    repo: "o/r",
    number: 1,
    url: "https://example.test",
    title: "t",
    branch: "",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    labels: [],
    hold: false,
    mergeable: null,
    reviewDecision: null,
    reviewers: [],
    threads: [],
    checks: [],
    firstSeenAt: 0,
    lastPolledAt: 0,
    lastChangedAt: 0,
    nextPollAt: 0,
    quietPolls: 0,
    watchedUntil: 0,
    ...over,
  }) as PrRecord;

describe("worktreeRows — the live set, named by the history", () => {
  it("takes the branch from the history record for the same path", () => {
    const rows = worktreeRows([
      chat({
        id: "c1",
        worktrees: ["C:/wt/feat-a-b"],
        worktreeHistory: [{ path: "C:/wt/feat-a-b", branch: "feat/a-b", createdAt: 5_000 }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ branch: "feat/a-b", createdAt: 5_000, chatId: "c1" });
  });

  it("matches the history across path spellings and case", () => {
    const rows = worktreeRows([
      chat({
        id: "c1",
        worktrees: ["C:\\wt\\feat-a\\"],
        worktreeHistory: [{ path: "c:/wt/feat-a", branch: "feat/a", createdAt: 7_000 }],
      }),
    ]);
    expect(rows[0]?.branch).toBe("feat/a");
  });

  it("keeps a live tree the history has no record of, with no branch", () => {
    const rows = worktreeRows([chat({ id: "c1", worktrees: ["C:/wt/old"], createdAt: 42 })]);
    expect(rows[0]).toMatchObject({ branch: "", createdAt: 42 });
  });

  it("leaves REMOVED history records out — the list is what exists now", () => {
    const rows = worktreeRows([
      chat({
        id: "c1",
        worktrees: [],
        worktreeHistory: [
          { path: "C:/wt/gone", branch: "feat/gone", createdAt: 1, removedAt: 2 },
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("folds two chats claiming one path into one row, newest claim winning", () => {
    const rows = worktreeRows([
      chat({
        id: "old",
        worktrees: ["C:/wt/shared"],
        worktreeHistory: [{ path: "C:/wt/shared", branch: "feat/x", createdAt: 100 }],
      }),
      chat({
        id: "new",
        worktrees: ["C:/wt/shared"],
        worktreeHistory: [{ path: "C:/wt/shared", branch: "feat/x", createdAt: 200 }],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chatId).toBe("new");
  });

  it("drops archived chats and sorts newest first", () => {
    const rows = worktreeRows([
      chat({ id: "a", worktrees: ["C:/wt/a"], createdAt: 10 }),
      chat({ id: "b", worktrees: ["C:/wt/b"], createdAt: 30 }),
      chat({ id: "z", worktrees: ["C:/wt/z"], createdAt: 99, archived: true }),
    ]);
    expect(rows.map((r) => r.chatId)).toEqual(["b", "a"]);
  });
});

describe("prRows — open first, then most recently changed", () => {
  it("puts every open PR above every settled one, whatever the clock says", () => {
    const rows = prRows(
      [
        pr({ key: "o/r#1", number: 1, state: "merged", lastChangedAt: 900 }),
        pr({ key: "o/r#2", number: 2, state: "open", lastChangedAt: 100 }),
      ],
      10,
    );
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });

  it("orders within each half by last change", () => {
    const rows = prRows(
      [
        pr({ key: "o/r#1", number: 1, state: "open", lastChangedAt: 100 }),
        pr({ key: "o/r#2", number: 2, state: "open", lastChangedAt: 300 }),
        pr({ key: "o/r#3", number: 3, state: "closed", lastChangedAt: 50 }),
        pr({ key: "o/r#4", number: 4, state: "merged", lastChangedAt: 80 }),
      ],
      10,
    );
    expect(rows.map((r) => r.number)).toEqual([2, 1, 4, 3]);
  });

  it("does not mutate the input", () => {
    const input = [
      pr({ key: "o/r#1", number: 1, state: "merged", lastChangedAt: 900 }),
      pr({ key: "o/r#2", number: 2, state: "open", lastChangedAt: 100 }),
    ];
    prRows(input, 1);
    expect(input.map((r) => r.number)).toEqual([1, 2]);
  });

  it("caps at the limit", () => {
    const rows = prRows(
      [1, 2, 3, 4].map((n) => pr({ key: `o/r#${n}`, number: n, lastChangedAt: n })),
      2,
    );
    expect(rows.map((r) => r.number)).toEqual([4, 3]);
  });
});
