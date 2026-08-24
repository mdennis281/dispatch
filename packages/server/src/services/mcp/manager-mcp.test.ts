import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ChatStatus,
  CheckRun,
  ReviewThread,
  WsServerEvent,
  ProjectMemory,
  PrReviewAgentState,
  WorkflowExemption,
} from "@dispatch/shared";
import { EventBus } from "../../bus.js";
import { memorySimilarity } from "../memory.js";
import {
  decodePrToolPayload,
  managerToolQualifiedName,
  type ManagerToolName,
} from "@dispatch/shared";
import {
  createManagerTools,
  createManagerMcpServers,
  managerToolDescriptors,
  prLandingBlockers,
  overrideConsentPrompt,
  exemptionConsentQuestion,
  readExemptionAnswer,
  EXEMPTION_ANSWERS,
  prCreateBlockers,
  WAIT_CAP_SECONDS,
  PR_POLL_INTERVAL_MS,
  NO_CHECKS_GRACE_MS,
  REVIEW_QUEUE_GRACE_MS,
  REVIEW_ROUND_GRACE_MS,
  type ManagerMcpBroker,
  type ManagerMcpMemory,
  type ManagerMcpGitHub,
  type ManagerMcpPrApproval,
  type ManagerMcpPrCreate,
  type ManagerMcpPrRegistry,
  type PrPollResult,
  type PrWatchSnapshot,
  type PrReadiness,
  type PrLandingPolicy,
  type PrLandingBlocker,
  type PrCreateState,
  type PrCreateResult,
  type ManagerMcpChats,
  type ManagerMcpExemptions,
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
    askUser: async () => ({ status: "declined" }),
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

/* ---------------------------------------------------------------- ask_user */

describe("manager-mcp — ask_user", () => {
  const questions = [
    {
      header: "Scope",
      question: "Which surfaces should be protected?",
      multiSelect: true,
      options: [
        { label: "REST", description: "Protect API requests." },
        { label: "WebSocket", description: "Protect the event stream." },
      ],
    },
  ];

  it("passes radio / multi-select questions to the bound chat and returns answers", async () => {
    let call:
      | { chatId: string; questions: typeof questions; timeoutSeconds?: number }
      | undefined;
    const broker: ManagerMcpBroker = {
      ...fakeBroker({ c1: "running" }),
      askUser: async (chatId, asked, timeoutSeconds) => {
        call = { chatId, questions: asked as typeof questions, timeoutSeconds };
        return {
          status: "answered",
          answers: { "Which surfaces should be protected?": "REST, WebSocket" },
        };
      },
    };
    const { askUser } = createManagerTools({ chatId: "c1", bus, broker });

    const res = await askUser.handler({ questions, timeoutSeconds: 90 }, {});

    expect(call).toEqual({ chatId: "c1", questions, timeoutSeconds: 90 });
    expect(resultText(res)).toContain("REST, WebSocket");
    expect(res.isError).toBeFalsy();
  });

  it("treats a decline as a final non-error response", async () => {
    const broker: ManagerMcpBroker = {
      ...fakeBroker({ c1: "running" }),
      askUser: async () => ({ status: "declined", message: "Not now." }),
    };
    const { askUser } = createManagerTools({ chatId: "c1", bus, broker });

    const res = await askUser.handler({ questions, timeoutSeconds: undefined }, {});

    expect(resultText(res)).toContain("declined");
    expect(resultText(res)).toContain("Not now.");
    expect(res.isError).toBeFalsy();
  });

  it("reports an inactivity timeout distinctly from a human decline", async () => {
    const broker: ManagerMcpBroker = {
      ...fakeBroker({ c1: "running" }),
      askUser: async () => ({ status: "timed_out", message: "No recent activity." }),
    };
    const { askUser } = createManagerTools({ chatId: "c1", bus, broker });

    const res = await askUser.handler({ questions, timeoutSeconds: 30 }, {});
    const text = resultText(res);

    expect(text).toContain("timed out without an answer");
    expect(text).toContain("No recent activity.");
    expect(text).not.toContain("declined");
  });

  it("does not describe an unavailable question channel as a human decline", async () => {
    const broker: ManagerMcpBroker = {
      ...fakeBroker({ c1: "running" }),
      askUser: async () => ({
        status: "unavailable",
        message: "No live session is available to ask through.",
      }),
    };
    const { askUser } = createManagerTools({ chatId: "c1", bus, broker });

    const res = await askUser.handler({ questions, timeoutSeconds: undefined }, {});
    const text = resultText(res);

    expect(text).toContain("could not be shown");
    expect(text).toContain("No live session");
    expect(text).not.toContain("declined");
    expect(res.isError).toBeFalsy();
  });
});

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
  /**
   * The reviewer queue. `undefined` → the binding has no `prReviewState` at all
   * (an older/narrower GitHub surface), which must stay silent rather than
   * reporting a stall it can't see. `null` → a failed read this poll.
   */
  review?: { requested: string[]; reported: Array<{ author: string; state: string }> } | null;
}

/**
 * A scriptable ManagerMcpGitHub. Each `pollPrState` call advances to the next
 * snapshot, so one snapshot = one poll cycle — which is now literally true, the
 * whole poll being one call.
 *
 * A snapshot that scripts no `review` yields `review: null`, i.e. "this poll
 * carried no read of the reviewer queue". That's the path a narrower binding
 * takes, and it must stay silent rather than reporting a stall it cannot see.
 */
function fakeGitHub(
  snaps: PollSnap[],
): ManagerMcpGitHub & { calls: { number: number; repo?: string }[] } {
  const calls: { number: number; repo?: string }[] = [];
  let idx = -1;
  const cur = (): PollSnap => snaps[Math.min(Math.max(idx, 0), snaps.length - 1)]!;
  const scriptsReview = snaps.some((s) => s.review !== undefined);
  return {
    calls,
    pollPrState: async (n, repo) => {
      calls.push({ number: n, repo });
      idx = Math.min(idx + 1, snaps.length - 1);
      const snap = cur();
      if (!snap.merge) return null;
      return {
        ...snap.merge,
        checks: snap.checks === undefined ? [] : snap.checks,
        threads: snap.threads === undefined ? [] : snap.threads,
        review: scriptsReview ? (snap.review ?? null) : null,
      };
    },
  };
}

const OPEN: PrPollResult = { number: 83, state: "open", merged: false };

