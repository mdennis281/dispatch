import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ChatStatus,
  CheckRun,
  ReviewThread,
  WsServerEvent,
  ProjectMemory,
} from "@dispatch/shared";
import { EventBus } from "../../bus.js";
import { memorySimilarity } from "../memory.js";
import {
  createManagerTools,
  createManagerMcpServer,
  prLandingBlockers,
  overrideConsentPrompt,
  prCreateBlockers,
  WAIT_CAP_SECONDS,
  PR_POLL_INTERVAL_MS,
  NO_CHECKS_GRACE_MS,
  type ManagerMcpBroker,
  type ManagerMcpMemory,
  type ManagerMcpGitHub,
  type ManagerMcpPrApproval,
  type ManagerMcpPrCreate,
  type PrPollResult,
  type PrReadiness,
  type PrLandingPolicy,
  type PrLandingBlocker,
  type PrCreateState,
  type PrCreateResult,
  type ManagerMcpChats,
  type SpawnChatConsent,
  type SpawnChatRequest,
  type SpawnChatTarget,
} from "./manager-mcp.js";

/* ------------------------------------------------------------------ fixtures */

let bus: EventBus;
let events: WsServerEvent[];

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

/** A scriptable broker whose per-chat status the test controls. */
function fakeBroker(states: Record<string, ChatStatus>): ManagerMcpBroker {
  return {
    has: (id) => id in states,
    getStatus: (id) => states[id],
    getContextUsage: async () => null,
    compact: () => {},
    markPrWatched: () => {},
  };
}

function resultText(res: CallToolResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

function statusLabels(): string[] {
  return events
    .filter((e): e is Extract<WsServerEvent, { type: "chat-status" }> => e.type === "chat-status")
    .map((e) => e.activity?.label ?? "");
}

/* -------------------------------------------------------------------- wait */

describe("manager-mcp — wait", () => {
  it("resolves after the delay and publishes a waiting chat-status", async () => {
    const { wait } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });

    const res = await wait.handler({ seconds: 0.02, reason: "CI to settle" }, {});

    expect(resultText(res)).toContain("Waited 0.02s");
    expect(resultText(res)).toContain("CI to settle");
    // The self-imposed pause surfaces via the working/typing status header.
    expect(statusLabels().some((l) => l === "waiting 0.02s: CI to settle")).toBe(true);
  });

  it("clamps seconds to the cap", async () => {
    const { wait } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    // A huge request would hang forever if not clamped — but we abort immediately
    // to keep the test fast while still exercising the clamp in the status label.
    const ac = new AbortController();
    const p = wait.handler({ seconds: 999_999, reason: undefined }, { signal: ac.signal });
    ac.abort();
    await p;
    expect(statusLabels().some((l) => l === `waiting ${WAIT_CAP_SECONDS}s`)).toBe(true);
  });

  it("cancels the wait when the session signal aborts (clears the timer)", async () => {
    const ac = new AbortController();
    const { wait } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      signal: ac.signal,
    });

    // 100s would exceed the test timeout if the abort didn't unwind the timer.
    const p = wait.handler({ seconds: 100, reason: "long" }, {});
    ac.abort();
    const res = await p;

    expect(resultText(res)).toContain("cancelled");
  });

  it("also cancels via the MCP request's extra.signal", async () => {
    const { wait } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const ac = new AbortController();
    const p = wait.handler({ seconds: 100, reason: undefined }, { signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });
});

/* ------------------------------------------------------------ wait_for_chat */

describe("manager-mcp — wait_for_chat", () => {
  it("resolves when the target chat transitions to a terminal state", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    // Subscription is registered synchronously before the handler awaits, so a
    // status published now is observed.
    bus.publish({ type: "chat-status", chatId: "c2", status: "done" });
    const res = await p;

    expect(resultText(res)).toContain('Chat c2 reached state "done"');
    expect(resultText(res)).toContain('"finalState":"done"');
    expect(resultText(res)).toContain('"timedOut":false');
  });

  it("ignores status of OTHER chats while waiting", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: 0.05 }, {});
    // A terminal state on an unrelated chat must NOT resolve this wait.
    bus.publish({ type: "chat-status", chatId: "c9", status: "done" });
    const res = await p;

    // Only the timeout should end it (c2 never went terminal).
    expect(resultText(res)).toContain("Timed out");
  });

  it("resolves immediately when the chat is already at rest", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "idle" }),
    });

    const res = await waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    expect(resultText(res)).toContain('Chat c2 reached state "idle"');
    expect(resultText(res)).toContain('"timedOut":false');
  });

  it("returns an informative (error) result for an unknown chatId", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });

    const res = await waitForChat.handler({ chatId: "ghost", timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown chatId "ghost"');
  });

  it("times out and reports the last known state", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const res = await waitForChat.handler({ chatId: "c2", timeoutSeconds: 0.02 }, {});
    expect(resultText(res)).toContain("Timed out waiting for chat c2");
    expect(resultText(res)).toContain("running");
    expect(resultText(res)).toContain('"timedOut":true');
  });

  it("cancels when the session signal aborts", async () => {
    const ac = new AbortController();
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
      signal: ac.signal,
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });
});

/* --------------------------------------------------------------- watch_pr */

/** One poll's worth of PR state the fake serves; advances on each merge-poll. */
interface PollSnap {
  merge: PrPollResult | null;
  /** `undefined` → []; `null` → a transient read failure the watcher tolerates. */
  checks?: CheckRun[] | null;
  threads?: ReviewThread[] | null;
}

/**
 * A scriptable ManagerMcpGitHub. `prMergeState` advances to the next snapshot on
 * each call (the watcher polls it first every iteration); `prChecks`/
 * `reviewThreads` read the CURRENT snapshot, so one snapshot = one poll cycle.
 */
function fakeGitHub(
  snaps: PollSnap[],
): ManagerMcpGitHub & { calls: { number: number; repo?: string }[] } {
  const calls: { number: number; repo?: string }[] = [];
  let idx = -1;
  const cur = (): PollSnap => snaps[Math.min(Math.max(idx, 0), snaps.length - 1)]!;
  return {
    calls,
    prMergeState: async (n, repo) => {
      calls.push({ number: n, repo });
      idx = Math.min(idx + 1, snaps.length - 1);
      return cur().merge;
    },
    prChecks: async () => (cur().checks === undefined ? [] : cur().checks!),
    reviewThreads: async () => (cur().threads === undefined ? [] : cur().threads!),
  };
}

const OPEN: PrPollResult = { number: 83, state: "open", merged: false };
const FAIL_BUILD: CheckRun = {
  name: "build",
  status: "completed",
  conclusion: "failure",
  url: "https://ci/build",
};
const PASS_BUILD: CheckRun = { name: "build", status: "completed", conclusion: "success" };
const PASS_LINT: CheckRun = { name: "lint", status: "completed", conclusion: "success" };
const RUNNING_BUILD: CheckRun = { name: "build", status: "in_progress" };
const THREAD_A: ReviewThread = {
  id: "T_A",
  isResolved: false,
  path: "src/a.ts",
  line: 10,
  author: "Copilot",
  body: "nit: rename this",
};
const THREAD_B: ReviewThread = {
  id: "T_B",
  isResolved: false,
  path: "src/b.ts",
  line: 3,
  author: "Copilot",
  body: "possible bug",
};

