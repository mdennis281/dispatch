import { describe, it, expect } from "vitest";
import type { ChatMessage, ToolUseRow } from "@dispatch/shared";
import {
  groupTranscriptRows,
  isPrPresentation,
  shellGroupPresentation,
  toolPresentation,
} from "./toolPresentations.js";
import { SHELL_FILTER_OPTIONS } from "./shellFilter.js";

function use(name: string, input: Record<string, unknown> = {}, id = name): ToolUseRow {
  return {
    id,
    chatId: "c1",
    kind: "tool_use",
    ts: 1,
    role: "assistant",
    name,
    toolUseId: id,
    input,
  } as unknown as ToolUseRow;
}

const mcp = (tool: string, input?: Record<string, unknown>, id?: string) =>
  use(`mcp__manager__${tool}`, input, id);

describe("PR calls leave the terminal frame", () => {
  it("groups adjacent PR calls into a run of their own", () => {
    const items = groupTranscriptRows([
      mcp("create_pr", { title: "feat: thing" }, "a"),
      mcp("watch_pr", { number: 96 }, "b"),
      mcp("resolve_thread", { threadId: "PRRT_1" }, "c"),
    ] as ChatMessage[]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("pr");
  });

  it("does not merge a PR run with a shell run", () => {
    // A terminal session and a pull request are different stories; interleaving
    // them made both unreadable, which is why PR tools moved out.
    const items = groupTranscriptRows([
      use("Bash", { command: "pnpm test" }, "sh"),
      mcp("watch_pr", { number: 96 }, "pr"),
      use("Bash", { command: "git push" }, "sh2"),
    ] as ChatMessage[]);
    expect(items.map((i) => i.kind)).toEqual(["shell", "pr", "shell"]);
  });

  it("keeps non-PR manager tools in the terminal frame", () => {
    // Only the `pr` category moved. `wait`, memory and terminal calls are still
    // terminal-shaped and still filterable there.
    const items = groupTranscriptRows([
      mcp("wait", { seconds: 5 }, "w"),
      mcp("recall", { query: "ports" }, "r"),
    ] as ChatMessage[]);
    expect(items.map((i) => i.kind)).toEqual(["shell"]);
  });

  it("refuses to present a PR call as a shell-frame row", () => {
    const row = mcp("approve_pr", { number: 96 });
    expect(isPrPresentation(toolPresentation(row))).toBe(true);
    // The frame asks this question directly; answering null is what keeps a PR
    // card from also rendering inside the terminal.
    expect(shellGroupPresentation(row)).toBeNull();
  });

  it("has retired the `pr` shell-filter toggle", () => {
    // The toggle described rows that no longer live there.
    expect(SHELL_FILTER_OPTIONS.map((o) => o.id)).not.toContain("pr");
  });
});
