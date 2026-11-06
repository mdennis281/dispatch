import { describe, expect, it } from "vitest";
import type { Chat, ChatSearchFrame } from "@dispatch/shared";

import { DAY_MS, searchChatsByAge, type ChatSearchDeps } from "./chat-search.js";
import type { ChatSummary, FindChatsQuery, FindChatsResult } from "./inspect.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function chat(id: string, ageMs: number): Chat {
  return { id, title: `chat ${id}`, projectId: "p1", createdAt: NOW - ageMs, updatedAt: NOW - ageMs } as Chat;
}

function summary(c: Chat, score = 0.8): ChatSummary {
  return {
    id: c.id,
    title: c.title,
    projectId: c.projectId,
    projectName: "Proj",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? c.createdAt,
    score,
    hits: [
      { id: `${c.id}-low`, kind: "user", snippet: "weak", score: 0.55 },
      { id: `${c.id}-best`, kind: "assistant", snippet: "strong", score },
    ],
  };
}

/** Deps whose `findChats` matches every chat in the window, recording each call. */
function deps(chats: Chat[], page?: (q: FindChatsQuery, inWindow: Chat[]) => FindChatsResult) {
  const calls: FindChatsQuery[] = [];
  const d: ChatSearchDeps = {
    listChats: async () => chats,
    findChats: async (q) => {
      calls.push(q);
      const inWindow = chats.filter((c) => {
        const at = c.updatedAt ?? c.createdAt;
        return at >= (q.since ?? -Infinity) && (q.before === undefined || at < q.before);
      });
      if (page) return page(q, inWindow);
      return {
        chats: inWindow.map((c) => summary(c)),
        candidates: inWindow.length,
        scanned: inWindow.length,
        bytesScanned: 0,
        truncated: false,
        unscanned: 0,
      };
    },
  };
  return { d, calls };
}

async function collect(gen: AsyncGenerator<ChatSearchFrame>): Promise<ChatSearchFrame[]> {
  const out: ChatSearchFrame[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe("searchChatsByAge", () => {
  it("walks newest first, a day at a time, ending with done", async () => {
    const chats = [chat("a", 2 * HOUR), chat("b", 30 * HOUR), chat("c", 50 * HOUR)];
    const { d, calls } = deps(chats);
    const frames = await collect(searchChatsByAge(d, { query: "colors", now: NOW }));

    const hitFrames = frames.filter((f) => f.type === "hits");
    expect(hitFrames.map((f) => f.type === "hits" && f.hits.map((h) => h.chatId))).toEqual([["a"], ["b"], ["c"]]);
    expect(hitFrames.map((f) => f.type === "hits" && f.daysBack)).toEqual([1, 2, 3]);
    expect(hitFrames.map((f) => f.type === "hits" && f.searched)).toEqual([1, 2, 3]);
    expect(frames.at(-1)).toEqual({ type: "done", searched: 3, total: 3, daysBack: 3 });

    // The first window is open-ended — a chat active right now can have an
    // `updatedAt` a few ms past the anchor.
    expect(calls[0]).toMatchObject({ since: NOW - DAY_MS, archived: true });
    expect(calls[0]!.before).toBeUndefined();
    expect(calls[1]).toMatchObject({ since: NOW - 2 * DAY_MS, before: NOW - DAY_MS });
  });

  it("jumps empty windows instead of querying each one", async () => {
    const chats = [chat("new", HOUR), chat("old", 40 * DAY_MS + HOUR)];
    const { d, calls } = deps(chats);
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ since: NOW - 41 * DAY_MS, before: NOW - 40 * DAY_MS });
    const last = frames.filter((f) => f.type === "hits").at(-1);
    expect(last).toMatchObject({ daysBack: 41, hits: [{ chatId: "old" }] });
  });

  it("puts a chat exactly on a window boundary in the window that holds it", async () => {
    const chats = [chat("edge", 3 * DAY_MS)];
    const { d, calls } = deps(chats);
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));

    // Windows are [since, before): now − 3d is the inclusive floor of
    // [now − 3d, now − 2d), not the excluded ceiling of the window below it. A
    // jump that computed the latter would skip the chat for good.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ since: NOW - 3 * DAY_MS, before: NOW - 2 * DAY_MS });
    expect(frames.filter((f) => f.type === "hits").flatMap((f) => (f.type === "hits" ? f.hits : []))).toHaveLength(1);
  });

  it("follows the cursor within a window and reports partial coverage", async () => {
    const chats = [chat("a", HOUR), chat("b", 2 * HOUR), chat("c", 3 * HOUR)];
    const { d, calls } = deps(chats, (q, inWindow) =>
      q.cursor
        ? { chats: [summary(inWindow[2]!)], candidates: 3, scanned: 1, bytesScanned: 0, truncated: false, unscanned: 0 }
        : {
            chats: inWindow.slice(0, 2).map((c) => summary(c)),
            candidates: 3,
            scanned: 2,
            bytesScanned: 0,
            truncated: true,
            unscanned: 1,
            nextCursor: "page-2",
          },
    );
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));

    expect(calls.map((c) => c.cursor)).toEqual([undefined, "page-2"]);
    const hits = frames.filter((f) => f.type === "hits");
    expect(hits.map((f) => f.type === "hits" && f.searched)).toEqual([2, 3]);
  });

  it("uses the best-scoring hit for the snippet, not the first one", async () => {
    const { d } = deps([chat("a", HOUR)]);
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));
    const first = frames[0];
    expect(first?.type === "hits" && first.hits[0]).toMatchObject({
      snippet: "strong",
      kind: "assistant",
      messageId: "a-best",
      projectName: "Proj",
    });
  });

  it("never lists a chat twice", async () => {
    const chats = [chat("a", HOUR), chat("b", 30 * HOUR)];
    // A chat touched mid-walk can resurface in an older page's results.
    const { d } = deps(chats, (_q, inWindow) => ({
      chats: [...inWindow, chats[0]!].map((c) => summary(c)),
      candidates: inWindow.length,
      scanned: inWindow.length,
      bytesScanned: 0,
      truncated: false,
      unscanned: 0,
    }));
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));
    const ids = frames.flatMap((f) => (f.type === "hits" ? f.hits.map((h) => h.chatId) : []));
    expect(ids).toEqual(["a", "b"]);
  });

  it("stops without a done frame once aborted", async () => {
    const chats = [chat("a", HOUR), chat("b", 30 * HOUR), chat("c", 60 * HOUR)];
    const abort = new AbortController();
    const { d, calls } = deps(chats);
    const frames: ChatSearchFrame[] = [];
    for await (const f of searchChatsByAge(d, { query: "x", now: NOW, signal: abort.signal })) {
      frames.push(f);
      abort.abort();
    }
    expect(calls).toHaveLength(1);
    expect(frames.map((f) => f.type)).toEqual(["hits"]);
  });

  it("ends at once on an empty store", async () => {
    const { d, calls } = deps([]);
    const frames = await collect(searchChatsByAge(d, { query: "x", now: NOW }));
    expect(calls).toHaveLength(0);
    expect(frames).toEqual([{ type: "done", searched: 0, total: 0, daysBack: 0 }]);
  });
});