describe("manager-mcp — watch_pr", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the instant a check fails (done:false) and shows a watching status", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: [FAIL_BUILD], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("needs attention");
    expect(resultText(res)).toContain('check "build"');
    expect(resultText(res)).toContain('"done":false');
    expect(resultText(res)).toContain('"type":"ci-failed"');
    expect(vi.getTimerCount()).toBe(0);
    expect(statusLabels().some((l) => l === "watching PR #83")).toBe(true);
  });

  it("returns on a new unresolved review comment and ignores resolved threads", async () => {
    const resolved: ReviewThread = { id: "T_done", isResolved: true, path: "z.ts", line: 1 };
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [resolved, THREAD_A] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});

    expect(resultText(res)).toContain('"type":"review-comment"');
    expect(resultText(res)).toContain('"threadId":"T_A"');
    expect(resultText(res)).not.toContain("T_done"); // resolved thread is not actionable
  });

  it("dedups handled activity and surfaces only NEW items on the next call", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [FAIL_BUILD], threads: [THREAD_A] }, // call 1 → build + T_A
      { merge: OPEN, checks: [FAIL_BUILD], threads: [THREAD_A, THREAD_B] }, // call 2 → only T_B
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const first = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    expect(resultText(first)).toContain('"threadId":"T_A"');
    expect(resultText(first)).toContain('check "build"');

    const second = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    expect(resultText(second)).toContain('"threadId":"T_B"');
    // The already-reported check + thread must NOT fire again.
    expect(resultText(second)).not.toContain('"threadId":"T_A"');
    expect(resultText(second)).not.toContain("ci-failed");
  });

  it("returns immediately when CI already finished green (no quiet-window block)", async () => {
    // The regression: a watch started AFTER a fast run finished used to sit here
    // until the timeout, because only FAILURE counted as activity.
    const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD, PASS_LINT], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('"type":"ci-passed"');
    expect(resultText(res)).toContain('"checksPassing":true');
    expect(resultText(res)).toContain("all 2 check(s) passing");
    expect(resultText(res)).toContain('"done":false'); // green ≠ merged
    expect(resultText(res)).not.toContain("needs attention"); // nothing to fix
    expect(gh.calls.length).toBe(1); // resolved on the very first poll
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiting while a check is still running", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_LINT, RUNNING_BUILD], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await p;

    // "Passing" while a job could still go red would be a lie.
    expect(resultText(res)).not.toContain("ci-passed");
    expect(resultText(res)).toContain('"timedOut":true');
  });

  it("reports green once, not on every re-call", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [PASS_BUILD], threads: [] },
      { merge: OPEN, checks: [PASS_BUILD], threads: [] },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const first = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    expect(resultText(first)).toContain('"type":"ci-passed"');

    // Unchanged green must not re-fire — otherwise the "call until done:true"
    // loop the tool asks for becomes a spin.
    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await p;
    expect(resultText(second)).not.toContain("ci-passed");
    expect(resultText(second)).toContain('"timedOut":true');
  });

  it("re-reports green when a new check joins the set", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [PASS_BUILD], threads: [] },
      { merge: OPEN, checks: [PASS_BUILD, PASS_LINT], threads: [] },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    const second = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});

    expect(resultText(second)).toContain('"type":"ci-passed"');
    expect(resultText(second)).toContain("lint");
  });

  it("reports the fix: a failing check that later goes green", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [FAIL_BUILD], threads: [] },
      { merge: OPEN, checks: [PASS_BUILD], threads: [] },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const first = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    expect(resultText(first)).toContain('"type":"ci-failed"');

    const second = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    expect(resultText(second)).toContain('"type":"ci-passed"');
    expect(resultText(second)).toContain('"checksPassing":true');
  });

  it("says so once when a PR has no checks at all, after the grace window", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(NO_CHECKS_GRACE_MS);
    const res = await p;

    expect(resultText(res)).toContain("no CI checks configured");
    expect(resultText(res)).toContain('"done":false');

    // Told once; the next watch goes back to waiting quietly.
    const again = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 120 }, {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resultText(await again)).not.toContain("no CI checks configured");
  });

  it("does not mistake an unreadable checks call for a PR without checks", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: null, threads: null }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 120 }, {});
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await p;

    expect(resultText(res)).not.toContain("no CI checks configured");
    expect(resultText(res)).toContain('"timedOut":true');
  });

  it("resolves done:true when the PR merges", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [], threads: [] },
      { merge: OPEN, checks: [], threads: [] },
      {
        merge: { number: 83, state: "merged", merged: true, mergedAt: "2026-07-05T21:00:00Z" },
      },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS); // poll 1 → sleep → poll 2
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS); // → poll 3 (merged) → settle
    const res = await p;

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('reached terminal state "merged"');
    expect(resultText(res)).toContain('"done":true');
    expect(resultText(res)).toContain('"mergedAt":"2026-07-05T21:00:00Z"');
    expect(gh.calls.length).toBe(3);
    expect(vi.getTimerCount()).toBe(0); // no strays — deadline is checked, not timed
  });

  it("resolves done:true (unmerged) when the PR is closed", async () => {
    const gh = fakeGitHub([{ merge: { number: 5, state: "closed", merged: false } }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 5, repo: undefined, timeoutSeconds: 1800 }, {});

    expect(resultText(res)).toContain('reached terminal state "closed"');
    expect(resultText(res)).toContain('"done":true');
    expect(resultText(res)).not.toContain("mergedAt");
  });

  it("marks the chat PR-watched on a terminal outcome, but not on a timeout", async () => {
    const watched: string[] = [];
    const spyBroker: ManagerMcpBroker = { ...fakeBroker({}), markPrWatched: (id) => watched.push(id) };

    // Terminal (merged) → flag the chat so its dot can go green once idle.
    const merged = fakeGitHub([{ merge: { number: 7, state: "merged", merged: true } }]);
    const { watchPr: watchMerged } = createManagerTools({
      chatId: "c1",
      bus,
      broker: spyBroker,
      github: merged,
    });
    await watchMerged.handler({ number: 7, repo: undefined, timeoutSeconds: 1800 }, {});
    expect(watched).toEqual(["c1"]);

    // Timeout (still open, no activity) → NOT settled; the agent is told to re-watch.
    const openGh = fakeGitHub([{ merge: OPEN, checks: [], threads: [] }]);
    const { watchPr: watchOpen } = createManagerTools({
      chatId: "c2",
      bus,
      broker: spyBroker,
      github: openGh,
    });
    const p = watchOpen.handler({ number: 8, repo: undefined, timeoutSeconds: 50 }, {});
    await vi.advanceTimersByTimeAsync(50_000);
    await p;
    expect(watched).toEqual(["c1"]); // unchanged — no c2
  });

  it("quietly times out with done:false/timedOut:true when nothing happens", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 50 }, {});
    await vi.advanceTimersByTimeAsync(50_000); // polls at 0/20/40s, then the deadline
    const res = await p;

    expect(res.isError).toBeFalsy(); // a quiet window is not an error
    expect(resultText(res)).toContain("No new activity on PR #83");
    expect(resultText(res)).toContain('"timedOut":true');
    expect(resultText(res)).toContain('"done":false');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolerates a transient null checks/threads read and keeps watching", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: null, threads: null }, // transient gh hiccup — not fatal
      { merge: { number: 83, state: "merged", merged: true } },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS); // poll 1 (null) → sleep → poll 2 (merged)
    const res = await p;

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('"done":true');
  });

  it("cancels promptly on session abort", async () => {
    const ac = new AbortController();
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [] }]);
    const { watchPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      signal: ac.signal,
    });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: undefined }, {});
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also cancels via the MCP request's extra.signal", async () => {
    const ac = new AbortController();
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler(
      { number: 83, repo: undefined, timeoutSeconds: undefined },
      { signal: ac.signal },
    );
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });

  it("returns an informative error when the merge poll throws (gh error)", async () => {
    const gh: ManagerMcpGitHub = {
      prMergeState: async () => {
        throw new Error("gh: not authenticated");
      },
      prChecks: async () => [],
      reviewThreads: async () => [],
    };
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 77, repo: undefined, timeoutSeconds: undefined }, {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Could not watch PR #77");
    expect(resultText(res)).toContain("not authenticated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an informative error for an unknown PR (null merge state)", async () => {
    const gh = fakeGitHub([{ merge: null }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 999, repo: undefined, timeoutSeconds: undefined }, {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("PR not found");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes an explicit owner/name override through and labels it", async () => {
    const gh = fakeGitHub([{ merge: { number: 42, state: "merged", merged: true } }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    await watchPr.handler({ number: 42, repo: "octo/repo", timeoutSeconds: undefined }, {});

    expect(gh.calls[0]).toEqual({ number: 42, repo: "octo/repo" });
    expect(statusLabels().some((l) => l === "watching PR #42 (octo/repo)")).toBe(true);
  });

  it("validates a positive integer PR number", async () => {
    const gh = fakeGitHub([{ merge: null }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 0, repo: undefined, timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("positive integer");
    expect(gh.calls.length).toBe(0); // never polled
  });

  it("reports unavailable when no GitHubService is wired", async () => {
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await watchPr.handler({ number: 1, repo: undefined, timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });
});

/* ------------------------------------------------------------ approve_pr */

/** A ready-to-land PR; each test overrides just the field it's exercising. */
function readyPr(over: Partial<PrReadiness> = {}): PrReadiness {
  return {
    number: 83,
    url: "https://github.com/octo/repo/pull/83",
    title: "feat: thing",
    state: "open",
    isDraft: false,
    mergeable: true,
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: [],
    checks: [PASS_BUILD],
    threads: [],
    // Default to "a reviewer reported" so the pre-existing landing tests keep
    // exercising the blocker they were written for, not the new review gate.
    requestedReviewers: [],
    submittedReviews: [{ author: "copilot-pull-request-reviewer", state: "APPROVED" }],
    ...over,
  };
}

/** A scriptable approval binding that records what it was asked to do. */
function fakeApproval(
  pr: PrReadiness | null,
  opts: {
    approved?: boolean;
    mergeError?: string;
    policy?: PrLandingPolicy;
    /** What the human says to an override card. Defaults to yes. */
    consent?: { approved: boolean; message?: string };
    /** Make the consent ask THROW, standing in for a dead session. */
    consentThrows?: string;
  } = {},
) {
  const calls: {
    approve: { n: number; body: string }[];
    merge: { n: number; method: string }[];
    confirm: { n: number; codes: string[] }[];
  } = {
    approve: [],
    merge: [],
    confirm: [],
  };
  const binding: ManagerMcpPrApproval = {
    defaultMethod: "squash",
    policy: opts.policy ?? {},
    confirmOverride: async ({ number, blockers }) => {
      calls.confirm.push({ n: number, codes: blockers.map((b) => b.code) });
      if (opts.consentThrows) throw new Error(opts.consentThrows);
      return opts.consent ?? { approved: true };
    },
    readiness: async () => pr,
    approve: async (n, _repo, body) => {
      calls.approve.push({ n, body });
      return opts.approved === false
        ? { approved: false, error: "can not approve your own pull request" }
        : { approved: true };
    },
    merge: async (n, _repo, method) => {
      calls.merge.push({ n, method });
      if (opts.mergeError) throw new Error(opts.mergeError);
    },
  };
  return { binding, calls };
}

const approveArgs = (over: Record<string, unknown> = {}) => ({
  number: 83,
  repo: undefined,
  method: undefined,
  note: undefined,
  allowNoChecks: undefined,
  allowNoReview: undefined,
  ...over,
});

describe("prLandingBlockers", () => {
  it("clears a green, unblocked, open PR", () => {
    expect(prLandingBlockers(readyPr())).toEqual([]);
  });

  it("reports EVERY blocker at once rather than the first", () => {
    // One complete to-do list beats discovering the next obstacle per round-trip.
    const codes = prLandingBlockers(
      readyPr({
        isDraft: true,
        checks: [FAIL_BUILD],
        threads: [THREAD_A],
        mergeable: false,
      }),
    ).map((b) => b.code);
    expect(codes).toEqual(
      expect.arrayContaining(["draft", "checks-failing", "unresolved-threads", "conflict"]),
    );
  });

  it("honours the `hold` label, case-insensitively", () => {
    const b = prLandingBlockers(readyPr({ labels: ["Hold"] }));
    expect(b.map((x) => x.code)).toContain("hold");
    // …and says not to route around it.
    expect(b.find((x) => x.code === "hold")!.detail).toMatch(/do not remove the label/i);
  });

  it("blocks on a pending check — green so far is not green", () => {
    expect(
      prLandingBlockers(readyPr({ checks: [PASS_BUILD, { name: "e2e", status: "in_progress" }] }))
        .map((b) => b.code),
    ).toEqual(["checks-pending"]);
  });

  it("fails CLOSED when the review threads can't be read", () => {
    // Everywhere else a failed read means "nothing new"; merging over comments we
    // simply couldn't fetch is the one mistake this must not make.
    expect(prLandingBlockers(readyPr({ threads: null })).map((b) => b.code)).toEqual([
      "threads-unreadable",
    ]);
  });

  it("ignores resolved and outdated threads", () => {
    const resolved: ReviewThread = { id: "T_done", isResolved: true };
    const outdated: ReviewThread = { id: "T_old", isResolved: false, isOutdated: true };
    expect(prLandingBlockers(readyPr({ threads: [resolved, outdated] }))).toEqual([]);
  });

  it("blocks on changes-requested", () => {
    expect(
      prLandingBlockers(readyPr({ reviewDecision: "changes_requested" })).map((b) => b.code),
    ).toContain("changes-requested");
  });

  it("says only 'already merged' for a settled PR, without piling on", () => {
    const b = prLandingBlockers(readyPr({ state: "merged", checks: [FAIL_BUILD], threads: null }));
    expect(b.map((x) => x.code)).toEqual(["not-open"]);
  });

  /* ---- the "vacuous green" hardening (requireChecks / requireReview) ---- */

  it("distinguishes 'checks passed' from 'NO checks reported' under requireChecks", () => {
    // The observed failure: on a repo where zero checks report, `on-green` was a
    // promise about nothing and this would have waved the PR straight through.
    const noChecks = readyPr({ checks: [] });
    expect(prLandingBlockers(noChecks, { requireChecks: false })).toEqual([]);
    const blocked = prLandingBlockers(noChecks, { requireChecks: true });
    expect(blocked.map((b) => b.code)).toEqual(["no-checks"]);
    // …and it names the override rather than being a dead end.
    expect(blocked[0].detail).toMatch(/allowNoChecks: true/);
  });

  it("lets the caller override the no-checks refusal explicitly", () => {
    expect(
      prLandingBlockers(readyPr({ checks: [] }), {
        requireChecks: true,
        allowNoChecks: true,
      }),
    ).toEqual([]);
  });

  it("still blocks a PASSING check set from being called 'no checks'", () => {
    // requireChecks must not fire when checks exist and are green.
    expect(prLandingBlockers(readyPr({ checks: [PASS_BUILD] }), { requireChecks: true })).toEqual([]);
  });

  it("refuses to land under requireReview when nobody has reported", () => {
    const unreviewed = readyPr({
      submittedReviews: [],
      requestedReviewers: ["copilot-pull-request-reviewer"],
    });
    expect(prLandingBlockers(unreviewed, { requireReview: false })).toEqual([]);
    const blocked = prLandingBlockers(unreviewed, { requireReview: true });
    expect(blocked.map((b) => b.code)).toEqual(["no-review"]);
    // It says WHO we're waiting on, and names the override.
    expect(blocked[0].detail).toMatch(/copilot-pull-request-reviewer/);
    expect(blocked[0].detail).toMatch(/allowNoReview: true/);
  });

  it("points at create_pr when nobody was ASKED but reviewers ARE configured", () => {
    const b = prLandingBlockers(readyPr({ submittedReviews: [], requestedReviewers: [] }), {
      requireReview: true,
      reviewers: ["copilot-pull-request-reviewer[bot]"],
    });
    expect(b[0].detail).toMatch(/copilot-pull-request-reviewer/);
    expect(b[0].detail).toMatch(/create_pr/);
  });

  // The loop that actually happened: this project configured NO reviewers, so
  // "re-open it through create_pr so the configured reviewers are asked" was
  // advice that could never come true — there were none to ask. The agent read
  // the dead end for what it was and reached for the override instead.
  it("names the EMPTY reviewer list as the fault when there is nobody to ask", () => {
    const b = prLandingBlockers(readyPr({ submittedReviews: [], requestedReviewers: [] }), {
      requireReview: true,
      reviewers: [],
    });
    expect(b[0].detail).toMatch(/configures NO reviewers/);
    expect(b[0].detail).toMatch(/workflow\.pr\.reviewers/);
    // It must NOT send the agent back to create_pr, which would change nothing.
    expect(b[0].detail).not.toMatch(/create_pr/);
  });

  it("tells the agent to WAIT when a requested reviewer just hasn't reported", () => {
    const b = prLandingBlockers(
      readyPr({ submittedReviews: [], requestedReviewers: ["copilot-pull-request-reviewer"] }),
      { requireReview: true, reviewers: ["copilot-pull-request-reviewer"] },
    );
    expect(b[0].detail).toMatch(/watch_pr/);
  });

  it("treats a PENDING (unsubmitted) review as nobody having reviewed", () => {
    // A draft review is invisible to everyone but its author.
    const b = prLandingBlockers(
      readyPr({ submittedReviews: [{ author: "someone", state: "PENDING" }] }),
      { requireReview: true },
    );
    expect(b.map((x) => x.code)).toEqual(["no-review"]);
  });

  it("accepts any SUBMITTED review as 'someone looked'", () => {
    // COMMENTED counts: the point of the gate is that a human/bot engaged, not
    // that they blessed it — `changes_requested` is caught by its own blocker.
    for (const state of ["APPROVED", "COMMENTED"]) {
      expect(
        prLandingBlockers(readyPr({ submittedReviews: [{ author: "r", state }] }), {
          requireReview: true,
        }),
        state,
      ).toEqual([]);
    }
  });

  it("reports the no-checks AND no-review refusals together", () => {
    const codes = prLandingBlockers(
      readyPr({ checks: [], submittedReviews: [], requestedReviewers: [] }),
      { requireChecks: true, requireReview: true },
    ).map((b) => b.code);
    expect(codes).toEqual(["no-checks", "no-review"]);
  });

  // Review caught this: an unreadable review state used to be coerced to
  // `{ requested: [], reported: [] }`, which reads downstream as "nobody was
  // ever asked" and points the agent at re-opening the PR through `create_pr`
  // — to fix what was actually a transient API failure. Same rule as
  // `threads === null`: an unreadable read is its own blocker.
  it("distinguishes an UNREADABLE review state from nobody having been asked", () => {
    const b = prLandingBlockers(
      readyPr({ submittedReviews: null, requestedReviewers: null }),
      { requireReview: true },
    );
    expect(b.map((x) => x.code)).toEqual(["review-state-unreadable"]);
    expect(b[0].detail).toMatch(/Couldn't read/i);
    // Crucially it must NOT tell the agent to go re-open the PR.
    expect(b[0].detail).not.toMatch(/create_pr/);
  });

  it("does not raise the unreadable blocker when requireReview is off", () => {
    expect(
      prLandingBlockers(readyPr({ submittedReviews: null, requestedReviewers: null }), {
        requireReview: false,
      }),
    ).toEqual([]);
  });

  it("still honours allowNoReview when the state is unreadable", () => {
    expect(
      prLandingBlockers(readyPr({ submittedReviews: null, requestedReviewers: null }), {
        requireReview: true,
        allowNoReview: true,
      }),
    ).toEqual([]);
  });
});

describe("overrideConsentPrompt", () => {
  const pr = { number: 83, title: "feat: thing", url: "https://x/pull/83" };
  const blocker = (code: PrLandingBlocker["code"], detail: string = code): PrLandingBlocker => ({
    code,
    detail,
  });

  it("says in the TITLE what is being waived", () => {
    expect(overrideConsentPrompt(pr, [blocker("no-review")]).title).toMatch(
      /nobody has reviewed it/,
    );
    expect(overrideConsentPrompt(pr, [blocker("no-checks")]).title).toMatch(/no CI check reported/);
    expect(
      overrideConsentPrompt(pr, [blocker("no-checks"), blocker("no-review")]).title,
    ).toMatch(/nobody has reviewed it and no CI reported/);
  });

  it("spells out every blocker being waived, and how to say no", () => {
    const { description } = overrideConsentPrompt(pr, [
      blocker("no-review", "Nobody has reviewed this PR yet"),
    ]);
    // "Merge it anyway?" with no statement of what "anyway" covers is a rubber
    // stamp with extra steps.
    expect(description).toContain("Nobody has reviewed this PR yet");
    expect(description).toContain("feat: thing");
    expect(description).toContain("https://x/pull/83");
    expect(description).toMatch(/Say no to leave the PR open/);
  });

  it("survives a PR with no title or url", () => {
    const { title, description } = overrideConsentPrompt({ number: 7 }, [blocker("no-review")]);
    expect(title).toContain("#7");
    expect(description).not.toContain("undefined");
  });
});

/* -------------------------------------------------------------- create_pr */

/** A branch that's ready for a PR; each test overrides the field it exercises. */
function readyBranch(over: Partial<PrCreateState> = {}): PrCreateState {
  return {
    branch: "feat/thing",
    trunk: "main",
    base: "main",
    aheadOfBase: 3,
    dirty: false,
    existing: null,
    cwd: "/repo",
    ...over,
  };
}

describe("prCreateBlockers", () => {
  it("clears a committed branch with work on it", () => {
    expect(prCreateBlockers(readyBranch())).toEqual([]);
  });

  it("refuses to open a PR from the trunk, and names the override", () => {
    const b = prCreateBlockers(readyBranch({ branch: "main" }));
    expect(b.map((x) => x.code)).toEqual(["on-trunk"]);
    expect(b[0].detail).toMatch(/allowTrunk: true/);
    expect(prCreateBlockers(readyBranch({ branch: "main" }), { allowTrunk: true })).toEqual([]);
  });

  it("refuses an empty PR, and names the override", () => {
    const b = prCreateBlockers(readyBranch({ aheadOfBase: 0 }));
    expect(b.map((x) => x.code)).toEqual(["no-commits"]);
    expect(b[0].detail).toMatch(/allowNoCommits: true/);
    expect(prCreateBlockers(readyBranch({ aheadOfBase: 0 }), { allowNoCommits: true })).toEqual([]);
  });

  it("does NOT block when it couldn't tell how far ahead the branch is", () => {
    // Same rule the trunk guard follows: a false positive gets the guard routed
    // around, which is worse than an occasional miss.
    expect(prCreateBlockers(readyBranch({ aheadOfBase: null }))).toEqual([]);
  });

  it("refuses a dirty tree, and names the override", () => {
    const b = prCreateBlockers(readyBranch({ dirty: true }));
    expect(b.map((x) => x.code)).toEqual(["dirty"]);
    expect(b[0].detail).toMatch(/allowDirty: true/);
    expect(prCreateBlockers(readyBranch({ dirty: true }), { allowDirty: true })).toEqual([]);
  });

  it("refuses when the branch's existing PR carries `hold`, case-insensitively", () => {
    const held = readyBranch({
      existing: { number: 7, url: "u", state: "open", labels: ["Hold"] },
    });
    const b = prCreateBlockers(held);
    expect(b.map((x) => x.code)).toEqual(["hold"]);
    expect(b[0].detail).toMatch(/allowHold: true/);
    expect(prCreateBlockers(held, { allowHold: true })).toEqual([]);
  });

  it("says only 'detached' on a detached HEAD, without piling on", () => {
    const b = prCreateBlockers(readyBranch({ branch: null, dirty: true, aheadOfBase: 0 }));
    expect(b.map((x) => x.code)).toEqual(["detached"]);
  });

  it("reports EVERY blocker at once rather than the first", () => {
    const codes = prCreateBlockers(
      readyBranch({ branch: "main", aheadOfBase: 0, dirty: true }),
    ).map((b) => b.code);
    expect(codes).toEqual(["on-trunk", "no-commits", "dirty"]);
  });
});

/** A scriptable create binding that records exactly what it was asked to do. */
function fakePrCreate(
  st: PrCreateState | null,
  opts: {
    reviewers?: string[];
    draft?: boolean;
    result?: Partial<PrCreateResult>;
    createError?: string;
  } = {},
) {
  const calls: {
    preflight: (string | undefined)[];
    preflightCwd: (string | undefined)[];
    create: Record<string, unknown>[];
  } = {
    preflight: [],
    preflightCwd: [],
    create: [],
  };
  const binding: ManagerMcpPrCreate = {
    reviewers: opts.reviewers ?? ["copilot-pull-request-reviewer"],
    draft: opts.draft ?? false,
    preflight: async (base, at) => {
      calls.preflight.push(base);
      calls.preflightCwd.push(at);
      return st;
    },
    create: async (input) => {
      calls.create.push({ ...input });
      if (opts.createError) throw new Error(opts.createError);
      return {
        number: 91,
        url: "https://github.com/octo/repo/pull/91",
        branch: st?.branch ?? "feat/thing",
        base: st?.base ?? "main",
        draft: input.draft,
        reviewersRequested: opts.reviewers ?? ["copilot-pull-request-reviewer"],
        reviewersFailed: [],
        attached: true,
        watching: true,
        ...opts.result,
      };
    },
  };
  return { binding, calls };
}

const createArgs = (over: Record<string, unknown> = {}) => ({
  title: undefined,
  body: undefined,
  base: undefined,
  draft: undefined,
  allowTrunk: undefined,
  allowNoCommits: undefined,
  allowDirty: undefined,
  allowHold: undefined,
  cwd: undefined,
  ...over,
});

describe("manager-mcp — create_pr", () => {
  it("opens the PR and reports the reviewers, the chat link and the watcher", async () => {
    const { binding, calls } = fakePrCreate(readyBranch());
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs({ title: "feat: thing" }), {});
    expect(res.isError).toBeFalsy();
    const text = resultText(res);
    expect(text).toContain("Opened PR #91");
    expect(text).toMatch(/review requested from copilot-pull-request-reviewer/);
    expect(text).toContain("recorded on this chat");
    expect(text).toMatch(/watching for review activity/);
    expect(calls.create[0]).toMatchObject({ title: "feat: thing", draft: false });
    // …and it advertises the work in the UI header like every other manager tool.
    expect(statusLabels().some((l) => l.startsWith("opening PR from"))).toBe(true);
  });

  it("REFUSES on the trunk / no commits / a dirty tree, naming each override", async () => {
    const { binding, calls } = fakePrCreate(
      readyBranch({ branch: "main", aheadOfBase: 0, dirty: true }),
    );
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs(), {});
    const text = resultText(res);
    expect(text).toContain("Not opening a PR yet");
    expect(text).toMatch(/allowTrunk: true/);
    expect(text).toMatch(/allowNoCommits: true/);
    expect(text).toMatch(/allowDirty: true/);
    // A refusal is a normal answer, not an error…
    expect(res.isError).toBeFalsy();
    // …and nothing was created.
    expect(calls.create).toEqual([]);
  });

  it("opens it anyway when the caller passes the overrides", async () => {
    // Enforce, with an escape hatch — the whole point of naming them.
    const { binding, calls } = fakePrCreate(
      readyBranch({ branch: "main", aheadOfBase: 0, dirty: true }),
    );
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(
      createArgs({ allowTrunk: true, allowNoCommits: true, allowDirty: true }),
      {},
    );
    expect(resultText(res)).toContain("Opened PR #91");
    expect(calls.create.length).toBe(1);
  });

  /**
   * The 2026-08-08 dead end: a complete, committed, tested change sat on a task
   * branch while create_pr reported `on-trunk` + `no-commits`, because the
   * binding's cwd is fixed when the SESSION is built and the agent had since
   * moved into a worktree. Both overrides it named would have opened an empty
   * main→main PR.
   */
  describe("which directory it inspects", () => {
    it("passes an explicit cwd to preflight, and pushes from the same one", async () => {
      const wt = "/repo/.claude/worktrees/task";
      const { binding, calls } = fakePrCreate(readyBranch({ cwd: wt }));
      const { createPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        prCreate: binding,
      });

      const res = await createPr.handler(createArgs({ cwd: wt }), {});

      expect(resultText(res)).toContain("Opened PR #91");
      expect(calls.preflightCwd).toEqual([wt]);
      // The create must run where preflight looked — reading the branch from one
      // checkout and pushing from another ships an unreviewed branch.
      expect(calls.create[0].cwd).toBe(wt);
    });

    it("names the directory it inspected when it refuses", async () => {
      const { binding } = fakePrCreate(
        readyBranch({ branch: "main", aheadOfBase: 0, cwd: "/repo" }),
      );
      const { createPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        prCreate: binding,
      });

      const res = await createPr.handler(createArgs(), {});
      const text = resultText(res);

      // Without this the refusal is a true sentence about the wrong directory,
      // which reads as "you haven't done the work".
      expect(text).toContain("/repo");
      expect(text).toContain("pass `cwd`");
      expect(text).toContain('"inspected":"/repo"');
    });

    it("says so when the cwd it was handed was ignored", async () => {
      // The binding fell back — it returns the session's dir, not the requested
      // one, because the request wasn't a worktree of this repo.
      const { binding } = fakePrCreate(
        readyBranch({ branch: "main", aheadOfBase: 0, cwd: "/repo" }),
      );
      const { createPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        prCreate: binding,
      });

      const res = await createPr.handler(createArgs({ cwd: "/somewhere/else" }), {});
      const text = resultText(res);

      expect(text).toContain("NOT a worktree of this chat's repository");
      expect(text).toContain("/somewhere/else");
      expect(text).toContain('"ignoredCwd":"/somewhere/else"');
    });
  });

  it("hands back an existing open PR instead of erroring or opening a second", async () => {
    const { binding, calls } = fakePrCreate(
      readyBranch({
        existing: { number: 7, url: "https://x/7", state: "open", labels: [] },
      }),
    );
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs(), {});
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("PR #7 is already open");
    expect(calls.create).toEqual([]);
  });

  it("refuses when the branch's existing PR is on `hold`", async () => {
    const { binding, calls } = fakePrCreate(
      readyBranch({
        existing: { number: 7, url: "https://x/7", state: "closed", labels: ["hold"] },
      }),
    );
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs(), {});
    expect(resultText(res)).toMatch(/hold/);
    expect(calls.create).toEqual([]);
  });

  it("says out loud when NO reviewers are configured", async () => {
    // Silence here is exactly how a PR ends up with nobody looking at it while
    // everyone assumes somebody is.
    const { binding } = fakePrCreate(readyBranch(), {
      reviewers: [],
      result: { reviewersRequested: [] },
    });
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs(), {});
    expect(resultText(res)).toMatch(/no reviewers are configured/i);
    expect(resultText(res)).toMatch(/workflow\.pr\.reviewers/);
  });

  it("warns rather than failing when a reviewer request didn't land", async () => {
    const { binding } = fakePrCreate(readyBranch(), {
      result: {
        reviewersRequested: [],
        reviewersFailed: [{ reviewer: "ghost", error: "Not Found" }],
      },
    });
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    const res = await createPr.handler(createArgs(), {});
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toMatch(/could not request ghost: Not Found/);
  });

  it("defaults `draft` to the project's configured setting", async () => {
    const { binding, calls } = fakePrCreate(readyBranch(), { draft: true });
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });

    await createPr.handler(createArgs(), {});
    expect(calls.create[0].draft).toBe(true);
    await createPr.handler(createArgs({ draft: false }), {});
    expect(calls.create[1].draft).toBe(false);
  });

  it("reports unavailable when the project doesn't ship through PRs", async () => {
    const { createPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await createPr.handler(createArgs(), {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });

  it("says so plainly when the repo/branch can't be resolved", async () => {
    const { binding } = fakePrCreate(null);
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });
    const res = await createPr.handler(createArgs(), {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/Could not resolve/);
  });
});

describe("manager-mcp — approve_pr", () => {
  it("approves, merges with the project's default method, and marks the PR watched", async () => {
    const { binding, calls } = fakeApproval(readyPr());
    let watched = "";
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: { ...fakeBroker({}), markPrWatched: (id) => (watched = id) },
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});

    expect(res.isError).toBeFalsy();
    expect(calls.merge).toEqual([{ n: 83, method: "squash" }]);
    expect(calls.approve).toHaveLength(1);
    expect(resultText(res)).toContain('"merged":true');
    expect(watched).toBe("c1"); // same bookkeeping a watch_pr-observed merge does
    expect(statusLabels().some((l) => l === "merging PR #83")).toBe(true);
  });

  it("honours a per-call method override and a custom note", async () => {
    const { binding, calls } = fakeApproval(readyPr());
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    await approvePr.handler(approveArgs({ method: "rebase", note: "verified locally" }), {});

    expect(calls.merge).toEqual([{ n: 83, method: "rebase" }]);
    expect(calls.approve[0]!.body).toBe("verified locally");
  });

  it("merges anyway when GitHub refuses the self-approval", async () => {
    // The author can't approve their own PR — expected, not a failure.
    const { binding, calls } = fakeApproval(readyPr(), { approved: false });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});

    expect(calls.merge).toHaveLength(1);
    expect(resultText(res)).toContain('"merged":true');
    expect(resultText(res)).toContain('"approved":false');
  });

  it("refuses with reasons — and never merges — when the PR isn't ready", async () => {
    const { binding, calls } = fakeApproval(readyPr({ checks: [FAIL_BUILD], threads: [THREAD_A] }));
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});

    expect(calls.merge).toEqual([]);
    expect(calls.approve).toEqual([]);
    expect(resultText(res)).toContain("Not landing PR #83 yet");
    expect(resultText(res)).toContain('"blockers":["checks-failing","unresolved-threads"]');
  });

  it("refuses a PR someone parked with the hold label", async () => {
    const { binding, calls } = fakeApproval(readyPr({ labels: ["hold"] }));
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});

    expect(calls.merge).toEqual([]);
    expect(resultText(res)).toContain('"blockers":["hold"]');
  });

  it("reports a GitHub merge refusal (branch protection) as an error, not a retry", async () => {
    const { binding } = fakeApproval(readyPr(), { mergeError: "Pull request is not mergeable" });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("GitHub refused the merge");
    expect(resultText(res)).toContain("not mergeable");
  });

  it("reports an unresolvable PR without merging", async () => {
    const { binding, calls } = fakeApproval(null);
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs({ number: 999 }), {});

    expect(res.isError).toBe(true);
    expect(calls.merge).toEqual([]);
  });

  it("validates a positive integer PR number", async () => {
    const { binding, calls } = fakeApproval(readyPr());
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs({ number: -1 }), {});
    expect(res.isError).toBe(true);
    expect(calls.merge).toEqual([]);
  });

  it("refuses to merge on NO checks when the project set requireChecks", async () => {
    // "on-green" on a repo where nothing reports is a promise about nothing.
    const { binding, calls } = fakeApproval(readyPr({ checks: [] }), {
      policy: { requireChecks: true },
    });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});
    expect(calls.merge).toEqual([]);
    expect(resultText(res)).toMatch(/No checks are reporting/);
    expect(resultText(res)).toMatch(/allowNoChecks: true/);
  });

  it("asks the human, then merges, when allowNoChecks is passed and they say yes", async () => {
    const { binding, calls } = fakeApproval(readyPr({ checks: [] }), {
      policy: { requireChecks: true },
    });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    await approvePr.handler(approveArgs({ allowNoChecks: true }), {});
    expect(calls.confirm).toEqual([{ n: 83, codes: ["no-checks"] }]);
    expect(calls.merge).toEqual([{ n: 83, method: "squash" }]);
  });

  it("refuses to merge unreviewed when the project set requireReview", async () => {
    const { binding, calls } = fakeApproval(
      readyPr({ submittedReviews: [], requestedReviewers: ["copilot-pull-request-reviewer"] }),
      { policy: { requireReview: true } },
    );
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});
    expect(calls.merge).toEqual([]);
    expect(resultText(res)).toMatch(/Nobody has reviewed/);
    expect(resultText(res)).toMatch(/allowNoReview: true/);
  });

  /* ---- the override consent gate ----
   *
   * The merge this exists to prevent: the human said "pr it and merge",
   * approve_pr correctly refused with `no-review`, and the agent re-called it
   * with `allowNoReview: true` on the reasoning that "merge" had authorised an
   * UNREVIEWED merge. The reviewer reported two minutes after the branch was
   * gone. An override justified by "the human told me to" cannot be granted by
   * the one party who can't witness that, so the flag now asks and waits.
   */

  it("asks the human, then merges, when allowNoReview is passed and they say yes", async () => {
    const { binding, calls } = fakeApproval(readyPr({ submittedReviews: [] }), {
      policy: { requireReview: true },
    });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    await approvePr.handler(approveArgs({ allowNoReview: true }), {});
    expect(calls.confirm).toEqual([{ n: 83, codes: ["no-review"] }]);
    expect(calls.merge).toEqual([{ n: 83, method: "squash" }]);
  });

  it("does NOT merge when the human declines the override", async () => {
    const { binding, calls } = fakeApproval(readyPr({ submittedReviews: [] }), {
      policy: { requireReview: true },
      consent: { approved: false, message: "wait for copilot" },
    });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs({ allowNoReview: true }), {});
    expect(calls.confirm).toHaveLength(1);
    expect(calls.merge).toEqual([]);
    // Nor may it approve — a review it then didn't land is noise on the PR.
    expect(calls.approve).toEqual([]);
    const text = resultText(res);
    expect(text).toMatch(/did not approve the override/i);
    expect(text).toMatch(/wait for copilot/);
    expect(text).toMatch(/don't re-ask/i);
    expect(JSON.parse(text.slice(text.lastIndexOf("{")))).toMatchObject({
      merged: false,
      overrideDeclined: true,
      blockers: ["no-review"],
    });
  });

  it("fails CLOSED when the human can't be asked at all", async () => {
    // No live session to put the card in front of. An unanswerable question is
    // not a yes — the whole point is that this decision has a witness.
    const { binding, calls } = fakeApproval(readyPr({ submittedReviews: [] }), {
      policy: { requireReview: true },
      consentThrows: "no live session to ask through",
    });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs({ allowNoReview: true }), {});
    expect(calls.merge).toEqual([]);
    expect(resultText(res)).toMatch(/no live session/);
  });

  it("does not ask when the override suppresses nothing", async () => {
    // `allowNoReview` on a PR a reviewer already approved buys nothing, so it
    // must not wake the human — the gate keys off what the flag actually did.
    const { binding, calls } = fakeApproval(readyPr(), { policy: { requireReview: true } });
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    await approvePr.handler(approveArgs({ allowNoReview: true, allowNoChecks: true }), {});
    expect(calls.confirm).toEqual([]);
    expect(calls.merge).toEqual([{ n: 83, method: "squash" }]);
  });

  it("does not ask while a blocker the override can't touch still stands", async () => {
    // The human is asked once, about a decision that's actually theirs — not
    // about a PR that a failing check stops regardless of what they say.
    const { binding, calls } = fakeApproval(
      readyPr({ submittedReviews: [], checks: [FAIL_BUILD] }),
      { policy: { requireReview: true } },
    );
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs({ allowNoReview: true }), {});
    expect(calls.confirm).toEqual([]);
    expect(calls.merge).toEqual([]);
    expect(resultText(res)).toMatch(/check\(s\) failing/);
  });

  it("names BOTH overrides on one card rather than asking twice", async () => {
    const { binding, calls } = fakeApproval(
      readyPr({ submittedReviews: [], requestedReviewers: [], checks: [] }),
      { policy: { requireChecks: true, requireReview: true } },
    );
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    await approvePr.handler(approveArgs({ allowNoReview: true, allowNoChecks: true }), {});
    expect(calls.confirm).toEqual([{ n: 83, codes: ["no-checks", "no-review"] }]);
  });

  it("keeps every pre-existing guard alongside the new ones", async () => {
    // The hardening must ADD to the bar, never replace it.
    const { binding, calls } = fakeApproval(
      readyPr({ labels: ["hold"], isDraft: true, checks: [], submittedReviews: [] }),
      { policy: { requireChecks: true, requireReview: true } },
    );
    const { approvePr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prApproval: binding,
    });

    const res = await approvePr.handler(approveArgs(), {});
    expect(calls.merge).toEqual([]);
    const text = resultText(res);
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/hold/);
    expect(text).toMatch(/No checks are reporting/);
    expect(text).toMatch(/Nobody has reviewed/);
  });

  it("reports unavailable when the project hasn't opted into auto-merge", async () => {
    // No binding is the enforcement: a session on a project without auto-merge
    // has no way to land anything (a raw `gh pr merge` is denied separately).
    const { approvePr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await approvePr.handler(approveArgs(), {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("hasn't enabled auto-merge");
  });
});

/* -------------------------------------------------------------- terminal */

describe("manager-mcp — terminal", () => {
  it("runs a command in a named terminal and returns output/exit/cwd", async () => {
    const calls: { name: string; command: string }[] = [];
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: {
        run: async ({ name, command }) => {
          calls.push({ name, command });
          return { output: "build ok", exitCode: 0, cwd: "C:\\repo" };
        },
      },
    });

    const res = await terminal.handler({ name: "build", command: "pnpm build", timeoutMs: undefined }, {});
    expect(calls).toEqual([{ name: "build", command: "pnpm build" }]);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("[build]");
    expect(resultText(res)).toContain("cwd=C:\\repo");
    expect(resultText(res)).toContain("exit=0");
    expect(resultText(res)).toContain("build ok");
  });

  it("surfaces a runner error as an error result", async () => {
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: {
        run: async () => ({
          output: "",
          exitCode: null,
          cwd: "",
          error: "Terminal cap reached (8 shells for this chat).",
        }),
      },
    });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("cap reached");
  });

  it("reports unavailable when no TerminalService is wired", async () => {
    const { terminal } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });

  it("validates a non-empty command", async () => {
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: { run: async () => ({ output: "", exitCode: 0, cwd: "" }) },
    });
    const res = await terminal.handler({ name: "x", command: "   ", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("requires a command");
  });
});

