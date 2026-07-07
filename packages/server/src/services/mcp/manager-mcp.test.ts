import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChatStatus, WsServerEvent, ProjectMemory } from "@cm/shared";
import { EventBus } from "../../bus.js";
import {
  createManagerTools,
  createManagerMcpServer,
  WAIT_CAP_SECONDS,
  PR_POLL_INTERVAL_MS,
  type ManagerMcpBroker,
  type ManagerMcpMemory,
  type ManagerMcpGitHub,
  type PrPollResult,
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

/* ------------------------------------------------------------- wait_for_pr */

/** A scriptable ManagerMcpGitHub whose per-poll result the test controls. */
function fakeGitHub(
  poll: (n: number, repo?: string) => Promise<PrPollResult | null>,
): ManagerMcpGitHub & { calls: { number: number; repo?: string }[] } {
  const calls: { number: number; repo?: string }[] = [];
  return {
    calls,
    prMergeState: async (n, repo) => {
      calls.push({ number: n, repo });
      return poll(n, repo);
    },
  };
}

describe("manager-mcp — wait_for_pr", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls until the PR merges, then resolves merged:true and clears every timer", async () => {
    const seq: (PrPollResult | null)[] = [
      { number: 77, state: "open", merged: false },
      { number: 77, state: "open", merged: false },
      { number: 77, state: "merged", merged: true, mergedAt: "2026-07-05T21:00:00Z" },
    ];
    let i = 0;
    const gh = fakeGitHub(async () => seq[Math.min(i++, seq.length - 1)]!);
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 77, repo: undefined, timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(0); // flush the immediate poll #1 (open)
    expect(gh.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS); // poll #2 (open)
    expect(gh.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS); // poll #3 (merged) → settle
    const res = await p;

    expect(gh.calls.length).toBe(3);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('reached terminal state "merged"');
    expect(resultText(res)).toContain('"merged":true');
    expect(resultText(res)).toContain('"mergedAt":"2026-07-05T21:00:00Z"');
    // The poll interval + the timeout timer are both torn down on settle.
    expect(vi.getTimerCount()).toBe(0);
    // The self-imposed wait surfaces via the working/typing status header.
    expect(statusLabels().some((l) => l === "waiting on PR #77")).toBe(true);
  });

  it("returns immediately when the PR is already merged (no waiting)", async () => {
    const gh = fakeGitHub(async () => ({
      number: 80,
      state: "merged",
      merged: true,
      mergedAt: "2026-07-05T21:53:02Z",
    }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 80, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(0); // flush the immediate poll only
    const res = await p;

    expect(gh.calls.length).toBe(1); // polled exactly once — no interval wait
    expect(resultText(res)).toContain('"merged":true');
    expect(vi.getTimerCount()).toBe(0); // nothing left ticking
  });

  it("resolves on a closed (unmerged) PR", async () => {
    const gh = fakeGitHub(async () => ({ number: 5, state: "closed", merged: false }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 5, repo: undefined, timeoutSeconds: 1800 }, {});
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;

    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain('reached terminal state "closed"');
    expect(resultText(res)).toContain('"merged":false');
    expect(resultText(res)).not.toContain("mergedAt");
  });

  it("times out with the last-known state and timedOut:true, clearing timers", async () => {
    const gh = fakeGitHub(async () => ({ number: 77, state: "open", merged: false }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 77, repo: undefined, timeoutSeconds: 50 }, {});
    await vi.advanceTimersByTimeAsync(50_000); // polls at 0/20/40s, then the 50s timeout
    const res = await p;

    expect(res.isError).toBeFalsy(); // a timeout is informative, not an error
    expect(resultText(res)).toContain("Timed out waiting for PR #77");
    expect(resultText(res)).toContain('"state":"open"');
    expect(resultText(res)).toContain('"timedOut":true');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels promptly on session abort and clears timers/listeners", async () => {
    const ac = new AbortController();
    const gh = fakeGitHub(async () => ({ number: 77, state: "open", merged: false }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
      signal: ac.signal,
    });

    const p = waitForPr.handler({ number: 77, repo: undefined, timeoutSeconds: undefined }, {});
    ac.abort(); // dispatched synchronously → finish() clears its timers now
    expect(vi.getTimerCount()).toBe(0);
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });

  it("also cancels via the MCP request's extra.signal", async () => {
    const ac = new AbortController();
    const gh = fakeGitHub(async () => ({ number: 77, state: "open", merged: false }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler(
      { number: 77, repo: undefined, timeoutSeconds: undefined },
      { signal: ac.signal },
    );
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });

  it("returns an informative error when the poll throws (gh error)", async () => {
    const gh = fakeGitHub(async () => {
      throw new Error("gh: not authenticated");
    });
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 77, repo: undefined, timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("Could not wait on PR #77");
    expect(resultText(res)).toContain("not authenticated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an informative error for an unknown PR (null poll)", async () => {
    const gh = fakeGitHub(async () => null);
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 999, repo: undefined, timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;

    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("PR not found");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes an explicit owner/name override through to the poller", async () => {
    const gh = fakeGitHub(async () => ({ number: 42, state: "merged", merged: true }));
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const p = waitForPr.handler({ number: 42, repo: "octo/repo", timeoutSeconds: undefined }, {});
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(gh.calls[0]).toEqual({ number: 42, repo: "octo/repo" });
    expect(statusLabels().some((l) => l === "waiting on PR #42 (octo/repo)")).toBe(true);
  });

  it("validates a positive integer PR number", async () => {
    const gh = fakeGitHub(async () => null);
    const { waitForPr } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      github: gh,
    });

    const res = await waitForPr.handler({ number: 0, repo: undefined, timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("positive integer");
    expect(gh.calls.length).toBe(0); // never polled
  });

  it("reports unavailable when no GitHubService is wired", async () => {
    const { waitForPr } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await waitForPr.handler({ number: 1, repo: undefined, timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
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
});
