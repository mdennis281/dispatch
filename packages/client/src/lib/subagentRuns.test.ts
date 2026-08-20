import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@dispatch/shared";
import {
  ackTaskId,
  deriveSubagentRuns,
  runDuration,
  sortRunsForRoster,
  toolDetail,
} from "./subagentRuns.js";

const CHAT = "c1";
let seq = 0;
const id = () => `m${++seq}`;

function task(toolUseId: string, opts: {
  ts?: number;
  type?: string;
  description?: string;
  parent?: string;
} = {}): ChatMessage {
  return {
    kind: "tool_use",
    id: id(),
    chatId: CHAT,
    ts: opts.ts ?? 1000,
    toolUseId,
    name: "Task",
    input: {
      subagent_type: opts.type ?? "claude",
      description: opts.description ?? "Do the thing",
      prompt: "the full prompt",
    },
    ...(opts.parent ? { parentToolUseId: opts.parent } : {}),
  };
}

function tool(toolUseId: string, name: string, parent: string, ts: number, input: Record<string, unknown> = {}): ChatMessage {
  return { kind: "tool_use", id: id(), chatId: CHAT, ts, toolUseId, name, input, parentToolUseId: parent };
}

function toolResult(toolUseId: string, opts: { ts: number; parent?: string; ok?: boolean; content?: unknown; durationMs?: number } ): ChatMessage {
  return {
    kind: "tool_result",
    id: id(),
    chatId: CHAT,
    ts: opts.ts,
    toolUseId,
    ok: opts.ok ?? true,
    content: opts.content,
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    ...(opts.parent ? { parentToolUseId: opts.parent } : {}),
    ...(opts.ok === false ? { isError: true } : {}),
  };
}

function assistant(text: string, parent: string | undefined, ts: number, model?: string): ChatMessage {
  return {
    kind: "assistant",
    id: id(),
    chatId: CHAT,
    ts,
    text,
    ...(model ? { model } : {}),
    ...(parent ? { parentToolUseId: parent } : {}),
  };
}

describe("deriveSubagentRuns — identity and status", () => {
  it("returns nothing when the transcript has no Task rows", () => {
    expect(deriveSubagentRuns([assistant("hi", undefined, 1)])).toEqual([]);
  });

  it("materializes a run the moment it is spawned, before any child row lands", () => {
    const runs = deriveSubagentRuns(
      [task("t1", { type: "Explore", description: "Find refs" })],
      { chatRunning: true },
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "t1",
      agentType: "Explore",
      description: "Find refs",
      status: "running",
      toolCount: 0,
      steps: [],
    });
  });

  it("stays running until the spawner's own result lands", () => {
    const rows: ChatMessage[] = [
      task("t1", { ts: 1000 }),
      tool("a1", "Read", "t1", 1100),
      toolResult("a1", { ts: 1200, parent: "t1" }),
    ];
    expect(deriveSubagentRuns(rows, { chatRunning: true })[0]!.status).toBe("running");

    rows.push(toolResult("t1", { ts: 5000, content: "All done." }));
    const done = deriveSubagentRuns(rows, { chatRunning: true })[0]!;
    expect(done.status).toBe("done");
    expect(done.report).toBe("All done.");
    expect(done.endedAt).toBe(5000);
    expect(done.durationMs).toBe(4000);
  });

  it("marks a run failed when its spawner result errored", () => {
    const runs = deriveSubagentRuns([
      task("t1"),
      toolResult("t1", { ts: 2000, ok: false, content: "blew up" }),
    ]);
    expect(runs[0]).toMatchObject({ status: "failed", report: "blew up" });
  });

  it("falls back to a child row's subagentType when the input carries none", () => {
    const spawn = task("t1");
    (spawn as { input: Record<string, unknown> }).input = { description: "x" };
    const child = assistant("working", "t1", 1100);
    (child as { subagentType?: string }).subagentType = "code-reviewer";
    expect(deriveSubagentRuns([spawn, child])[0]!.agentType).toBe("code-reviewer");
  });
});