/* --------------------------------------------------------------- memory */

/** An in-memory ManagerMcpMemory (round-trip without touching the fs). */
function fakeMemory(): ManagerMcpMemory & { data: Map<string, ProjectMemory> } {
  const data = new Map<string, ProjectMemory>();
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    data,
    remember: async (input) => {
      const name = slug(input.name);
      const m: ProjectMemory = {
        projectId: "p1",
        name,
        description: input.description,
        type: input.type,
        body: input.body,
        file: `${name}.md`,
        updatedAt: 1,
      };
      data.set(name, m);
      return m;
    },
    recall: async (query) => {
      const all = [...data.values()];
      const index = `# Project memory\n${all
        .map((m) => `- [${m.name}](${m.file}) — ${m.description}`)
        .join("\n")}`;
      if (!query) return { index, matches: [] };
      const q = query.toLowerCase();
      return {
        index,
        matches: all.filter(
          (m) =>
            m.name.includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.body.toLowerCase().includes(q),
        ),
      };
    },
    forget: async (name) => data.delete(slug(name)),
    findSimilar: async (candidate) => {
      const slugName = slug(candidate.name);
      const cand = {
        name: slugName,
        description: candidate.description ?? "",
        body: candidate.body ?? "",
      };
      return [...data.values()]
        .filter((m) => m.name !== slugName)
        .map((m) => ({ m, similarity: memorySimilarity(cand, m) }))
        .filter((s) => s.similarity >= 0.35)
        .sort((a, b) => b.similarity - a.similarity)
        .map((s) => ({
          name: s.m.name,
          description: s.m.description,
          similarity: Math.round(s.similarity * 100) / 100,
        }));
    },
  };
}

