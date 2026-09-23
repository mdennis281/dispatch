import { describe, it, expect } from "vitest";
import { AcpStreamDecoder, toolNameOf, contentText, turnEndOf } from "./stream.js";
import type { RpcFrame } from "./rpc.js";

/**
 * Every frame below is VERBATIM from a live goose 1.51.0 run against a local
 * Ollama model — not hand-written to match the decoder. That is the point: the
 * decoder's contract is with what the agent actually emits, and a fixture
 * invented from the docs would have missed that goose nests the tool name under
 * `_meta.goose.toolCall` rather than putting it on the update.
 */
function notify(update: Record<string, unknown>): RpcFrame {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "20260923_2", update } };
}

const d = (): AcpStreamDecoder => {
  let n = 0;
  return new AcpStreamDecoder({ genId: () => `gen${++n}` });
};

describe("toolNameOf", () => {
  it("translates goose developer tools into Claude's names", () => {
    // Downstream icons, target derivation and the guard's Bash matcher all key
    // off these names.
    expect(toolNameOf("shell", "developer")).toBe("Bash");
    expect(toolNameOf("write", "developer")).toBe("Write");
    expect(toolNameOf("edit", "developer")).toBe("Edit");
    expect(toolNameOf("read_image", "developer")).toBe("Read");
  });

  it("namespaces a project MCP tool instead of renaming it", () => {
    expect(toolNameOf("watch_pr", "dispatch-github")).toBe("mcp__dispatch-github__watch_pr");
  });

  it("leaves an unknown developer tool under its own name", () => {
    // Guessing a mapping would mean guessing its input shape too.
    expect(toolNameOf("tree", "developer")).toBe("tree");
  });
});

