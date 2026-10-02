import { describe, expect, it } from "vitest";
import type { Chat, CheckRun, PrRecord } from "@dispatch/shared";
import {
  orphanPrs,
  prMark,
  prsByChat,
  worktreeRows,
  worktreesByChat,
} from "./derive.js";

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

describe("prsByChat — what each chat opened, most live first", () => {
  it("keys off the registry's own attribution and skips the unattributed", () => {
    const by = prsByChat([
      pr({ key: "o/r#1", number: 1, chatId: "c1", lastChangedAt: 10 }),
      pr({ key: "o/r#2", number: 2, lastChangedAt: 99 }),
    ]);
    expect([...by.keys()]).toEqual(["c1"]);
    expect(by.get("c1")?.map((r) => r.number)).toEqual([1]);
  });

  it("puts an open PR first even when a merged one changed more recently", () => {
    const by = prsByChat([
      pr({ key: "o/r#1", number: 1, chatId: "c1", state: "merged", lastChangedAt: 900 }),
      pr({ key: "o/r#2", number: 2, chatId: "c1", state: "open", lastChangedAt: 100 }),
      pr({ key: "o/r#3", number: 3, chatId: "c1", state: "closed", lastChangedAt: 50 }),
    ]);
    expect(by.get("c1")?.map((r) => r.number)).toEqual([2, 1, 3]);
  });
});

describe("worktreesByChat", () => {
  it("groups the live trees by their owner", () => {
    const rows = worktreeRows([
      chat({ id: "c1", worktrees: ["C:/wt/a", "C:/wt/b"] }),
      chat({ id: "c2", worktrees: ["C:/wt/c"] }),
    ]);
    const by = worktreesByChat(rows);
    expect(by.get("c1")).toHaveLength(2);
    expect(by.get("c2")).toHaveLength(1);
    expect(by.get("nobody")).toBeUndefined();
  });
});

describe("orphanPrs — the ones no row on the page can carry", () => {
  it("takes both the never-attributed and the chat-since-deleted", () => {
    const rows = orphanPrs(
      [
        pr({ key: "o/r#1", number: 1 }), // dependabot: no chatId at all
        pr({ key: "o/r#2", number: 2, chatId: "gone" }), // chat deleted
        pr({ key: "o/r#3", number: 3, chatId: "here" }), // has a row
      ],
      new Set(["here"]),
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
  });

  it("orders open first, then most recently changed", () => {
    const rows = orphanPrs(
      [
        pr({ key: "o/r#1", number: 1, state: "merged", lastChangedAt: 900 }),
        pr({ key: "o/r#2", number: 2, state: "open", lastChangedAt: 100 }),
        pr({ key: "o/r#3", number: 3, state: "open", lastChangedAt: 300 }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input", () => {
    const input = [
      pr({ key: "o/r#1", number: 1, state: "merged", lastChangedAt: 900 }),
      pr({ key: "o/r#2", number: 2, state: "open", lastChangedAt: 100 }),
    ];
    orphanPrs(input, new Set());
    expect(input.map((r) => r.number)).toEqual([1, 2]);
  });
});

describe("prMark — a whole pull request as one tone and one word", () => {
  const run = (over: Partial<CheckRun>): CheckRun =>
    ({ name: "job", status: "completed", conclusion: "success", ...over }) as CheckRun;

  it("reads a settled PR off its state and stops there", () => {
    // Even with CI red underneath it: a merged PR's last run is history, and
    // this is a four-character column.
    expect(
      prMark(pr({ key: "k", state: "merged", checks: [run({ conclusion: "failure" })] })),
    ).toEqual({ tone: "success", label: "merged" });
    expect(prMark(pr({ key: "k", state: "closed" }))).toEqual({
      tone: "muted",
      label: "closed",
    });
  });

  it("ranks the things that stop a merge: requested changes over failing CI", () => {
    const both = pr({
      key: "k",
      reviewDecision: "changes_requested",
      checks: [run({ conclusion: "failure" })],
    });
    expect(prMark(both).label).toBe("changes requested");
  });

  it("reports failing CI over a run still going", () => {
    const mixed = pr({
      key: "k",
      checks: [run({ conclusion: "failure" }), run({ status: "in_progress" })],
    });
    expect(prMark(mixed)).toEqual({ tone: "danger", label: "CI failing" });
  });

  it("calls a draft a draft and a held PR held, before it looks at CI at all", () => {
    expect(prMark(pr({ key: "k", isDraft: true, checks: [run({})] })).label).toBe("draft");
    expect(prMark(pr({ key: "k", hold: true, checks: [run({})] })).label).toBe("on hold");
  });

  it("is plain 'open' with nothing to report — not green", () => {
    // No checks is not the same as passing: a PR opened a minute ago has no
    // runs yet, and a green mark there is a claim about CI that hasn't started.
    expect(prMark(pr({ key: "k" }))).toEqual({ tone: "accent", label: "open" });
    expect(prMark(pr({ key: "k", reviewDecision: "approved", checks: [run({})] }))).toEqual({
      tone: "success",
      label: "approved",
    });
  });
});
