import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, PRRef, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { PrReviewWatcher, type PrReviewGitHub } from "./pr-review-watcher.js";
import type { PrPollSnapshot } from "./github.js";
import { PrRegistry, PR_POLL_HOT_MS } from "./pr-registry.js";

let root: string;
let bus: EventBus;
let store: Store;
let events: WsServerEvent[];

/**
 * The per-signal script a test writes, assembled into the ONE snapshot the
 * watcher now polls.
 *
 * Deliberately still expressed per signal — "a review landed", "a check went
 * red" — because that is what each test is about, and because the signals do
 * still arrive independently from GitHub; they just arrive in one response now.
 * A script fn that THROWS stands for a read that failed, which must sink the
 * whole poll: with one query there is no such thing as half an answer.
 */
interface FakePrScript {
  prMergeState?: () => Promise<{ state: "open" | "closed" | "merged" } | null>;
  prChecks?: () => Promise<Array<{ name: string; status: string; conclusion?: string | null }>>;
  reviewThreads?: () => Promise<
    Array<{ id: string; isResolved: boolean; isOutdated?: boolean; path?: string; author?: string }>
  >;
  prReviewState?: () => Promise<{
    requested: string[];
    reported: Array<{ author: string; state: string }>;
  } | null>;
}

function fakeGitHub(over: FakePrScript = {}): PrReviewGitHub {
  return {
    pollPrState: async (repo, number) => {
      const merge = await (over.prMergeState ?? (async () => ({ state: "open" as const })))();
      if (!merge) return null;
      const checks = await (over.prChecks ?? (async () => []))();
      const threads = await (over.reviewThreads ?? (async () => []))();
      const review = await (over.prReviewState ??
        (async () => ({ requested: [], reported: [] })))();
      return {
        repo,
        number,
        url: `https://github.com/${repo}/pull/${number}`,
        title: "",
        branch: "feat/x",
        baseBranch: "main",
        state: merge.state,
        merged: merge.state === "merged",
        isDraft: false,
        labels: [],
        mergeable: null,
        reviewDecision: null,
        reviewers: [],
        threads: threads as PrPollSnapshot["threads"],
        checks: checks as PrPollSnapshot["checks"],
        requested: review?.requested ?? [],
        reported: review?.reported ?? [],
      };
    },
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

describe("PrReviewWatcher — arm", () => {
  // Review caught that `arm()` only called `stateFor`, which creates an EMPTY
  // state — so it was a no-op, and the first sweep after `create_pr` still
  // reported every pre-existing check, thread and review as brand-new activity.
  // Copilot reviews fast: on a busy repo the PR you just opened could badge you
  // for a comment that landed before the ref was even recorded.

  const NOISY = {
    prChecks: async () => [{ name: "build", status: "completed", conclusion: "failure" }],
    reviewThreads: async () => [
      { id: "T_1", isResolved: false, path: "src/app.ts", author: "copilot" },
    ],
    prReviewState: async () => ({
      requested: [],
      reported: [{ author: "copilot", state: "CHANGES_REQUESTED" }],
    }),
  };

  it("seeds the dedup state so the first sweep reports nothing pre-existing", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({ store, bus, github: fakeGitHub(NOISY) });

    await watcher.arm("c1", REF);
    await expect(watcher.sweep()).resolves.toEqual([]);
    expect(reviewItems()).toEqual([]);
  });

  it("still reports what happens AFTER arming", async () => {
    await makeChat("c1", [REF]);
    let threads = [{ id: "T_1", isResolved: false, path: "src/app.ts", author: "copilot" }];
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ ...NOISY, reviewThreads: async () => threads }),
    });

    await watcher.arm("c1", REF);
    // A SECOND thread lands after arming — the whole point is that this counts.
    threads = [
      ...threads,
      { id: "T_2", isResolved: false, path: "src/store.ts", author: "copilot" },
    ];

    const raised = await watcher.sweep();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.reasons.join(" ")).toMatch(/src\/store\.ts/);
    // ...and the pre-existing one is not re-reported alongside it.
    expect(raised[0]!.reasons.join(" ")).not.toMatch(/src\/app\.ts/);
  });

  it("is best-effort — unreadable reads leave the old behaviour, not a throw", async () => {
    await makeChat("c1", [REF]);
    const boom = async () => {
      throw new Error("boom");
    };
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ prChecks: boom, reviewThreads: boom, prReviewState: boom }),
    });

    await expect(watcher.arm("c1", REF)).resolves.toBeUndefined();
  });

  it("does nothing when the ref carries no repo", async () => {
    await makeChat("c1", [REF]);
    const watcher = new PrReviewWatcher({ store, bus, github: fakeGitHub(NOISY) });
    await expect(watcher.arm("c1", { ...REF, repo: undefined })).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------ feeding the PR catalog */

describe("PrReviewWatcher — the PR catalog", () => {
  /** Clock-injected so the catalog's cadence can be stepped rather than waited. */
  function withRegistry(over: FakePrScript = {}, opts: { discover?: PRRef[] } = {}) {
    let now = 1_000_000;
    const registry = new PrRegistry({ store, bus, now: () => now });
    const watcher = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub(over),
      registry,
      now: () => now,
      discover: opts.discover
        ? async () => opts.discover!.map((ref) => ({ projectId: "p1", ref }))
        : undefined,
    });
    return { registry, watcher, advance: (ms: number) => (now += ms) };
  }

  it("records every poll it makes, so the catalog is a by-product of watching", async () => {
    await makeChat("c1", [REF]);
    const { registry, watcher } = withRegistry({
      prChecks: async () => [{ name: "build", status: "completed", conclusion: "failure" }],
    });

    await watcher.sweep();

    const rows = await registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "octo/repo#42", chatId: "c1", projectId: "p1" });
    expect(rows[0]!.checks[0]).toMatchObject({ name: "build", conclusion: "failure" });
  });

  it("puts a brand-new PR in the catalog AND polls it on the same sweep", async () => {
    // Waiting a cadence it has no state to justify would leave a just-opened PR
    // missing from the list for as long as the backoff said.
    await makeChat("c1", [REF]);
    const { registry, watcher } = withRegistry();

    await watcher.sweep();

    expect((await registry.list())[0]!.lastPolledAt).toBeGreaterThan(0);
  });

  it("honours the catalog's cadence — a parked PR is not re-polled every sweep", async () => {
    await makeChat("c1", [REF]);
    let polls = 0;
    const { watcher, advance } = withRegistry({
      prMergeState: async () => {
        polls += 1;
        return { state: "open" as const };
      },
    });

    await watcher.sweep();
    expect(polls).toBe(1);
    // Immediately again: nothing is due, so nothing is asked of GitHub.
    await watcher.sweep();
    expect(polls).toBe(1);
    // Once its turn comes round, it is polled again.
    advance(PR_POLL_HOT_MS);
    await watcher.sweep();
    expect(polls).toBe(2);
  });

  it("discovers open PRs no chat owns, and shows them unattributed", async () => {
    // Retiring the project-wide overlay must not lose sight of a human's PR or
    // a bot's — they are listed exactly as an `external` worktree is.
    const foreign: PRRef = { ...REF, number: 99, title: "somebody else's" };
    const { registry, watcher } = withRegistry({}, { discover: [foreign] });

    await watcher.sweep();

    const rows = await registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 99, projectId: "p1" });
    expect(rows[0]!.chatId).toBeUndefined();
  });

  it("raises NO attention for a discovered PR — nobody owns it to wake", async () => {
    const foreign: PRRef = { ...REF, number: 99 };
    const { watcher } = withRegistry(
      { reviewThreads: async () => [{ id: "T_1", isResolved: false, author: "someone" }] },
      { discover: [foreign] },
    );

    expect(await watcher.sweep()).toEqual([]);
    expect(reviewItems()).toEqual([]);
  });

  it("does not let discovery orphan a PR a chat owns", async () => {
    await makeChat("c1", [REF]);
    // The same PR turns up in the project-wide sweep, which knows no chat.
    const { registry, watcher } = withRegistry({}, { discover: [REF] });

    await watcher.sweep();

    const rows = await registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chatId).toBe("c1");
  });

  it("marks a row stale when the poll fails, rather than silently keeping old state", async () => {
    await makeChat("c1", [REF]);
    const { registry, watcher, advance } = withRegistry();
    await watcher.sweep();

    // Now GitHub goes dark.
    const dark = new PrReviewWatcher({
      store,
      bus,
      github: fakeGitHub({ prMergeState: async () => null }),
      registry,
    });
    advance(PR_POLL_HOT_MS);
    await dark.sweep();

    expect((await registry.list())[0]!.pollError).toContain("could not be read");
  });
});
