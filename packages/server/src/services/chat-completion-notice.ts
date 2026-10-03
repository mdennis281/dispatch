/**
 * "THE CHAT YOU SPAWNED IS DONE" — a one-shot notice back to the caller.
 *
 * `spawn_chat` returns the instant the new chat is started, which leaves the
 * caller with two bad options: block on `wait_for_chat` (and spend its own turn
 * doing nothing) or forget the child exists. Both were observed: a parent that
 * waited burned a turn's worth of wall-clock on a child that took twenty
 * minutes, and a parent that didn't never looked again, so work it had
 * explicitly delegated finished with nobody reading it.
 *
 * So the caller gets told. The notice rides {@link ChatMessenger}, i.e. the
 * ordinary peer-message path — same `user` row stamped `origin: "peer"`, same
 * rate limits, same waking of a dormant target — because "a chat sent you
 * something" is exactly what this is, and a second transport would be a second
 * thing to keep honest.
 *
 * WHY A SERVICE RATHER THAN A FEW LINES IN `broker.spawnChat`: the firing rule
 * is the whole subtlety (see {@link ChatCompletionNotices.arm}), and it is
 * untestable inside the container's wiring.
 *
 * DURABILITY LIMIT, stated rather than discovered, and the same one
 * `ChatMessenger.held` documents: an armed notice lives only in this process's
 * map and is LOST if the server restarts before it fires. A restart kills the
 * child's live session too, so the turn being watched for does not survive
 * either — but the honest consequence is that a spawn interrupted by a restart
 * notifies nobody, and a parent that was told to end its turn is left waiting
 * for a message that is not coming. Making that survive needs the intent
 * persisted AND re-armed by restart recovery, which in turn has to reconstruct
 * whether the child's turn had already ended; that is its own change, not a
 * flag on this one.
 */
import type { ChatStatus } from "@dispatch/shared";
import { isChatWorking } from "@dispatch/shared";
import type { EventBus } from "../bus.js";

/**
 * Statuses that mean the child's turn is over and nothing is running in it.
 *
 * DELIBERATELY WIDER than `wait_for_chat`'s terminal set, which omits `failed`:
 * a wait resumes the waiter either way, so the distinction costs it nothing,
 * whereas a parent told nothing about a child whose turn failed has been handed
 * the exact silence this service exists to remove. A turn that died on a usage
 * limit is the notice worth the most, not the one to suppress.
 */
const AT_REST: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "idle",
  "done",
  "failed",
  "error",
]);

/** How long an armed notice waits for a child that never comes to rest. */
export const NOTICE_TTL_MS = 24 * 60 * 60_000;

/**
 * How long to wait after an at-rest status before believing it — then re-read
 * the live status and only fire if the chat really did stay put.
 *
 * NOT paranoia; `at rest` is genuinely published mid-flight. `onTurnEnd`
 * publishes `idle` and THEN calls `flushPendingSends`, which starts the next
 * turn from whatever was queued during the last one, and `ChatMessenger` flushes
 * its held peer messages off that same event. Firing on the raw edge tells the
 * parent "nothing is running in it now" about a child that is already a
 * sentence into its next turn.
 *
 * Generous rather than tight, because nothing here is latency-sensitive: a
 * completion notice that arrives a second late costs nobody anything, and the
 * flush it is waiting out goes through `sendMessage`, which is several awaits
 * deep. A working status arriving inside the window cancels the fire outright,
 * so the timer is the backstop for a flip this never saw an event for.
 */
export const NOTICE_SETTLE_MS = 1_500;

/**
 * How many settle windows in a row the notice will wait out while the chat
 * still has work pending, before it stops re-checking and goes back to waiting
 * for a status edge.
 *
 * A bound is needed because the re-check is the ONLY thing watching some of
 * these transitions. Both queue flushers swallow a delivery error and just
 * clear their pending flag — no status event follows — so a send that was
 * still preparing at the first check and then failed would leave the notice
 * armed until its 24h TTL with nothing ever looking again. Re-checking turns
 * that into a notice one window late.
 *
 * ~60s of polling at 1.5s. Long enough to outlast any plausible preparation,
 * short enough that a genuinely stuck chat is not polled for a day; past it the
 * notice stays armed and the next `running` → at-rest edge opens a fresh budget.
 */
export const NOTICE_QUIESCE_TRIES = 40;

/** One child chat being watched on its parent's behalf. */
export interface ChatCompletionNotice {
  /** The spawned chat whose completion is being waited for. */
  chatId: string;
  /** The chat that called `spawn_chat` and gets the message. */
  parentChatId: string;
  /**
   * Fallback title for the notice text, used only when {@link
   * ChatCompletionNoticeOpts.getTitle} has nothing. The live title is preferred
   * because at arm time the child is usually still called whatever `createChat`
   * named it — the auto-titler renames it a turn later, which is before this
   * notice is ever written.
   */
  title?: string;
}