describe("deriveSubagentRuns — timeline", () => {
  it("builds steps in order and pairs each tool call with its result", () => {
    const runs = deriveSubagentRuns([
      task("t1", { ts: 1000 }),
      assistant("Let me look.", "t1", 1100, "claude-opus-5"),
      tool("a1", "Read", "t1", 1200, { file_path: "src/a.ts" }),
      toolResult("a1", { ts: 1300, parent: "t1", durationMs: 42 }),
      tool("a2", "Bash", "t1", 1400, { command: "npm test" }),
    ]);
    const run = runs[0]!;
    expect(run.model).toBe("claude-opus-5");
    expect(run.toolCount).toBe(2);
    expect(run.steps.map((s) => s.kind)).toEqual(["message", "tool", "tool"]);

    const read = run.steps[1]!;
    expect(read.kind === "tool" && read.pending).toBe(false);
    expect(read.kind === "tool" && read.durationMs).toBe(42);

    // The unresolved call is the live step — what the subagent is doing NOW.
    const bash = run.steps[2]!;
    expect(bash.kind === "tool" && bash.pending).toBe(true);
    expect(run.latest).toBe("Bash · npm test");
  });

  it("reports the effort the run's LATEST row carried", () => {
    // The first row carries the level the broker configured; once a hook has
    // observed what the runtime really applied, later rows carry that — so the
    // newest wins rather than the first (unlike `model`, which never changes).
    const first = assistant("starting", "t1", 1100);
    (first as { effort?: string }).effort = "medium";
    const later = tool("a1", "Read", "t1", 1200);
    (later as { effort?: string }).effort = "low";
    expect(deriveSubagentRuns([task("t1"), first, later])[0]!.effort).toBe("low");
  });

  it("leaves effort undefined for a transcript recorded before rows carried it", () => {
    expect(
      deriveSubagentRuns([task("t1"), assistant("hi", "t1", 1100)])[0]!.effort,
    ).toBeUndefined();
  });

  it("skips thinking-only assistant rows (they would render as blanks)", () => {
    const runs = deriveSubagentRuns([
      task("t1"),
      assistant("   ", "t1", 1100),
      assistant("real text", "t1", 1200),
    ]);
    expect(runs[0]!.steps).toHaveLength(1);
  });

  it("counts the subagent's own turns", () => {
    const runs = deriveSubagentRuns([
      task("t1"),
      { kind: "result", id: id(), chatId: CHAT, ts: 1500, subtype: "success", isError: false, parentToolUseId: "t1" } as ChatMessage,
      { kind: "result", id: id(), chatId: CHAT, ts: 1600, subtype: "success", isError: false, parentToolUseId: "t1" } as ChatMessage,
    ]);
    expect(runs[0]!.turnCount).toBe(2);
  });
});

describe("deriveSubagentRuns — nesting", () => {
  it("links a subagent that spawns a subagent without recursing rows", () => {
    const runs = deriveSubagentRuns([
      task("t1", { ts: 1000, type: "lead" }),
      tool("a1", "Read", "t1", 1100),
      task("t2", { ts: 1200, type: "helper", parent: "t1" }),
      assistant("nested work", "t2", 1300),
      toolResult("t2", { ts: 1900, parent: "t1", content: "nested report" }),
    ]);
    expect(runs.map((r) => r.id)).toEqual(["t1", "t2"]);

    const [lead, helper] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(lead.childRunIds).toEqual(["t2"]);
    expect(helper.parentRunId).toBe("t1");
    expect(helper.status).toBe("done");
    expect(helper.report).toBe("nested report");

    // The spawn is ONE step in the parent, not the child's rows inlined.
    expect(lead.steps.map((s) => s.kind)).toEqual(["tool", "subagent"]);
    // ...and it doesn't inflate the parent's tool count.
    expect(lead.toolCount).toBe(1);
    // The nested run owns its own rows.
    expect(helper.steps.map((s) => s.kind)).toEqual(["message"]);
  });

  it("keeps concurrent runs separate", () => {
    const runs = deriveSubagentRuns(
      [
        task("t1", { ts: 1000, type: "alpha" }),
        task("t2", { ts: 1010, type: "beta" }),
        tool("a1", "Read", "t1", 1100),
        tool("b1", "Grep", "t2", 1110),
        tool("b2", "Bash", "t2", 1120),
        toolResult("t1", { ts: 2000, content: "alpha done" }),
      ],
      { chatRunning: true },
    );
    const alpha = runs.find((r) => r.id === "t1")!;
    const beta = runs.find((r) => r.id === "t2")!;
    expect(alpha.toolCount).toBe(1);
    expect(beta.toolCount).toBe(2);
    expect(alpha.status).toBe("done");
    expect(beta.status).toBe("running");
  });
});

/**
 * The async `Agent` spawn returns a LAUNCH ACK within milliseconds and the
 * subagent keeps working in the background. Reading that ack as "the run
 * finished" reported a live run as done in 19ms with launch metadata printed as
 * its report — these lock the corrected behaviour.
 */
