import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@cm/shared";
import { deriveTodos } from "./todos.js";

/**
 * Build a top-level `tool_use` row (parentToolUseId null → folded by the strip).
 * `parent` overrides that to simulate a subagent-produced row.
 */
function toolUse(
  name: string,
  input: Record<string, unknown>,
  i: number,
  parent: string | null = null,
): ChatMessage {
  return {
    kind: "tool_use",
    id: `row-${i}`,
    chatId: "c1",
    ts: 1_000 + i,
    toolUseId: `toolu_${i}`,
    name,
    input,
    parentToolUseId: parent,
  };
}

/** A `TaskCreate` exactly as the SDK persists it: flat, NO id in the input. */
function create(subject: string, i: number): ChatMessage {
  return toolUse(
    "TaskCreate",
    { subject, description: `${subject} — detail`, activeForm: `Doing ${subject}` },
    i,
  );
}

/** A `TaskUpdate` referencing a task by its SDK-assigned sequential `taskId`. */
function update(taskId: string, status: string, i: number, parent: string | null = null): ChatMessage {
  return toolUse("TaskUpdate", { taskId, status }, i, parent);
}

describe("deriveTodos — real Task tool shape (BUG B regression)", () => {
  it("reflects TaskUpdate completions against id-less TaskCreate rows", () => {
    let i = 0;
    const rows: ChatMessage[] = [];
    // 11 creates, none of which carry an id in the input (mirrors the real transcript).
    for (let n = 1; n <= 11; n++) rows.push(create(`Task ${n}`, i++));
    // TaskUpdate patches reference the SDK's implicit sequential ids "1".."11".
    // Complete 1..10; leave 11 in_progress — matching the real failing transcript.
    for (let n = 1; n <= 10; n++) rows.push(update(String(n), "completed", i++));
    rows.push(update("11", "in_progress", i++));

    const s = deriveTodos(rows);

    expect(s.total).toBe(11);
    expect(s.completed).toBe(10); // was 0 before the fix
    expect(s.inProgress).toBe(1);
    expect(s.pending).toBe(0);
    expect(s.allDone).toBe(false);
    expect(s.active?.content).toBe("Task 11");
    // Every created task got its sequential id, so keys are "1".."11".
    expect(s.todos.map((t) => t.key)).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    );
  });

  it("uses `subject` as the todo content and carries activeForm", () => {
    const s = deriveTodos([create("Design elite archetype", 0)]);
    expect(s.todos[0]!.content).toBe("Design elite archetype");
    expect(s.todos[0]!.activeForm).toBe("Doing Design elite archetype");
    expect(s.completed).toBe(0);
    expect(s.pending).toBe(1);
  });

  it("completes across TWO create batches (ids keep counting up)", () => {
    let i = 0;
    const rows: ChatMessage[] = [];
    for (let n = 1; n <= 5; n++) rows.push(create(`A${n}`, i++)); // ids 1..5
    for (let n = 1; n <= 5; n++) rows.push(update(String(n), "completed", i++));
    for (let n = 6; n <= 8; n++) rows.push(create(`B${n}`, i++)); // ids 6..8
    rows.push(update("6", "completed", i++));

    const s = deriveTodos(rows);
    expect(s.total).toBe(8);
    expect(s.completed).toBe(6);
  });

  it("ignores a subagent's TaskUpdate (parentToolUseId set) — top level only", () => {
    let i = 0;
    const rows: ChatMessage[] = [
      create("Only task", i++), // id "1"
      // A subagent tries to complete id "1" — must NOT affect the main strip.
      update("1", "completed", i++, "toolu_parent"),
    ];
    const s = deriveTodos(rows);
    expect(s.total).toBe(1);
    expect(s.completed).toBe(0);
    expect(s.pending).toBe(1);
  });

  it("still honours TodoWrite whole-list replace (no id regression)", () => {
    const rows: ChatMessage[] = [
      toolUse(
        "TodoWrite",
        {
          todos: [
            { content: "one", status: "completed", activeForm: "doing one" },
            { content: "two", status: "in_progress", activeForm: "doing two" },
          ],
        },
        0,
      ),
    ];
    const s = deriveTodos(rows);
    expect(s.total).toBe(2);
    expect(s.completed).toBe(1);
    expect(s.inProgress).toBe(1);
  });
});
