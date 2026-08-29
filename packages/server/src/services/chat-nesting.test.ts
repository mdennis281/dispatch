import { describe, it, expect } from "vitest";
import type { Chat } from "@dispatch/shared";
import { reviewingPurposeLabel, spawnedPurposeLabel } from "@dispatch/shared";
import { chatNestingDepth, type NestingLookup } from "./chat-nesting.js";

const chat = (id: string, extra: Partial<Chat> = {}): Chat =>
  ({
    id,
    projectId: extra.projectId ?? "p1",
    title: id,
    modeId: "default",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }) as Chat;

/** A lookup over a fixed set of chats and a fixed PR → author map. */
const lookup = (chats: Chat[], prs: Record<string, string> = {}): NestingLookup => ({
  getChat: async (id) => chats.find((c) => c.id === id) ?? null,
  prAuthorChatId: async (key) => prs[key] ?? null,
});

const spawned = (id: string, parentChatId: string) =>
  chat(id, {
    parentChatId,
    purpose: { kind: "spawned", label: spawnedPurposeLabel(parentChatId) },
  });

const reviewer = (id: string, reviewOf: string) =>
  chat(id, { reviewOf, purpose: { kind: "pr:review" } });

describe("chatNestingDepth", () => {
  it("reads a chat a human opened as the top level", async () => {
    const root = chat("root");
    expect(await chatNestingDepth("root", lookup([root]))).toBe(0);
  });

  it("counts the direct spawn edge", async () => {
    const chats = [chat("root"), spawned("child", "root"), spawned("grand", "child")];
    expect(await chatNestingDepth("child", lookup(chats))).toBe(1);
    expect(await chatNestingDepth("grand", lookup(chats))).toBe(2);
  });

  it("counts a reviewer through its pull request, which carries no parent id", async () => {
    // The edge the sidebar joins on. Missing it would call a reviewer depth 0
    // and let it open a level the tree has nowhere to draw — the whole reason
    // this walk follows two edges rather than reading `parentChatId`.
    const chats = [chat("root"), spawned("child", "root"), reviewer("r", "o/r#7")];
    const depth = await chatNestingDepth("r", lookup(chats, { "o/r#7": "child" }));

    expect(depth).toBe(2);
  });

  it("reads a pre-`reviewOf` reviewer's target back out of its purpose label", async () => {
    // Never spelled out here: the sentence has one writer and one parser, both
    // in shared, and a third literal in a test is how `detached` broke before.
    const legacy = chat("legacy", {
      purpose: { kind: "pr:review", label: reviewingPurposeLabel("mdennis281/dispatch", 139) },
    });
    const depth = await chatNestingDepth(
      "legacy",
      lookup([chat("root"), legacy], { "mdennis281/dispatch#139": "root" }),
    );

    expect(depth).toBe(1);
  });

  it("reads a pre-`parentChatId` chat's parent back out of its purpose label", async () => {
    // The edge the sidebar reads for these chats (`spawnParentId`). Counting
    // them 0 would let one spawn a chat the sidebar then draws at depth 2 —
    // exactly what the cap exists to prevent.
    const legacy = chat("legacy", {
      purpose: { kind: "spawned", label: spawnedPurposeLabel("root") },
    });

    expect(await chatNestingDepth("legacy", lookup([chat("root"), legacy]))).toBe(1);
  });

  it("refuses to read a parent out of a DETACHED chat's label", async () => {
    // `detached` says it wants no parent by omitting `parentChatId`, which is
    // indistinguishable from a pre-field chat — so the label it gets is written
    // in a shape the parser declines. Counting it 1 would make the flag change
    // nothing but which field the id was read from.
    const free = chat("free", {
      purpose: { kind: "spawned", label: spawnedPurposeLabel("root", true) },
    });

    expect(await chatNestingDepth("free", lookup([chat("root"), free]))).toBe(0);
  });

  it("stops at a parent in another project, which no sidebar draws", async () => {
    // A non-detached cross-project spawn still WRITES `parentChatId`, but
    // `buildChatTree` only sees one project's chats, so that parent fails its
    // `present` check and the row is a top-level row in the target project.
    // Following the edge would refuse a spawn from a chat that is visibly a root.
    const chats = [
      chat("a-root", { projectId: "pA" }),
      chat("b-child", { projectId: "pB", parentChatId: "a-root" }),
      chat("b-grand", { projectId: "pB", parentChatId: "b-child" }),
    ];

    expect(await chatNestingDepth("b-child", lookup(chats))).toBe(0);
    expect(await chatNestingDepth("b-grand", lookup(chats))).toBe(1);
  });

  it("stops at a parent that is gone rather than failing", async () => {
    // The sidebar files an orphan at the top level, so the depth it actually
    // renders at is the one counted from wherever the chain still reaches.
    const orphan = spawned("orphan", "deleted");
    expect(await chatNestingDepth("orphan", lookup([orphan]))).toBe(0);

    const unattributed = reviewer("r", "o/r#7");
    expect(await chatNestingDepth("r", lookup([unattributed]))).toBe(0);
  });

  it("stops on a cycle instead of never settling", async () => {
    // Only reachable from corrupt data, but this runs inside a tool call a human
    // is waiting on — a promise that never settles is the worst way to fail it.
    const a = spawned("a", "b");
    const b = spawned("b", "a");

    expect(await chatNestingDepth("a", lookup([a, b]))).toBe(1);
  });

  it("reads a chat that isn't there as the top level", async () => {
    expect(await chatNestingDepth("ghost", lookup([]))).toBe(0);
  });

  it("bounds a chain longer than anything the sidebar draws", async () => {
    const chats = [chat("c0"), ...Array.from({ length: 60 }, (_, i) => spawned(`c${i + 1}`, `c${i}`))];
    const depth = await chatNestingDepth("c60", lookup(chats));

    expect(depth).toBe(32);
  });
});