describe("deriveSubagentRuns — async (background) spawns", () => {
  const asyncRows = (): ChatMessage[] => [
    task("t1", { ts: 1000, type: "Explore" }),
    // The ack lands almost immediately, BEFORE any of the subagent's rows.
    toolResult("t1", {
      ts: 1019,
      content: [{ type: "text", text: "Async agent launched successfully. agentId: abc" }],
    }),
    assistant("I'll analyze the commit now.", "t1", 4000),
    tool("a1", "Bash", "t1", 5000, { command: "git show --stat" }),
    toolResult("a1", { ts: 5200, parent: "t1" }),
    assistant("Here is my analysis: it is a fix.", "t1", 9000),
  ];

  it("stays RUNNING while the parent turn runs, despite the ack", () => {
    const run = deriveSubagentRuns(asyncRows(), { chatRunning: true })[0]!;
    expect(run.async).toBe(true);
    expect(run.status).toBe("running");
    // Duration tracks real work, not the 19ms ack.
    expect(run.durationMs).toBe(8000);
    expect(run.report).toBeUndefined();
  });

  it("settles once the parent turn ends, reporting its own last message", () => {
    const run = deriveSubagentRuns(asyncRows(), { chatRunning: false })[0]!;
    expect(run.status).toBe("done");
    expect(run.endedAt).toBe(9000);
    expect(run.durationMs).toBe(8000);
    // NOT the launch metadata.
    expect(run.report).toBe("Here is my analysis: it is a fix.");
  });

  it("a synchronous spawn is unaffected — its result is still the report", () => {
    const rows: ChatMessage[] = [
      task("t1", { ts: 1000 }),
      assistant("working", "t1", 1100),
      toolResult("t1", { ts: 2000, content: "the real report" }),
    ];
    const run = deriveSubagentRuns(rows, { chatRunning: true })[0]!;
    expect(run.async).toBe(false);
    expect(run.status).toBe("done");
    expect(run.report).toBe("the real report");
  });

  it("a failed launch is failed immediately, even mid-turn", () => {
    const rows: ChatMessage[] = [
      task("t1", { ts: 1000 }),
      toolResult("t1", { ts: 1010, ok: false, content: "no such agent type" }),
      assistant("stray", "t1", 2000),
    ];
    const run = deriveSubagentRuns(rows, { chatRunning: true })[0]!;
    expect(run.status).toBe("failed");
    expect(run.report).toBe("no such agent type");
  });

  it("unwraps SDK content blocks instead of printing raw JSON", () => {
    const rows: ChatMessage[] = [
      task("t1"),
      assistant("x", "t1", 1100),
      toolResult("t1", {
        ts: 2000,
        content: [
          { type: "text", text: "First part." },
          { type: "text", text: "Second part." },
        ],
      }),
    ];
    expect(deriveSubagentRuns(rows)[0]!.report).toBe("First part.\n\nSecond part.");
  });
});

describe("deriveSubagentRuns — per-task settle verdicts", () => {
  function settle(
    opts: {
      taskId?: string;
      toolUseId?: string;
      status?: "completed" | "failed" | "stopped";
      ts?: number;
      summary?: string;
      durationMs?: number;
    } = {},
  ): ChatMessage {
    return {
      kind: "task_status",
      id: id(),
      chatId: CHAT,
      ts: opts.ts ?? 9500,
      taskId: opts.taskId ?? "task-1",
      status: opts.status ?? "completed",
      ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    };
  }

  /** Two background agents launched together — the case the parent turn can't tell apart. */
  function twoAsync(): ChatMessage[] {
    return [
      task("t1", { ts: 1000, description: "first" }),
      task("t2", { ts: 1000, description: "second" }),
      toolResult("t1", { ts: 1010, content: "Async agent launched. agentId: aaaaaa111" }),
      toolResult("t2", { ts: 1010, content: "Async agent launched. agentId: bbbbbb222" }),
      assistant("one working", "t1", 3000),
      assistant("two working", "t2", 3000),
    ];
  }

  it("settles ONLY the notified run while its sibling keeps running", () => {
    const rows = [...twoAsync(), settle({ toolUseId: "t1", ts: 4000 })];
    const [a, b] = deriveSubagentRuns(rows, { chatRunning: true });
    expect(a!.status).toBe("done");
    expect(a!.endedAt).toBe(4000);
    expect(b!.status).toBe("running");
  });

  it("correlates by the task id in the launch ack when the notification omits tool_use_id", () => {
    const rows = [...twoAsync(), settle({ taskId: "bbbbbb222", ts: 4000 })];
    const [a, b] = deriveSubagentRuns(rows, { chatRunning: true });
    expect(a!.status).toBe("running");
    expect(b!.status).toBe("done");
  });

  it("carries failed and stopped through as themselves", () => {
    const failed = deriveSubagentRuns(
      [...twoAsync(), settle({ toolUseId: "t1", status: "failed" })],
      { chatRunning: true },
    )[0]!;
    expect(failed.status).toBe("failed");
    const stopped = deriveSubagentRuns(
      [...twoAsync(), settle({ toolUseId: "t1", status: "stopped" })],
      { chatRunning: true },
    )[0]!;
    expect(stopped.status).toBe("stopped");
  });

  it("prefers the run's own last message as the report, falling back to the SDK recap", () => {
    const spoke = deriveSubagentRuns(
      [...twoAsync(), settle({ toolUseId: "t1", summary: "recap" })],
      { chatRunning: true },
    )[0]!;
    expect(spoke.report).toBe("one working");

    const silent = deriveSubagentRuns(
      [
        task("t1", { ts: 1000 }),
        toolResult("t1", { ts: 1010, content: "Async agent launched. agentId: aaaaaa111" }),
        tool("x1", "Bash", "t1", 2000, { command: "ls" }),
        settle({ toolUseId: "t1", summary: "recap", durationMs: 4321 }),
      ],
      { chatRunning: true },
    )[0]!;
    expect(silent.report).toBe("recap");
    expect(silent.durationMs).toBe(4321);
  });

  it("beats the parent turn: a verdict wins even after the chat goes idle", () => {
    const run = deriveSubagentRuns(
      [...twoAsync(), settle({ toolUseId: "t1", status: "failed", ts: 4000 })],
      { chatRunning: false },
    )[0]!;
    expect(run.status).toBe("failed");
  });
});

