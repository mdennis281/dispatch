import { describe, expect, it } from "vitest";
import { PrRecordSchema, spawnedPurposeLabel, type Chat, type PrRecord } from "@dispatch/shared";
import { chatFamily, chatTree, renderChatTree, type ChatTreeDeps } from "./chat-tree.js";

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id,
    projectId: "p1",
    title: `Chat ${id}`,
    modeId: "default",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: Number(id.replace(/\D/g, "") || 0),
    updatedAt: 1_793_000_000_000,
    ...over,
  } as Chat;
}

/**
 * root ─┬─ kidA (spawned) ── grandkid (spawned)
 *       ├─ kidB (spawned, legacy purpose sentence, no parentChatId)
 *       └─ rev1 (reviewer of root's PR o/r#7)
 * detached (says who spawned it, but asked not to nest)
 * other-project child of root (a different project draws as a root)
 */
const chats: Chat[] = [
  chat("root1", { prs: [{ number: 7, url: "u", branch: "b", repo: "o/r" }] }),
  chat("kidA2", { parentChatId: "root1", status: "running" }),
  chat("kidB3", { purpose: { kind: "spawned", label: spawnedPurposeLabel("root1") } }),
  chat("rev4", { reviewOf: "o/r#7", purpose: { kind: "pr:review", label: "Reviewing PR #7 in o/r" } }),
  chat("grand5", { parentChatId: "kidA2", status: "awaiting-input" }),
  chat("detached6", { purpose: { kind: "spawned", label: spawnedPurposeLabel("root1", true) } }),
  chat("foreign7", { parentChatId: "root1", projectId: "p2" }),
];

const deps: ChatTreeDeps = {
  getChat: async (id) => chats.find((c) => c.id === id) ?? null,
  listChats: async (projectId) => chats.filter((c) => c.projectId === projectId),
  getPrRecord: async (): Promise<PrRecord | null> => null,
};

describe("chatTree", () => {
  it("walks both of the sidebar's edges: parentChatId (and its legacy sentence) and reviewOf → PR author", async () => {
    const tree = await chatTree("root1", deps);
    expect(tree?.ancestors).toEqual([]);
    const kids = tree!.chat.children!;
    expect(kids.map((k) => [k.id, k.relation])).toEqual([
      ["kidA2", "spawned"],
      ["kidB3", "spawned"],
      ["rev4", "reviewer"],
    ]);
    expect(kids[0]!.children?.map((g) => [g.id, g.blockedOnHuman])).toEqual([["grand5", true]]);
    expect(kids[2]!.reviewOf).toBe("o/r#7");
    // Neither the detached spawn nor the cross-project child nests.
    const all = JSON.stringify(tree);
    expect(all).not.toContain("detached6");
    expect(all).not.toContain("foreign7");
  });

  it("lists ancestors root-first, and respects depth", async () => {
    const tree = await chatTree("grand5", deps);
    expect(tree!.ancestors.map((a) => a.id)).toEqual(["root1", "kidA2"]);
    expect(tree!.chat.relation).toBe("spawned");
    expect((await chatTree("root1", deps, 1))!.chat.children!.every((k) => k.children === undefined)).toBe(true);
    expect(await chatTree("nope", deps)).toBeNull();
  });

  it("joins a reviewer through the REGISTRY's author when the chat's refs don't name the PR", async () => {
    const reg = PrRecordSchema.parse({ key: "o/r#9", repo: "o/r", number: 9, url: "u", firstSeenAt: 1, lastChangedAt: 1, chatId: "kidA2" });
    const withReg: ChatTreeDeps = {
      ...deps,
      listChats: async () => [...chats.filter((c) => c.projectId === "p1"), chat("rev8", { reviewOf: "o/r#9" })],
      getPrRecord: async (key) => (key === reg.key ? reg : null),
    };
    const tree = await chatTree("kidA2", withReg);
    expect(tree!.chat.children!.map((k) => [k.id, k.relation])).toEqual([["grand5", "spawned"], ["rev8", "reviewer"]]);
  });

  it("survives a cycle", async () => {
    const loop = [chat("a1", { parentChatId: "b2" }), chat("b2", { parentChatId: "a1" })];
    const d: ChatTreeDeps = { ...deps, getChat: async (id) => loop.find((c) => c.id === id) ?? null, listChats: async () => loop };
    const tree = await chatTree("a1", d);
    expect(tree!.ancestors.map((a) => a.id)).toEqual(["b2"]);
    expect(tree!.chat.children?.map((c) => c.id) ?? []).toEqual([]);
  });

  it("renders an indented tree with the asked chat marked", async () => {
    const text = renderChatTree((await chatTree("kidA2", deps))!);
    expect(text.split("\n").map((l) => l.replace(/ · \d{4}-.*$/, ""))).toEqual([
      'root1 "Chat root1"',
      '  └ ▶ kidA2 "Chat kidA2" · running',
      '    └ grand5 "Chat grand5" · awaiting-input · ⏸ waiting on the human',
    ]);
  });
});

describe("chatFamily", () => {
  it("is the direct parent and children only", async () => {
    expect(await chatFamily(chats[1]!, deps)).toEqual({
      parent: { id: "root1", title: "Chat root1", relation: "spawned" },
      children: [{ id: "grand5", title: "Chat grand5", relation: "spawned", status: "awaiting-input" }],
    });
    expect((await chatFamily(chats[0]!, deps)).children.map((c) => c.id)).toEqual(["kidA2", "kidB3", "rev4"]);
  });
});
