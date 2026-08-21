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
import type { AttentionItem, Chat, PRRef, ResolvedReviewAgent, ReviewKind } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import type { PrPollSnapshot } from "./github.js";
import type { PrScope } from "./pr-registry.js";

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

/**
 * How often discovery runs — the pass that finds open PRs NO chat owns.
 *
 * Deliberately far slower than the activity sweep. A PR nobody in Dispatch
 * opened has no chat to wake and raises no attention item; discovery exists so
 * it is VISIBLE in the catalog, and a PR appearing in a list within five minutes
 * is not a latency anyone can feel.
 */
export const PR_DISCOVER_MS = 5 * 60_000;

/**
 * The narrow GitHub surface this watcher needs (kept decoupled for tests).
 *
 * One method, because there is now one poll: `GitHubService.pollPrState` reads
 * merge state, checks, threads and the reviewer queue in a single GraphQL round
 * trip. This used to be four methods with four independent failure modes, and
 * `watch_pr` had its own four — the same questions asked twice, with two dedup
 * memories that could disagree about the same PR.
 *
 * `null` = no snapshot this pass. Unlike the old per-signal nulls, this is
 * all-or-nothing: say nothing rather than raise a badge on a partial read, which
 * is the same rule as before, just expressed once.
 */
export interface PrReviewGitHub {
  pollPrState(repo: string, prNumber: number): Promise<PrPollSnapshot | null>;
}

/**
 * The PR catalog, as this watcher needs it. Structural so the watcher stays
 * testable without a Store, and so the sweep's cadence questions
 * (`due`) live with the rows rather than here.
 */
export interface PrReviewRegistry {
  record(snapshot: PrPollSnapshot, scope: PrScope): Promise<unknown>;
  track(ref: PRRef, scope: PrScope): Promise<unknown>;
  noteError(repo: string, number: number, error: string): Promise<void>;
  due(now?: number): Promise<Array<{ repo: string; number: number } & PrScope>>;
  /** Record that Dispatch's own reviewer was asked (idempotent per head sha). */
  requestReviewAgent(repo: string, number: number, by: string): Promise<unknown>;
  /** Take the review job, or null because there isn't one. See the registry. */
  claimReviewAgent(
    repo: string,
    number: number,
    opts: { maxRounds: number },
  ): Promise<{ reviewAgent?: { rounds: number } } | null>;
  /** Attach the reviewer's chat to the row, once it exists. */
  noteReviewChat(repo: string, number: number, chatId: string): Promise<unknown>;
}

/**
 * How the sweep spawns a review, and how it finds out whether it should.
 *
 * Split into a policy read and an action for the same reason the spawn consent
 * surface is: the decision has to be answerable without doing anything. The
 * sweep asks this per PR it just polled, so `policyFor` must be cheap — it reads
 * the project record, which the store already holds.
 */
