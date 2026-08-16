import { describe, it, expect } from "vitest";
import { isPrSettledIdle, type Chat, type PRRef } from "./domain.js";

type ChatFacts = Pick<Chat, "status" | "prs" | "updatedAt" | "lastUserMessageAt">;

const OPEN: PRRef = { number: 1, url: "u", branch: "b", state: "open" };
const MERGED: PRRef = { number: 2, url: "u", branch: "b", state: "merged", settledAt: 500 };

function chat(over: Partial<ChatFacts> = {}): ChatFacts {
  return { status: "idle", prs: [MERGED], updatedAt: 900, lastUserMessageAt: 100, ...over };
}

describe("isPrSettledIdle", () => {
  it("is true for an idle chat whose PR merged with nothing said since", () => {
    expect(isPrSettledIdle(chat())).toBe(true);
  });

  it("is false while the chat is still working", () => {
    for (const status of ["running", "waiting", "queued", "awaiting-input"] as const) {
      expect(isPrSettledIdle(chat({ status }))).toBe(false);
    }
  });

  it("is false once a user message follows the merge", () => {
    expect(isPrSettledIdle(chat({ lastUserMessageAt: 501 }))).toBe(false);
  });

  it("holds at the boundary — the message that CAUSED the merge doesn't clear it", () => {
    // A turn's own user message necessarily precedes the merge it produced;
    // only a later one supersedes the dot.
    expect(isPrSettledIdle(chat({ lastUserMessageAt: 500 }))).toBe(true);
  });

  it("treats a chat with no recorded status as idle", () => {
    expect(isPrSettledIdle({ prs: [MERGED], updatedAt: 900, lastUserMessageAt: 100 })).toBe(true);
  });

  it("is false with no PRs, or only open ones", () => {
    expect(isPrSettledIdle(chat({ prs: [] }))).toBe(false);
    expect(isPrSettledIdle(chat({ prs: [OPEN] }))).toBe(false);
  });

  it("counts a closed PR, not just a merged one", () => {
    const closed: PRRef = { ...MERGED, state: "closed" };
    expect(isPrSettledIdle(chat({ prs: [closed] }))).toBe(true);
  });

  it("uses the LATEST settle across several PRs", () => {
    const early: PRRef = { ...MERGED, number: 3, settledAt: 200 };
    // Superseded by the later merge at 500, so a message at 300 is still older
    // than "when this chat last landed something".
    expect(isPrSettledIdle(chat({ prs: [early, MERGED], lastUserMessageAt: 300 }))).toBe(true);
    expect(isPrSettledIdle(chat({ prs: [early, MERGED], lastUserMessageAt: 600 }))).toBe(false);
  });

  describe("chats predating these fields", () => {
    const legacy: PRRef = { number: 4, url: "u", branch: "b", state: "merged" };

    it("falls back to updatedAt so an already-landed chat still reads green", () => {
      expect(isPrSettledIdle({ status: "idle", prs: [legacy], updatedAt: 900 })).toBe(true);
    });

    it("does NOT guess once user messages are being recorded", () => {
      // No settledAt to compare against — pinning the dot green through every
      // later turn is worse than showing plain idle.
      const c = { status: "idle" as const, prs: [legacy], updatedAt: 900, lastUserMessageAt: 100 };
      expect(isPrSettledIdle(c)).toBe(false);
    });

    it("still honours a dated ref alongside an undated one", () => {
      const c = chat({ prs: [legacy, MERGED] });
      expect(isPrSettledIdle(c)).toBe(true);
    });
  });
});
