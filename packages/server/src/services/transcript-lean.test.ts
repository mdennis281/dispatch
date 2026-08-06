import { describe, it, expect } from "vitest";
import type { ChatMessage, ToolResultRow, ToolUseRow, SystemMessageRow } from "@dispatch/shared";
import { leanRow, leanRows } from "./transcript-lean.js";

function toolUse(name: string, input: Record<string, unknown>): ToolUseRow {
  return { kind: "tool_use", id: "u1", chatId: "c1", ts: 1, toolUseId: "t1", name, input };
}

function toolResult(content: unknown): ToolResultRow {
  return { kind: "tool_result", id: "r1", chatId: "c1", ts: 2, toolUseId: "t1", ok: true, content };
}

/** A payload comfortably over every inline threshold. */
const BIG = "x".repeat(20_000);

describe("lean transcript projection — small payloads pass through", () => {
  it("leaves a small tool_use input verbatim and unflagged", () => {
    const row = toolUse("Bash", { command: "echo hi" });
    const lean = leanRow(row) as ToolUseRow;
    expect(lean).toBe(row); // identity: nothing to copy
    expect(lean.inputOmitted).toBeUndefined();
  });

  it("leaves a small tool_result content verbatim and unflagged", () => {
    const row = toolResult("hi\nthere");
    const lean = leanRow(row) as ToolResultRow;
    expect(lean).toBe(row);
    expect(lean.contentOmitted).toBeUndefined();
    expect(lean.content).toBe("hi\nthere");
  });

  it("never touches the rows that ARE their content", () => {
    const rows: ChatMessage[] = [
      { kind: "assistant", id: "a1", chatId: "c1", ts: 1, text: BIG },
      { kind: "user", id: "u1", chatId: "c1", ts: 2, text: BIG },
      { kind: "notice", id: "n1", chatId: "c1", ts: 3, level: "info", text: BIG },
    ];
    for (const r of rows) expect(leanRow(r)).toBe(r);
  });
});

describe("lean transcript projection — large payloads are clipped + flagged", () => {
  it("keeps the keys a COLLAPSED card renders and drops the bulk", () => {
    const lean = leanRow(
      toolUse("Edit", { file_path: "src/a.ts", old_string: BIG, new_string: BIG }),
    ) as ToolUseRow;
    expect(lean.inputOmitted).toBe(true);
    // The "Open" affordance resolves its file from this key — it must survive.
    expect(lean.input.file_path).toBe("src/a.ts");
    expect(lean.input.old_string).toBeUndefined();
    expect(JSON.stringify(lean).length).toBeLessThan(1_000);
  });

  it("clips a long display string rather than dropping it", () => {
    const lean = leanRow(toolUse("Bash", { command: BIG })) as ToolUseRow;
    const command = lean.input.command as string;
    expect(command.startsWith("xxx")).toBe(true);
    expect(command.length).toBeLessThan(600);
    expect(command.endsWith("…")).toBe(true);
  });

  it("clips a big tool result to a head preview and reports the real size", () => {
    const lean = leanRow(toolResult(BIG)) as ToolResultRow;
    expect(lean.contentOmitted).toBe(true);
    // Serialized size (the two JSON quotes included) — it's the wire cost the
    // card's "48 KB" label is telling the reader about.
    expect(lean.contentBytes).toBe(20_002);
    expect(String(lean.content).length).toBeLessThan(1_600);
    expect(String(lean.content).startsWith("xxx")).toBe(true);
  });

  it("previews a non-string result payload as readable JSON", () => {
    const lean = leanRow(toolResult({ files: Array.from({ length: 500 }, (_, i) => `f${i}.ts`) })) as ToolResultRow;
    expect(lean.contentOmitted).toBe(true);
    expect(String(lean.content)).toContain("f0.ts");
  });

  it("reduces a big system payload to the model the transcript shows", () => {
    const row: SystemMessageRow = {
      kind: "system",
      id: "s1",
      chatId: "c1",
      ts: 1,
      subtype: "init",
      data: { model: "claude-opus-5", tools: Array.from({ length: 400 }, (_, i) => `tool${i}`) },
    };
    const lean = leanRow(row) as SystemMessageRow;
    expect(lean.dataOmitted).toBe(true);
    expect(lean.data).toEqual({ model: "claude-opus-5" });
  });
});

describe("lean transcript projection — todo tools are exempt", () => {
  // The client folds these inputs into the live Tasks strip on every render, so
  // clipping them would silently break task tracking on long chats.
  it.each(["TodoWrite", "TaskCreate", "TaskUpdate"])("keeps a huge %s input whole", (name) => {
    const todos = Array.from({ length: 400 }, (_, i) => ({
      content: `task ${i} ${"y".repeat(100)}`,
      status: "pending",
    }));
    const row = toolUse(name, { todos });
    const lean = leanRow(row) as ToolUseRow;
    expect(lean).toBe(row);
    expect(lean.inputOmitted).toBeUndefined();
    expect((lean.input.todos as unknown[]).length).toBe(400);
  });
});

describe("lean transcript projection — bulk", () => {
  it("shrinks a realistic tool-heavy page by an order of magnitude", () => {
    const page: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      page.push(toolUse("Bash", { command: `run ${i}`, script: BIG }));
      page.push(toolResult(BIG));
    }
    const before = JSON.stringify(page).length;
    const after = JSON.stringify(leanRows(page)).length;
    expect(after).toBeLessThan(before / 10);
    // ...and the projection is pure: the source rows are untouched.
    expect(JSON.stringify(page).length).toBe(before);
  });
});