describe("AcpStreamDecoder", () => {
  it("streams text chunks as deltas and flushes one assistant message", () => {
    const dec = d();
    const a = dec.decode(notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "The" },
      messageId: "chatcmpl-255",
    }));
    const b = dec.decode(notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " answer" },
      messageId: "chatcmpl-255",
    }));
    expect(a).toEqual([{ type: "delta", id: "chatcmpl-255", channel: "text", delta: "The" }]);
    expect(b[0]).toMatchObject({ delta: " answer", id: "chatcmpl-255" });

    // The final assistant event must correlate with the deltas that streamed it.
    expect(dec.flushMessage()).toEqual([
      { type: "assistant", id: "chatcmpl-255", text: "The answer" },
    ]);
    // Flushing twice must not duplicate the message.
    expect(dec.flushMessage()).toEqual([]);
  });

  it("reads the tool name out of goose's _meta, not the update", () => {
    const dec = d();
    const out = dec.decode(notify({
      sessionUpdate: "tool_call",
      toolCallId: "cOqAGzfoBNdL2KyZ28KHXLnIN7lC6XNp",
      title: "shell · echo PERMTEST",
      rawInput: { command: "echo PERMTEST" },
      _meta: { goose: { toolCall: { toolName: "shell", extensionName: "developer" } } },
    }));
    expect(out).toEqual([
      {
        type: "tool-use",
        toolUseId: "cOqAGzfoBNdL2KyZ28KHXLnIN7lC6XNp",
        name: "Bash",
        input: { command: "echo PERMTEST" },
      },
    ]);
  });

  it("remaps path to file_path so the row renders a target", () => {
    const dec = d();
    const [call] = dec.decode(notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_pqtml5rq",
      title: "write · acp-probe-tmp2.txt",
      rawInput: { path: "acp-probe-tmp2.txt", content: "hello" },
      _meta: { goose: { toolCall: { toolName: "write", extensionName: "developer" } } },
    }));
    expect(call).toMatchObject({
      name: "Write",
      input: { file_path: "acp-probe-tmp2.txt", content: "hello" },
    });
    expect((call as { input: Record<string, unknown> }).input).not.toHaveProperty("path");
  });

  it("ends the streaming message when a tool call interrupts it", () => {
    const dec = d();
    dec.decode(notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me check." },
      messageId: "m1",
    }));
    const out = dec.decode(notify({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      rawInput: { command: "ls" },
      _meta: { goose: { toolCall: { toolName: "shell", extensionName: "developer" } } },
    }));
    expect(out.map((e) => e.type)).toEqual(["assistant", "tool-use"]);
    expect(out[0]).toMatchObject({ text: "Let me check." });
  });

  it("turns a completed tool_call_update into a result", () => {
    const dec = d();
    const out = dec.decode(notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_pqtml5rq",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Created acp-probe-tmp2.txt (1 lines)" } }],
      locations: [{ path: "acp-probe-tmp2.txt", line: 1 }],
    }));
    expect(out).toEqual([
      {
        type: "tool-result",
        toolUseId: "call_pqtml5rq",
        ok: true,
        content: [{ type: "text", text: "Created acp-probe-tmp2.txt (1 lines)" }],
      },
    ]);
  });

  it("marks a failed tool call not-ok", () => {
    const dec = d();
    const [out] = dec.decode(notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    }));
    expect(out).toMatchObject({ type: "tool-result", ok: false });
  });

  it("ignores in_progress updates rather than buffering live output", () => {
    // These carry stdout chunks Dispatch has nowhere to render; accumulating
    // them would grow without bound on a long-running command.
    const dec = d();
    expect(dec.decode(notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      _meta: { toolNotification: { type: "live_output" } },
    }))).toEqual([]);
  });

  it("reports context from usage_update and remembers it for the turn end", () => {
    const dec = d();
    const out = dec.decode(notify({ sessionUpdate: "usage_update", used: 4261, size: 128000 }));
    expect(out).toEqual([{ type: "usage", contextTokens: 4261, contextWindow: 128000 }]);
    expect(dec.contextTokens()).toBe(4261);
    expect(dec.contextWindow()).toBe(128000);
  });

  it("stays silent on updates that are not transcript rows", () => {
    const dec = d();
    // goose emits session_info_update several times a turn.
    expect(dec.decode(notify({
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run_f426" } },
    }))).toEqual([]);
    expect(dec.decode(notify({ sessionUpdate: "current_mode_update", modeId: "auto" }))).toEqual([]);
    expect(dec.decode({ jsonrpc: "2.0", method: "something/else" })).toEqual([]);
  });

  it("renders a plan as TodoWrite so the existing todo strip shows it", () => {
    const dec = d();
    const out = dec.decode(notify({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the file", status: "completed" },
        { content: "Edit it", status: "in_progress" },
        { content: "Run tests", status: "pending" },
      ],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "tool-use", name: "TodoWrite" });
    expect((out[0] as unknown as { input: { todos: unknown[] } }).input.todos).toEqual([
      { content: "Read the file", status: "completed", activeForm: "Read the file" },
      { content: "Edit it", status: "in_progress", activeForm: "Edit it" },
      { content: "Run tests", status: "pending", activeForm: "Run tests" },
    ]);
  });
});

describe("contentText", () => {
  it("unwraps ACP's doubly-nested content blocks", () => {
    expect(contentText([{ type: "content", content: { type: "text", text: "a" } }])).toBe("a");
  });

  it("survives a shape it does not recognise", () => {
    expect(contentText(undefined)).toBe("");
    expect(contentText([null, 5, { type: "image" }])).toBe("");
  });
});

describe("turnEndOf", () => {
  it("treats end_turn as success and carries the context figures", () => {
    expect(turnEndOf(
      { stopReason: "end_turn", usage: { totalTokens: 7768, inputTokens: 7722, outputTokens: 46 } },
      { contextTokens: 7768, contextWindow: 128000 },
    )).toEqual({
      type: "turn-end",
      ok: true,
      subtype: "success",
      usage: { totalTokens: 7768, inputTokens: 7722, outputTokens: 46 },
      contextTokens: 7768,
      contextWindow: 128000,
    });
  });

  it("reports a refusal as a failed turn under its own subtype", () => {
    expect(turnEndOf({ stopReason: "refusal" }, {})).toMatchObject({ ok: false, subtype: "refusal" });
  });

  it("treats a cancelled turn as ok — the user asked for it", () => {
    expect(turnEndOf({ stopReason: "cancelled" }, {})).toMatchObject({ ok: true, subtype: "cancelled" });
  });

  it("omits cost and limits rather than reporting zeros", () => {
    // A local model has no cost and no rate limit; a 0 would render as real.
    const out = turnEndOf({ stopReason: "end_turn" }, {});
    expect(out).not.toHaveProperty("costUsd");
    expect(out).not.toHaveProperty("limit");
  });
});