describe("manager-mcp — memory tools", () => {
  it("remember → recall → forget round-trips a project memory", async () => {
    const mem = fakeMemory();
    const { remember, recall, forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: mem,
    });

    const rem = await remember.handler(
      { name: "Deploy Runbook", description: "how we ship", type: "project", body: "run pnpm ship" },
      {},
    );
    expect(rem.isError).toBeFalsy();
    expect(resultText(rem)).toContain("deploy-runbook");
    expect(mem.data.has("deploy-runbook")).toBe(true);

    // recall with no query returns the index…
    const idx = await recall.handler({ query: undefined, type: undefined }, {});
    expect(resultText(idx)).toContain("[deploy-runbook](deploy-runbook.md)");

    // …and a query returns the full body.
    const hit = await recall.handler({ query: "ship", type: undefined }, {});
    expect(resultText(hit)).toContain("run pnpm ship");

    const gone = await forget.handler({ name: "deploy-runbook" }, {});
    expect(gone.isError).toBeFalsy();
    expect(resultText(gone)).toContain("Forgot");
    expect(mem.data.has("deploy-runbook")).toBe(false);
  });

  it("recall reports no matches (still returns the index) for a miss", async () => {
    const mem = fakeMemory();
    await mem.remember({ name: "x", description: "d", type: "project", body: "b" });
    const { recall } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory: mem });
    const res = await recall.handler({ query: "nomatch", type: undefined }, {});
    expect(resultText(res)).toContain('No memories matched "nomatch"');
  });

  it("recall bounds its output size for huge / many matches (never blows the tool limit)", async () => {
    const mem = fakeMemory();
    // Ten memories with 20k-char bodies all matching "big" → naive rendering would
    // be ~200k chars, over the MCP tool-result cap.
    for (let i = 0; i < 10; i++) {
      await mem.remember({
        name: `big-${i}`,
        description: `big memory ${i}`,
        type: "project",
        body: "big " + "x".repeat(20000),
      });
    }
    const { recall } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory: mem });
    const res = await recall.handler({ query: "big", type: undefined }, {});
    const text = resultText(res);
    expect(text.length).toBeLessThan(30000);
    // Long bodies are clamped and/or extra matches are summarized, not dumped.
    expect(text).toMatch(/truncated .* more chars|match\(es\) omitted/);
  });

  it("forget of a missing memory is an informative error result", async () => {
    const { forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: fakeMemory(),
    });
    const res = await forget.handler({ name: "ghost" }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("No memory named");
  });

  it("remember requires a non-empty name", async () => {
    const { remember } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: fakeMemory(),
    });
    const res = await remember.handler({ name: "   ", description: "", type: "project", body: "b" }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("non-empty name");
  });

  it("remember nudges to consolidate when the new fact duplicates an existing one", async () => {
    const mem = fakeMemory();
    const { remember } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory: mem });
    await remember.handler(
      {
        name: "consumable-wheel-ui",
        description: "consumable wheel controls grenade heal tap hold scroll",
        type: "project",
        body: "wheel ctrl space",
      },
      {},
    );
    // A near-identical fact under a different name → still saved, but nudged.
    const res = await remember.handler(
      {
        name: "consumable-wheel-controls",
        description: "consumable wheel controls grenade heal tap hold scroll",
        type: "project",
        body: "wheel ctrl space",
      },
      {},
    );
    const text = resultText(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain('Remembered "consumable-wheel-controls"'); // the save still happened
    expect(text).toContain("may duplicate");
    expect(text).toContain("consumable-wheel-ui");
    expect(mem.data.has("consumable-wheel-controls")).toBe(true);
  });

  it("remember does not nudge for a genuinely distinct fact", async () => {
    const mem = fakeMemory();
    const { remember } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory: mem });
    await remember.handler(
      { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "pipeline" },
      {},
    );
    const res = await remember.handler(
      {
        name: "boss-animation-system",
        description: "spritesheet boss idle attack teleport timings",
        type: "project",
        body: "sheets",
      },
      {},
    );
    expect(resultText(res)).not.toContain("may duplicate");
  });

  it("reports unavailable when no MemoryService is wired", async () => {
    const { remember, recall, forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    for (const res of [
      await remember.handler({ name: "a", description: "", type: "project", body: "b" }, {}),
      await recall.handler({ query: undefined, type: undefined }, {}),
      await forget.handler({ name: "a" }, {}),
    ]) {
      expect(res.isError).toBe(true);
      expect(resultText(res)).toContain("not available");
    }
  });
});

