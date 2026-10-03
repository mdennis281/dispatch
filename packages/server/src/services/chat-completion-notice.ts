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
  deps?: {
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
    ttlMs?: number;
  };
}

interface Armed extends ChatCompletionNotice {
  /**
   * Whether this child has been seen mid-turn yet — the gate described in
   * {@link ChatCompletionNotices.arm}.
   */
  working: boolean;
  timer: unknown;
}

export class ChatCompletionNotices {
  private readonly bus: EventBus;
  private readonly sendFn: ChatCompletionNoticeOpts["send"];
  private readonly getTitle?: ChatCompletionNoticeOpts["getTitle"];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly ttlMs: number;

  private readonly armed = new Map<string, Armed>();
  private offStatus?: () => void;
  private disposed = false;

  constructor(opts: ChatCompletionNoticeOpts) {
    this.bus = opts.bus;
    this.sendFn = opts.send;
    this.getTitle = opts.getTitle;
    this.ttlMs = opts.deps?.ttlMs ?? NOTICE_TTL_MS;
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
        return;
      }
      if (!entry.working || !AT_REST.has(e.status)) return;
      // Disarmed BEFORE the await: delivering the notice starts a turn in the
      // parent, and nothing stops the bus re-entering this handler for the
      // child in the meantime. Without the handoff the parent gets told twice.
      this.disarm(e.chatId);
      void this.fire(entry, e.status);
    });
  }

  private unwatch(): void {
    this.offStatus?.();
    this.offStatus = undefined;
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