describe("deriveSubagentRuns — windowed transcript", () => {
  it("produces no run when the spawning Task row is above the loaded window", () => {
    // Only the orphaned children survived the window; MessageList renders them
    // at root in that case, so a run must NOT be half-invented here.
    const runs = deriveSubagentRuns([
      assistant("orphaned subagent text", "t-gone", 1100),
      tool("a1", "Read", "t-gone", 1200),
    ]);
    expect(runs).toEqual([]);
  });
});

describe("roster + formatting helpers", () => {
  it("sorts live runs first, then newest finished", () => {
    const runs = deriveSubagentRuns(
      [
        task("old", { ts: 1000 }),
        toolResult("old", { ts: 1500 }),
        task("newer", { ts: 3000 }),
        toolResult("newer", { ts: 3500 }),
        task("live", { ts: 2000 }),
      ],
      { chatRunning: true },
    );
    expect(sortRunsForRoster(runs).map((r) => r.id)).toEqual(["live", "newer", "old"]);
  });

  it("formats durations across the ms/s/mm:ss boundaries", () => {
    expect(runDuration(420)).toBe("420ms");
    expect(runDuration(8_100)).toBe("8.1s");
    expect(runDuration(42_000)).toBe("42s");
    expect(runDuration(84_000)).toBe("1:24");
    expect(runDuration(724_000)).toBe("12:04");
  });

  it("pulls a readable detail off assorted tool inputs", () => {
    const mk = (input: Record<string, unknown>) =>
      toolDetail(tool("x", "T", "p", 1, input) as never);
    expect(mk({ command: "npm test" })).toBe("npm test");
    expect(mk({ file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(mk({ pattern: "TODO" })).toBe("TODO");
    expect(mk({ nothing: 1 })).toBeUndefined();
  });
});


/**
 * A tool result is only a launch ack if it is SHAPED like one. Matching the id
 * pattern anywhere in a command's output wedged that call on "running" forever.
 */
describe("ackTaskId", () => {
  const res = (text: string) =>
    toolResult("t1", { ts: 1, content: [{ type: "text", text }] }) as never as Parameters<typeof ackTaskId>[0];

  it("reads the id out of a one-line launch ack", () => {
    expect(ackTaskId(res("Async agent launched successfully. agentId: a730258b58"))).toBe("a730258b58");
  });

  it("reads a backgrounded Bash ack", () => {
    expect(ackTaskId(res("Command running in background with ID: bash_120394"))).toBe("bash_120394");
  });

  it("ignores a command's own output that merely mentions an id", () => {
    const dump = ["export const actions = {", "  createChat(input: {", "    agentId: string;"]
      .concat(Array.from({ length: 40 }, (_, i) => `    line${i}: string;`))
      .join("\n");
    expect(ackTaskId(res(dump))).toBeUndefined();
  });

  it("ignores a long single-line payload", () => {
    expect(ackTaskId(res(`agentId: abcdefgh ${"x".repeat(500)}`))).toBeUndefined();
  });

  it("has nothing to read when there is no result", () => {
    expect(ackTaskId(undefined)).toBeUndefined();
  });
});
