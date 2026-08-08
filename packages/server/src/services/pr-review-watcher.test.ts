import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, PRRef, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { PrReviewWatcher, type PrReviewGitHub } from "./pr-review-watcher.js";

let root: string;
let bus: EventBus;
let store: Store;
let events: WsServerEvent[];

/** A scriptable GitHub surface whose per-PR answers each test mutates in place. */
function fakeGitHub(over: Partial<PrReviewGitHub> = {}): PrReviewGitHub {
  return {
    prMergeState: async () => ({ state: "open" as const }),
    prChecks: async () => [],
    reviewThreads: async () => [],
    prReviewState: async () => ({ requested: [], reported: [] }),
    ...over,
  };
}

async function makeChat(id: string, prs: PRRef[]): Promise<Chat> {
  return store.saveChat({
    id,
    projectId: "p1",
    title: id,
    modeId: "default",
    effort: "medium",
    worktrees: [],
    prs,
    createdAt: 1,
  } as Chat);
}

const REF: PRRef = {
  number: 42,
  url: "https://github.com/octo/repo/pull/42",
  branch: "feat/x",
  repo: "octo/repo",
  state: "open",
};

const reviewItems = (): Array<Extract<WsServerEvent, { type: "attention-add" }>["item"]> =>
  events
    .filter((e): e is Extract<WsServerEvent, { type: "attention-add" }> => e.type === "attention-add")
    .map((e) => e.item)
    .filter((i) => i.kind === "review");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-prwatch-"));
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  store = new Store(join(root, "data"));
  await store.init?.();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PrReviewWatcher — noticing", () => {
  it("raises a `review` attention item when a review lands", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prReviewState: async () => ({
          requested: [],
          reported: [{ author: "copilot", state: "CHANGES_REQUESTED" }],
        }),
      }),
    });

    const raised = await watcher.sweep();
    expect(raised.map((r) => r.chatId)).toEqual(["c1"]);
    const items = reviewItems();
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ chatId: "c1", kind: "review", prNumber: 42, url: REF.url });
    expect(items[0].summary).toMatch(/copilot changes requested/);
  });

  it("raises one when a new unresolved review thread appears", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        reviewThreads: async () => [
          { id: "T_1", isResolved: false, path: "src/app.ts", author: "copilot" },
        ],
      }),
    });

    await watcher.sweep();
    expect(reviewItems()[0].summary).toMatch(/review comment from copilot on src\/app\.ts/);
  });

  it("raises one when a check fails", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prChecks: async () => [{ name: "build", status: "completed", conclusion: "failure" }],
      }),
    });

    await watcher.sweep();
    expect(reviewItems()[0].summary).toMatch(/check "build" failure/);
  });

  it("says nothing when nothing new happened", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({ store, bus, github: fakeGitHub() });
    expect(await watcher.sweep()).toEqual([]);
    expect(reviewItems()).toEqual([]);
  });

  it("ignores resolved and outdated threads, and passing checks", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prChecks: async () => [{ name: "build", status: "completed", conclusion: "success" }],
        reviewThreads: async () => [
          { id: "T_done", isResolved: true },
          { id: "T_old", isResolved: false, isOutdated: true },
        ],
      }),
    });
    expect(await watcher.sweep()).toEqual([]);
  });

  it("stays silent when a `gh` read fails — a false badge is worse than none", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prMergeState: async () => null,
        reviewThreads: async () => {
          throw new Error("gh exploded");
        },
      }),
    });
    expect(await watcher.sweep()).toEqual([]);
    expect(reviewItems()).toEqual([]);
  });

  it("skips PRs already recorded as merged/closed, and settles ones that just landed", async () => {
    await makeChat("c1", [{ ...REF, state: "merged" }]);
    let polled = 0;
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prMergeState: async () => {
          polled += 1;
          return { state: "open" as const };
        },
      }),
    });
    await watcher.sweep();
    // A chat with a year of landed PRs must not cost a `gh` call per PR per sweep.
    expect(polled).toBe(0);

    await makeChat("c2", [REF]);
    const settling = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ prMergeState: async () => ({ state: "merged" as const }) }),
    });
    await settling.sweep();
    expect((await store.getChat("c2"))?.prs[0].state).toBe("merged");
  });
});