export interface PrReviewAgentHooks {
  /** This project's reviewer policy; null = no project, or GitHub is unreadable. */
  policyFor(projectId: string | undefined): Promise<ResolvedReviewAgent | null>;
  /** Launch the reviewer. Returns the chat it created, so the row can link to it. */
  spawn(input: {
    projectId: string;
    repo: string;
    number: number;
    round: number;
    policy: ResolvedReviewAgent;
  }): Promise<{ chatId: string } | null>;
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
  /**
   * The PR catalog. Every poll this sweep makes is handed to it, and its `due`
   * answers decide which rows get polled at all — that's where the adaptive
   * cadence lives. Absent → the watcher behaves exactly as it did before the
   * catalog existed.
   */
  registry?: PrReviewRegistry;
  /**
   * Find open PRs across the projects, including ones no chat owns.
   *
   * A function rather than a GitHub method because resolving project → repo →
   * open PRs needs the Store and the GitHub service together; doing it in the
   * container keeps this class's GitHub surface at one method. Absent →
   * discovery is off and the catalog holds only what chats own.
   */
  discover?: () => Promise<Array<{ projectId: string; ref: PRRef }>>;
  /**
   * Dispatch's own reviewer. Absent → the sweep never spawns one, which is
   * exactly how it behaved before this existed.
   *
   * It hangs off the sweep rather than off `create_pr` because the trigger is a
   * review REQUEST, and requests keep arriving long after a PR is opened — after
   * every fix round, and whenever a human asks on GitHub. The sweep is already
   * the thing that notices what happened on a PR while nobody was looking.
   */
  reviewAgent?: PrReviewAgentHooks;
  intervalMs?: number;
  discoverMs?: number;
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
  private readonly registry?: PrReviewRegistry;
  private readonly discoverFn?: () => Promise<Array<{ projectId: string; ref: PRRef }>>;
  private readonly reviewAgent?: PrReviewAgentHooks;
  private readonly intervalMs: number;
  private readonly discoverMs: number;
  /** When discovery last ran; 0 = never, so the first sweep discovers. */
  private lastDiscoverAt = 0;
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
    this.registry = opts.registry;
    this.discoverFn = opts.discover;
    this.reviewAgent = opts.reviewAgent;
    this.intervalMs = opts.intervalMs ?? PR_REVIEW_POLL_MS;
    this.discoverMs = opts.discoverMs ?? PR_DISCOVER_MS;
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
    const snap = await this.github.pollPrState(repo, ref.number).catch(() => null);
    if (!snap) return;
    // Fingerprints must match `checkOne` EXACTLY, or arming shifts the noise
    // rather than removing it.
    for (const c of snap.checks) st.checks.set(c.name, c.conclusion ?? c.status);
    for (const t of snap.threads) {
      if (t.isResolved || t.isOutdated) continue;
      st.threads.add(t.id);
    }
    for (const r of snap.reported) {
      if (r.state === "PENDING") continue;
      st.reviews.add(`${r.author}:${r.state}`);
    }
    // The catalog gets the arming poll too — a PR opened seconds ago should show
    // its real state, not sit blank until the first sweep comes round.
    await this.registry
      ?.record(snap, { chatId })
      .catch(() => undefined);
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
    // Discovery FIRST, so a PR found this pass is polled on this pass rather
    // than waiting a full interval to be looked at.
    await this.discoverUnowned().catch(() => undefined);

    const chats = await this.store.listChats().catch(() => [] as Chat[]);
    /** Every PR an owning chat covered — so the unowned pass doesn't re-poll it. */
    const owned = new Set<string>();
    const work: Array<{ chat: Chat; ref: PRRef; scope: PrScope }> = [];
    for (const chat of chats) {
      for (const ref of chat.prs ?? []) {
        // A merged/closed PR is over. Note the state on the REF rather than
        // re-polling it forever — a chat with a year of landed PRs must not cost
        // a `gh` call per PR per sweep.
        if (ref.state === "merged" || ref.state === "closed") continue;
        const scope: PrScope = { chatId: chat.id, projectId: chat.projectId || undefined };
        work.push({ chat, ref, scope });
        // The row is created from the ref alone, ALWAYS — even when the poll
        // won't be due. A PR the catalog has never heard of must appear at once;
        // waiting for its turn in the cadence would leave a just-opened PR
        // missing from the list for as long as the backoff said. Creating them
        // BEFORE the due set is read is what makes a brand-new row (nextPollAt
        // 0) get its first poll on this very pass rather than the next one.
        if (ref.repo) {
          owned.add(`${ref.repo}#${ref.number}`);
          await this.registry?.track(ref, scope).catch(() => undefined);
        }
      }
    }

    // The due rows are read ONCE per sweep and then serve BOTH passes below.
    // Asking the catalog per PR would mean re-reading the whole roster file for
    // every PR in it, which is quadratic in the one dimension this feature is
    // expected to grow in.
    const due = await this.dueRows();

