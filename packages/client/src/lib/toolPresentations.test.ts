import { describe, expect, it } from "vitest";
import { LEGACY_MANAGER_TOOL_PREFIX, type ChatMessage, type ToolUseRow } from "@dispatch/shared";
import { displayResultText, groupTranscriptRows, resultPreview, resultText, toolPresentation } from "./toolPresentations.js";

/** A tool name as it was recorded before the servers were split. Composed, not
 *  spelled, so `tools/verify/no-stale-tool-names.mjs` can stay exemption-free —
 *  a literal here would fail the very check it exists to enforce. */
const legacy = (tool: string) => `${LEGACY_MANAGER_TOOL_PREFIX}${tool}`;

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
      toolPresentation(tool("mcp__dispatch-workspace__terminal", { name: "build", command: "Get-ChildItem src" })),
    ).toEqual({ kind: "shell", command: "Get-ChildItem src", language: "powershell", terminal: "build" });
  });

  it("falls back for unknown and malformed tools", () => {
    expect(toolPresentation(tool("mcp__github__search", { query: "x" }))).toBeNull();
    expect(toolPresentation(tool("Bash", { description: "missing command" }))).toBeNull();
  });

  it("gives first-party Dispatch MCPs semantic presentations", () => {
    expect(toolPresentation(tool("mcp__dispatch-confirm__ask_user", { questions: [] }))).toMatchObject({
      kind: "dispatch",
      title: "Ask user",
      activity: "Waiting for an answer",
      category: "chat",
    });
    expect(toolPresentation(tool("mcp__dispatch-session__wait", { seconds: 10 }))).toMatchObject({
      kind: "dispatch",
      title: "Wait",
      activity: "Waiting",
      category: "wait",
      countdownSeconds: 10,
    });
    expect(toolPresentation(tool("mcp__dispatch-github__watch_pr", { number: 40 }))).toMatchObject({
      kind: "dispatch",
      title: "Watch pull request",
      subject: "PR #40",
      category: "pr",
    });
    // A call recorded before the servers were split still renders as Dispatch's
    // own — 267 of 291 transcripts on the install this shipped from contain one,
    // and they are re-rendered from stored rows for as long as the chat exists.
    expect(toolPresentation(tool(legacy("terminal"), { command: "ls", name: "t" }))).toMatchObject({
      kind: "shell",
      command: "ls",
    });
    expect(toolPresentation(tool(legacy("watch_pr"), { number: 40 }))).toMatchObject({
      kind: "dispatch",
      title: "Watch pull request",
      category: "pr",
    });
    expect(toolPresentation(tool("mcp__dispatch-workspace__brand_new_tool", { name: "demo" }))).toMatchObject({
      kind: "dispatch",
      title: "Brand New Tool",
      subject: "demo",
    });
  });
});