export interface ChatCompletionNoticeOpts {
  bus: EventBus;
  /**
   * Deliver the notice. Wired to `ChatMessenger.send`; narrowed to what this
   * needs so the test doesn't have to build a messenger.
   */
  send(input: { from: string; to: string; message: string }): Promise<unknown>;
  /** The child's CURRENT title, read when the notice fires. Optional. */
  getTitle?(chatId: string): Promise<string | undefined>;
  /**
   * The child's live broker status, re-read after {@link NOTICE_SETTLE_MS} to
   * confirm it really is at rest. Absent — for a caller that cannot supply one
   * — means the settle window is still waited out but the raw edge is trusted.
   */
  getStatus?(chatId: string): ChatStatus | undefined;
  /**
   * Whether the chat has work that will open a turn even though its status does
   * not say so yet — a queued message mid-flush, a parked peer message.
   *
   * The reason the settle window is not the whole answer: it is elapsed time,
   * and preparing a turn (posture refresh, rules lookup, the user row) can take
   * longer than any window worth waiting. This makes the decision on a FACT
   * instead. Wired to `broker.hasPendingWork` + `ChatMessenger.hasPending`.
   */
  hasPendingWork?(chatId: string): boolean;
  deps?: {
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
    ttlMs?: number;
    settleMs?: number;
  };
}

interface Armed extends ChatCompletionNotice {
  /**
   * Whether this child has been seen mid-turn yet — the gate described in
   * {@link ChatCompletionNotices.arm}.
   */
  working: boolean;
  timer: unknown;
  /** The settle timer, while an at-rest edge is being confirmed. */
  settle?: unknown;
  /** Re-checks spent on the current at-rest edge (see NOTICE_QUIESCE_TRIES). */
  tries: number;
}

export class ChatCompletionNotices {
  private readonly bus: EventBus;
  private readonly sendFn: ChatCompletionNoticeOpts["send"];
  private readonly getTitle?: ChatCompletionNoticeOpts["getTitle"];
  private readonly getStatus?: ChatCompletionNoticeOpts["getStatus"];
  private readonly hasPendingWork?: ChatCompletionNoticeOpts["hasPendingWork"];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly ttlMs: number;
  private readonly settleMs: number;

  private readonly armed = new Map<string, Armed>();
  private offStatus?: () => void;
  private disposed = false;

