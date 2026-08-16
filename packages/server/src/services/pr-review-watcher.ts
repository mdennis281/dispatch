/**
 * PrReviewWatcher — server-side "a PR this chat owns needs you" surface.
 *
 * WHY this exists, precisely. `mcp__manager__watch_pr` is a PULL api: it only
 * works while an agent keeps calling it in a loop. On the run that motivated
 * this file, the agent called it ONCE, got back "no CI checks configured",
 * concluded there was nothing to wait for, and stopped. Two subsequent rounds of
 * review comments landed into silence — and the human found them by opening
 * GitHub, despite the Attention Queue existing and being this app's entire
 * answer to "which chat needs you".
 *
 * So the noticing has to happen where nothing has to remember to ask. This
 * service polls the PRs recorded on chats (`Chat.prs` — the ownership record
 * `create_pr` writes) and raises a `review` attention item when something
 * actually new lands: a submitted review, a new unresolved review thread, or a
 * failing check.
 *
 * Two policies are deliberate, not incidental:
 *
 *   - **Dedup, hard.** Each signal fires exactly once, mirroring `watch_pr`'s
 *     "each result reported only once" semantics. A badge that re-fires forever
 *     is worse than no badge: it trains the human to ignore the badge.
 *   - **Auto-resume ONLY the owning chat.** When review activity lands on a PR,
 *     we wake the chat whose own `prs` carries that PR — the chat that opened it
 *     and is the only one that can meaningfully respond. This was chosen over
 *     blanket auto-resume: `Chat.prs` is what makes "whose PR is this" a fact
 *     rather than a guess, and waking unrelated chats to tell them about someone
 *     else's review round is how an autonomy feature becomes a nuisance. Every
 *     other chat gets exactly what a human gets: the badge on the queue.
 *
 * Everything here is best-effort. A `gh` hiccup degrades to "no new activity
 * this pass" (never a false badge, never an abort), and a resume failure leaves
 * the badge standing so the human can still act on it.
 */
import type { AttentionItem, Chat, PRRef } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";

/** How often the watcher sweeps every chat's open PRs. */
export const PR_REVIEW_POLL_MS = 90_000;

/**
 * Check conclusions that count as FAILING — the ones that are actionable work.
 * Same set `watch_pr` uses; `neutral`/`skipped`/`success` are not news.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "stale",
]);

/** The narrow GitHub surface this watcher needs (kept decoupled for tests). */
export interface PrReviewGitHub {
  /** Open/closed/merged state; null = unreadable this pass. */
  prMergeState(
    prNumber: number,
    opts: { repo?: string },
  ): Promise<{ state: "open" | "closed" | "merged" } | null>;
  /** CI checks; throwing/rejecting is treated as "couldn't read". */
  prChecks(repo: string, prNumber: number): Promise<Array<{
    name: string;
    status: string;
    conclusion?: string | null;
  }>>;
  /** Review threads; same failure handling. */
  reviewThreads(repo: string, prNumber: number): Promise<Array<{
    id: string;
    isResolved: boolean;
    isOutdated?: boolean;
    path?: string;
    author?: string;
  }>>;
  /**
   * Who was asked and who reported (submitted reviews are the signal here).
   * null = unreadable this pass, same contract as the other reads.
   */
  prReviewState(repo: string, prNumber: number): Promise<{
    requested: string[];
    reported: Array<{ author: string; state: string }>;
  } | null>;
}

/** Per-(chat, PR) dedup memory — what we have ALREADY told this chat about. */
interface SeenState {
  /** Review thread ids already surfaced. */
  threads: Set<string>;
  /** check name → the conclusion/status last reported (a pass→fail flip re-fires). */
  checks: Map<string, string>;
  /** `${author}:${state}` of every submitted review already surfaced. */
  reviews: Set<string>;
}

/** One round of new activity on one PR. */
export interface PrReviewActivity {
  chatId: string;
  ref: PRRef;
  /** Human sentences, one per new signal. */
  reasons: string[];
}