describe("groupTranscriptRows", () => {
  it("groups handled shell calls across their folded results", () => {
    const a = tool("Bash", { command: "pwd" }, "a");
    const b = tool("mcp__dispatch-workspace__terminal", { command: "Get-Location" }, "b");
    const result: ChatMessage = {
      kind: "tool_result", id: "r", toolUseId: "a", chatId: "chat", ts: 2, turn: 0,
      name: "Bash", ok: true, content: "/repo",
    };
    const grouped = groupTranscriptRows([a, result, b]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "shell", rows: [a, b] });
  });

  it("keeps first-party MCP exchanges inside the same terminal run", () => {
    const shell = tool("Bash", { command: "pwd" }, "shell");
    const recall = tool("mcp__dispatch-memory__recall", { query: "terminal UI" }, "recall");
    const remember = tool("mcp__dispatch-memory__remember", { name: "terminal-ui" }, "remember");
    const grouped = groupTranscriptRows([shell, recall, remember]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "shell", rows: [shell, recall, remember] });
  });

  it("keeps an unhandled tool on the existing row path", () => {
    const unknown = tool("WebFetch", { url: "https://example.com" });
    expect(groupTranscriptRows([unknown])).toEqual([{ kind: "row", row: unknown }]);
  });

  it("collects adjacent file calls into their own run", () => {
    const edit = tool("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "edit");
    const read = tool("Read", { file_path: "src/b.ts" }, "read");
    const grouped = groupTranscriptRows([edit, read]);
    expect(grouped).toEqual([{ kind: "files", rows: [edit, read] }]);
  });

  it("does not merge file work into a terminal run", () => {
    // A shell run is a session and a file run is a changelog; interleaving them
    // in one frame would make both unreadable.
    const first = tool("Bash", { command: "pwd" }, "first");
    const write = tool("Write", { file_path: "src/a.ts", content: "x" }, "write");
    const last = tool("Bash", { command: "ls" }, "last");
    expect(groupTranscriptRows([first, write, last])).toEqual([
      { kind: "shell", rows: [first] },
      { kind: "files", rows: [write] },
      { kind: "shell", rows: [last] },
    ]);
  });

  it("hides empty Codex wait heartbeats but preserves real TaskOutput calls", () => {
    const heartbeat = tool("TaskOutput", {}, "wait");
    const emptyResult: ChatMessage = {
      kind: "tool_result", id: "wait-result", toolUseId: "wait", chatId: "chat",
      ts: 2, turn: 0, ok: true, content: "",
    };
    expect(groupTranscriptRows([heartbeat, emptyResult])).toEqual([]);

    const named = tool("TaskOutput", { task_id: "task-1" }, "named");
    expect(groupTranscriptRows([named])).toEqual([{ kind: "row", row: named }]);
    const useful = tool("TaskOutput", {}, "useful");
    const usefulResult: ChatMessage = {
      kind: "tool_result", id: "useful-result", toolUseId: "useful", chatId: "chat",
      ts: 2, turn: 0, ok: true, content: "agent finished",
    };
    expect(groupTranscriptRows([useful, usefulResult])).toEqual([{ kind: "row", row: useful }]);

    const failed = tool("TaskOutput", {}, "failed");
    const failedResult: ChatMessage = {
      kind: "tool_result", id: "failed-result", toolUseId: "failed", chatId: "chat",
      ts: 2, turn: 0, ok: false, isError: true, content: "",
    };
    expect(groupTranscriptRows([failed, failedResult])).toEqual([{ kind: "row", row: failed }]);
  });

  it("keeps the first copy of a duplicated Codex root tool event", () => {
    const root = tool("Bash", { command: "git status" }, "root-row");
    const duplicate = {
      ...root,
      id: "child-copy",
      parentToolUseId: "codex-agent:root-thread",
    };
    expect(groupTranscriptRows([root, duplicate])).toEqual([{ kind: "shell", rows: [root] }]);
  });
});

describe("file tool presentations", () => {
  it("presents a path-bearing call with the action it performs", () => {
    expect(toolPresentation(tool("Edit", { file_path: "C:/repo/src/a.ts" }))).toEqual({
      kind: "file",
      tool: "Edit",
      action: "edit",
      path: "C:/repo/src/a.ts",
    });
    expect(toolPresentation(tool("Read", { file_path: "src/a.ts" }))).toMatchObject({
      kind: "file",
      action: "read",
    });
  });

  it("presents a search by what it looked for, and where", () => {
    expect(toolPresentation(tool("Grep", { pattern: "toolPresentation", path: "packages" }))).toEqual({
      kind: "file",
      tool: "Grep",
      action: "search",
      pattern: "toolPresentation",
      scope: "packages",
      filter: undefined,
    });
    // The directory and the glob narrow a Grep in different ways, so neither
    // one shadows the other — the old shape dropped the glob whenever a path
    // was also given.
    expect(
      toolPresentation(tool("Grep", { pattern: "useMemo", path: "C:/repo/src", glob: "**/*.tsx" })),
    ).toEqual({
      kind: "file",
      tool: "Grep",
      action: "search",
      pattern: "useMemo",
      scope: "C:/repo/src",
      filter: "**/*.tsx",
    });
    // A Glob's pattern IS its scope — repeating it would read as a filter on itself.
    expect(toolPresentation(tool("Glob", { glob: "**/*.tsx" }))).toEqual({
      kind: "file",
      tool: "Glob",
      action: "search",
      pattern: "**/*.tsx",
      scope: undefined,
      filter: undefined,
    });
  });

  it("falls back to the generic card when a file call names no file", () => {
    expect(toolPresentation(tool("Edit", { old_string: "a", new_string: "b" }))).toBeNull();
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