  constructor(opts: ChatCompletionNoticeOpts) {
    this.bus = opts.bus;
    this.sendFn = opts.send;
    this.getTitle = opts.getTitle;
    this.getStatus = opts.getStatus;
    this.hasPendingWork = opts.hasPendingWork;
    this.ttlMs = opts.deps?.ttlMs ?? NOTICE_TTL_MS;
    this.settleMs = opts.deps?.settleMs ?? NOTICE_SETTLE_MS;
    this.setTimer =
      opts.deps?.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending notice must never be the reason the process stays up.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      opts.deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Watch `chatId` and message `parentChatId` once it comes to rest.
   *
   * CALL THIS BEFORE THE CHILD'S BRIEF IS SENT. The subscription has to exist
   * before the turn it is watching for, or a short turn finishes into a bus
   * nobody is listening to.
   *
   * Which is why the firing rule is not "the child is at rest": arming happens
   * moments after `ensureSession`, and a session that has started but has no
   * work yet IS at rest. Firing on that would announce the child as finished
   * before its brief had even been delivered. So a notice fires on the first
   * at-rest status AFTER the child has been seen mid-turn — `running`,
   * `waiting` or `queued`, per `isChatWorking`.
   *
   * The deliberate consequence: a child whose brief never starts a turn at all
   * never notifies. That is the right failure. A notice announcing a chat as
   * complete when it never ran is worse than no notice, because the parent acts
   * on it — it goes and reads an empty transcript and concludes the work was
   * done and produced nothing.
   *
   * One-shot. Re-arming the same child replaces the pending notice rather than
   * stacking a second one, so a parent cannot be told twice about one spawn.
   */
  arm(notice: ChatCompletionNotice): void {
    if (this.disposed) return;
    if (notice.chatId === notice.parentChatId) return;
    this.disarm(notice.chatId);
    this.armed.set(notice.chatId, {
      ...notice,
      working: false,
      tries: 0,
      timer: this.setTimer(() => this.disarm(notice.chatId), this.ttlMs),
    });
    this.watch();
  }

  /** Forget any notice pending for `chatId` without sending it. */
  disarm(chatId: string): void {
    const entry = this.armed.get(chatId);
    if (!entry) return;
    this.armed.delete(chatId);
    this.clearTimer(entry.timer);
    if (entry.settle !== undefined) this.clearTimer(entry.settle);
    if (this.armed.size === 0) this.unwatch();
  }

  /** Whether a notice is still pending for `chatId` (for tests and callers). */
  pending(chatId: string): boolean {
    return this.armed.has(chatId);
  }

  dispose(): void {
    this.disposed = true;
    for (const chatId of [...this.armed.keys()]) this.disarm(chatId);
    this.unwatch();
  }

  /**
   * Subscribe lazily, and only while something is armed.
   *
   * The same reasoning as `ChatMessenger.watchStatus`: most chats spawn nothing,
   * and a permanent subscriber on a bus every chat publishes to is a cost paid
   * by everyone for a feature most turns don't use.
   */
  private watch(): void {
    if (this.offStatus || this.disposed) return;
    this.offStatus = this.bus.on("chat-status", (e) => {
      const entry = this.armed.get(e.chatId);
      if (!entry) return;
      if (isChatWorking(e.status)) {
        entry.working = true;
        // The child picked work back up inside the settle window — the queued
        // message it had waiting, most likely. The notice stays armed for
        // whenever THAT turn ends.
        if (entry.settle !== undefined) {
          this.clearTimer(entry.settle);
          entry.settle = undefined;
        }
        return;
      }
      if (!entry.working || !AT_REST.has(e.status)) return;
      // Already confirming this chat: the pending re-check is authoritative, so
      // a second at-rest edge needs no second timer.
      if (entry.settle !== undefined) return;
      // A fresh edge, so a fresh re-check budget: the last one was spent on a
      // turn that has since been and gone.
      entry.tries = 0;
      entry.settle = this.setTimer(() => this.confirm(e.chatId, e.status), this.settleMs);
    });
  }

  private unwatch(): void {
    this.offStatus?.();
    this.offStatus = undefined;
  }

  /**
   * The settle window elapsed. Fire only if the chat is STILL at rest and has
   * nothing queued that is about to open another turn.
   *
   * `getStatus` returning undefined counts as at rest: no live session is the
   * most finished a chat gets.
   *
   * Either check failing leaves the notice ARMED and re-checks, up to
   * {@link NOTICE_QUIESCE_TRIES} windows. Re-checking rather than simply waiting
   * for the next status edge because a pending flush can CLEAR without one —
   * both flushers swallow a delivery error and just drop their pending flag —
   * and nothing else would ever look again.
   *
   * The cost of being wrong this way is a notice that arrives a window or two
   * late. The cost of the other way is telling the parent its delegated work is
   * finished while the child is mid-sentence.
   */
  private confirm(chatId: string, status: ChatStatus): void {
    const entry = this.armed.get(chatId);
    if (!entry) return;
    entry.settle = undefined;
    const live = this.getStatus?.(chatId);
    if ((live !== undefined && !AT_REST.has(live)) || this.hasPendingWork?.(chatId)) {
      // Past the budget, stop polling and fall back to the status edge: a chat
      // this busy will publish one, and a chat that never does was never going
      // to be answered by a 41st look.
      if (entry.tries >= NOTICE_QUIESCE_TRIES) return;
      entry.tries += 1;
      entry.settle = this.setTimer(() => this.confirm(chatId, status), this.settleMs);
      return;
    }
    // Disarmed BEFORE the await: delivering the notice starts a turn in the
    // parent, and nothing stops the bus re-entering the handler for the child
    // in the meantime. Without the handoff the parent gets told twice.
    this.disarm(chatId);
    void this.fire(entry, live ?? status);
  }

  private async fire(entry: Armed, status: ChatStatus): Promise<void> {
    try {
      const title =
        (await this.getTitle?.(entry.chatId).catch(() => undefined)) ?? entry.title;
      await this.sendFn({
        from: entry.chatId,
        to: entry.parentChatId,
        message: completionNotice({ chatId: entry.chatId, title }, status),
      });
    } catch {
      // Best-effort by design. A notice that cannot be delivered — the parent
      // was deleted, the rate limit refused it — must not become an unhandled
      // rejection, and there is nobody left to report it to.
    }
  }
}

/**
 * The notice text.
 *
 * Exported for the test, and because the wording is the feature: it has to say
 * what happened, what to do next, and how to turn it off — a parent told only
 * "chat X is done" either ignores it or guesses at a follow-up.
 */
export function completionNotice(
  notice: Pick<ChatCompletionNotice, "chatId" | "title">,
  status: ChatStatus,
): string {
  const name = notice.title ? `"${notice.title}"` : "the chat";
  const outcome =
    status === "error" || status === "failed"
      ? "stopped on an error and may not have finished the work"
      : "finished its turn and is now idle";
  return (
    `${name} — the chat you spawned — ${outcome}. Nothing is running in it now.\n` +
    `Read what it actually did with chat_read({ chatId: "${notice.chatId}" }) before ` +
    "acting on this; send it more work with chat_send, or carry on with your own.\n" +
    "(You asked for this by spawning it with notifyWhenComplete — pass false to skip it.)"
  );
}
