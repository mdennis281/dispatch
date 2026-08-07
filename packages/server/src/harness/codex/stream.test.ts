import { describe, it, expect } from "vitest";
import { CodexStreamDecoder, limitHitOf, questionsOf } from "./stream.js";

function decoder() {
  let n = 0;
  return new CodexStreamDecoder({ genId: () => `gen-${++n}` });
}

const note = (method: string, params: Record<string, unknown>) => ({ method, params });
const item = (i: Record<string, unknown>) => ({ item: i, threadId: "t", turnId: "turn-1" });

describe("CodexStreamDecoder — text and reasoning", () => {
  it("streams agent message deltas under the item id", () => {
    const d = decoder();
    expect(d.decode(note("item/agentMessage/delta", { itemId: "i1", delta: "Hel" }))).toEqual([
      { type: "delta", id: "i1", channel: "text", delta: "Hel" },
    ]);
  });

  it("routes both reasoning channels to thinking", () => {
    const d = decoder();
    expect(d.decode(note("item/reasoning/textDelta", { itemId: "r1", delta: "a" }))[0]).toMatchObject({
      channel: "thinking",
      delta: "a",
    });
    expect(
      d.decode(note("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "b" }))[0],
    ).toMatchObject({ channel: "thinking", delta: "b" });
  });

  it("finalizes an agent message under the same id its deltas used", () => {
    const d = decoder();
    d.decode(note("item/agentMessage/delta", { itemId: "i1", delta: "Done" }));
    const out = d.decode(note("item/completed", item({ type: "agentMessage", id: "i1", text: "Done" })));
    expect(out).toEqual([{ type: "assistant", id: "i1", text: "Done", thinking: undefined, uuid: "i1" }]);
  });

  it("attaches streamed reasoning to the message that follows it", () => {
    const d = decoder();
    d.decode(note("item/reasoning/textDelta", { itemId: "r1", delta: "weighing options" }));
    const out = d.decode(note("item/completed", item({ type: "agentMessage", id: "i1", text: "Go" })));
    expect(out[0]).toMatchObject({ text: "Go", thinking: "weighing options" });
  });

  it("does not replay reasoning onto a second message", () => {
    const d = decoder();
    d.decode(note("item/reasoning/textDelta", { itemId: "r1", delta: "once" }));
    d.decode(note("item/completed", item({ type: "agentMessage", id: "i1", text: "a" })));
    const second = d.decode(note("item/completed", item({ type: "agentMessage", id: "i2", text: "b" })));
    expect(second[0]).toMatchObject({ text: "b", thinking: undefined });
  });

  it("ignores the echoed user message so the transcript keeps one copy", () => {
    const d = decoder();
    expect(d.decode(note("item/started", item({ type: "userMessage", id: "u1" })))).toEqual([]);
  });
});

describe("CodexStreamDecoder — tools", () => {
  it("presents a command execution as a Bash call", () => {
    const d = decoder();
    const out = d.decode(
      note("item/started", item({ type: "commandExecution", id: "c1", command: "git status", cwd: "/repo" })),
    );
    expect(out).toEqual([
      {
        type: "tool-use",
        toolUseId: "c1",
        name: "Bash",
        input: { command: "git status", cwd: "/repo", description: "git status" },
      },
    ]);
  });

  it("closes a command with its output and exit code", () => {
    const d = decoder();
    d.decode(note("item/started", item({ type: "commandExecution", id: "c1", command: "x" })));
    const out = d.decode(
      note(
        "item/completed",
        item({
          type: "commandExecution",
          id: "c1",
          command: "x",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: "boom",
        }),
      ),
    );
    expect(out).toEqual([{ type: "tool-result", toolUseId: "c1", ok: false, content: "boom" }]);
  });

  it("synthesizes the call row when a tool completes without starting", () => {
    const d = decoder();
    const out = d.decode(
      note("item/completed", item({ type: "commandExecution", id: "c9", command: "ls", exitCode: 0 })),
    );
    expect(out.map((e) => e.type)).toEqual(["tool-use", "tool-result"]);
  });

  it("names a single file change Edit with a derivable target", () => {
    const d = decoder();
    const out = d.decode(
      note(
        "item/started",
        item({
          type: "fileChange",
          id: "f1",
          changes: [{ path: "src/app.ts", kind: { type: "update" }, diff: "@@" }],
        }),
      ),
    );
    expect(out[0]).toMatchObject({ name: "Edit", input: { file_path: "src/app.ts" } });
  });

  it("names a multi-file change MultiEdit", () => {
    const d = decoder();
    const out = d.decode(
      note(
        "item/started",
        item({
          type: "fileChange",
          id: "f1",
          changes: [
            { path: "a.ts", kind: { type: "update" }, diff: "" },
            { path: "b.ts", kind: { type: "add" }, diff: "" },
          ],
        }),
      ),
    );
    expect(out[0]).toMatchObject({ name: "MultiEdit" });
  });

  it("maps an MCP call to the mcp__server__tool name Dispatch already renders", () => {
    const d = decoder();
    const out = d.decode(
      note(
        "item/started",
        item({ type: "mcpToolCall", id: "m1", server: "manager", tool: "wait", arguments: { ms: 5 } }),
      ),
    );
    expect(out[0]).toMatchObject({ name: "mcp__manager__wait", server: "manager", input: { ms: 5 } });
  });

  it("marks a failed MCP call as not ok", () => {
    const d = decoder();
    const out = d.decode(
      note(
        "item/completed",
        item({ type: "mcpToolCall", id: "m1", server: "s", tool: "t", error: { message: "nope" } }),
      ),
    );
    expect(out.at(-1)).toMatchObject({ type: "tool-result", ok: false });
  });

  it("marks a declined tool as not ok", () => {
    const d = decoder();
    const out = d.decode(
      note("item/completed", item({ type: "commandExecution", id: "c1", command: "x", status: "declined" })),
    );
    expect(out.at(-1)).toMatchObject({ ok: false });
  });
});

describe("CodexStreamDecoder — plan", () => {
  it("renders the plan as a TodoWrite call in the client's vocabulary", () => {
    const d = decoder();
    const out = d.decode(
      note("turn/plan/updated", {
        threadId: "t",
        turnId: "t1",
        explanation: "here is the plan",
        plan: [
          { step: "Read the code", status: "completed" },
          { step: "Fix the bug", status: "inProgress" },
          { step: "Ship", status: "pending" },
        ],
      }),
    );
    expect(out[0]).toMatchObject({
      type: "tool-use",
      name: "TodoWrite",
      input: {
        explanation: "here is the plan",
        todos: [
          { content: "Read the code", status: "completed" },
          // Normalized to the underscore form the client's folder understands.
          { content: "Fix the bug", status: "in_progress" },
          { content: "Ship", status: "pending" },
        ],
      },
    });
  });

  it("ignores an empty plan", () => {
    const d = decoder();
    expect(d.decode(note("turn/plan/updated", { plan: [] }))).toEqual([]);
  });
});

describe("CodexStreamDecoder — usage, turns and errors", () => {
  it("tracks context occupancy and window", () => {
    const d = decoder();
    const out = d.decode(
      note("thread/tokenUsage/updated", {
        threadId: "t",
        turnId: "t1",
        tokenUsage: { total: { totalTokens: 20663 }, last: {}, modelContextWindow: 258400 },
      }),
    );
    expect(out).toEqual([{ type: "usage", contextTokens: 20663, contextWindow: 258400 }]);
  });

  it("ends a completed turn as success and carries the final text", () => {
    const d = decoder();
    const out = d.decode(
      note("turn/completed", {
        threadId: "t",
        turn: {
          id: "t1",
          status: "completed",
          durationMs: 5421,
          items: [{ type: "agentMessage", id: "m", text: "PONG." }],
        },
      }),
    );
    expect(out[0]).toMatchObject({
      type: "turn-end",
      ok: true,
      subtype: "success",
      result: "PONG.",
      durationMs: 5421,
    });
  });

  it("passes an interrupted turn through under its own subtype", () => {
    const d = decoder();
    const out = d.decode(note("turn/completed", { turn: { id: "t1", status: "interrupted", items: [] } }));
    expect(out[0]).toMatchObject({ ok: false, subtype: "interrupted" });
  });

  it("treats a retryable error as a notice, not a dead turn", () => {
    const d = decoder();
    const out = d.decode(
      note("error", { willRetry: true, error: { message: "stream hiccup" }, threadId: "t", turnId: "t1" }),
    );
    expect(out).toEqual([{ type: "notice", level: "warn", text: "stream hiccup — retrying." }]);
  });

  it("ends the turn on a non-retryable error", () => {
    const d = decoder();
    const out = d.decode(note("error", { willRetry: false, error: { message: "bad request" } }));
    expect(out[0]).toMatchObject({ type: "turn-end", ok: false, subtype: "error", result: "bad request" });
  });

  it("flags a usage-limit error so the resume scheduler can arm", () => {
    const d = decoder();
    const out = d.decode(
      note("error", {
        willRetry: false,
        error: { message: "You've used your weekly limit.", codexErrorInfo: "usageLimitExceeded" },
      }),
    );
    expect(out[0]).toMatchObject({
      subtype: "usage_limit",
      limit: { reason: "You've used your weekly limit." },
    });
  });

  it("reports compaction", () => {
    const d = decoder();
    expect(d.decode(note("thread/compacted", { threadId: "t", turnId: "t1" }))).toEqual([
      { type: "compacted" },
    ]);
  });

  it("ignores notifications it has no meaning for", () => {
    const d = decoder();
    expect(d.decode(note("mcpServer/startupStatus/updated", { name: "x" }))).toEqual([]);
  });
});

describe("limitHitOf", () => {
  it("recognizes the usage-limit and budget codes", () => {
    expect(limitHitOf({ message: "m", codexErrorInfo: "usageLimitExceeded" })).toEqual({ reason: "m" });
    expect(limitHitOf({ message: "m", codexErrorInfo: "sessionBudgetExceeded" })).toEqual({ reason: "m" });
  });

  it("is undefined for any other error", () => {
    expect(limitHitOf({ message: "m", codexErrorInfo: "badRequest" })).toBeUndefined();
    expect(limitHitOf({ message: "m" })).toBeUndefined();
  });
});

describe("questionsOf", () => {
  it("projects a requestUserInput payload onto the neutral question shape", () => {
    expect(
      questionsOf({
        questions: [
          {
            id: "q1",
            header: "Approach",
            question: "Which way?",
            isOther: true,
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "q1",
        header: "Approach",
        question: "Which way?",
        // Codex has no multi-select flag — every question is single-select.
        multiSelect: false,
        allowOther: true,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
    ]);
  });

  it("survives a payload with no questions", () => {
    expect(questionsOf({})).toEqual([]);
  });
});