/** One `pollPrState` answer, built from just the pieces a test cares about. */
function snap(over: Partial<PrWatchSnapshot> = {}): PrWatchSnapshot {
  return { ...OPEN, checks: [], threads: [], review: null, ...over };
}
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

  // The failure this whole signal exists for: round one lands, the agent pushes
  // fixes, and GitHub has already cleared the reviewer's request — so the PR is
  // not "awaiting review", it is stopped, and every further watch_pr call burns
  // its full quiet window on a review nobody is going to write.
  it("reports a STALLED reviewer queue instead of waiting on a review nobody owes", async () => {
    // A still-running check keeps every other signal quiet, so the stall is the
    // only thing that can end this watch.
    const gh = fakeGitHub([
      {
        merge: OPEN,
        checks: [RUNNING_BUILD],
        threads: [],
        review: {
          requested: [],
          reported: [{ author: "Copilot", state: "CHANGES_REQUESTED" }],
        },
      },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);
    const res = await p;

    expect(resultText(res)).toContain('"reviewStalled":true');
    expect(resultText(res)).toContain('"type":"review-stalled"');
    expect(resultText(res)).toContain("nobody is queued to review");
    // It names who already reported, so the agent knows this is round two.
    expect(resultText(res)).toContain("Copilot already changes requested");
    // And it must NOT tell the agent to just watch again — that's the loop.
    expect(resultText(res)).toContain("request_review");
    expect(resultText(res)).toMatch(/Do NOT just call watch_pr again/);
  });

  it("says nobody has EVER reviewed when the queue is empty and no review exists", async () => {
    const gh = fakeGitHub([
      { merge: OPEN, checks: [RUNNING_BUILD], threads: [], review: { requested: [], reported: [] } },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);

    expect(resultText(await p)).toContain("nobody has reviewed");
  });

  it("stays quiet while a reviewer IS on the hook", async () => {
    const gh = fakeGitHub([
      {
        merge: OPEN,
        checks: [PASS_BUILD],
        threads: [],
        review: { requested: ["Copilot"], reported: [] },
      },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

    // Green still reports; the queue is healthy, so no stall.
    expect(resultText(res)).toContain('"reviewStalled":false');
    expect(resultText(res)).not.toContain("review-stalled");
  });

  it("re-fires the stall for a LATER round, not just the first", async () => {
    // The queue is a live variable here rather than a poll script, so the test
    // can play the real sequence: stall → re-request → report → stall again.
    let queue: { requested: string[]; reported: Array<{ author: string; state: string }> } = {
      requested: [],
      reported: [{ author: "Copilot", state: "APPROVED" }],
    };
    const gh: ManagerMcpGitHub = {
      pollPrState: async () => snap({ checks: [RUNNING_BUILD], review: queue }),
    };
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const first = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);
    expect(resultText(await first)).toContain("review-stalled");

    // The agent re-requests: somebody is on the hook, so waiting is right again
    // and the stall must go quiet.
    queue = { requested: ["Copilot"], reported: [] };
    const second = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resultText(await second)).toContain('"timedOut":true');

    // They report, GitHub clears the request, and the PR is stopped all over
    // again. A once-ever flag would go silent here — the same "waiting on a
    // review nobody owes" bug, one round later.
    queue = { requested: [], reported: [{ author: "Copilot", state: "COMMENTED" }] };
    const third = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);
    expect(resultText(await third)).toContain("review-stalled");
  });

  it("does not call an empty queue stalled inside the grace window", async () => {
    // A request takes a beat to register after create_pr asks for it.
    const gh = fakeGitHub([
      { merge: OPEN, checks: null, threads: null, review: { requested: [], reported: [] } },
    ]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
    await vi.advanceTimersByTimeAsync(30_000);

    expect(resultText(await p)).toContain('"timedOut":true');
  });

  it("treats an unreadable reviewer queue as no news, never as a stall", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: null, threads: null, review: null }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(1800_000);

    expect(resultText(await p)).not.toContain("review-stalled");
  });

  // A poll that carries NO read of the reviewer queue (an older/narrower GitHub
  // surface) must watch normally and never mention a stall. Most tests in this
  // file run on such a poll; this one states the contract by name.
  it("watches normally when the poll carries no reviewer queue", async () => {
    const gh: ManagerMcpGitHub = {
      // `review: null` — no queue read this poll, which is a different claim
      // from an empty queue and must not be reported as a stall.
      pollPrState: async () =>
        snap({ checks: [PASS_BUILD], threads: [THREAD_A], review: null }),
    };
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('"threadId":"T_A"');
    expect(resultText(res)).toContain('"reviewStalled":false');
    expect(resultText(res)).not.toContain("review-stalled");
  });

  // The grace window is a claim about CONTINUOUS observation. If the queue is
  // seen empty, then goes unreadable for a while, then reads empty again, firing
  // off the ORIGINAL timestamp asserts a minute of emptiness we never watched —
  // and the reviewer may have been re-requested while we were blind.
  it("restarts the grace window after a gap in observation", async () => {
    let review: { requested: string[]; reported: Array<{ author: string; state: string }> } | null =
      { requested: [], reported: [] };
    const gh: ManagerMcpGitHub = {
      pollPrState: async () => snap({ checks: [RUNNING_BUILD], review }),
    };
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    // Empty, but only briefly — then the read goes dark for well past the window.
    const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS);
    review = null;
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS * 2);

    // Readable again and still empty: the clock has to start over, so nothing
    // fires on this poll.
    review = { requested: [], reported: [] };
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // still watching, no stall yet

    // A full fresh window of continuous emptiness — now it's earned.
    await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);
    expect(resultText(await p)).toContain("review-stalled");
  });

  /* ------------------------------------------- the reviewer's own round cap */

  // The failure these exist for: Dispatch's reviewer stops on a per-PR round
  // cap, and that stop is invisible from GitHub. On a dedicated-account project
  // the reviewer never leaves the queue (it never submits), so every GitHub-side
  // signal reads "a review is coming" while the sweep has permanently stopped
  // spawning — and the author burns the full 1800s window, twice, on PRs #141
  // and #143.
  describe("spent round cap", () => {
    /** rounds/maxRounds spent, with a review that actually landed. */
    const SPENT_POSTED: PrReviewAgentState = {
      rounds: 2,
      maxRounds: 2,
      chatId: "reviewer-1",
      reviewedAt: 1_000,
      postedAt: 2_000,
      findings: 3,
    };

    /**
     * A catalog that answers only the reviewer question — the one thing
     * `watch_pr` reads off a stored row rather than off GitHub. Every other
     * method degrades to null, which is the interface's documented contract.
     */
    function fakeRegistry(state: PrReviewAgentState | null): ManagerMcpPrRegistry {
      return {
        snapshot: async () => null,
        refresh: async () => null,
        noteWatched: async () => {},
        refreshByThread: async () => null,
        snapshotByThread: async () => null,
        reviewAgent: async () => state,
        noteReviewRequestError: async () => {},
        notePostedReview: async () => {},
      };
    }

    it("returns instead of blocking once the cap is spent, and does NOT send the agent to request_review", async () => {
      // A still-running check keeps every other signal quiet, so the spent cap
      // is the only thing that can end this watch — exactly the shape of the
      // real dead wait.
      const gh = fakeGitHub([{ merge: OPEN, checks: [RUNNING_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry(SPENT_POSTED),
      });

      const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      expect(resultText(res)).toContain('"reviewsSpent":true');
      expect(resultText(res)).toContain('"type":"reviews-spent"');
      expect(resultText(res)).toContain("spent all 2 of 2 rounds");
      // CI is still running, so there is something real left to wait for.
      expect(resultText(res)).toContain('"landableOnChecks":false');
      expect(resultText(res)).toContain("Wait on CI instead");
      // The whole point of the separate signal: `request_review` is the one
      // action that cannot help, and the advice must say so rather than send
      // the agent back round the loop that hung.
      expect(resultText(res)).toContain("Do not call `mcp__dispatch-github__request_review`");
      expect(resultText(res)).not.toContain("put a reviewer back on the hook");
    });

    it("calls the PR landable on checks alone when CI is green and no thread is open", async () => {
      const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD, PASS_LINT], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry(SPENT_POSTED),
      });

      const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      expect(resultText(res)).toContain('"landableOnChecks":true');
      expect(resultText(res)).toContain("landable on checks alone");
      expect(resultText(res)).toContain("approve_pr");
      // Landing stays approve_pr's job, and its own refusals stay the human's
      // to waive — the tool must not hint at an override.
      expect(resultText(res)).not.toContain("allowNoReview");
    });

    it("keeps answering the landable state rather than blocking on a re-call", async () => {
      const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry(SPENT_POSTED),
      });

      await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      // Green is deduped and no round can spawn, so with a once-ever flag this
      // second call would sit for the full window with NOTHING that could ever
      // end it. That is the bug in its purest form.
      const second = await watchPr.handler(
        { number: 83, repo: undefined, timeoutSeconds: 1800 },
        {},
      );
      expect(resultText(second)).toContain('"landableOnChecks":true');
      expect(resultText(second)).not.toContain('"timedOut":true');
      expect(vi.getTimerCount()).toBe(0);
    });

    it("says the cap is spent even when no round ever posted anything", async () => {
      // The normal case on this repo: the reviewer credential 403s on post, so
      // rounds run, spend the cap, and leave `postedAt` unset forever. Nothing
      // more is coming and the row cannot say so on its own.
      const gh = fakeGitHub([{ merge: OPEN, checks: [RUNNING_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry({
          rounds: 2,
          maxRounds: 2,
          chatId: "reviewer-1",
          reviewedAt: Date.now(),
        }),
      });

      const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      expect(resultText(res)).toContain('"reviewsSpent":true');
      expect(resultText(res)).toContain("none of them posted a review");
      expect(resultText(res)).toContain('"posted":false');
    });

    it("keeps waiting while the final round's chat is still working", async () => {
      // Claimed and unposted with a LIVE reviewer chat is a review being
      // written right now. Calling that "no review is coming" would race it.
      const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "running" }),
        github: gh,
        prRegistry: fakeRegistry({
          rounds: 2,
          maxRounds: 2,
          chatId: "reviewer-1",
          reviewedAt: Date.now(),
        }),
      });

      const first = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
      expect(resultText(first)).toContain("ci-passed"); // green still reports
      expect(resultText(first)).not.toContain("reviews-spent");

      const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resultText(await p)).toContain('"timedOut":true');
    });

    it("gives a round whose chat it cannot find the spawn window, then calls it over", async () => {
      // The lease is taken before the reviewer chat exists, so an unknown chat
      // is equally "spawning" and "long gone". Only the window separates them.
      const gh = fakeGitHub([{ merge: OPEN, checks: [RUNNING_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        github: gh,
        prRegistry: fakeRegistry({ rounds: 1, maxRounds: 1, reviewedAt: Date.now() }),
      });

      const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
      await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS);
      expect(vi.getTimerCount()).toBeGreaterThan(0); // still inside the window

      await vi.advanceTimersByTimeAsync(REVIEW_ROUND_GRACE_MS);
      expect(resultText(await p)).toContain('"reviewsSpent":true');
    });

    it("supersedes the stalled-queue advice a call LATER, when the cap is no longer news", async () => {
      const gh = fakeGitHub([
        {
          merge: OPEN,
          checks: [RUNNING_BUILD],
          threads: [],
          review: { requested: [], reported: [{ author: "dispatch-review", state: "COMMENTED" }] },
        },
      ]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry(SPENT_POSTED),
      });

      // Call one returns on the cap immediately — well inside the stall's grace
      // window, so the two signals arrive on DIFFERENT calls in practice.
      expect(
        resultText(await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {})),
      ).toContain('"type":"reviews-spent"');

      const p = watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});
      await vi.advanceTimersByTimeAsync(REVIEW_QUEUE_GRACE_MS);
      const res = await p;

      // The cap is deduped away as news, but it is still TRUE…
      expect(resultText(res)).toContain('"reviewStalled":true');
      expect(resultText(res)).toContain('"reviewsSpent":true');
      // …and only one action survives. Telling the agent to re-request here is
      // exactly how it ends up watching a queue entry the sweep can never claim.
      expect(resultText(res)).not.toContain("put a reviewer back on the hook");
      expect(resultText(res)).toContain("Do not call `mcp__dispatch-github__request_review`");
    });

    it("stays quiet while another round can still spawn", async () => {
      const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry({ ...SPENT_POSTED, rounds: 1, maxRounds: 4 }),
      });

      const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      expect(resultText(res)).toContain('"reviewsSpent":false');
      expect(resultText(res)).not.toContain("reviews-spent");
    });

    it("says nothing when the row never recorded a cap", async () => {
      // Rows written before `maxRounds` was mirrored onto them. Inventing a
      // denominator would report a permanent stop nobody can see.
      const gh = fakeGitHub([{ merge: OPEN, checks: [PASS_BUILD], threads: [] }]);
      const { watchPr } = createManagerTools({
        chatId: "c1",
        bus,
        broker: fakeBroker({ "reviewer-1": "done" }),
        github: gh,
        prRegistry: fakeRegistry({ rounds: 9, chatId: "reviewer-1", postedAt: 2_000 }),
      });

      const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 1800 }, {});

      expect(resultText(res)).toContain('"reviewsSpent":false');
    });
  });

  it("prints each review comment's thread id so resolve_thread is one call away", async () => {
    const gh = fakeGitHub([{ merge: OPEN, checks: [], threads: [THREAD_A] }]);
    const { watchPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), github: gh });

    const res = await watchPr.handler({ number: 83, repo: undefined, timeoutSeconds: 30 }, {});

    // Replying-without-resolving was the habit; the id being invisible in the
    // prose is what made the hand-rolled graphql alternative feel necessary.
    expect(resultText(res)).toContain("thread: T_A");
    expect(resultText(res)).toContain("resolve_thread");
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

  it("returns an informative error when the poll throws (gh error)", async () => {
    const gh: ManagerMcpGitHub = {
      pollPrState: async () => {
        throw new Error("gh: not authenticated");
      },
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

/* -------------------------------------------------- resolve_thread */

/** A GitHub binding that records the thread actions it was asked to perform. */
function fakeThreadGitHub(
  opts: { replyThrows?: string; resolveThrows?: string } = {},
): ManagerMcpGitHub & { replies: Array<[string, string]>; resolved: string[] } {
  const replies: Array<[string, string]> = [];
  const resolved: string[] = [];
  return {
    replies,
    resolved,
    pollPrState: async () => snap(),
    replyToThread: async (id, body) => {
      if (opts.replyThrows) throw new Error(opts.replyThrows);
      replies.push([id, body]);
    },
    resolveThread: async (id) => {
      if (opts.resolveThrows) throw new Error(opts.resolveThrows);
      resolved.push(id);
    },
  };
}

describe("manager-mcp — resolve_thread", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  it("replies then resolves, in that order", async () => {
    const gh = fakeThreadGitHub();
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await resolveThread.handler(
      { threadId: "T_A", reply: "Renamed it in 4f2a1c.", resolve: undefined },
      {},
    );

    expect(res.isError).toBeFalsy();
    expect(gh.replies).toEqual([["T_A", "Renamed it in 4f2a1c."]]);
    expect(gh.resolved).toEqual(["T_A"]);
    expect(resultText(res)).toContain("Resolved thread T_A");
  });

  it("resolves with no reply when none is given", async () => {
    const gh = fakeThreadGitHub();
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    await resolveThread.handler({ threadId: "T_A", reply: undefined, resolve: undefined }, {});

    expect(gh.replies).toEqual([]);
    expect(gh.resolved).toEqual(["T_A"]);
  });

  it("can reply WITHOUT resolving, and says the thread still blocks", async () => {
    const gh = fakeThreadGitHub();
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await resolveThread.handler(
      { threadId: "T_A", reply: "Disagree — out of scope here.", resolve: false },
      {},
    );

    expect(gh.replies).toHaveLength(1);
    expect(gh.resolved).toEqual([]);
    expect(resultText(res)).toContain("left it OPEN");
    expect(resultText(res)).toContain("block the merge");
  });

  // Reply-first is deliberate: a resolve that lands with a failed reply closes
  // the thread with no explanation, which is worse than not resolving at all.
  it("does NOT resolve when the reply fails", async () => {
    const gh = fakeThreadGitHub({ replyThrows: "gh: 403" });
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await resolveThread.handler(
      { threadId: "T_A", reply: "fixed", resolve: undefined },
      {},
    );

    expect(res.isError).toBe(true);
    expect(gh.resolved).toEqual([]);
    expect(resultText(res)).toContain("was NOT resolved");
  });

  it("says the reply landed even when the resolve fails", async () => {
    const gh = fakeThreadGitHub({ resolveThrows: "gh: node not found" });
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await resolveThread.handler(
      { threadId: "T_A", reply: "fixed", resolve: undefined },
      {},
    );

    expect(res.isError).toBe(true);
    expect(gh.replies).toHaveLength(1);
    expect(resultText(res)).toContain("Replied, but could not resolve");
  });

  it("refuses a no-op (no reply and no resolve) and a missing threadId", async () => {
    const gh = fakeThreadGitHub();
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const noop = await resolveThread.handler(
      { threadId: "T_A", reply: undefined, resolve: false },
      {},
    );
    expect(noop.isError).toBe(true);
    expect(resultText(noop)).toContain("would do nothing");

    const missing = await resolveThread.handler(
      { threadId: "  ", reply: "x", resolve: undefined },
      {},
    );
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain("requires a threadId");
    expect(gh.replies).toEqual([]);
  });

  // A narrower GitHub surface (one that can watch but not act) must not be
  // offered the tool, and must not silently no-op if it somehow is called.
  it("reports unavailable when the GitHub binding can't resolve threads", async () => {
    const { resolveThread } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: fakeGitHub([{ merge: OPEN }]), // watch-only binding
    });

    const res = await resolveThread.handler(
      { threadId: "T_A", reply: undefined, resolve: undefined },
      {},
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });
});

/* -------------------------------------------------- request_review */

describe("manager-mcp — request_review", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  const ghWith = (
    result: { requested: string[]; failed: Array<{ reviewer: string; error: string }> },
    defaults: readonly string[] = ["copilot-pull-request-reviewer[bot]"],
    /**
     * What the queue reads back as afterwards. Defaults to "whatever gh claimed
     * it requested"; `null` stands for a queue that couldn't be re-read.
     */
    verify?: string[] | null,
    /** The login Dispatch's own reviewer posts as, when the project has one. */
    reviewAgentLogin?: string,
  ): ManagerMcpGitHub & { asked: Array<{ n: number; list: readonly string[] }> } => {
    const asked: Array<{ n: number; list: readonly string[] }> = [];
    const queued = verify === undefined ? result.requested : verify;
    return {
      asked,
      defaultReviewers: defaults,
      reviewAgentLogin,
      pollPrState: async () =>
        snap({ review: queued === null ? null : { requested: queued, reported: [] } }),
      requestReviewers: async (n, list) => {
        asked.push({ n, list });
        return result;
      },
    };
  };

  it("defaults to the project's configured reviewers", async () => {
    const gh = ghWith({ requested: ["copilot-pull-request-reviewer[bot]"], failed: [] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: undefined, repo: undefined }, {});

    expect(gh.asked).toEqual([{ n: 83, list: ["copilot-pull-request-reviewer[bot]"] }]);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("Review requested on PR #83");
    expect(resultText(res)).toContain("now awaiting review from copilot-pull-request-reviewer[bot]");
    expect(resultText(res)).toContain("watch_pr");
  });

  it("uses an explicit reviewer list over the default", async () => {
    const gh = ghWith({ requested: ["alice"], failed: [] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: ["alice"], repo: undefined }, {});

    expect(gh.asked[0]!.list).toEqual(["alice"]);
  });

  // An empty list is a config fault, not something to retry — saying so is what
  // stops the re-request/re-watch loop on a project that asks nobody.
  it("names the config when there is nobody to ask", async () => {
    const gh = ghWith({ requested: [], failed: [] }, []);
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: undefined, repo: undefined }, {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("workflow.pr.reviewers");
    expect(gh.asked).toEqual([]); // never even tried
  });

  it("reports a partial failure without claiming success", async () => {
    const gh = ghWith({ requested: [], failed: [{ reviewer: "ghost", error: "Not Found" }] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: ["ghost"], repo: undefined }, {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Nobody is queued");
    expect(resultText(res)).toContain("Not Found");
    expect(resultText(res)).toContain("retrying the same list will fail the same way");
  });

  // Observed live on PR #22: asking Copilot for a re-review after it had already
  // reported returned exit 0 and queued NOBODY. Calling that a success is the
  // worst outcome available — it sends the agent back to watch_pr to wait on the
  // very empty queue this tool exists to refill.
  it("does not claim success when GitHub accepts the request but queues nobody", async () => {
    const gh = ghWith({ requested: ["copilot-pull-request-reviewer[bot]"], failed: [] }, undefined, []);
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: undefined, repo: undefined }, {});

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Nobody is queued");
    expect(resultText(res)).toContain("STILL EMPTY");
    expect(resultText(res)).toContain("Do NOT go back to watch_pr");
    expect(resultText(res)).toContain('"verified":true');
  });

  it("reports who is actually on the hook, not merely who was asked", async () => {
    // gh claims two; the queue only really holds one.
    const gh = ghWith({ requested: ["alice", "bob"], failed: [] }, undefined, ["alice"]);
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler(
      { number: 83, extraRounds: undefined, reviewers: ["alice", "bob"], repo: undefined },
      {},
    );

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("now awaiting review from alice");
    expect(resultText(res)).toContain('"requested":["alice"]');
  });

  it("falls back to gh's own answer when the queue can't be re-read", async () => {
    const gh = ghWith({ requested: ["alice"], failed: [] }, undefined, null);
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await requestReview.handler({ number: 83, extraRounds: undefined, reviewers: ["alice"], repo: undefined }, {});

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("queue not re-read");
    expect(resultText(res)).toContain('"verified":false');
  });

  /**
   * A catalog that answers the reviewer question and records a cap raise —
   * everything else degrades to null, which is the interface's contract.
   */
  function reviewRegistry(
    state: PrReviewAgentState | null,
    raises: number[] = [],
  ): ManagerMcpPrRegistry {
    return {
      snapshot: async () => null,
      refresh: async () => null,
      noteWatched: async () => {},
      refreshByThread: async () => null,
      snapshotByThread: async () => null,
      reviewAgent: async () => state,
      raiseReviewRoundCap: async (_n, _repo, extra) => {
        raises.push(extra);
      },
      noteReviewRequestError: async () => {},
      notePostedReview: async () => {},
    };
  }

  // The loop that produced the contradiction on PR #147: `watch_pr` says the
  // rounds are spent, the agent calls `request_review` anyway, and the request
  // lands on GitHub — which drops the reviews already filed out of
  // `latestReviews`, so `approve_pr` then refuses a PR that was ready. The
  // cheapest place to break that chain is to not make the request.
  it("refuses to re-request once the rounds are spent, and says the bar is MET", async () => {
    const gh = ghWith(
      { requested: ["dispatch-review"], failed: [] },
      ["dispatch-review"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry({
        rounds: 2,
        maxRounds: 2,
        chatId: "reviewer-1",
        reviewedAt: 1_000,
        postedAt: 2_000,
      }),
    });

    const res = await requestReview.handler(
      { number: 147, extraRounds: undefined, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("requirement for this PR is MET");
    expect(resultText(res)).toContain("approve_pr");
    expect(resultText(res)).toContain('"requirementMet":true');
    // The whole point: GitHub is never touched, so nothing gets superseded.
    expect(gh.asked).toEqual([]);
  });

  it("says the rounds died unreviewed rather than claiming the bar is met", async () => {
    const gh = ghWith(
      { requested: ["dispatch-review"], failed: [] },
      ["dispatch-review"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry({ rounds: 2, maxRounds: 2, chatId: "r1", reviewedAt: 1_000 }),
    });

    const res = await requestReview.handler(
      { number: 147, extraRounds: undefined, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(resultText(res)).toContain("none of them posted a review");
    expect(resultText(res)).toContain('"requirementMet":false');
  });

  it("extraRounds raises the cap and lets the request through", async () => {
    const raises: number[] = [];
    const gh = ghWith({ requested: ["dispatch-review"], failed: [] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry(
        { rounds: 2, maxRounds: 2, chatId: "r1", reviewedAt: 1_000, postedAt: 2_000 },
        raises,
      ),
    });


    const res = await requestReview.handler(
      { number: 147, extraRounds: 1, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(raises).toEqual([1]);
    expect(gh.asked).toEqual([{ n: 147, list: ["dispatch-review"] }]);
    expect(resultText(res)).toContain("dispatch-review");
  });

  // The refusal is about ONE account. A project can ask both a machine reviewer
  // and a human, and a spent Dispatch cap says nothing about the human — aborting
  // the whole call reported success while alice was never queued at all.
  it("still queues the OTHER reviewers when only Dispatch's own cap is spent", async () => {
    const gh = ghWith(
      { requested: ["alice"], failed: [] },
      ["dispatch-review", "alice"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry({
        rounds: 2,
        maxRounds: 2,
        chatId: "r1",
        reviewedAt: 1_000,
        postedAt: 2_000,
      }),
    });

    const res = await requestReview.handler(
      { number: 147, extraRounds: undefined, reviewers: ["alice"], repo: undefined },
      {},
    );

    // alice is asked; the spent reviewer is dropped from the list, not the call.
    expect(gh.asked).toEqual([{ n: 147, list: ["alice"] }]);
    expect(resultText(res)).toContain("alice");
    // …and the spent cap is still SAID, or it goes silent just because somebody
    // else happened to be askable.
    expect(resultText(res)).toContain("was NOT asked");
  });

  it("drops Dispatch's own reviewer from a spent list but keeps the rest", async () => {
    const gh = ghWith(
      { requested: ["alice"], failed: [] },
      ["dispatch-review", "alice"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry({
        rounds: 2,
        maxRounds: 2,
        chatId: "r1",
        reviewedAt: 1_000,
        postedAt: 2_000,
      }),
    });

    // No explicit list, so it falls back to the project's two configured
    // reviewers — one of which is the spent one.
    await requestReview.handler(
      { number: 147, extraRounds: undefined, reviewers: undefined, repo: undefined },
      {},
    );

    expect(gh.asked).toEqual([{ n: 147, list: ["alice"] }]);
  });

  // A grant clears the head dedup, so it would also let a second round spawn
  // beside one still writing — two reviewers on the same diff. Waiting is the
  // answer there.
  it("refuses extraRounds while a round is claimed and its chat is alive", async () => {
    const raises: number[] = [];
    const gh = ghWith(
      { requested: ["dispatch-review"], failed: [] },
      ["dispatch-review"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      // The reviewer chat is still going.
      broker: fakeBroker({ "reviewer-1": "running" }),
      github: gh,
      prRegistry: reviewRegistry(
        // Claimed, never posted — `running`.
        { rounds: 2, maxRounds: 2, chatId: "reviewer-1", reviewedAt: 1_000 },
        raises,
      ),
    });

    const res = await requestReview.handler(
      { number: 147, extraRounds: 1, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("still running");
    expect(raises).toEqual([]);
    expect(gh.asked).toEqual([]);
  });

  it("grants extraRounds once that chat is over — the reviewer-died case", async () => {
    const raises: number[] = [];
    const gh = ghWith(
      { requested: ["dispatch-review"], failed: [] },
      ["dispatch-review"],
      undefined,
      "dispatch-review",
    );
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ "reviewer-1": "error" }),
      github: gh,
      prRegistry: reviewRegistry(
        { rounds: 2, maxRounds: 2, chatId: "reviewer-1", reviewedAt: 1_000 },
        raises,
      ),
    });

    await requestReview.handler(
      { number: 147, extraRounds: 1, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(raises).toEqual([1]);
    expect(gh.asked).toEqual([{ n: 147, list: ["dispatch-review"] }]);
  });

  it("leaves an unspent cap alone — this gate must not cost the ordinary path", async () => {
    const gh = ghWith({ requested: ["dispatch-review"], failed: [] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      prRegistry: reviewRegistry({ rounds: 1, maxRounds: 2, chatId: "r1", postedAt: 2_000 }),
    });

    await requestReview.handler(
      { number: 147, extraRounds: undefined, reviewers: ["dispatch-review"], repo: undefined },
      {},
    );

    expect(gh.asked).toEqual([{ n: 147, list: ["dispatch-review"] }]);
  });

  it("validates the PR number and reports an unavailable binding", async () => {
    const gh = ghWith({ requested: [], failed: [] });
    const { requestReview } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });
    const bad = await requestReview.handler({ number: -1, extraRounds: undefined, reviewers: undefined, repo: undefined }, {});
    expect(bad.isError).toBe(true);
    expect(resultText(bad)).toContain("positive integer");

    const { requestReview: unbound } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    const res = await unbound.handler({ number: 1, extraRounds: undefined, reviewers: undefined, repo: undefined }, {});
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
    // No Dispatch reviewer row by default — these tests are about GitHub's
    // evidence, and the round record is a SECOND, independent way the bar is met.
    reviewRounds: null,
    ...over,
    // Defaulted FROM `submittedReviews` unless a test names it, because the ever-
    // list is a superset of the live one in reality: a test that says "GitHub
    // shows no review" means both lists are empty, and having to say so twice
    // would be a trap rather than coverage. The tests that matter here are the
    // ones where the two genuinely DIVERGE, and those pass it explicitly.
    everSubmittedReviews:
      over.everSubmittedReviews !== undefined
        ? over.everSubmittedReviews
        : (over.submittedReviews !== undefined
            ? over.submittedReviews
            : [{ author: "copilot-pull-request-reviewer", state: "APPROVED" }]),
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

  // `reviewDecision` is an aggregate GitHub only clears when the SAME reviewer
  // submits a fresh APPROVED review. Dispatch's reviewer never submits one and
  // stops permanently at its round cap, so this blocker had no exit: no override
  // takes it, no later round clears it. PR #149 hit exactly that with every
  // finding fixed and every thread resolved.
  it("stops blocking once the changes-requested verdict is STALE and nothing is open", () => {
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: [],
        everSubmittedReviews: [
          { author: "dispatch-review", state: "CHANGES_REQUESTED", stale: true },
        ],
        submittedReviews: [{ author: "dispatch-review", state: "CHANGES_REQUESTED" }],
      }),
      { requireReview: true },
    );
    expect(b).toEqual([]);
  });

  // Both halves are required, and each is tested on its own. A stale verdict
  // with an open thread behind it is still an objection.
  it("keeps blocking when a stale verdict still has an open thread", () => {
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: [{ id: "t1", isResolved: false, path: "a.ts", line: 1 }],
        everSubmittedReviews: [
          { author: "dispatch-review", state: "CHANGES_REQUESTED", stale: true },
        ],
      }),
    );
    expect(b.map((x) => x.code)).toContain("changes-requested");
  });

  it("keeps blocking when the verdict is about the CURRENT head", () => {
    // They asked for changes to code that is still there. Resolving the thread
    // does not make that go away.
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: [],
        everSubmittedReviews: [
          { author: "dispatch-review", state: "CHANGES_REQUESTED", stale: false },
        ],
      }),
    );
    expect(b.map((x) => x.code)).toContain("changes-requested");
  });

  it("keeps blocking when staleness could not be determined", () => {
    // `undefined` is "couldn't compare" — it must not read as stale, or an
    // unreadable commit would forgive a live objection.
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: [],
        everSubmittedReviews: [{ author: "dispatch-review", state: "CHANGES_REQUESTED" }],
      }),
    );
    expect(b.map((x) => x.code)).toContain("changes-requested");
  });

  it("keeps blocking when the threads can't be read at all", () => {
    // No way to tell whether anything is outstanding, so the verdict stands.
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: null,
        everSubmittedReviews: [
          { author: "dispatch-review", state: "CHANGES_REQUESTED", stale: true },
        ],
      }),
    );
    expect(b.map((x) => x.code)).toContain("changes-requested");
  });

  it("keeps blocking when one of two changes-requested verdicts is current", () => {
    // Every one of them has to be stale. A second reviewer objecting to the
    // code as it stands is not superseded by the first one's verdict ageing out.
    const b = prLandingBlockers(
      readyPr({
        reviewDecision: "changes_requested",
        threads: [],
        everSubmittedReviews: [
          { author: "dispatch-review", state: "CHANGES_REQUESTED", stale: true },
          { author: "alice", state: "CHANGES_REQUESTED", stale: false },
        ],
      }),
    );
    expect(b.map((x) => x.code)).toContain("changes-requested");
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

  // The PR is already OPEN, so "re-open it through create_pr" was advice the
  // agent could not take — create_pr refuses a branch that already has a PR. The
  // actionable move is to ask again, because GitHub clears a reviewer's request
  // once they report and fix commits don't re-queue them.
  it("points at request_review when nobody was ASKED but reviewers ARE configured", () => {
    const b = prLandingBlockers(readyPr({ submittedReviews: [], requestedReviewers: [] }), {
      requireReview: true,
      reviewers: ["copilot-pull-request-reviewer[bot]"],
    });
    expect(b[0].detail).toMatch(/copilot-pull-request-reviewer/);
    expect(b[0].detail).toMatch(/request_review/);
    expect(b[0].detail).not.toMatch(/create_pr/);
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

  // The disagreement this whole change is about. `watch_pr` told chat Akn-… that
  // PR #147 was landable on checks alone; `approve_pr`, called seconds later,
  // refused it for `no-review` — on a PR carrying two dispatch-review reviews.
  // The cause is GitHub's supersede-on-re-request: `request_review` had just put
  // the reviewer back in the queue, which empties `latestReviews`.
  it("lands a PR whose review only vanished from latestReviews on a re-request", () => {
    const b = prLandingBlockers(
      readyPr({
        // GitHub's live view: nobody has reported, and the reviewer is queued.
        submittedReviews: [],
        requestedReviewers: ["dispatch-review"],
        // The truth: they reviewed it, twice.
        everSubmittedReviews: [{ author: "dispatch-review", state: "COMMENTED" }],
      }),
      { requireReview: true, reviewers: ["dispatch-review"] },
    );
    expect(b).toEqual([]);
  });

  // The second, independent route to the same answer: Dispatch's own round
  // record. `watch_pr` already reads it to say "the reviewer is DONE"; the merge
  // gate reading only GitHub is what let the two contradict each other.
  it("counts two COMPLETED review rounds as the review requirement being met", () => {
    const b = prLandingBlockers(
      readyPr({
        submittedReviews: [],
        everSubmittedReviews: [],
        requestedReviewers: ["dispatch-review"],
        reviewRounds: { roundsSpent: true, posted: true, round: 2, maxRounds: 2 },
      }),
      { requireReview: true, reviewers: ["dispatch-review"] },
    );
    expect(b).toEqual([]);
  });

  // Spent is NOT the same as reviewed. A round is claimed before the reviewer
  // chat exists, so a cap burned by rounds that all died still spends it — and
  // merging on that is the silent unreviewed merge the whole bar exists to stop.
  it("does NOT count spent rounds that never posted anything", () => {
    const b = prLandingBlockers(
      readyPr({
        submittedReviews: [],
        everSubmittedReviews: [],
        requestedReviewers: ["dispatch-review"],
        reviewRounds: { roundsSpent: true, posted: false, round: 2, maxRounds: 2 },
      }),
      { requireReview: true, reviewers: ["dispatch-review"] },
    );
    expect(b.map((x) => x.code)).toEqual(["no-review"]);
    // And it must not send the agent back to watch_pr: no round can spawn, so
    // that wait can never end. That dead wait is what `reviews-spent` exists for.
    expect(b[0].detail).not.toMatch(/Call watch_pr/);
    expect(b[0].detail).toMatch(/extraRounds/);
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

/* ------------------------------------------------------ request_exemption */

/** A scriptable exemption binding recording exactly what it was asked for. */
function fakeExemptions(
  opts: {
    verdict?: Awaited<ReturnType<ManagerMcpExemptions["request"]>>;
    throws?: string;
    existing?: WorkflowExemption[];
  } = {},
) {
  const asked: Parameters<ManagerMcpExemptions["request"]>[0][] = [];
  const binding: ManagerMcpExemptions = {
    request: async (input) => {
      asked.push(input);
      if (opts.throws) throw new Error(opts.throws);
      return opts.verdict ?? { granted: false };
    },
    list: () => opts.existing ?? [],
  };
  return { binding, asked };
}

function granted(over: Partial<WorkflowExemption> = {}): WorkflowExemption {
  return {
    id: "x1",
    scope: "pr-create-by-hand",
    lifetime: "session",
    reason: "create_pr keeps refusing with 'Could not resolve this chat's repo or branch'",
    grantedAt: 1,
    uses: 0,
    ...over,
  };
}

describe("manager-mcp — request_exemption", () => {
  it("reports the grant and its lifetime when the human says yes", async () => {
    const { binding, asked } = fakeExemptions({
      verdict: { granted: true, exemption: granted({ lifetime: "once" }) },
    });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    const res = await requestExemption.handler(
      { guard: "pr-create-by-hand", reason: "create_pr is down", command: "gh pr create --fill" },
      {},
    );
    expect(asked).toEqual([
      {
        scope: "pr-create-by-hand",
        reason: "create_pr is down",
        command: "gh pr create --fill",
      },
    ]);
    const text = resultText(res);
    expect(text).toContain("Granted");
    expect(text).toContain("one shot");
    expect(JSON.parse(text.slice(text.lastIndexOf("{")))).toMatchObject({
      granted: true,
      lifetime: "once",
    });
  });

  it("treats a refusal as an ANSWER, not an error, and says don't re-ask", async () => {
    // Same shape as the approve_pr override decline: flagging it as an error is
    // what pushes a model into retrying the thing it was just told not to do.
    const { binding } = fakeExemptions({
      verdict: { granted: false, message: "fix create_pr instead" },
    });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    const res = await requestExemption.handler(
      { guard: "pr-create-by-hand", reason: "blocked", command: undefined },
      {},
    );
    expect(res.isError).toBeFalsy();
    const text = resultText(res);
    expect(text).toContain("fix create_pr instead");
    expect(text).toMatch(/don't re-ask/i);
    expect(JSON.parse(text.slice(text.lastIndexOf("{")))).toMatchObject({ granted: false });
  });

  it("fails CLOSED when the card can't be raised at all", async () => {
    const { binding } = fakeExemptions({ throws: "no live session to ask through" });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    const text = resultText(
      await requestExemption.handler({ guard: "all", reason: "everything is broken", command: undefined }, {}),
    );
    expect(text).toContain("Not granted");
    expect(text).toContain("no live session");
  });

  it("doesn't spend a second card on a guard that's already lifted", async () => {
    const { binding, asked } = fakeExemptions({ existing: [granted()] });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    const text = resultText(
      await requestExemption.handler(
        { guard: "pr-create-by-hand", reason: "still stuck", command: undefined },
        {},
      ),
    );
    expect(asked).toEqual([]);
    expect(text).toContain("Already exempt");
  });

  it("counts an existing `all` grant as covering a narrower ask", async () => {
    const { binding, asked } = fakeExemptions({ existing: [granted({ scope: "all" })] });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    await requestExemption.handler({ guard: "push-to-trunk", reason: "x", command: undefined }, {});
    expect(asked).toEqual([]);
  });

  it("still asks for `all` when only a narrow grant is held", async () => {
    const { binding, asked } = fakeExemptions({ existing: [granted()] });
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    await requestExemption.handler({ guard: "all", reason: "x", command: undefined }, {});
    expect(asked).toHaveLength(1);
  });

  it("refuses a request with no reason — that's the whole basis for the decision", async () => {
    const { binding, asked } = fakeExemptions();
    const { requestExemption } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      exemptions: binding,
    });
    const res = await requestExemption.handler(
      { guard: "pr-create-by-hand", reason: "   ", command: undefined },
      {},
    );
    expect(res.isError).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("exemptionConsentQuestion / readExemptionAnswer", () => {
  it("quotes the command and the agent's reason — the two things worth reading", () => {
    const q = exemptionConsentQuestion({
      scope: "pr-create-by-hand",
      command: "gh pr create --fill --base main",
      reason: "create_pr returns 'Could not resolve this chat's repo or branch'",
    });
    expect(q.question).toContain("gh pr create --fill --base main");
    expect(q.question).toContain("Could not resolve");
    expect(q.question).toContain("THIS CHAT");
    expect(q.options.map((o) => o.label)).toEqual([
      EXEMPTION_ANSWERS.once,
      EXEMPTION_ANSWERS.session,
      EXEMPTION_ANSWERS.no,
    ]);
  });

  it("shouts about `all`, which is the grant that covers guards nobody discussed", () => {
    const q = exemptionConsentQuestion({ scope: "all", reason: "several guards at once" });
    expect(q.question).toContain("EVERY workflow guard");
    // …and doesn't shout on a narrow one, or the warning means nothing.
    expect(
      exemptionConsentQuestion({ scope: "push-to-trunk", reason: "x" }).question,
    ).not.toContain("EVERY workflow guard");
  });

  it("maps only the two YES labels to a lifetime; everything else is a NO", () => {
    expect(readExemptionAnswer(EXEMPTION_ANSWERS.once)).toBe("once");
    expect(readExemptionAnswer(EXEMPTION_ANSWERS.session)).toBe("session");
    expect(readExemptionAnswer(EXEMPTION_ANSWERS.no)).toBeNull();
    expect(readExemptionAnswer(undefined)).toBeNull();
    // Free-form prose is NOT consent to a particular scope — reading it as one
    // is exactly the inference that produced the unreviewed merge confirmOverride
    // exists to prevent.
    expect(readExemptionAnswer("yeah go on then")).toBeNull();
  });

  it("still reads a picked option when the human attached a note to it", () => {
    // The card appends notes as `<label> — additional instructions: …`. An
    // exact-match read would turn a yes-with-a-caveat into a silent denial.
    expect(
      readExemptionAnswer(`${EXEMPTION_ANSWERS.session} — additional instructions: only for #93`),
    ).toBe("session");
    expect(
      readExemptionAnswer(`${EXEMPTION_ANSWERS.no} — additional instructions: fix create_pr`),
    ).toBeNull();
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

  it("names both causes, and never tells the agent to get a worktree it has", async () => {
    // This message used to be "Make sure the chat has a worktree." — which was
    // the WRONG advice in the case that produced it most: a chat whose bound
    // worktree had been reaped after a merge had a perfectly good one, and no
    // way to act on being told to get another. The two live causes are a
    // directory the server can't see (pass `cwd`) and a `gh` that can't name the
    // repository (sign in / check `origin`), and they have different remedies.
    const { binding } = fakePrCreate(null);
    const { createPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      prCreate: binding,
    });
    const text = resultText(await createPr.handler(createArgs(), {}));

    expect(text).toContain("pass `cwd`");
    expect(text).toContain("gh repo view");
    expect(text).not.toMatch(/Make sure the chat has a worktree/);
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
    // Split the card payload off first: PR tools now answer with prose for the
    // model AND one machine-readable line for the transcript, so "the last {"
    // is the payload's, not the model-facing JSON's.
    const { payload, text } = decodePrToolPayload(resultText(res));
    expect(text).toMatch(/did not approve the override/i);
    expect(text).toMatch(/wait for copilot/);
    expect(text).toMatch(/don't re-ask/i);
    expect(JSON.parse(text.slice(text.lastIndexOf("{")))).toMatchObject({
      merged: false,
      overrideDeclined: true,
      blockers: ["no-review"],
    });
    // …and the card says the same thing, without the human having to read prose.
    expect(payload).toMatchObject({
      tool: "approve_pr",
      outcome: { ok: false, summary: expect.stringMatching(/declined the override/i) },
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
        tail: async () => ({ output: "", found: false }),
        list: () => [],
      },
    });

    const res = await terminal.handler({ name: "build", command: "pnpm build", timeoutMs: undefined, background: undefined }, {});
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
        tail: async () => ({ output: "", found: false }),
        list: () => [],
      },
    });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined, background: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("cap reached");
  });

  it("reports unavailable when no TerminalService is wired", async () => {
    const { terminal } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined, background: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });

  it("validates a non-empty command", async () => {
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: {
        run: async () => ({ output: "", exitCode: 0, cwd: "" }),
        tail: async () => ({ output: "", found: false }),
        list: () => [],
      },
    });
    const res = await terminal.handler({ name: "x", command: "   ", timeoutMs: undefined, background: undefined }, {});
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
    read: async (name) => data.get(slug(name)) ?? null,
    inventory: async (opts) => {
      const live = new Set(data.keys());
      const linksOf = new Map<string, string[]>(
        [...data.values()].map((m) => [
          m.name,
          [...m.body.matchAll(/\[\[([^\]]+)\]\]/g)]
            .map((x) => slug(x[1] ?? ""))
            .filter((t) => live.has(t) && t !== m.name),
        ]),
      );
      return [...data.values()]
        .filter((m) => !opts?.type || m.type === opts.type)
        .filter((m) => !opts?.prefix || m.name.startsWith(opts.prefix))
        .filter((m) => !opts?.names?.length || opts.names.map(slug).includes(m.name))
        .map((m) => ({
          ...m,
          chars: m.body.length,
          surfaced: 0,
          recalled: 0,
          links: linksOf.get(m.name) ?? [],
          backlinks: [...linksOf.entries()]
            .filter(([, targets]) => targets.includes(m.name))
            .map(([from]) => from),
        }));
    },
    grep: async (opts) => {
      const re = new RegExp(
        opts.regex ? opts.pattern : opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        opts.caseSensitive ? "" : "i",
      );
      const matches = [...data.values()]
        .filter((m) => re.test(m.body))
        .map((m) => ({ name: m.name, type: m.type, field: "body" as const, line: 1, text: m.body }));
      return { matches, truncated: false, timedOut: false, scanned: data.size };
    },
    findSimilar: async (candidate, opts) => {
      const slugName = slug(candidate.name);
      const cand = {
        name: slugName,
        description: candidate.description ?? "",
        body: candidate.body ?? "",
      };
      return [...data.values()]
        .filter((m) => m.name !== slugName)
        .map((m) => ({ m, similarity: memorySimilarity(cand, m) }))
        .filter((s) => s.similarity >= (opts?.threshold ?? 0.35))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, opts?.limit ?? 3)
        .map((s) => ({
          name: s.m.name,
          description: s.m.description,
          similarity: Math.round(s.similarity * 100) / 100,
        }));
    },
  };
}

/**
 * The manager tools keyed by their WIRE name (`memory_list`), not the factory's
 * variable name. The curation tools are exercised by the name an agent actually
 * calls, so a rename that breaks the tool can't pass because the local binding
 * still resolves.
 */
type LooseTool = {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
};

function toolsByName(memory: ManagerMcpMemory): Record<string, LooseTool> {
  const tools = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory });
  return Object.fromEntries(
    Object.values(tools).map((t) => [t.name, t as unknown as LooseTool]),
  );
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

  it("memory_list reports the curation signals, honours filters, and sorts", async () => {
    const mem = fakeMemory();
    await mem.remember({
      name: "hub",
      description: "the central fact",
      type: "project",
      body: "points at [[spoke]]",
    });
    await mem.remember({ name: "spoke", description: "pointed at", type: "reference", body: "s" });
    const { memory_list: list } = toolsByName(mem);

    const all = await list.handler({}, {});
    const text = resultText(all);
    expect(text).toContain("2 memories");
    expect(text).toContain("never retrieved");
    expect(text).toContain("→ spoke"); // hub's outbound link
    expect(text).toContain("← hub"); // spoke's backlink

    const filtered = resultText(await list.handler({ type: "reference" }, {}));
    expect(filtered).toContain("spoke");
    expect(filtered).not.toContain("`hub`");

    // Biggest first — the "what is this store spending its context on" view.
    const bySize = resultText(await list.handler({ sort: "size" }, {}));
    expect(bySize.indexOf("`hub`")).toBeLessThan(bySize.indexOf("`spoke`"));
  });

  it("memory_list bounds even the plain listing of a very large store", async () => {
    const mem = fakeMemory();
    for (let i = 0; i < 400; i++) {
      await mem.remember({
        name: `fact-${i}`,
        description: "d".repeat(300),
        type: "project",
        body: "b",
      });
    }
    const { memory_list: list } = toolsByName(mem);
    const text = resultText(await list.handler({ limit: 400 }, {}));
    expect(text.length).toBeLessThan(30000);
    expect(text).toContain("omitted to stay within the size limit");
  });

  it("memory_list bounds its output when bodies are requested", async () => {
    const mem = fakeMemory();
    for (let i = 0; i < 10; i++) {
      await mem.remember({
        name: `big-${i}`,
        description: `d${i}`,
        type: "project",
        body: "x".repeat(20000),
      });
    }
    const { memory_list: list } = toolsByName(mem);
    const text = resultText(await list.handler({ includeBody: true }, {}));
    expect(text.length).toBeLessThan(30000);
    expect(text).toMatch(/truncated .* more chars|omitted to stay within/);
  });

  it("memory_search groups hits by memory and says when it truncated", async () => {
    const mem = fakeMemory();
    await mem.remember({
      name: "taskkill-orphans",
      description: "d",
      type: "feedback",
      body: "never taskkill the server",
    });
    await mem.remember({ name: "other", description: "d", type: "project", body: "unrelated" });
    const { memory_search: search } = toolsByName(mem);

    const hit = resultText(await search.handler({ pattern: "taskkill" }, {}));
    expect(hit).toContain("1 hit(s) in 1 memory");
    expect(hit).toContain("taskkill-orphans");

    const miss = resultText(await search.handler({ pattern: "nothing-here" }, {}));
    expect(miss).toContain("No memory matches");
  });

  it("memory_search flags a timed-out scan as PARTIAL, not as the whole answer", async () => {
    const mem = fakeMemory();
    await mem.remember({ name: "a", description: "d", type: "project", body: "match" });
    const slow: ManagerMcpMemory = {
      ...mem,
      grep: async () => ({
        matches: [{ name: "a", type: "project" as const, field: "body" as const, line: 1, text: "match" }],
        truncated: true,
        timedOut: true,
        scanned: 1,
      }),
    };
    const { memory_search: search } = toolsByName(slow);
    const text = resultText(await search.handler({ pattern: "match", regex: true }, {}));
    // Exhaustiveness is this tool's entire value — a partial result that reads
    // complete is worse than an error.
    expect(text).toContain("PARTIAL");
    expect(text).not.toContain("raise `limit`");
  });

  it("memory_similar sweeps wider when asked, and needs something to compare", async () => {
    const mem = fakeMemory();
    await mem.remember({
      name: "pfsense-wan-flap",
      description: "pfSense WAN speed duplex autoselect link flap",
      type: "project",
      body: "b",
    });
    await mem.remember({
      name: "pfsense-wan-autoselect",
      description: "pfSense WAN autoselect duplex speed causes a link flap",
      type: "project",
      body: "b",
    });
    const { memory_similar: similar } = toolsByName(mem);

    const byName = resultText(await similar.handler({ name: "pfsense-wan-flap" }, {}));
    expect(byName).toContain("pfsense-wan-autoselect");
    expect(byName).toContain("% similar");

    // Free text compares against all three fields — see the tool's note on why.
    const byText = resultText(
      await similar.handler({ text: "pfSense WAN autoselect duplex link flap", threshold: 0.25 }, {}),
    );
    expect(byText).toContain("pfsense-wan");

    const unknown = await similar.handler({ name: "ghost" }, {});
    expect(unknown.isError).toBe(true);
    const neither = await similar.handler({}, {});
    expect(neither.isError).toBe(true);
    expect(resultText(neither)).toContain("either a `name` or some `text`");
  });

  it("memory_history reports an unavailable history as an answer, not an error", async () => {
    const mem = fakeMemory();
    const withHistory = {
      ...mem,
      history: async () => ({
        available: false,
        reason: "this project's memory lives in the runtime store",
        commits: [],
      }),
    };
    const { memory_history: history } = toolsByName(withHistory);
    const res = await history.handler({}, {});
    // An agent that reads this as a failure retries; it must read as a fact.
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("runtime store");
  });

  it("memory_history renders commits and drops the generated index from the file list", async () => {
    const mem = fakeMemory();
    const withHistory = {
      ...mem,
      history: async () => ({
        available: true,
        commits: [
          {
            sha: "abc1234def",
            date: "2026-08-01T10:00:00Z",
            author: "Michael",
            subject: "chore(memory): update two memories",
            files: [
              { name: "deploy-runbook", kind: "modified" as const },
              { name: "old-fact", kind: "deleted" as const },
              // MEMORY.md changes on EVERY memory commit, so listing it would
              // make each line read as if the index were the interesting change.
              { name: "MEMORY", kind: "modified" as const },
            ],
          },
        ],
      }),
    };
    const { memory_history: history } = toolsByName(withHistory);
    const text = resultText(await history.handler({}, {}));
    expect(text).toContain("2026-08-01");
    expect(text).toContain("abc1234d");
    expect(text).toContain("deleted old-fact");
    expect(text).not.toContain("MEMORY");
  });

  it("each curation tool degrades cleanly when its backing surface is missing", async () => {
    // `findSimilar`/`inventory`/`grep`/`history` are all optional on the
    // interface, so a session on older wiring must get a readable message
    // rather than a crash inside the handler.
    const bare: ManagerMcpMemory = {
      remember: async () => {
        throw new Error("unused");
      },
      recall: async () => ({ index: "", matches: [] }),
      forget: async () => false,
    };
    const tools = toolsByName(bare);
    for (const name of ["memory_list", "memory_search", "memory_history", "memory_similar"]) {
      const res = await tools[name]!.handler({ pattern: "x", name: "y" }, {});
      expect(res.isError, name).toBe(true);
      expect(resultText(res), name).toContain("not available in this session");
    }
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
    detached: undefined,
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

  it("nests by default, and passes `detached` through when the agent opts out", async () => {
    // Opt-OUT, not opt-in: a chat spawned BY a chat is a child of it, and
    // defaulting to detached is what put five spawned chats in the sidebar as
    // five unrelated top-level rows. The flag has to reach `spawn` verbatim —
    // it is the only thing that decides whether `parentChatId` gets written.
    const chats = fakeChats({});
    const { spawnChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      chats: chats.binding,
    });

    await spawnChat.handler(spawnArgs({ prompt: "go" }), {});
    await spawnChat.handler(spawnArgs({ prompt: "go", detached: true }), {});

    expect(chats.calls.spawned[0]?.detached).toBe(false);
    expect(chats.calls.spawned[1]?.detached).toBe(true);
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

/**
 * Tool names registered across ALL of a session's category servers.
 *
 * The tests below assert which tools a binding does and does not buy, which is
 * a question about the whole toolbox, not about one server — so the partition is
 * flattened away here rather than in each assertion.
 */
const registeredNames = (ctx: Parameters<typeof createManagerMcpServers>[0]): string[] =>
  Object.values(createManagerMcpServers(ctx)).flatMap((server) =>
    Object.keys(
      (server as unknown as { instance: { _registeredTools?: Record<string, unknown> } })
        .instance._registeredTools ?? {},
    ),
  );

describe("manager-mcp — server factory", () => {
  it("builds one in-process SDK server per category, all `dispatch-` prefixed", () => {
    const servers = createManagerMcpServers({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    // A bare session has no GitHub/memory/terminal bindings, so only the
    // always-on categories are built — an unbound category is ABSENT rather
    // than registered empty.
    expect(Object.keys(servers).sort()).toEqual(["dispatch-chat", "dispatch-confirm", "dispatch-session"]);
    for (const [name, server] of Object.entries(servers)) {
      expect(server.type).toBe("sdk");
      expect(server.name).toBe(name);
      expect(server.instance).toBeDefined();
    }
  });

  it("serves every tool from exactly one category server", () => {
    const servers = createManagerMcpServers({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: fakeGitHub([]),
      prCreate: fakePrCreate(readyBranch()).binding,
      prApproval: fakeApproval(readyPr()).binding,
      exemptions: fakeExemptions().binding,
      chats: fakeChats({}).binding,
    });
    const all = Object.values(servers).flatMap((server) =>
      Object.keys(
        (server as unknown as { instance: { _registeredTools?: Record<string, unknown> } })
          .instance._registeredTools ?? {},
      ),
    );
    // A tool registered on two servers would give the agent two names for one
    // thing and split its metrics; the partition exists to make that impossible.
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("create_pr");
    expect(all).toContain("ask_user");
  });

  it("gives every catalog descriptor the name its `tool(...)` definition carries", () => {
    // `TOOL_WIRE_NAME` maps the factory's property names to wire names, and the
    // compiler only checks that each value is SOME real tool name — a typo that
    // lands on a different valid name type-checks and then serves `recall` under
    // `forget`. This is the check that catches it.
    const tools = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const declared = new Map(managerToolDescriptors().map((d) => [d.description, d.name]));
    for (const def of Object.values(tools)) {
      expect(declared.get(def.description), def.name).toBe(def.name);
    }
    // …and the registry covers exactly the tools the factory builds.
    expect(managerToolDescriptors().map((d) => d.name).sort()).toEqual(
      Object.values(tools).map((t) => t.name).sort(),
    );
  });

  it("puts each tool on the server the shared registry names", () => {
    const servers = createManagerMcpServers({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: fakeGitHub([]),
    });
    for (const [name, server] of Object.entries(servers)) {
      const tools = Object.keys(
        (server as unknown as { instance: { _registeredTools?: Record<string, unknown> } })
          .instance._registeredTools ?? {},
      );
      for (const tool of tools) {
        expect(managerToolQualifiedName(tool as ManagerToolName)).toBe(`mcp__${name}__${tool}`);
      }
    }
  });

  it("registers approve_pr ONLY when the approval binding is present", () => {
    const names = registeredNames;

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
    const names = registeredNames;

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

  it("registers request_exemption ONLY when the exemptions binding is present", () => {
    // Bound only where a guard is actually enforcing. Offering it anywhere else
    // invites the agent to ask for permission nobody needed to give.
    const names = registeredNames;

    expect(names({ chatId: "c1", bus, broker: fakeBroker({}) })).not.toContain("request_exemption");
    expect(
      names({
        chatId: "c1",
        bus,
        broker: fakeBroker({}),
        exemptions: fakeExemptions().binding,
      }),
    ).toContain("request_exemption");
  });

  it("registers spawn_chat ONLY when the chats binding is present", () => {
    const names = registeredNames;

    expect(names({ chatId: "c1", bus, broker: fakeBroker({}) })).not.toContain("spawn_chat");
    expect(
      names({ chatId: "c1", bus, broker: fakeBroker({}), chats: fakeChats({}).binding }),
    ).toContain("spawn_chat");
  });
});