/* --------------------------------------------------------- server assembly */

/* -------------------------------------------------------------- spawn_chat */

/** A scriptable chats binding recording what the tool asked for. */
function fakeChats(opts: {
  project?: SpawnChatTarget | null;
  consent?: SpawnChatConsent;
  spawnError?: Error;
}) {
  const calls = {
    resolved: [] as (string | undefined)[],
    consented: [] as SpawnChatRequest[],
    spawned: [] as SpawnChatRequest[],
  };
  const project = opts.project === undefined ? { id: "p1", name: "Dispatch" } : opts.project;
  const binding: ManagerMcpChats = {
    resolveProject: async (id) => {
      calls.resolved.push(id);
      return project;
    },
    consent: async ({ request }) => {
      calls.consented.push(request);
      return opts.consent ?? { approved: true, auto: false };
    },
    spawn: async ({ request, project: target }) => {
      calls.spawned.push(request);
      if (opts.spawnError) throw opts.spawnError;
      return {
        chatId: "c-new",
        title: request.title ?? "New chat",
        projectId: target.id,
        projectName: target.name,
      };
    },
  };
  return { binding, calls };
}

/** Full arg object for spawn_chat's handler (its shape has no optional keys). */
function spawnArgs(over: Partial<SpawnChatRequest> & { prompt: string }) {
  return {
    title: undefined,
    projectId: undefined,
    modeId: undefined,
    agentId: undefined,
    effort: undefined,
    model: undefined,
    reason: undefined,
    ...over,
  };
}

