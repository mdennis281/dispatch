/**
 * How many OS processes each chat is actually holding.
 *
 * The companion to `chatRuntime`, and a STANDING store for the same reason: the
 * number sits on every sidebar row, so it has to be here when the sidebar first
 * paints. Polled rather than pushed — there is no process-table traffic on the
 * event bus, and the server's own scan is cached behind a TTL, so a poll costs
 * one cheap read whatever the client does.
 *
 * WHAT THE NUMBER IS FOR. Nothing evicts an idle chat's session: it keeps its
 * runtime subprocess and every MCP server under it resident, on purpose, so a
 * chat parked waiting for someone to test something is still there when they
 * come back. The cost of that is invisible until it is displayed — fifteen
 * resident sessions against four in use looks like nothing until the rows say
 * "9" each.
 *
 * TWO NUMBERS, because two things with different lifetimes were being added
 * together. The SESSION tree is swept automatically once a chat has been idle
 * past the configured window (`AppSettings.idleSessionMinutes`) — safe, because
 * `stop()` re-arms resume, so the next message brings the context back and all a
 * purge costs is that message's spin-up. The SHELLS are not swept by anything:
 * a chat parked for you to test against a dev server it started has to still
 * have the dev server. Showing one total would make the half that is about to be
 * reclaimed indistinguishable from the half that never will be.
 */
import { create } from "zustand";
import { api } from "../lib/api.js";

/** What one chat is holding, split by who reaps it. Mirrors the server tally. */
export interface ChatProcessTally {
  /** Its runtime subprocess and every MCP server under it. Swept when idle. */
  session: number;
  /** Its background shells. Never swept automatically — they are yours. */
  shells: number;
}

const NONE: ChatProcessTally = { session: 0, shells: 0 };

interface ChatProcessStore {
  /** chatId → live counts. A chat holding nothing is ABSENT. */
  byChat: Record<string, ChatProcessTally>;
  /** When the server measured it; 0 = never loaded. */
  at: number;
  refresh: () => Promise<void>;
  /** Reap a branch's processes, then re-read so the row settles on the truth. */
  kill: (chatIds: string[]) => Promise<number>;
}

export const useChatProcesses = create<ChatProcessStore>((set, get) => ({
  byChat: {},
  at: 0,
  refresh: async () => {
    // A failed read keeps the LAST reading rather than blanking every row — the
    // same trade as `chatRuntime`. A stale count is off by one poll; an empty
    // one claims every chat is holding nothing, which is the reading that would
    // make somebody stop looking.
    const res = await api.chats.processes().catch(() => null);
    if (res) set({ byChat: res.byChat, at: res.at });
  },
  kill: async (chatIds) => {
    const res = await api.chats.killProcesses(chatIds).catch(() => null);
    // Re-read rather than subtracting locally: `stop()` tears down a tree whose
    // exact size we only learn by looking again, and a chat that failed to stop
    // must go back to showing its real number rather than an optimistic zero.
    await get().refresh();
    return res?.freed ?? 0;
  },
}));

/**
 * The counts for a chat and everything folded under it.
 *
 * Reviewer chats are separate chats with their own sessions, so their processes
 * are their own — and a collapsed row that hid them would under-report exactly
 * when it matters most, since a branch with four reviewer chats behind it is
 * carrying five trees, not one. Mirrors `branchRuntimeMs`.
 *
 * SPLIT, not summed, because the two halves have different lifetimes: the
 * session tree is swept once the chat has been idle a while, and the shells are
 * yours until you say otherwise. One number would make a dev server you are
 * still testing against look like something about to be reclaimed.
 */
export function branchProcessCount(
  byChat: Record<string, ChatProcessTally>,
  chatId: string,
  under: readonly { id: string }[],
): ChatProcessTally {
  const ids = [chatId, ...under.map((c) => c.id)];
  let session = 0;
  let shells = 0;
  for (const id of ids) {
    const tally = byChat[id] ?? NONE;
    session += tally.session;
    shells += tally.shells;
  }
  return { session, shells };
}

/** Every chat id a branch's count covers — what the kill button must reap. */
export function branchChatIds(chatId: string, under: readonly { id: string }[]): string[] {
  return [chatId, ...under.map((c) => c.id)];
}
