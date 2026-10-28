/**
 * `ChatSummaryService` over a fake store and the `generate` seam: what reaches
 * the model, and the three things that keep a bot in a loop from spending a
 * model call per question (cache, in-flight sharing, per-caller limit).
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@dispatch/shared";
import { ChatSummaryService, SummaryRateLimitError, summarySource } from "./chat-summary.js";

const user = (id: string, text: string, extra: Partial<ChatMessage> = {}) =>
  ({ id, kind: "user", text, ts: 0, ...extra }) as unknown as ChatMessage;
const said = (id: string, text: string, extra: Partial<ChatMessage> = {}) =>
  ({ id, kind: "assistant", text, ts: 0, ...extra }) as unknown as ChatMessage;

function fixture(opts: { limitPerHour?: number } = {}) {
  const rows: ChatMessage[] = [user("r1", "fix the build"), said("r2", "on it")];
  const prompts: string[] = [];
  let clock = 1_000;
  let release: (() => void) | undefined;
  let hold = false;
  const service = new ChatSummaryService({
    store: {
      getChat: async (id: string) => (id === "c1" ? ({ id, title: "Build", harness: "claude" } as never) : null),
      readMessages: async () => rows,
      getSettings: async () => null as never,
    } as never,
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      if (hold) await new Promise<void>((r) => (release = r));
      return `summary #${prompts.length}`;
    },
    now: () => clock,
    ...opts,
  });
  return {
    service,
    rows,
    prompts,
    tick: (ms: number) => (clock += ms),
    hold: () => (hold = true),
    release: () => release?.(),
  };
}

describe("ChatSummaryService", () => {
  it("caches until a new row lands, and a cache hit is free", async () => {
    const f = fixture({ limitPerHour: 1 });
    const first = await f.service.summarize("c1", { caller: "channel:grok" });
    expect(first).toMatchObject({ summary: "summary #1", cached: false, upToRowId: "r2", provider: "claude" });
    // The limit is 1, so this would throw if a hit counted.
    expect(await f.service.summarize("c1", { caller: "channel:grok" })).toMatchObject({ summary: "summary #1", cached: true });
    f.rows.push(said("r3", "done"));
    await expect(f.service.summarize("c1", { caller: "channel:grok" })).rejects.toBeInstanceOf(SummaryRateLimitError);
    expect(f.prompts).toHaveLength(1);
  });

  it("treats a different focus as a different question", async () => {
    const f = fixture();
    await f.service.summarize("c1", { caller: "a" });
    const focused = await f.service.summarize("c1", { caller: "a", focus: "did it land?" });
    expect(focused.cached).toBe(false);
    expect(f.prompts[1]).toContain("did it land?");
  });

  it("shares one model call between concurrent callers", async () => {
    const f = fixture();
    f.hold();
    const one = f.service.summarize("c1", { caller: "a" });
    const two = f.service.summarize("c1", { caller: "b" });
    await new Promise((r) => setTimeout(r, 0));
    f.release();
    expect(await one).toEqual(await two);
    expect(f.prompts).toHaveLength(1);
  });

  it("limits model calls per caller over a rolling hour", async () => {
    const f = fixture({ limitPerHour: 1 });
    await f.service.summarize("c1", { caller: "a" });
    f.rows.push(said("r3", "more"));
    const err = await f.service.summarize("c1", { caller: "a" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SummaryRateLimitError);
    expect((err as SummaryRateLimitError).retryAfterMs).toBe(3_600_000);
    // Another caller has its own budget…
    expect((await f.service.summarize("c1", { caller: "b" })).cached).toBe(false);
    // …and the first gets theirs back an hour on.
    f.tick(3_600_000);
    f.rows.push(said("r4", "even more"));
    expect((await f.service.summarize("c1", { caller: "a" })).cached).toBe(false);
  });

  it("charges nothing for an empty chat or a failed call", async () => {
    const f = fixture({ limitPerHour: 1 });
    f.rows.splice(0);
    for (let i = 0; i < 3; i++) await f.service.summarize("c1", { caller: "a" });
    expect(f.prompts).toHaveLength(0);

    const failing = new ChatSummaryService({
      store: {
        getChat: async () => ({ id: "c1", title: "t", harness: "claude" }) as never,
        readMessages: async () => [user("r1", "hi")],
        getSettings: async () => null as never,
      } as never,
      generate: async () => { throw new Error("timed out"); },
      limitPerHour: 1,
    });
    await expect(failing.summarize("c1", { caller: "a" })).rejects.toThrow("timed out");
    // Still the full budget: the second failure is the model's, not the limit's.
    await expect(failing.summarize("c1", { caller: "a" })).rejects.toThrow("timed out");
  });

  it("refuses an unknown chat", async () => {
    await expect(fixture().service.summarize("nope", { caller: "a" })).rejects.toThrow(/No chat/);
  });
});

describe("summarySource", () => {
  it("keeps what was said and drops how it was done", () => {
    const text = summarySource([
      user("1", "ship it"),
      user("2", "from a peer", { origin: "peer", peer: { chatId: "p", title: "Planner" } } as never),
      user("3", "from a bot", { origin: "channel", channel: { name: "grok" } } as never),
      said("4", "subagent chatter", { parentToolUseId: "t1" } as never),
      ({ id: "5", kind: "tool", ts: 0 }) as unknown as ChatMessage,
      said("6", "shipped"),
    ]);
    expect(text).toBe("[human] ship it\n\n[agent Planner] from a peer\n\n[grok] from a bot\n\n[agent] shipped");
  });

  it("keeps the opening ask and the recent tail of a long chat", () => {
    const rows = [user("first", "THE ASK"), ...Array.from({ length: 200 }, (_, i) => said(`m${i}`, "x".repeat(400))), said("last", "THE END")];
    const text = summarySource(rows);
    expect(text.startsWith("[human] THE ASK")).toBe(true);
    expect(text.endsWith("[agent] THE END")).toBe(true);
    expect(text).toMatch(/characters of the middle of the chat omitted/);
    expect(text.length).toBeLessThan(37_000);
  });
});