    const out: PrReviewActivity[] = [];
    for (const { chat, ref, scope } of work) {
      const activity = await this.checkOne(chat, ref, scope, due?.keys ?? null).catch(() => null);
      if (activity) out.push(activity);
    }
    await this.pollUnowned(owned, due?.rows ?? []).catch(() => undefined);
    return out;
  }

  /**
   * The rows due this pass, plus their `repo#number` keys for membership tests —
   * or `null` when there is no catalog, which means "poll everything" and is
   * exactly how this watcher behaved before the catalog existed.
   */
  private async dueRows(): Promise<{
    rows: Array<{ repo: string; number: number } & PrScope>;
    keys: Set<string>;
  } | null> {
    if (!this.registry) return null;
    const rows = await this.registry.due(this.now()).catch(() => null);
    if (!rows) return null;
    return { rows, keys: new Set(rows.map((r) => `${r.repo}#${r.number}`)) };
  }

  /**
   * Find open PRs no chat owns and put them in the catalog, unattributed.
   *
   * They raise no attention and wake nobody — there is no owning chat, and
   * badging a human's PR is the nuisance this module's docblock rules out. They
   * are here to be SEEN, which is the same reason a worktree that appeared from
   * outside is listed as `external` rather than hidden.
   */
  private async discoverUnowned(): Promise<void> {
    if (!this.discoverFn || !this.registry) return;
    const now = this.now();
    if (now - this.lastDiscoverAt < this.discoverMs) return;
    this.lastDiscoverAt = now;
    for (const { projectId, ref } of await this.discoverFn()) {
      await this.registry.track(ref, { projectId }).catch(() => undefined);
    }
  }

  /**
   * Refresh catalog rows that no chat's sweep covered — the discovered ones.
   * Same due-based cadence, no attention side effects.
   */
  private async pollUnowned(
    covered: ReadonlySet<string>,
    due: ReadonlyArray<{ repo: string; number: number } & PrScope>,
  ): Promise<void> {
    if (!this.registry) return;
    for (const row of due) {
      if (covered.has(`${row.repo}#${row.number}`)) continue;
      const snap = await this.github.pollPrState(row.repo, row.number).catch(() => null);
      if (!snap) {
        await this.registry
          .noteError(row.repo, row.number, "GitHub could not be read for this PR")
          .catch(() => undefined);
        continue;
      }
      await this.registry.record(snap, { projectId: row.projectId }).catch(() => undefined);
      await this.maybeSpawnReview(snap, { projectId: row.projectId }).catch(() => undefined);
    }
  }

  /**
   * Spawn Dispatch's own reviewer, if this PR is asking for one.
   *
   * Runs off every poll rather than off any single event, because the two
   * request sources arrive differently: a local request is a write we made, and
   * a GitHub one is a field that quietly appears in the reviewer queue between
   * one sweep and the next. Reading both from the same snapshot is what keeps
   * "was a review requested" a single question with a single answer.
   *
   * Every failure here is swallowed. A sweep that cannot spawn a reviewer must
   * still record the poll, raise its attention items and move to the next PR —
   * this is an addition to the sweep, not a new way for it to die.
   */
  private async maybeSpawnReview(snapshot: PrPollSnapshot, scope: PrScope): Promise<void> {
    const hooks = this.reviewAgent;
    const registry = this.registry;
    if (!hooks || !registry || snapshot.state !== "open") return;
    // A draft is the author saying "not yet". Reviewing one spends a round on
    // code that is expected to change, and `create_pr` requests reviewers on
    // drafts too — so honouring the request here would make `draft: true` cost
    // a review every time. A draft can still be reviewed on demand from its row.
    if (snapshot.isDraft) return;
    const projectId = scope.projectId;
    if (!projectId) return;
    const policy = await hooks.policyFor(projectId);
    if (!policy?.enabled) return;

    // GitHub-sourced request: the configured account is sitting in the queue.
    // Recorded onto the row first so both sources converge on one fact before
    // anything reads it — see `PrReviewAgentStateSchema`.
    if (policy.login) {
      const login = policy.login.toLowerCase();
      if (snapshot.requested.some((r) => r.toLowerCase() === login)) {
        await registry.requestReviewAgent(snapshot.repo, snapshot.number, policy.login);
      }
    }

    const claimed = await registry.claimReviewAgent(snapshot.repo, snapshot.number, {
      maxRounds: policy.maxRounds,
    });
    if (!claimed) return;

    const round = claimed.reviewAgent?.rounds ?? 1;
    const chat = await hooks.spawn({
      projectId,
      repo: snapshot.repo,
      number: snapshot.number,
      round,
      policy,
    });
    if (chat) {
      await registry
        .noteReviewChat(snapshot.repo, snapshot.number, chat.chatId)
        .catch(() => undefined);
      this.bus.publish({
        type: "notice",
        level: "info",
        text:
          `Reviewing PR #${snapshot.number} in ${snapshot.repo} ` +
          `(round ${round} of ${policy.maxRounds})`,
      });
    }
  }

  private async checkOne(
    chat: Chat,
    ref: PRRef,
    scope: PrScope,
    due: ReadonlySet<string> | null,
  ): Promise<PrReviewActivity | null> {
    const repo = ref.repo;
    // Without an owner/repo there is nothing pollable: the poll is one GraphQL
    // query, and GraphQL cannot auto-detect a repository the way `gh pr view`
    // could. A ref that old predates `repo` being recorded.
    if (!repo) return null;
    // The catalog decides WHEN, via its adaptive cadence: a PR with a reviewer on
    // the hook or CI in flight stays on the sweep's own interval, and only a
    // genuinely parked one backs off.
    if (due && !due.has(`${repo}#${ref.number}`)) return null;

    const snap = await this.github.pollPrState(repo, ref.number).catch(() => null);
    // Unreadable this pass → say nothing. A badge raised on a failed read is a
    // false alarm, and false alarms are how a queue stops being read.
    if (!snap) {
      await this.registry
        ?.noteError(repo, ref.number, "GitHub could not be read for this PR")
        .catch(() => undefined);
      return null;
    }
    await this.registry?.record(snap, scope).catch(() => undefined);
    await this.maybeSpawnReview(snap, scope).catch(() => undefined);
    if (snap.state !== "open") {
      await this.markSettled(chat.id, ref, snap.state);
      return null;
    }

    const st = this.stateFor(chat.id, ref);
    const checks = snap.checks;
    const threads = snap.threads;
    const reviews = { reported: snap.reported };

    const reasons: string[] = [];
    // Which CLASS of activity fired, so notification filters can be finer than
    // "review": a red check is worth a 2am push, a nit is not. A single poll can
    // find several, so this is a set and the item carries all of them.
    const reviewKinds = new Set<ReviewKind>();

    for (const c of checks ?? []) {
      const conclusion = c.conclusion ?? undefined;
      const fingerprint = conclusion ?? c.status;
      const failing = conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
      if (failing && st.checks.get(c.name) !== fingerprint) {
        reasons.push(`check "${c.name}" ${conclusion}`);
        reviewKinds.add("check");
      }
      st.checks.set(c.name, fingerprint);
    }

    for (const t of threads ?? []) {
      if (t.isResolved || t.isOutdated) continue;
      if (st.threads.has(t.id)) continue;
      st.threads.add(t.id);
      reasons.push(`review comment from ${t.author ?? "a reviewer"}${t.path ? ` on ${t.path}` : ""}`);
      reviewKinds.add("comment");
    }

    for (const r of reviews?.reported ?? []) {
      // PENDING is a draft review nobody can see yet — not activity.
      if (r.state === "PENDING") continue;
      const key = `${r.author}:${r.state}`;
      if (st.reviews.has(key)) continue;
      st.reviews.add(key);
      reasons.push(`${r.author} ${r.state.toLowerCase().replace(/_/g, " ")}`);
      reviewKinds.add("review");
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
      reviewKinds: [...reviewKinds],
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
      // "It landed" is the one PR event that closes a loop rather than opening
      // one, and until now it was the only state change the human had to go
      // looking for. It rides the `review` kind (so it inherits the queue's
      // triage weight) but carries the `settled` sub-kind, which is what lets
      // someone keep failed-check pushes and mute merge confetti.
      this.bus.publish({
        type: "attention-add",
        item: {
          id: `att-review-${chatId}-${ref.number}-settled`,
          chatId,
          kind: "review",
          summary: `PR #${ref.number} ${state}`,
          projectId: chat.projectId || undefined,
          prNumber: ref.number,
          url: ref.url,
          reviewKinds: ["settled"],
          createdAt: this.now(),
        },
      });
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
