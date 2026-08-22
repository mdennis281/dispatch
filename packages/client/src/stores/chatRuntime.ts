/**
 * How long the agents under each chat have actually run.
 *
 * A STANDING store like `stores/prs`, not an on-demand one like the two metrics
 * stores next to it — those load when the Metrics view mounts and are thrown
 * away when it unmounts, because a chart nobody is looking at costs nothing to
 * not have. This answer sits on every sidebar row, so it has to already be here
 * when the sidebar first paints and it has to keep moving while a chat works.
 *
 * POLLED, not pushed. There is no `metric_span` traffic on the event bus, and
 * adding some would mean a message per tool call — thousands an hour to move a
 * number that is only ever read rounded to the minute. One indexed GROUP BY on
 * a slow interval is the cheaper side of that trade by a wide margin.
 */
import { create } from "zustand";
import { api } from "../lib/api.js";

interface ChatRuntimeStore {
  /** chatId → summed milliseconds. A chat with no recorded spans is ABSENT. */
  byChat: Record<string, number>;
  /** When the server measured it; 0 = never loaded. */
  at: number;
  refresh: () => Promise<void>;
}

export const useChatRuntime = create<ChatRuntimeStore>((set) => ({
  byChat: {},
  at: 0,
  refresh: async () => {
    // A failed read leaves the LAST reading in place rather than blanking every
    // row: a stale duration is off by the length of one poll, and an empty one
    // reads as "this chat never ran".
    const res = await api.metrics.chatRuntime().catch(() => null);
    if (res) set({ byChat: res.byChat, at: res.at });
  },
}));

/**
 * The figure for a chat and everything filed under it.
 *
 * Subagents need no help here — their spans carry their parent's `chatId`, so
 * the server's per-chat sum already includes them. Reviewer chats are separate
 * chats with their own ids, so their time is added on: a review is agent time
 * this change cost, and a row that hid it would under-report by however long
 * Dispatch spent reading the diff.
 */
export function branchRuntimeMs(
  byChat: Record<string, number>,
  chatId: string,
  under: readonly { id: string }[],
): number {
  let ms = byChat[chatId] ?? 0;
  for (const c of under) ms += byChat[c.id] ?? 0;
  return ms;
}
