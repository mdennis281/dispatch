/**
 * When the composer should stand down because a question is waiting.
 *
 * An AskUserQuestion card is the one surface in a transcript where the thing to
 * do is NOT "type into the box at the bottom" — the answer lives in the card.
 * On a phone that distinction is expensive: tapping the card's notes field
 * raises the keyboard, the shell shrinks to fit above it (`--cm-kb`), and the
 * full composer then rides up and parks between what you are reading and the
 * keyboard, eating ~120px of a window that has maybe 300 left.
 *
 * So while a question is open the composer collapses to a slim, dimmed stub and
 * stops following the keyboard (see `Composer`). It is a nudge, not a lock:
 * double-tapping the stub hands the real composer straight back, and a draft
 * already in progress is never collapsed out from under the person writing it.
 *
 * Pure on purpose — the component owns the DOM and the latch, this owns the
 * policy, and the policy is what has edge cases worth a test.
 */
import type { AttentionItem } from "@dispatch/shared";

/**
 * The open question blocking this chat, or null.
 *
 * Reads the RAW queue rather than `visible`: muting the question kind is a
 * decision about what the Attention Queue lists, and it would be a surprise for
 * it to also change how the composer behaves in a chat you are looking at.
 *
 * **A `permissionRequestId` is required, not incidental.** `kind: "question"`
 * is not by itself an ask with a card: `services/restart-resume.ts` raises one
 * for a chat a restart interrupted, and that item has no request behind it and
 * no card in the transcript — its own notice says "Send a message to pick it
 * back up." Standing the composer down there would collapse the box in the one
 * flow whose whole instruction is to type in it. The id IS the card (see
 * `attentionCardId`), so requiring it is the same test as "there is something
 * above to point at".
 *
 * Oldest first, matching the order the cards appear in the transcript — if two
 * asks are somehow open, the stub should point at the one you reach first.
 */
export function blockingQuestion(
  items: readonly AttentionItem[],
  chatId: string | null | undefined,
): AttentionItem | null {
  if (!chatId) return null;
  let best: AttentionItem | null = null;
  for (const item of items) {
    if (item.kind !== "question" || item.chatId !== chatId) continue;
    if (!item.permissionRequestId) continue;
    if (!best || item.createdAt < best.createdAt) best = item;
  }
  return best;
}

/**
 * Whether the composer stands down right now.
 *
 * `reclaimedId` is the question the human has already taken the composer back
 * for. Latching the ID rather than a boolean is what makes the next question
 * re-collapse the composer: "I want to type about THIS one" is an answer about
 * one ask, not a permanent opt-out — and a plain boolean would have had to be
 * cleared by something, which is exactly the reset nobody remembers to write.
 */
export function composerDeferred(
  question: AttentionItem | null,
  reclaimedId: string | null,
  /** A half-written message or a staged attachment. Never collapsed away. */
  hasDraft: boolean,
): boolean {
  if (!question || hasDraft) return false;
  return question.id !== reclaimedId;
}

/** How long after a tap a second one still counts as the same gesture. */
export const DOUBLE_TAP_MS = 400;

/**
 * Whether this tap completes a double-tap.
 *
 * The stub detects the gesture itself instead of leaning on `dblclick`: that
 * event is reliable with a mouse and merely likely under a touch engine, and
 * this is the ONLY way back to the composer — "likely" is not good enough for
 * the escape hatch.
 */
export function isDoubleTap(now: number, lastTapAt: number, windowMs = DOUBLE_TAP_MS): boolean {
  return lastTapAt > 0 && now - lastTapAt <= windowMs;
}
