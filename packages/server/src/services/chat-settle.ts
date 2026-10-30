/**
 * "This chat's turn is over" — the settle rule, shared by every consumer that
 * announces a finished chat to somebody outside it (webhooks' `chat-settled`,
 * the integration event feed's `chat.settled`).
 *
 * Not the raw `idle` edge: `onTurnEnd` publishes `idle` BEFORE flushing queued
 * sends, so that edge says "done" about a chat that is already a sentence into
 * its next turn. The rule is the completion notice's:
 *
 *   - Fire only for a chat seen WORKING since the last fire. A session that
 *     starts with no work is at rest, and announcing it would report a turn
 *     that never happened.
 *   - Wait `settleMs` after the at-rest edge, then re-read the live status and
 *     the pending-work fact; a queued message mid-flush is a turn about to open.
 *   - Re-check up to {@link NOTICE_QUIESCE_TRIES} times, because a pending flush
 *     can clear without another status edge following it.
 *
 * Extracted from WebhookService when the event feed needed the identical
 * answer; two copies of this rule would drift the first time one was fixed.
 */
import { isChatWorking, type ChatStatus } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { AT_REST, NOTICE_QUIESCE_TRIES, NOTICE_SETTLE_MS } from "./chat-completion-notice.js";

/** The newest assistant row's text, read off the transcript tail — what a settled turn said. */
export async function lastAssistantText(store: Pick<Store, "readMessages">, chatId: string): Promise<string> {
  const rows = await store.readMessages(chatId, { limit: 50 }).catch(() => []);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    // Only the main thread's own prose: a subagent's row is not the answer
    // the human was waiting on.
    if (row.kind === "assistant" && !row.parentToolUseId && row.text.trim()) return row.text;
  }
  return "";
}

export interface ChatSettleWatcherDeps {
  /** Called once per settled turn, with the status it settled at. */
  onSettled(chatId: string, status: ChatStatus): void;
  /** Live broker status, re-read after the settle window. */
  getStatus?(chatId: string): ChatStatus | undefined;
  /** A turn about to open under an at-rest status. */
  hasPendingWork?(chatId: string): boolean;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  settleMs?: number;
}

interface Watch {
  /** Seen mid-turn since the last fire — the gate against a fresh session's idle. */
  working: boolean;
  settle?: unknown;
  tries: number;
  status: ChatStatus;
}

export class ChatSettleWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly settleMs: number;

  constructor(private readonly deps: ChatSettleWatcherDeps) {
    this.settleMs = deps.settleMs ?? NOTICE_SETTLE_MS;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Feed a `chat-status` edge. */
  onStatus(chatId: string, status: ChatStatus): void {
    const w = this.watches.get(chatId) ?? { working: false, tries: 0, status };
    this.watches.set(chatId, w);
    w.status = status;
    if (isChatWorking(status)) {
      w.working = true;
      // Picked work back up inside the window — the queued message, most
      // likely. The settle is cancelled outright; the NEXT at-rest edge opens a
      // fresh one.
      if (w.settle !== undefined) {
        this.clearTimer(w.settle);
        w.settle = undefined;
      }
      return;
    }
    if (!w.working || !AT_REST.has(status)) return;
    if (w.settle !== undefined) return;
    w.tries = 0;
    w.settle = this.setTimer(() => this.confirm(chatId), this.settleMs);
  }

  /** Forget a chat (deleted, or nobody is listening any more). */
  drop(chatId: string): void {
    const w = this.watches.get(chatId);
    if (!w) return;
    if (w.settle !== undefined) this.clearTimer(w.settle);
    this.watches.delete(chatId);
  }

  dispose(): void {
    for (const w of this.watches.values()) {
      if (w.settle !== undefined) this.clearTimer(w.settle);
    }
    this.watches.clear();
  }

  private confirm(chatId: string): void {
    const w = this.watches.get(chatId);
    if (!w) return;
    w.settle = undefined;
    const live = this.deps.getStatus?.(chatId);
    if ((live !== undefined && !AT_REST.has(live)) || this.deps.hasPendingWork?.(chatId)) {
      if (w.tries >= NOTICE_QUIESCE_TRIES) return;
      w.tries += 1;
      w.settle = this.setTimer(() => this.confirm(chatId), this.settleMs);
      return;
    }
    // One fire per settled turn: the gate re-arms on the next working status.
    w.working = false;
    this.deps.onSettled(chatId, live ?? w.status);
  }
}
