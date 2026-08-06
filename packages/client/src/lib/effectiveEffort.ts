/**
 * The effort the chat's MAIN loop is actually running at.
 *
 * `chat.effort` is what the user picked; it isn't always what runs. An agent
 * definition can pin its own level, and a model that doesn't support the picked
 * one is silently downgraded. The broker stamps the real level on every row it
 * emits (observed from a hook once the thread has run a tool), so the newest
 * main-loop row is the answer — subagent rows are skipped, since a run may
 * legitimately differ from its parent.
 *
 * Returns a primitive, so the selector is re-render-safe by identity.
 */
import type { Effort } from "@dispatch/shared";
import { useMessages } from "../stores/messages.js";

/** Rows scanned back from the tail before giving up (keeps this O(1)-ish). */
const SCAN_LIMIT = 250;

export function useEffectiveEffort(chatId: string | null): Effort | undefined {
  return useMessages((s) => {
    const rows = chatId ? s.byChat[chatId] : undefined;
    if (!rows?.length) return undefined;
    const stop = Math.max(0, rows.length - SCAN_LIMIT);
    for (let i = rows.length - 1; i >= stop; i--) {
      const row = rows[i]!;
      if (row.kind !== "assistant" && row.kind !== "tool_use") continue;
      // A subagent's level says nothing about the main loop's.
      if (row.parentToolUseId) continue;
      if (row.effort) return row.effort;
    }
    return undefined;
  });
}