describe("PrReviewWatcher — dedup", () => {
  it("reports each thread, review and failing check EXACTLY once", async () => {
    // A badge that re-fires forever is worse than none: it trains the human to
    // ignore the badge, which is the very thing being fixed.
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prChecks: async () => [{ name: "build", status: "completed", conclusion: "failure" }],
        reviewThreads: async () => [{ id: "T_1", isResolved: false, author: "copilot" }],
        prReviewState: async () => ({
          requested: [],
          reported: [{ author: "copilot", state: "COMMENTED" }],
        }),
      }),
    });

    expect((await watcher.sweep()).length).toBe(1);
    expect((await watcher.sweep()).length).toBe(0);
    expect((await watcher.sweep()).length).toBe(0);
    expect(reviewItems().length).toBe(1);
  });

  it("fires again for the NEXT round — the failure this exists to catch", async () => {
    // "Fixed the comments, then went silent on the next round" is the exact
    // shape of the bug: round two must reach the human.
    await makeChat("c1", [REF]);
    let threads: Array<{ id: string; isResolved: boolean; author?: string }> = [
      { id: "T_1", isResolved: false, author: "copilot" },
    ];
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ reviewThreads: async () => threads }),
    });

    expect((await watcher.sweep()).length).toBe(1);
    threads = [...threads, { id: "T_2", isResolved: false, author: "copilot" }];
    const second = await watcher.sweep();
    expect(second.length).toBe(1);
    expect(second[0].reasons.length).toBe(1);
    // Distinct ids, so the queue's dedup-by-id can't swallow the second round.
    const ids = reviewItems().map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("re-fires a check that flips from passing to failing", async () => {
    await makeChat("c1", [REF]);
    let conclusion = "success";
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prChecks: async () => [{ name: "build", status: "completed", conclusion }],
      }),
    });

    expect(await watcher.sweep()).toEqual([]);
    conclusion = "failure";
    expect((await watcher.sweep()).length).toBe(1);
    // …but not a second time for the same red build.
    expect(await watcher.sweep()).toEqual([]);
  });

  it("treats an unsubmitted (PENDING) review as no activity", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prReviewState: async () => ({ requested: [], reported: [{ author: "r", state: "PENDING" }] }),
      }),
    });
    expect(await watcher.sweep()).toEqual([]);
  });

  it("keeps dedup state per chat, so two chats each get told once", async () => {
    await makeChat("c1", [REF]);
    await makeChat("c2", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        reviewThreads: async () => [{ id: "T_1", isResolved: false }],
      }),
    });
    expect((await watcher.sweep()).map((r) => r.chatId).sort()).toEqual(["c1", "c2"]);
    expect(await watcher.sweep()).toEqual([]);
  });
});

describe("PrReviewWatcher — auto-resume", () => {
  it("wakes ONLY the chat whose own `prs` carries the PR", async () => {
    // Chosen deliberately over blanket auto-resume: `Chat.prs` is the ownership
    // record, and waking unrelated chats about someone else's review round is
    // how an autonomy feature becomes a nuisance.
    await makeChat("owner", [REF]);
    await makeChat("bystander", []);
    const woken: string[] = [];
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        reviewThreads: async () => [{ id: "T_1", isResolved: false, author: "copilot" }],
      }),
      resume: async (chatId) => {
        woken.push(chatId);
      },
    });

    await watcher.sweep();
    expect(woken).toEqual(["owner"]);
    // The bystander got neither a badge nor a nudge.
    expect(reviewItems().map((i) => i.chatId)).toEqual(["owner"]);
  });

  it("tells the woken chat what happened and how to work the round", async () => {
    await makeChat("owner", [REF]);
    const prompts: string[] = [];
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        prChecks: async () => [{ name: "build", status: "completed", conclusion: "failure" }],
      }),
      resume: async (_chatId, text) => {
        prompts.push(text);
      },
    });

    await watcher.sweep();
    expect(prompts[0]).toMatch(/PR #42/);
    expect(prompts[0]).toMatch(/check "build" failure/);
    expect(prompts[0]).toMatch(/watch_pr/);
  });

  it("badges but does NOT nudge a chat that's already mid-turn", async () => {
    // It's already working — very possibly inside watch_pr. Queuing a message
    // behind that helps nobody.
    await makeChat("owner", [REF]);
    const woken: string[] = [];
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        reviewThreads: async () => [{ id: "T_1", isResolved: false }],
      }),
      resume: async (chatId) => {
        woken.push(chatId);
      },
      isBusy: () => true,
    });

    await watcher.sweep();
    expect(woken).toEqual([]);
    expect(reviewItems().length).toBe(1);
  });

  it("leaves the badge standing when the resume itself fails", async () => {
    await makeChat("owner", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({
        reviewThreads: async () => [{ id: "T_1", isResolved: false }],
      }),
      resume: async () => {
        throw new Error("no session");
      },
    });

    await watcher.sweep();
    expect(reviewItems().length).toBe(1);
    expect(
      events.some((e) => e.type === "notice" && /Could not resume this chat/.test(e.text)),
    ).toBe(true);
  });

  it("does nothing at all when no resume seam is wired", async () => {
    await makeChat("owner", [REF]);
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ reviewThreads: async () => [{ id: "T_1", isResolved: false }] }),
    });
    await expect(watcher.sweep()).resolves.toHaveLength(1);
  });
});
