/**
 * THE PALETTE'S TRANSCRIPT SEARCH — `findChats`, walked backwards a day at a time.
 *
 * The store is ~300 transcripts and ~800 MB. Scanning all of it before showing
 * anything means the palette shows nothing for seconds, for a question whose
 * answer is almost always "the chat from this afternoon". So the walk goes in
 * age order: the last 24 hours, then the 24 before that, and so on, emitting
 * each page as it lands. The recent answer shows up almost at once; older ones
 * keep arriving underneath it until the walk runs out of chats or the client
 * hangs up.
 *
 * The matching itself is entirely `InspectService.findChats` — the same
 * token-similarity scorer (`compileQuery`) and budgeted, cursor-paged scan that
 * `chat_find` uses. Two search engines over the same transcripts would rank
 * the same chat differently depending on which box you typed into.
 *
 * Empty windows are JUMPED, not walked. A store whose previous chat is six
 * weeks older than the one before it would otherwise make 42 calls that each
 * list every chat to find nothing.
 */
import type { Chat, ChatSearchFrame, ChatSearchHit } from "@dispatch/shared";
import type { ChatSummary, FindChatsQuery, FindChatsResult } from "./inspect.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Transcript bytes one page may scan. Small next to `findChats`' own 256 MB
 * default on purpose: a busy day can hold 100 MB of tool output, and a page is
 * the unit of "something new appears" — one that size would be a frozen list.
 */
const PAGE_BUDGET_BYTES = 48 * 1024 * 1024;
/** Matches per page before the cursor carries the rest of the window. */
const PAGE_LIMIT = 30;
/**
 * Rows kept per chat. More than one because `scanTranscript` collects hits in
 * FILE order and stops at the cap — with one, the snippet would be the oldest
 * passage that cleared the bar rather than the best.
 */
const HITS_PER_CHAT = 3;

export interface ChatSearchDeps {
  listChats(): Promise<Chat[]>;
  findChats(q: FindChatsQuery): Promise<FindChatsResult>;
}

export interface ChatSearchOptions {
  query: string;
  /** The walk's anchor; window k is [now − (k+1)·W, now − k·W). */
  now?: number;
  windowMs?: number;
  signal?: AbortSignal;
}

const activity = (c: Chat): number => c.updatedAt ?? c.createdAt;

/** A `findChats` summary as one palette row: its best passage, or its title. */
function toHit(s: ChatSummary): ChatSearchHit {
  const best = (s.hits ?? [])
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  return {
    chatId: s.id,
    title: s.title,
    projectId: s.projectId,
    ...(s.projectName ? { projectName: s.projectName } : {}),
    ...(s.archived ? { archived: true } : {}),
    at: s.updatedAt,
    score: s.score ?? best?.score ?? 0,
    snippet: best?.snippet ?? s.title,
    kind: best?.kind ?? "title",
    ...(best?.id ? { messageId: best.id } : {}),
  };
}

/**
 * Walk every chat newest-first in `windowMs` windows, yielding a frame per page.
 *
 * The FIRST window has no upper bound: a chat that is active right now has an
 * `updatedAt` a few ms past `now` by the time it's read, and the live chat is
 * the likeliest one to be looking for.
 */
export async function* searchChatsByAge(
  deps: ChatSearchDeps,
  opts: ChatSearchOptions,
): AsyncGenerator<ChatSearchFrame> {
  const query = opts.query.trim();
  const now = opts.now ?? Date.now();
  const W = opts.windowMs ?? DAY_MS;
  const aborted = (): boolean => opts.signal?.aborted === true;

  // Archived chats are in: this is a search of history, and archiving is
  // tidying the sidebar, not disowning what was said.
  const times = (await deps.listChats()).map(activity).sort((a, b) => b - a);
  const total = times.length;
  /** Chats with activity at/after `t` — what a finished window has covered. */
  const coveredSince = (t: number): number => {
    let n = 0;
    while (n < times.length && times[n]! >= t) n++;
    return n;
  };

  let k = 0;
  let daysBack = 0;
  let searched = 0;
  // A chat can be listed by two pages when it is touched mid-walk and its
  // activity moves windows; a palette row that appears twice is a bug report.
  const seen = new Set<string>();

  while (!aborted()) {
    const before = k === 0 ? undefined : now - k * W;
    const since = now - (k + 1) * W;
    const newest = times.find((t) => before === undefined || t < before);
    if (newest === undefined) break;
    if (newest < since) {
      // Jump to the window holding `newest`: the k with
      // now − (k+1)·W ≤ newest < now − k·W. The max() is a floor on progress —
      // a jump that failed to move would be a loop.
      k = Math.max(k + 1, Math.ceil((now - newest) / W) - 1);
      continue;
    }

    daysBack = Math.round(((k + 1) * W) / DAY_MS);
    let cursor: string | undefined;
    do {
      const res = await deps.findChats({
        query,
        since,
        ...(before !== undefined ? { before } : {}),
        archived: true,
        hitsPerChat: HITS_PER_CHAT,
        limit: PAGE_LIMIT,
        scanBudgetBytes: PAGE_BUDGET_BYTES,
        ...(cursor ? { cursor } : {}),
      });
      if (aborted()) return;
      const hits: ChatSearchHit[] = [];
      for (const s of res.chats) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        hits.push(toHit(s));
      }
      cursor = res.nextCursor;
      searched = Math.max(searched, coveredSince(since) - (cursor ? res.unscanned : 0));
      yield { type: "hits", hits, daysBack, searched, total };
    } while (cursor && !aborted());
    k++;
  }

  if (!aborted()) yield { type: "done", searched: total, total, daysBack };
}
