import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeStreamDecoder, contextTokensOf, parseMcpServer } from "./stream.js";

/** Deterministic ids so assertions can name them. */
function decoder(overrides: Partial<ConstructorParameters<typeof ClaudeStreamDecoder>[0]> = {}) {
  let n = 0;
  return new ClaudeStreamDecoder({ genId: () => `gen-${++n}`, ...overrides });
}

const msg = (o: Record<string, unknown>) => o as unknown as SDKMessage;

describe("parseMcpServer", () => {
  it("pulls the server out of a namespaced tool", () => {
    expect(parseMcpServer("mcp__dispatch-session__wait")).toBe("dispatch-session");
  });

  it("keeps hyphens and underscores inside the server name", () => {
    expect(parseMcpServer("mcp__claude-in-chrome__navigate")).toBe("claude-in-chrome");
    expect(parseMcpServer("mcp__ssh_hass_hub__exec")).toBe("ssh_hass_hub");
  });

  it("is undefined for a built-in tool", () => {
    expect(parseMcpServer("Bash")).toBeUndefined();
  });
});

describe("contextTokensOf", () => {
  it("counts fresh input, both cache buckets and output", () => {
    expect(
      contextTokensOf({
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
      }),
    ).toBe(135);
  });

  it("is null for absent or empty usage, so the meter keeps its last value", () => {
    expect(contextTokensOf(undefined)).toBeNull();
    expect(contextTokensOf({})).toBeNull();
    expect(contextTokensOf({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });
});

describe("ClaudeStreamDecoder", () => {
  it("emits init and captures the session id and model", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "claude-opus-5",
        permissionMode: "default",
        tools: ["Bash"],
        mcp_servers: [{ name: "dispatch-session" }],
      }),
    );
    expect(out).toEqual([
      {
        type: "init",
        sessionId: "sess-1",
        model: "claude-opus-5",
        permissionMode: "default",
        tools: ["Bash"],
        mcpServers: [{ name: "dispatch-session" }],
      },
    ]);
    expect(d.sessionId).toBe("sess-1");
  });

  it("streams deltas under the id message_start allocated, then reuses it on finalize", () => {
    const d = decoder();
    d.decode(msg({ type: "stream_event", event: { type: "message_start", message: { id: "m-7" } } }));

    const deltas = d.decode(
      msg({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      }),
    );
    expect(deltas).toEqual([{ type: "delta", id: "m-7", channel: "text", delta: "Hel" }]);

    const final = d.decode(
      msg({
        type: "assistant",
        message: { id: "m-7", content: [{ type: "text", text: "Hello" }] },
      }),
    );
    // Same id as the chunks — this is what lets the client swap the live
    // buffer for the persisted row instead of rendering the text twice.
    expect(final[0]).toMatchObject({ type: "assistant", id: "m-7", text: "Hello" });
  });

  it("allocates an id on the first delta when message_start was missed", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
      }),
    );
    expect(out).toEqual([{ type: "delta", id: "gen-1", channel: "text", delta: "x" }]);
  });

  it("routes thinking deltas to their own channel", () => {
    const d = decoder();
    d.decode(msg({ type: "stream_event", event: { type: "message_start", message: { id: "m-1" } } }));
    const out = d.decode(
      msg({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      }),
    );
    expect(out).toEqual([{ type: "delta", id: "m-1", channel: "thinking", delta: "hmm" }]);
  });

  it("ignores subagent partials so they cannot steal the main loop's buffer", () => {
    const d = decoder();
    d.decode(msg({ type: "stream_event", event: { type: "message_start", message: { id: "main" } } }));
    // A subagent's message_start must NOT reassign the slot.
    d.decode(
      msg({
        type: "stream_event",
        parent_tool_use_id: "task-1",
        event: { type: "message_start", message: { id: "sub" } },
      }),
    );
    const out = d.decode(
      msg({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "!" } },
      }),
    );
    expect(out).toEqual([{ type: "delta", id: "main", channel: "text", delta: "!" }]);
  });

  it("does not let a subagent message consume the main loop's stream id", () => {
    const d = decoder();
    d.decode(msg({ type: "stream_event", event: { type: "message_start", message: { id: "main" } } }));
    // Subagent finalizes mid-stream; it gets its own id and leaves the slot.
    const sub = d.decode(
      msg({
        type: "assistant",
        parent_tool_use_id: "task-1",
        subagent_type: "Explore",
        message: { id: "sub-msg", content: [{ type: "text", text: "found it" }] },
      }),
    );
    expect(sub[0]).toMatchObject({ id: "sub-msg", parentToolUseId: "task-1", subagentType: "Explore" });

    const main = d.decode(
      msg({ type: "assistant", message: { id: "main-api", content: [{ type: "text", text: "done" }] } }),
    );
    expect(main[0]).toMatchObject({ id: "main", text: "done" });
  });

  it("splits text, thinking and tool_use out of one assistant message", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "assistant",
        uuid: "u-1",
        message: {
          id: "m-1",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "Running it." },
            { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "assistant", text: "Running it.", thinking: "considering" });
    expect(out[1]).toMatchObject({
      type: "tool-use",
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls" },
      uuid: "u-1",
    });
  });

  it("suppresses the AskUserQuestion tool row (it renders as a question card)", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "assistant",
        message: {
          id: "m-1",
          content: [{ type: "tool_use", id: "tu-1", name: "AskUserQuestion", input: {} }],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("tags MCP tool calls with their server", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "assistant",
        message: {
          id: "m",
          content: [{ type: "tool_use", id: "tu", name: "mcp__dispatch-session__wait", input: {} }],
        },
      }),
    );
    expect(out[0]).toMatchObject({ server: "dispatch-session" });
  });

  it("reports each tool call's thread before emitting it", () => {
    const seen: [string, string | null][] = [];
    const d = decoder({ onToolThread: (id, parent) => seen.push([id, parent]) });
    d.decode(
      msg({
        type: "assistant",
        parent_tool_use_id: "task-9",
        message: { id: "m", content: [{ type: "tool_use", id: "tu-1", name: "Read", input: {} }] },
      }),
    );
    expect(seen).toEqual([["tu-1", "task-9"]]);
  });

  it("stamps the effort the host resolved for the thread", () => {
    const d = decoder({ effortOf: (parent) => (parent === null ? "high" : "low") });
    const main = d.decode(
      msg({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi" }] } }),
    );
    const sub = d.decode(
      msg({
        type: "assistant",
        parent_tool_use_id: "t",
        message: { id: "m2", content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(main[0]).toMatchObject({ effort: "high" });
    expect(sub[0]).toMatchObject({ effort: "low" });
  });

  it("turns tool_result blocks into tool-result events", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "user",
        parent_tool_use_id: "task-1",
        subagent_type: "Explore",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
            { type: "tool_result", tool_use_id: "tu-2", is_error: true, content: "boom" },
          ],
        },
      }),
    );
    expect(out).toEqual([
      {
        type: "tool-result",
        toolUseId: "tu-1",
        ok: true,
        content: "ok",
        parentToolUseId: "task-1",
        subagentType: "Explore",
      },
      {
        type: "tool-result",
        toolUseId: "tu-2",
        ok: false,
        content: "boom",
        parentToolUseId: "task-1",
        subagentType: "Explore",
      },
    ]);
  });

  it("tracks main-loop context occupancy and reports it on turn end", () => {
    const d = decoder();
    d.contextWindow = 200_000;
    d.decode(
      msg({
        type: "assistant",
        message: { id: "m", content: [{ type: "text", text: "a" }], usage: { input_tokens: 50, output_tokens: 5 } },
      }),
    );
    // A subagent's usage must not move the main-loop meter.
    d.decode(
      msg({
        type: "assistant",
        parent_tool_use_id: "t",
        message: { id: "m2", content: [{ type: "text", text: "b" }], usage: { input_tokens: 9999 } },
      }),
    );
    const out = d.decode(msg({ type: "result", subtype: "success", is_error: false, result: "done" }));
    expect(out[0]).toMatchObject({
      type: "turn-end",
      ok: true,
      subtype: "success",
      result: "done",
      contextTokens: 55,
      contextWindow: 200_000,
    });
  });

  it("marks an errored result as a failed turn", () => {
    const d = decoder();
    const out = d.decode(
      msg({ type: "result", subtype: "error_during_execution", is_error: true, result: "nope" }),
    );
    expect(out[0]).toMatchObject({ type: "turn-end", ok: false, subtype: "error_during_execution" });
  });

  it("emits a task-notification row for a settled background task", () => {
    const d = decoder();
    const out = d.decode(
      msg({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "tu-1",
        status: "failed",
        summary: "it broke",
        usage: { total_tokens: 1234.6, tool_uses: 3, duration_ms: 900 },
      }),
    );
    expect(out).toEqual([
      {
        type: "task-notification",
        taskId: "task-1",
        toolUseId: "tu-1",
        status: "failed",
        summary: "it broke",
        totalTokens: 1235,
        toolUses: 3,
        durationMs: 900,
      },
    ]);
  });

  it("normalizes an unknown task status to completed", () => {
    const d = decoder();
    const out = d.decode(msg({ type: "system", subtype: "task_notification", task_id: "t", status: "weird" }));
    expect(out[0]).toMatchObject({ status: "completed" });
  });

  it("ignores message types it has no meaning for", () => {
    const d = decoder();
    expect(d.decode(msg({ type: "something_new" }))).toEqual([]);
  });
});
