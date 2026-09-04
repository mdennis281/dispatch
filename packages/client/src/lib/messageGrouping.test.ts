import { describe, expect, it } from "vitest";
import type { AssistantMessageRow, ChatMessage } from "@dispatch/shared";
import { continuedAssistantIds } from "./messageGrouping.js";
import type { TranscriptItem } from "./toolPresentations.js";

function say(id: string, over: Partial<AssistantMessageRow> = {}): AssistantMessageRow {
  return { id, chatId: "c", ts: 0, kind: "assistant", text: `body ${id}`, ...over };
}

function item(row: ChatMessage): TranscriptItem {
  return { kind: "row", row };
}

const shell: TranscriptItem = {
  kind: "shell",
  rows: [{ id: "t1", chatId: "c", ts: 0, kind: "tool_use", toolUseId: "u1", name: "Bash", input: {} }],
};

describe("continuedAssistantIds", () => {
  it("continues the second of two adjacent messages, never the first", () => {
    const ids = continuedAssistantIds([item(say("a")), item(say("b")), item(say("c"))]);
    expect([...ids]).toEqual(["b", "c"]);
  });

  it("brings the header back after anything at all in between", () => {
    const between: TranscriptItem[] = [
      shell,
      item({ id: "r", chatId: "c", ts: 0, kind: "result", subtype: "success", isError: false }),
      item({ id: "u", chatId: "c", ts: 0, kind: "user", text: "go on" }),
    ];
    for (const gap of between) {
      const ids = continuedAssistantIds([item(say("a")), gap, item(say("b"))]);
      expect([...ids]).toEqual([]);
    }
  });

  it("keeps the header when the speaker's badges change", () => {
    const model = continuedAssistantIds([
      item(say("a", { model: "claude-opus-5" })),
      item(say("b", { model: "claude-sonnet-5" })),
    ]);
    expect([...model]).toEqual([]);

    const harness = continuedAssistantIds([
      item(say("a", { harness: "claude" })),
      item(say("b", { harness: "codex" })),
    ]);
    expect([...harness]).toEqual([]);

    const subagent = continuedAssistantIds([
      item(say("a")),
      item(say("b", { subagentType: "Explore" })),
    ]);
    expect([...subagent]).toEqual([]);
  });

  it("groups across a usage-limit sentence, which renders nothing", () => {
    const limit = say("limit", {
      text: "You've hit your 5-hour limit — resets 4:50pm (America/Chicago)",
    });
    const ids = continuedAssistantIds([item(say("a")), item(limit), item(say("b"))]);
    // The limit row is dropped from the transcript, so `b` is visually adjacent
    // to `a` — and the invisible row must not claim a header of its own either.
    expect([...ids]).toEqual(["b"]);
  });
});
