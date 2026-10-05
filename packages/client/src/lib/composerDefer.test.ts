import { describe, it, expect } from "vitest";
import type { AttentionItem } from "@dispatch/shared";
import {
  blockingQuestion,
  composerDeferred,
  isDoubleTap,
  DOUBLE_TAP_MS,
} from "./composerDefer.js";

function item(over: Partial<AttentionItem> & Pick<AttentionItem, "id">): AttentionItem {
  return {
    chatId: "c1",
    kind: "question",
    summary: "Which approach?",
    createdAt: 1_000,
    ...over,
  };
}

describe("blockingQuestion", () => {
  it("finds an open question on this chat", () => {
    expect(blockingQuestion([item({ id: "q1" })], "c1")?.id).toBe("q1");
  });

  it("ignores other chats and other kinds", () => {
    const items = [
      item({ id: "other-chat", chatId: "c2" }),
      item({ id: "perm", kind: "permission" }),
      item({ id: "idle", kind: "idle" }),
      item({ id: "review", kind: "review" }),
    ];
    expect(blockingQuestion(items, "c1")).toBeNull();
  });

  it("takes the oldest when two are open", () => {
    const items = [
      item({ id: "newer", createdAt: 2_000 }),
      item({ id: "older", createdAt: 1_000 }),
    ];
    expect(blockingQuestion(items, "c1")?.id).toBe("older");
  });

  it("is null with no active chat", () => {
    expect(blockingQuestion([item({ id: "q1" })], null)).toBeNull();
  });
});

describe("composerDeferred", () => {
  const q = item({ id: "q1" });

  it("stands the composer down while a question is open", () => {
    expect(composerDeferred(q, null, false)).toBe(true);
  });

  it("stays out of the way with nothing open", () => {
    expect(composerDeferred(null, null, false)).toBe(false);
  });

  it("hands the composer back once reclaimed for that question", () => {
    expect(composerDeferred(q, "q1", false)).toBe(false);
  });

  it("re-collapses for the NEXT question after a reclaim", () => {
    expect(composerDeferred(item({ id: "q2" }), "q1", false)).toBe(true);
  });

  it("never collapses a draft in progress", () => {
    expect(composerDeferred(q, null, true)).toBe(false);
  });
});

describe("isDoubleTap", () => {
  it("needs a previous tap", () => {
    expect(isDoubleTap(1_000, 0)).toBe(false);
  });

  it("accepts a second tap inside the window", () => {
    expect(isDoubleTap(1_000 + DOUBLE_TAP_MS, 1_000)).toBe(true);
  });

  it("rejects one past it", () => {
    expect(isDoubleTap(1_001 + DOUBLE_TAP_MS, 1_000)).toBe(false);
  });
});
