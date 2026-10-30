import { describe, expect, it } from "vitest";
import type { AttentionItem, PermissionRequest } from "@dispatch/shared";
import { buildAttentionEntries, createAttentionTools, questionsFromInput, type AttentionEntry } from "./attention-tools.js";

const askInput = {
  questions: [
    {
      header: "Target",
      question: "Which branch?",
      multiSelect: false,
      options: [{ label: "main", description: "the trunk" }, { label: "dev" }],
    },
    { question: "Anything else?", options: [] },
    "garbage",
    { options: [{ label: "no question text" }] },
  ],
};

describe("questionsFromInput", () => {
  it("normalizes AskUserQuestion input and skips what it cannot read", () => {
    expect(questionsFromInput(askInput)).toEqual([
      {
        index: 0,
        header: "Target",
        question: "Which branch?",
        multiSelect: false,
        options: [{ label: "main", description: "the trunk" }, { label: "dev" }],
      },
      { index: 1, question: "Anything else?", multiSelect: false, options: [] },
    ]);
    expect(questionsFromInput({})).toEqual([]);
  });
});

describe("buildAttentionEntries", () => {
  const items: AttentionItem[] = [
    { id: "q1", chatId: "c1", projectId: "p1", kind: "question", summary: "asks", permissionRequestId: "r1", createdAt: Date.UTC(2026, 9, 29, 19) },
    { id: "q2", chatId: "c1", kind: "question", summary: "answered already", permissionRequestId: "gone", createdAt: 1 },
    { id: "p1", chatId: "c2", kind: "permission", summary: "Bash", permissionRequestId: "r2", createdAt: 2 },
    { id: "d1", chatId: "c2", kind: "done", summary: "finished", createdAt: 3 },
  ];
  const pending: PermissionRequest[] = [
    { id: "r1", chatId: "c1", toolName: "AskUserQuestion", input: askInput },
    { id: "r2", chatId: "c2", toolName: "Bash", displayName: "Run command", input: { command: "ls" } },
  ];

  it("adds the question, the tool, the chat title, local time and dismissibility", async () => {
    const titles: string[] = [];
    const out = await buildAttentionEntries(items, {
      pending,
      chatTitle: async (id) => {
        titles.push(id);
        return `Chat ${id}`;
      },
    });
    expect(out[0]).toMatchObject({ id: "q1", chatTitle: "Chat c1", dismissible: false, questions: [{ question: "Which branch?" }, { index: 1 }] });
    expect(out[0]!.createdAtLocal).toMatch(/^2026-10-29 \d\d:00:00 \S+$/);
    expect(out[1]!.questions).toBeUndefined();
    expect(out[2]).toMatchObject({ permissionTool: "Run command", dismissible: false });
    expect(out[3]).toMatchObject({ dismissible: true });
    // One title lookup per chat, not per item.
    expect(titles.sort()).toEqual(["c1", "c2"]);
  });
});

describe("attention_list", () => {
  it("renders items with their questions, and says so when the queue is empty", async () => {
    const entries = await buildAttentionEntries(items(), { pending: [{ id: "r1", chatId: "c1", toolName: "AskUserQuestion", input: askInput }] });
    let seen: unknown;
    const { attentionList } = createAttentionTools({
      attention: {
        list: async (q) => {
          seen = q;
          return entries as AttentionEntry[];
        },
      },
    });
    const res = await attentionList.handler({ kinds: ["question"], project: " p1 ", chatId: undefined }, {});
    expect(seen).toEqual({ kinds: ["question"], project: "p1" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("1 item waiting:");
    expect(text).toContain("Q0: Which branch? — options: main | dev");

    const empty = createAttentionTools({ attention: { list: async () => [] } });
    expect(((await empty.attentionList.handler({ kinds: undefined, project: undefined, chatId: undefined }, {})).content[0] as { text: string }).text)
      .toContain("Nothing is waiting");
    const unbound = await createAttentionTools({}).attentionList.handler({ kinds: undefined, project: undefined, chatId: undefined }, {});
    expect(unbound.isError).toBe(true);
  });

  function items(): AttentionItem[] {
    return [{ id: "q1", chatId: "c1", kind: "question", summary: "asks", permissionRequestId: "r1", createdAt: 1 }];
  }
});
