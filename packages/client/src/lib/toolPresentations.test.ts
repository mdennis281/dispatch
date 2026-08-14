import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolUseRow } from "@dispatch/shared";
import { displayResultText, groupTranscriptRows, resultPreview, resultText, toolPresentation } from "./toolPresentations.js";

function tool(name: string, input: Record<string, unknown>, id = name): ToolUseRow {
  return { kind: "tool_use", id, toolUseId: id, chatId: "chat", ts: 1, turn: 0, name, input };
}

describe("tool presentation handlers", () => {
  it("normalizes provider and managed-terminal shell calls", () => {
    expect(toolPresentation(tool("Bash", { command: "rg foo" }))).toMatchObject({
      kind: "shell",
      command: "rg foo",
      language: "bash",
    });
    expect(
      toolPresentation(tool("mcp__manager__terminal", { name: "build", command: "Get-ChildItem src" })),
    ).toEqual({ kind: "shell", command: "Get-ChildItem src", language: "powershell", terminal: "build" });
  });

  it("falls back for unknown and malformed tools", () => {
    expect(toolPresentation(tool("mcp__github__search", { query: "x" }))).toBeNull();
    expect(toolPresentation(tool("Bash", { description: "missing command" }))).toBeNull();
  });

  it("gives first-party Dispatch MCPs semantic presentations", () => {
    expect(toolPresentation(tool("mcp__manager__wait", { seconds: 10 }))).toMatchObject({
      kind: "dispatch",
      title: "Wait",
      activity: "Waiting",
      category: "wait",
      countdownSeconds: 10,
    });
    expect(toolPresentation(tool("mcp__manager__watch_pr", { number: 40 }))).toMatchObject({
      kind: "dispatch",
      title: "Watch pull request",
      subject: "PR #40",
      category: "pr",
    });
    expect(toolPresentation(tool("mcp__manager__brand_new_tool", { name: "demo" }))).toMatchObject({
      kind: "dispatch",
      title: "Brand New Tool",
      subject: "demo",
    });
  });
});

describe("groupTranscriptRows", () => {
  it("groups handled shell calls across their folded results", () => {
    const a = tool("Bash", { command: "pwd" }, "a");
    const b = tool("mcp__manager__terminal", { command: "Get-Location" }, "b");
    const result: ChatMessage = {
      kind: "tool_result", id: "r", toolUseId: "a", chatId: "chat", ts: 2, turn: 0,
      name: "Bash", ok: true, content: "/repo",
    };
    const grouped = groupTranscriptRows([a, result, b]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "shell", rows: [a, b] });
  });

  it("keeps an unhandled tool on the existing row path", () => {
    const unknown = tool("Read", { file_path: "README.md" });
    expect(groupTranscriptRows([unknown])).toEqual([{ kind: "row", row: unknown }]);
  });
});

it("builds a compact first-line result preview", () => {
  expect(resultPreview("\nfirst\nsecond")).toBe("first");
  expect(resultPreview([{ type: "text", text: "[build] cwd=C:\\repo exit=0\ncompiled 3 files" }])).toBe("compiled 3 files");
  expect(resultText([{ type: "text", text: "hello" }])).toBe("hello");
  expect(displayResultText("[build] cwd=C:\\repo exit=0\ncompiled 3 files\ncomplete")).toBe("compiled 3 files\ncomplete");
  expect(resultText([{ type: "image", data: "base64" }])).toBe("");
  expect(resultPreview([])).toBe("No output");
  expect(resultPreview(undefined)).toBe("No output");
});