describe("manager-mcp — spawn_chat", () => {
  it("asks for consent BEFORE creating anything, then spawns", async () => {
    const chats = fakeChats({});
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(
      spawnArgs({
        prompt: "  Audit the SQL migrations.  ",
        title: "Migration audit",
        reason: "long job",
      }),
      {},
    );

    expect(chats.calls.consented).toHaveLength(1);
    expect(chats.calls.consented[0]?.prompt).toBe("Audit the SQL migrations.");
    expect(chats.calls.consented[0]?.reason).toBe("long job");
    expect(chats.calls.spawned).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("c-new");
  });

  it("does NOT spawn when the human declines, and says so without erroring", async () => {
    // A refusal is an answer, not a fault: flagging it as an error is what pushes
    // a model into retrying the exact thing it was just told not to do.
    const chats = fakeChats({
      consent: { approved: false, auto: false, message: "not now" },
    });
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(spawnArgs({ prompt: "go" }), {});

    expect(chats.calls.spawned).toHaveLength(0);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("Declined");
    expect(resultText(res)).toContain("not now");
    expect(resultText(res)).toContain("Do NOT retry");
  });

  it("refuses an empty prompt without bothering the human", async () => {
    const chats = fakeChats({});
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(spawnArgs({ prompt: "   " }), {});

    expect(res.isError).toBe(true);
    expect(chats.calls.consented).toHaveLength(0);
  });

  it("reports an unknown projectId instead of spawning somewhere else", async () => {
    const chats = fakeChats({ project: null });
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(spawnArgs({ prompt: "go", projectId: "nope" }), {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("nope");
    expect(chats.calls.consented).toHaveLength(0);
  });

  it("says the chat could not be created when spawning fails AFTER approval", async () => {
    const chats = fakeChats({ spawnError: new Error("disk full") });
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(spawnArgs({ prompt: "go" }), {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Approved, but");
    expect(resultText(res)).toContain("disk full");
  });

  it("notes when a setting auto-approved the spawn", async () => {
    const chats = fakeChats({ consent: { approved: true, auto: true } });
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    const res = await spawnChat.handler(spawnArgs({ prompt: "go" }), {});

    expect(resultText(res)).toContain("auto-approved");
  });

  it("exposes no argument that skips the consent gate", () => {
    // The whole design: only the human's own setting lifts the prompt. A bypass
    // argument would make the gate exactly as strong as the model's restraint.
    const keys = Object.keys(
      createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) }).spawnChat.inputSchema,
    );
    expect(keys).not.toContain("requireConsent");
    expect(keys).not.toContain("force");
    expect(keys).not.toContain("skipConsent");
  });
});

describe("manager-mcp — server factory", () => {
  it("builds an in-process SDK MCP server named 'manager'", () => {
    const server = createManagerMcpServer({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("manager");
    expect(server.instance).toBeDefined();
  });

  it("registers approve_pr ONLY when the approval binding is present", () => {
    const names = (ctx: Parameters<typeof createManagerMcpServer>[0]) =>
      Object.keys(
        (createManagerMcpServer(ctx) as unknown as {
          instance: { _registeredTools?: Record<string, unknown> };
        }).instance._registeredTools ?? {},
      );

    // GitHub wired but no auto-merge → the agent is offered no way to merge.
    expect(names({ chatId: "c1", bus, broker: fakeBroker({}), github: fakeGitHub([]) })).not.toContain(
      "approve_pr",
    );
    expect(
      names({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        github: fakeGitHub([]),
        prApproval: fakeApproval(readyPr()).binding,
      }),
    ).toContain("approve_pr");
  });

  it("registers create_pr ONLY when the create binding is present", () => {
    // The binding's presence is the permission — same pattern as approve_pr, and
    // it's bound exactly where the guard refuses a raw `gh pr create`, so the
    // refusal always has a sanctioned path to name.
    const names = (ctx: Parameters<typeof createManagerMcpServer>[0]) =>
      Object.keys(
        (createManagerMcpServer(ctx) as unknown as {
          instance: { _registeredTools?: Record<string, unknown> };
        }).instance._registeredTools ?? {},
      );

    expect(names({ chatId: "c1", bus, broker: fakeBroker({}), github: fakeGitHub([]) })).not.toContain(
      "create_pr",
    );
    expect(
      names({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        github: fakeGitHub([]),
        prCreate: fakePrCreate(readyBranch()).binding,
      }),
    ).toContain("create_pr");
  });

  it("registers spawn_chat ONLY when the chats binding is present", () => {
    const names = (ctx: Parameters<typeof createManagerMcpServer>[0]) =>
      Object.keys(
        (createManagerMcpServer(ctx) as unknown as {
          instance: { _registeredTools?: Record<string, unknown> };
        }).instance._registeredTools ?? {},
      );

    expect(names({ chatId: "c1", bus, broker: fakeBroker({}) })).not.toContain("spawn_chat");
    expect(
      names({ chatId: "c1", bus, broker: fakeBroker({}), chats: fakeChats({}).binding }),
    ).toContain("spawn_chat");
  });
});
