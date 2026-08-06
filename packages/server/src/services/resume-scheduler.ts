/**
 * AUTO-RESUME AFTER A USAGE LIMIT.
 *
 * When a subscription window runs out, the SDK ends the turn with
 * "You've hit your session limit · resets 4:50pm (America/Chicago)" and the chat
 * simply stops — mid-task, with no retry and nothing to click. This service
 * turns that dead end into a scheduled continuation: it parses the reset time,
 * persists a {@link ResumePlan} on the chat, and re-sends a continuation prompt
 * the moment the window reopens.
 *
 * The plan lives on the chat record, not in memory, so a server restart re-arms
 * it (see {@link ResumeScheduler.restore}) instead of silently stranding the
 * chat. The user can cancel at any point, which keeps the plan around marked
 * `cancelledAt` so the transcript can still say what happened.
 *
 * Sending goes through an injected `send` so this service never has to know how
 * a session is (re)built — that stays with the route layer's `ensureSession`.
 */
import { parseSessionLimit, type Chat, type ResumePlan } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";

/** `setTimeout` silently fires immediately past this; re-arm in hops instead. */
const MAX_TIMER_MS = 2_147_483_000;

/** What we say to pick the work back up. */
export const RESUME_PROMPT =
  "The usage limit has lifted. Continue where you left off — pick up the task " +
  "you were working on when the session was interrupted.";

export interface ResumeSchedulerDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  genId?: () => string;
}

export interface ResumeSchedulerOpts {
  store: Store;
  bus: EventBus;
  /**
   * Deliver the continuation prompt. Must ensure a live session first — the
   * subprocess is long gone by the time a limit lifts.
   */
  send: (chatId: string, text: string) => Promise<void>;
  deps?: ResumeSchedulerDeps;
}

export class ResumeScheduler {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly send: (chatId: string, text: string) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly genId: () => string;
  private readonly timers = new Map<string, unknown>();
  /** In-flight fires, so shutdown (and tests) can wait one out. */
  private readonly inflight = new Set<Promise<void>>();
  private disposed = false;

  constructor(opts: ResumeSchedulerOpts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.send = opts.send;
    this.now = opts.deps?.now ?? (() => Date.now());
    this.setTimer =
      opts.deps?.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending resume must never hold the process open on its own.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      opts.deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.genId = opts.deps?.genId ?? (() => Math.random().toString(36).slice(2, 11));
  }

  /** Is a live (un-cancelled, un-fired) plan armed for this chat? */
  isArmed(chatId: string): boolean {
    return this.timers.has(chatId);
  }

  /**
   * A turn ended with an error — plan a resume if it was a usage limit.
   * Returns the plan, or null when the error was something else entirely.
   */
  async onTurnError(chatId: string, reason: string | undefined): Promise<ResumePlan | null> {
    if (this.disposed) return null;
    const limit = parseSessionLimit(reason, this.now());
    if (!limit || !reason) return null;
    const plan: ResumePlan = { at: limit.resetsAt, reason, prompt: RESUME_PROMPT };
    const chat = await this.patch(chatId, plan);
    if (!chat) return null;
    this.arm(chatId, plan);
    return plan;
  }

  /** Cancel a pending resume. Idempotent; returns the chat when one changed. */
  async cancel(chatId: string): Promise<Chat | null> {
    this.disarm(chatId);
    const chat = await this.store.getChat(chatId);
    const plan = chat?.resume;
    // Nothing to cancel: no plan, or one that already fired / was cancelled.
    if (!chat || !plan || plan.cancelledAt || plan.firedAt) return null;
    return this.patch(chatId, { ...plan, cancelledAt: this.now() });
  }

  /** Re-arm every persisted plan at boot (a restart must not strand a chat). */
  async restore(): Promise<void> {
    const chats = await this.store.listChats().catch(() => [] as Chat[]);
    for (const chat of chats) {
      const plan = chat.resume;
      if (!plan || plan.cancelledAt || plan.firedAt) continue;
      this.arm(chat.id, plan);
    }
  }

  /**
   * Wait for any resume already in flight. A fire spans several awaits (store
   * read, patch, send), so both shutdown and tests need a way to let one land
   * rather than yanking the store out from under it.
   */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  /* --------------------------------------------------------------- internals */

  private async patch(chatId: string, resume: ResumePlan): Promise<Chat | null> {
    const chat = await this.store.getChat(chatId);
    if (!chat) return null;
    const saved = await this.store.saveChat({ ...chat, resume, updatedAt: this.now() });
    this.bus.publish({ type: "chat-update", chat: saved });
    return saved;
  }

  private arm(chatId: string, plan: ResumePlan): void {
    this.disarm(chatId);
    if (this.disposed) return;
    // A reset that is already in the past fires on the next tick rather than
    // never — that's the "server was down when the window reopened" case.
    const delay = Math.max(0, plan.at - this.now());
    const handle = this.setTimer(() => {
      const p = this.fire(chatId).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }, Math.min(delay, MAX_TIMER_MS));
    this.timers.set(chatId, handle);
  }

  private disarm(chatId: string): void {
    const handle = this.timers.get(chatId);
    if (handle !== undefined) this.clearTimer(handle);
    this.timers.delete(chatId);
  }

  private async fire(chatId: string): Promise<void> {
    this.timers.delete(chatId);
    if (this.disposed) return;
    // Re-read rather than trust the closure: the user may have cancelled, or
    // sent their own message, while the timer was pending.
    const chat = await this.store.getChat(chatId).catch(() => null);
    const plan = chat?.resume;
    if (!chat || !plan || plan.cancelledAt || plan.firedAt) return;
    // A clamped long sleep wakes early on purpose — go back to sleep.
    if (this.now() < plan.at) {
      this.arm(chatId, plan);
      return;
    }
    await this.patch(chatId, { ...plan, firedAt: this.now() });
    await this.notice(chatId, "Usage limit lifted — continuing automatically.");
    try {
      await this.send(chatId, plan.prompt);
    } catch (err) {
      await this.notice(
        chatId,
        `Could not continue automatically: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  /** Drop a transcript marker so the resumed turn has a visible cause. */
  private async notice(
    chatId: string,
    text: string,
    level: "info" | "error" = "info",
  ): Promise<void> {
    try {
      const row = await this.store.appendMessage({
        kind: "notice",
        id: this.genId(),
        chatId,
        ts: this.now(),
        level,
        text,
      });
      this.bus.publish({ type: "chat-message", chatId, message: row });
    } catch {
      /* a missing transcript must not break the resume itself */
    }
  }
}