export interface PrReviewWatcherOptions {
  store: Store;
  bus: EventBus;
  github: PrReviewGitHub;
  /**
   * Wake a chat with a prompt. Must ensure a live session first — by the time a
   * review round lands the subprocess is usually long gone (same contract as
   * ResumeScheduler's `send`).
   */
  resume?: (chatId: string, text: string) => Promise<void>;
  /**
   * Is this chat currently busy? A chat mid-turn is already working (very
   * possibly inside `watch_pr`); nudging it would just queue a message behind
   * whatever it's doing. It still gets the badge.
   */
  isBusy?: (chatId: string) => boolean;
  intervalMs?: number;
  now?: () => number;
  genId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class PrReviewWatcher {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly github: PrReviewGitHub;
  private readonly resumeFn?: (chatId: string, text: string) => Promise<void>;
  private readonly isBusy: (chatId: string) => boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** `${chatId}|${repo}#${number}` → what that chat has already been told. */
  private readonly seen = new Map<string, SeenState>();
  private timer: unknown;
  private running = false;
  private disposed = false;
  private inflight?: Promise<void>;

  constructor(opts: PrReviewWatcherOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.github = opts.github;
    this.resumeFn = opts.resume;
    this.isBusy = opts.isBusy ?? (() => false);
    this.intervalMs = opts.intervalMs ?? PR_REVIEW_POLL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        // A background sweep must never hold the process open on its own.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /** Begin sweeping. Idempotent. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.timer = this.setTimer(() => void this.sweep().catch(() => {}), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Let an in-flight sweep land (shutdown + tests). */
  async drain(): Promise<void> {
    await this.inflight?.catch(() => {});
  }

  /**
   * Pre-seed a PR's dedup state so the very first sweep after `create_pr`
   * doesn't badge the chat for review activity that predates it. Called by the
   * create path — "arming the watcher" is mostly this plus the fact that the
   * `PRRef` now exists for the sweep to find.
   *
   * This used to just call `stateFor`, which creates an EMPTY state — so it was
   * a no-op and the first sweep still reported every pre-existing check, thread
   * and review as new (review caught this). It now reads the current snapshot
   * and records the same fingerprints `checkOne` would, so only what happens
   * AFTER arming counts as activity.
   *
   * Best-effort and non-fatal: if the reads fail, the state stays empty and the
   * worst case is the old behaviour — one noisy first sweep, never a crash in
   * the create path. Returns a promise so tests can await it; the caller
   * deliberately does not.
   */
  async arm(chatId: string, ref: PRRef): Promise<void> {
    const st = this.stateFor(chatId, ref);
    const repo = ref.repo;
    if (!repo) return;
    const [checks, threads, reviews] = await Promise.all([
      this.github.prChecks(repo, ref.number).catch(() => null),
      this.github.reviewThreads(repo, ref.number).catch(() => null),
      this.github.prReviewState(repo, ref.number).catch(() => null),
    ]);
    // Fingerprints must match `checkOne` EXACTLY, or arming shifts the noise
    // rather than removing it.
    for (const c of checks ?? []) st.checks.set(c.name, c.conclusion ?? c.status);
    for (const t of threads ?? []) {
      if (t.isResolved || t.isOutdated) continue;
      st.threads.add(t.id);
    }
    for (const r of reviews?.reported ?? []) {
      if (r.state === "PENDING") continue;
      st.reviews.add(`${r.author}:${r.state}`);
    }
  }

  /**
   * One full pass over every chat's PRs. Returns the activity it raised, so
   * tests (and a future manual "check now" button) can assert on it directly.
   */
  async sweep(): Promise<PrReviewActivity[]> {
    const p = this.runSweep();
    this.inflight = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /* --------------------------------------------------------------- internals */

  private async runSweep(): Promise<PrReviewActivity[]> {
    const chats = await this.store.listChats().catch(() => [] as Chat[]);
    const out: PrReviewActivity[] = [];
    for (const chat of chats) {
      for (const ref of chat.prs ?? []) {
        // A merged/closed PR is over. Note the state on the REF rather than
        // re-polling it forever — a chat with a year of landed PRs must not cost
        // a `gh` call per PR per sweep.
        if (ref.state === "merged" || ref.state === "closed") continue;
        const activity = await this.checkOne(chat, ref).catch(() => null);
        if (activity) out.push(activity);
      }
    }
    return out;
  }

  private async checkOne(chat: Chat, ref: PRRef): Promise<PrReviewActivity | null> {
    const repo = ref.repo;
    const merge = await this.github
      .prMergeState(ref.number, { repo })
      .catch(() => null);
    // Unreadable this pass → say nothing. A badge raised on a failed read is a
    // false alarm, and false alarms are how a queue stops being read.
    if (!merge) return null;
    if (merge.state !== "open") {
      await this.markSettled(chat.id, ref, merge.state);
      return null;
    }
    // Without an owner/repo we can't read checks/threads/reviews at all; the
    // merge-state probe above auto-detects, but these three don't.
    if (!repo) return null;

    const st = this.stateFor(chat.id, ref);
    const [checks, threads, reviews] = await Promise.all([
      this.github.prChecks(repo, ref.number).catch(() => null),
      this.github.reviewThreads(repo, ref.number).catch(() => null),
      this.github.prReviewState(repo, ref.number).catch(() => null),
    ]);

    const reasons: string[] = [];

    for (const c of checks ?? []) {
      const conclusion = c.conclusion ?? undefined;
      const fingerprint = conclusion ?? c.status;
      const failing = conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
      if (failing && st.checks.get(c.name) !== fingerprint) {
        reasons.push(`check "${c.name}" ${conclusion}`);
      }
      st.checks.set(c.name, fingerprint);
    }

    for (const t of threads ?? []) {
      if (t.isResolved || t.isOutdated) continue;
      if (st.threads.has(t.id)) continue;
      st.threads.add(t.id);
      reasons.push(`review comment from ${t.author ?? "a reviewer"}${t.path ? ` on ${t.path}` : ""}`);
    }

    for (const r of reviews?.reported ?? []) {
      // PENDING is a draft review nobody can see yet — not activity.
      if (r.state === "PENDING") continue;
      const key = `${r.author}:${r.state}`;
      if (st.reviews.has(key)) continue;
      st.reviews.add(key);
      reasons.push(`${r.author} ${r.state.toLowerCase().replace(/_/g, " ")}`);
    }

    if (!reasons.length) return null;

    const summary = `PR #${ref.number}: ${reasons.join("; ")}`;
    const item: AttentionItem = {
      // Stable per ROUND, not per PR: an id that never changed would let the
      // queue's dedup-by-id silently swallow the second round of comments —
      // which is the exact failure this service exists to prevent.
      id: `att-review-${chat.id}-${ref.number}-${this.genId()}`,
      chatId: chat.id,
      kind: "review",
      summary,
      projectId: chat.projectId || undefined,
      prNumber: ref.number,
      url: ref.url,
      createdAt: this.now(),
    };
    this.bus.publish({ type: "attention-add", item });

    // ONLY the owning chat is woken — see the module docblock. `chat` here IS the
    // owner by construction: we found this PR by walking ITS `prs`.
    await this.wake(chat.id, ref, reasons);
    return { chatId: chat.id, ref, reasons };
  }

  /** Nudge the owning chat to work the round, unless it's already busy. */
  private async wake(chatId: string, ref: PRRef, reasons: string[]): Promise<void> {
    if (!this.resumeFn || this.isBusy(chatId)) return;
    const prompt =
      `New activity on your PR #${ref.number}${ref.url ? ` (${ref.url})` : ""}: ` +
      `${reasons.join("; ")}.\n\n` +
      "Work this review round: call `mcp__manager__watch_pr` for the details, address " +
      "what it reports, call `mcp__manager__resolve_thread` for each thread you actually " +
      "fixed, and once your fixes are pushed call `mcp__manager__request_review` to put " +
      "the reviewer back on the hook (submitting a review clears their request — new " +
      "commits do NOT re-queue them). Keep going until the PR lands.";
    await this.resumeFn(chatId, prompt).catch((err: unknown) => {
      // Leave the badge standing — the human can still act on it.
      this.bus.publish({
        type: "notice",
        chatId,
        level: "warn",
        text: `Could not resume this chat for PR #${ref.number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  /**
   * Record a PR's terminal state on the chat so later sweeps skip it, and drop
   * its dedup memory (nothing more will ever be reported for it).
   */
  private async markSettled(
    chatId: string,
    ref: PRRef,
    state: "merged" | "closed",
  ): Promise<void> {
    this.seen.delete(this.key(chatId, ref));
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat) return;
      const prs = (chat.prs ?? []).map((p) =>
        p.number === ref.number && p.repo === ref.repo
          ? { ...p, state, settledAt: p.settledAt ?? this.now() }
          : p,
      );
      const saved = await this.store.saveChat({ ...chat, prs, updatedAt: this.now() });
      this.bus.publish({ type: "chat-update", chat: saved });
    } catch {
      /* best-effort: a failed write just means we re-poll it next sweep */
    }
  }

  private key(chatId: string, ref: PRRef): string {
    return `${chatId}|${ref.repo ?? ""}#${ref.number}`;
  }

  private stateFor(chatId: string, ref: PRRef): SeenState {
    const k = this.key(chatId, ref);
    let st = this.seen.get(k);
    if (!st) {
      st = { threads: new Set(), checks: new Map(), reviews: new Set() };
      this.seen.set(k, st);
    }
    return st;
  }
}
