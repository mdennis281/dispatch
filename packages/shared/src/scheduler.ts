/**
 * The app-wide scheduler as the client sees it: what is running, what is
 * waiting for a slot, and whether a global pause is holding everything.
 *
 * A pause is NOT a freeze. Neither runtime can suspend a turn mid-thought —
 * Claude's SDK offers `interrupt()`, Codex `turn/interrupt`, both of which end
 * the turn. So a pause interrupts every live turn and then holds the queue
 * closed, and resume re-opens it with a note to each chat it cut off.
 */
import * as z from "zod";
import { ChatStatusSchema } from "./common.js";

export const PauseStateSchema = z.object({
  /** When the pause began (epoch ms). */
  since: z.number(),
  /**
   * Chats whose turn the pause cut off. These, and only these, get the
   * "you were paused" note on resume — a chat that was already queued never
   * started, so it has nothing to be told.
   */
  interrupted: z.array(z.string()),
  /** Set once "kill processes" ran during this pause. */
  killedAt: z.number().optional(),
  /** Chats whose processes were killed — their shells are gone for certain. */
  killed: z.array(z.string()).optional(),
});
export type PauseState = z.infer<typeof PauseStateSchema>;

export const SchedulerSnapshotSchema = z.object({
  paused: PauseStateSchema.nullable(),
  /** The `maxActiveSessions` cap in force. */
  cap: z.number(),
  /**
   * Chats with an open turn. `occupied` is whether it currently holds one of
   * the cap's slots — a chat blocked in `watch_pr` or on a question has a turn
   * open but frees its slot, and the panel shows that difference.
   */
  running: z.array(
    z.object({
      chatId: z.string(),
      status: ChatStatusSchema,
      occupied: z.boolean(),
    }),
  ),
  /** Chats waiting for a slot (or for the pause to lift), in admission order. */
  queued: z.array(z.object({ chatId: z.string() })),
});
export type SchedulerSnapshot = z.infer<typeof SchedulerSnapshotSchema>;

/** Pushed whenever running/queued membership or the pause state changes. */
export const SchedulerEventSchema = z.object({
  type: z.literal("scheduler"),
  snapshot: SchedulerSnapshotSchema,
});

/**
 * The note an interrupted chat receives on resume. Shared so the server sends
 * and the tests assert the same sentence.
 */
export function pauseResumeNote(state: PauseState, chatId: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - state.since) / 60_000));
  const killed = state.killed?.includes(chatId) ?? false;
  return [
    `Dispatch paused all agent work for about ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
      "and your previous turn was interrupted mid-flight by that pause — not by an error, and not by anything you did.",
    "Pick up where you left off. A tool call that was running when the pause hit may or may not have completed, " +
      "so check its effect (files, git state, PRs) before repeating it.",
    killed
      ? "Your processes were killed during the pause: every shell, background command and dev server you had " +
        "running is gone and must be restarted before you rely on it."
      : "Any shell or background command that was running in your turn was stopped with it — restart " +
        "existing shells and long-running processes before you rely on them.",
  ].join("\n\n");
}
