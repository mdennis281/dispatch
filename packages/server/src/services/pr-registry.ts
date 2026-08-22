/**
 * PrRegistry — the PR catalog's rows: what Dispatch knows about every pull
 * request it is tracking, persisted, and kept live.
 *
 * WHY this exists. Until now the app held PR state in three places and none of
 * them held it for long:
 *
 *   - `Chat.prs` records that a chat OWNS a PR — a pointer, and nothing about
 *     the PR itself beyond whether it has settled.
 *   - The project overlay ran `gh pr list` on every open and kept nothing, so it
 *     could not render without a round trip and could not show you what changed
 *     while you weren't looking.
 *   - `watch_pr` and `PrReviewWatcher` each polled GitHub with their own dedup
 *     memory and threw the answers away, which is why the agent's picture of a
 *     PR and the app's were different facts that never met.
 *
 * So this holds the state, keyed `owner/repo#number` (numbers restart at 1 per
 * repo — keying on the bare number is what made the old overlay refuse to fold
 * live events in at all), and something else POLLS it: one body,
 * `GitHubService.pollPrState`, driven by the background sweep and by `watch_pr`.
 * This class never spawns a poll loop of its own.
 *
 * `Chat.prs` remains the ownership pointer. `chatId` here is copied FROM it, so
 * the settled-PR green dot and `isPrSettledIdle()` keep reading exactly the
 * record they always have.
 */
import {
  applyRegistryQuery,
  prRecordKey,
  isHeldByLabel,
  PrSnapshotSchema,
  type PrRecord,
  type PrReviewAgentState,
  type PrSnapshot,
  type PRRef,
  type RegistryQuery,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import type { PrPollSnapshot } from "./github.js";

/**
 * The floor cadence, and the one a PR sits at whenever anything is expected to
 * happen on it. Matches the sweep's own tick — a row can never be polled more
 * often than the sweep runs, so a shorter value here would be a lie.
 */
export const PR_POLL_HOT_MS = 90_000;

/**
 * The cadence while an AGENT is blocked on `watch_pr`.
 *
 * Faster than hot, and justified by exactly the thing that makes it expensive:
 * somebody is waiting. Every other cadence trades staleness against GitHub
 * quota; this one trades quota against a chat sitting idle for up to a minute
 * after its PR went green, which is the most visible kind of slowness this app
 * has. It applies only while a watch is live (see `PrRecord.watchedUntil`), so
 * the load is bounded by how many agents are actually watching.
 */
export const PR_POLL_WATCHED_MS = 30_000;

/**
 * How long one `watch_pr` poll keeps a PR on the fast cadence.
 *
 * Comfortably longer than the tool's own poll interval, so a watch that is
 * merely between polls still counts as live; short enough that a watch killed
 * mid-flight (an interrupted turn, a crashed session) stops costing anything
 * within a couple of minutes. Nothing has to remember to clear it — an agent
 * that stops watching simply stops renewing.
 */
export const PR_WATCH_TTL_MS = 2 * 60_000;

/**
 * Backoff for a PARKED PR — one with nobody queued to review, no CI in flight
 * and nothing changing. It is deliberately not applied to a PR that is waiting
 * on a reviewer: noticing a review round promptly is the entire purpose of the
 * background sweep, and backing off there would trade the feature away for
 * savings on the case that is already cheap.
 */
export const PR_POLL_BACKOFF_MS: readonly number[] = [90_000, 180_000, 600_000];

/** How long after a change a PR counts as "active" and stays on the hot cadence. */
export const PR_ACTIVE_WINDOW_MS = 5 * 60_000;

/** Where a row came from, which decides what we may overwrite. */
export interface PrScope {
  projectId?: string;
  /** The owning chat, from its `Chat.prs`. Absent = discovered, unattributed. */
  chatId?: string;
}

export interface PrRegistryOptions {
  store: Store;
  bus: EventBus;
  /**
   * Poll one PR. Optional so the registry is constructible in tests and in any
   * deployment without a GitHub service; without it `refresh()` is a no-op that
   * says so rather than pretending it refreshed.
   */
  poll?: (repo: string, number: number) => Promise<PrPollSnapshot | null>;
  now?: () => number;
}

export class PrRegistry {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly poll?: (repo: string, number: number) => Promise<PrPollSnapshot | null>;
  private readonly now: () => number;

  constructor(opts: PrRegistryOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.poll = opts.poll;
    this.now = opts.now ?? (() => Date.now());
  }

  /* ----------------------------------------------------------------- reads */

  /** Every row, newest activity first. */
  async list(query?: RegistryQuery): Promise<PrRecord[]> {
    const all = await this.store.listPrRecords();
    const sorted = [...all].sort((a, b) => b.lastChangedAt - a.lastChangedAt);
    if (!query) return sorted;
    return applyRegistryQuery(sorted, query, {
      text: (p) => [p.title, p.branch, p.repo, p.author, `#${p.number}`, ...p.labels],
      touchedAt: (p) => p.lastChangedAt,
    });
  }

  /**
   * Rows the sweep should poll now.
   *
   * A settled PR is never returned: it is over, and a chat with a year of landed
   * PRs must not cost a GitHub call per PR per sweep — the same rule the review
   * watcher already applied to `Chat.prs`.
   */
  async due(now = this.now()): Promise<PrRecord[]> {
    const all = await this.store.listPrRecords();
    return all.filter((p) => p.state === "open" && now >= p.nextPollAt);
  }

  /* ---------------------------------------------------------------- writes */

  /**
   * Record a poll. Returns the stored row.
   *
   * `scope` only ever ADDS attribution — a discovery pass that finds a PR a chat
   * opened passes no `chatId`, and must not erase the one `create_pr` wrote.
   */
  async record(snapshot: PrPollSnapshot, scope: PrScope = {}): Promise<PrRecord> {
    const now = this.now();
    const key = prRecordKey(snapshot.repo, snapshot.number);
    const prev = await this.store.getPrRecord(key);
    const next = this.fieldsFrom(snapshot);
    const changed = !prev || fingerprint(prev) !== fingerprint(next);
    const quietPolls = changed ? 0 : (prev?.quietPolls ?? 0) + 1;
    const lastChangedAt = changed ? now : (prev?.lastChangedAt ?? now);

    // Persist every poll (the cadence bookkeeping has to advance for the backoff
    // to mean anything) but only ANNOUNCE a real change — plus the poll that
    // clears an error, which is news the catalog is trustworthy again. A socket
    // message per tracked PR per sweep, saying nothing, is how a live feed
    // teaches a client to ignore it.
    return this.publish(
      await this.store.upsertPrRecord(
        key,
        {
          ...next,
          ...scope,
          firstSeenAt: now,
          lastPolledAt: now,
          lastChangedAt,
          nextPollAt: 0,
          quietPolls,
          watchedUntil: 0,
        },
        {
          ...next,
          // Attribution is add-only: `undefined` here would be spread over a
          // known chatId and orphan the row from the chat that opened it.
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.chatId ? { chatId: scope.chatId } : {}),
          lastPolledAt: now,
          lastChangedAt,
          quietPolls,
          nextPollAt:
            now + this.cadenceFor(next, lastChangedAt, quietPolls, now, prev?.watchedUntil ?? 0),
          pollError: undefined,
        },
      ),
      changed || !!prev?.pollError,
    );
  }

  /**
   * Start tracking a PR from the pointer alone — the `create_pr` hook, and what
   * boot backfill uses. No GitHub call: the row appears immediately with what
   * the ref knows, and the next sweep fills in live state.
   *
   * `nextPollAt: 0` so it is polled on the very next sweep rather than waiting
   * out a cadence it has no state to justify.
   */
  async track(ref: PRRef, scope: PrScope = {}): Promise<PrRecord | null> {
    // Without an owner/repo there is no key and nothing pollable. A PRRef that
    // old predates `repo` being recorded; it stays out of the catalog rather
    // than landing under a key that could collide with another repo's PR.
    if (!ref.repo) return null;
    const now = this.now();
    const key = prRecordKey(ref.repo, ref.number);
    // A no-op `track` must not write or announce. The sweep calls this for every
    // open PR every pass so a new one appears instantly; without this it would
    // also rewrite the whole roster file and push a socket message per PR per
    // pass, to say nothing at all.
    const prev = await this.store.getPrRecord(key);
    if (
      prev &&
      (!scope.chatId || prev.chatId === scope.chatId) &&
      (!scope.projectId || prev.projectId === scope.projectId)
    ) {
      return prev;
    }
    return this.publish(
      await this.store.upsertPrRecord(
        key,
        {
          repo: ref.repo,
          number: ref.number,
          url: ref.url,
          title: ref.title ?? "",
          branch: ref.branch,
          baseBranch: "",
          state: ref.state ?? "open",
          isDraft: false,
          labels: [],
          hold: false,
          mergeable: null,
          reviewDecision: null,
          reviewers: [],
          threads: [],
          checks: [],
          ...scope,
          firstSeenAt: now,
          lastPolledAt: 0,
          lastChangedAt: ref.settledAt ?? now,
          nextPollAt: 0,
          quietPolls: 0,
          watchedUntil: 0,
        },
        {
          // An existing row already holds richer state than the ref does; only
          // the ownership the ref is authoritative about is written through.
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.chatId ? { chatId: scope.chatId } : {}),
        },
      ),
    );
  }

  /**
   * Mark this PR as being actively watched by an agent, and return the row.
   *
   * Called by `watch_pr` on every poll. It only ever EXTENDS the window, and it
   * pulls `nextPollAt` in to match — otherwise a row that had just backed off to
   * ten minutes would keep that appointment for ten minutes after an agent
   * started waiting on it, which is precisely the case this exists to fix.
   *
   * A no-op for a PR the catalog has never heard of: `watch_pr` can be pointed
   * at any number, and creating a hollow row from a watch would put PRs in the
   * roster that nothing is tracking.
   */
  async noteWatched(repo: string, number: number): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev) return null;
    const now = this.now();
    const watchedUntil = Math.max(prev.watchedUntil, now + PR_WATCH_TTL_MS);
    if (prev.watchedUntil === watchedUntil && prev.nextPollAt <= now + PR_POLL_WATCHED_MS) {
      return prev;
    }
    // No `publish`: a watch window is server bookkeeping, not something the
    // catalog renders, and announcing it would wake every client every 30s.
    return this.store.upsertPrRecord(key, { ...prev }, {
      watchedUntil,
      nextPollAt: Math.min(prev.nextPollAt, now + PR_POLL_WATCHED_MS),
    });
  }

  /**
   * Record that Dispatch's own reviewer has been ASKED to look at this PR.
   *
   * This is the write behind both request sources — a configured machine
   * account showing up in GitHub's reviewer queue, and a local request from
   * `request_review` or the PR row's own button. Downstream there is one fact
   * to read, which is the entire reason the state lives here rather than being
   * re-derived from GitHub on one path and remembered in memory on the other.
   *
   * Idempotent against the HEAD it was asked at: re-asking for a review of code
   * that has not moved is not a new request, and the sweep re-observes GitHub's
   * queue every pass, so a write per pass would be a write per 90 seconds
   * forever. A push moves the sha and genuinely does re-arm it.
   *
   * A no-op for a PR the catalog has never heard of — same rule as
   * `noteWatched`: a request must not conjure a hollow row.
   */
  async requestReviewAgent(repo: string, number: number, by: string): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev) return null;
    const sha = prev.headRefOid;
    const state = prev.reviewAgent;
    // Already asked at this head, and nothing has served it yet. A parked
    // refusal defeats the short-circuit on purpose: getting here means the
    // reviewer IS in the queue now, so the recorded "GitHub would not queue it"
    // is stale, and skipping the write would leave the row saying no review is
    // coming while one is about to start.
    if (state?.requestedSha === sha && state?.requestedAt && !state.requestError) return prev;
    const now = this.now();
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: {
          ...(state ?? { rounds: 0 }),
          requestedSha: sha,
          requestedAt: now,
          requestedBy: by,
          requestError: undefined,
        },
      }),
    );
  }

  /**
   * Take the review job for this PR, or return null because there isn't one.
   *
   * The lease is written BEFORE the review happens — `reviewedSha` is set at
   * claim time, not at post time. That is deliberate and it is the difference
   * between one reviewer and a fleet of them: the sweep comes round every 90
   * seconds and a review takes minutes, so a claim recorded only on completion
   * would spawn a fresh reviewer every pass for the whole duration of the first.
   *
   * The cost is that a reviewer chat which dies mid-run has still spent its
   * round. That is the right direction to fail in — a spent round is one missing
   * review the human can re-trigger, where the other direction is unbounded
   * spawning that looks like progress while it burns quota.
   */
  async claimReviewAgent(
    repo: string,
    number: number,
    opts: { maxRounds: number },
  ): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev || prev.state !== "open") return null;
    const state: PrReviewAgentState = prev.reviewAgent ?? { rounds: 0 };
    if (!state.requestedAt) return null;
    if (state.rounds >= opts.maxRounds) return null;
    // Dedup on the HEAD, not on "has been reviewed": a review is only spent on
    // the code it read, so a push re-arms it and a re-request on unchanged code
    // does not.
    const sha = prev.headRefOid;
    if (sha && state.reviewedSha === sha) return null;
    const now = this.now();
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: {
          ...state,
          requestedSha: undefined,
          requestedAt: undefined,
          reviewedSha: sha,
          reviewedAt: now,
          rounds: state.rounds + 1,
          maxRounds: opts.maxRounds,
          // The previous round's verdict is cleared HERE rather than left to be
          // overwritten on post. A round that dies before filing would otherwise
          // keep showing the round before it as its result — the row would read
          // "reviewed, 3 findings" about code that reviewer never saw.
          postedAt: undefined,
          findings: undefined,
          postedEvent: undefined,
        },
      }),
    );
  }

  /**
   * Record that the reviewer chat actually POSTED — the completion signal the
   * claim deliberately cannot be.
   *
   * Only the chat holding the lease may complete a row. A human's chat calling
   * `post_review` on a PR Dispatch reviewed last week is a different event, and
   * letting it land here would date that old round to now and change its
   * findings count to this one's.
   */
  async notePostedReview(
    repo: string,
    number: number,
    by: {
      chatId: string;
      findings?: number;
      event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
    },
  ): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    const state = prev?.reviewAgent;
    if (!prev || !state || state.chatId !== by.chatId) return null;
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: {
          ...state,
          postedAt: this.now(),
          findings: by.findings,
          postedEvent: by.event,
        },
      }),
    );
  }

  /**
   * Record GitHub's refusal to put the reviewer into this PR's review queue —
   * or clear a stale one by passing no error.
   *
   * Kept off {@link notePolicy}'s `problem` because the sweep rewrites that
   * field from `resolveReviewer` every 90 seconds, which would erase a per-PR
   * fact almost as fast as it was written. See `PrReviewAgentStateSchema`.
   *
   * Like every other reviewer write here, a no-op for a PR the catalog has not
   * heard of, and silent when nothing changed — this runs on every `create_pr`
   * and every `request_review`, and a write per call for an error that is
   * usually absent would be a broadcast per call to every connected client.
   */
  async noteReviewRequestError(
    repo: string,
    number: number,
    error?: string,
  ): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev) return null;
    const state = prev.reviewAgent;
    // Nothing recorded and nothing to record. Notably this is the CLEAR path for
    // a healthy PR, which must not conjure reviewer state onto every row that
    // ever had a PR opened for it.
    if (!state && !error) return prev;
    if (state?.requestError === error) return prev;
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: { ...(state ?? { rounds: 0 }), requestError: error },
      }),
    );
  }

  /**
   * Mirror the reviewer POLICY onto the row — the round cap, and why the
   * reviewer is refusing to run at all.
   *
   * Called off every sweep pass, so it writes only on a real change: the sweep
   * sees each PR every 90 seconds, and a write per pass would be a broadcast per
   * pass to every connected client for a value that changes once a year.
   *
   * A `problem` may CREATE the reviewer state where none exists, and that is the
   * point — the misconfiguration this reports is precisely the one in which no
   * request is ever recorded, because there is no reviewer account to put in
   * GitHub's queue and nothing local asks on its behalf. Without this the state
   * has no row to sit on. A clean policy conjures nothing: `maxRounds` alone is
   * not worth turning "nobody asked" into a stored object on every PR.
   */
  async notePolicy(
    repo: string,
    number: number,
    policy: { maxRounds?: number; problem?: string },
  ): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev) return null;
    const state = prev.reviewAgent;
    // Null only ever means "no such row", as everywhere else here — an
    // unchanged row comes back as itself.
    if (!state && !policy.problem) return prev;
    const maxRounds = policy.maxRounds ?? state?.maxRounds;
    if (state?.problem === policy.problem && state?.maxRounds === maxRounds) return prev;
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: { ...(state ?? { rounds: 0 }), maxRounds, problem: policy.problem },
      }),
    );
  }

  /**
   * Attach the reviewer's chat to the row, once it exists.
   *
   * Separate from the claim because the claim has to happen BEFORE the chat does
   * — the lease is what stops the next sweep spawning a second reviewer while
   * the first is still being created. A spawn that fails simply never gets here,
   * and the row keeps a spent round with no chat, which is a state the catalog
   * can show honestly.
   */
  async noteReviewChat(repo: string, number: number, chatId: string): Promise<PrRecord | null> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev?.reviewAgent) return null;
    return this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        reviewAgent: { ...prev.reviewAgent, chatId },
      }),
    );
  }

  /**
   * Which tracked PR owns this review thread?
   *
   * `resolve_thread` is handed a thread id and nothing else — the tool has never
   * needed to know which PR it belongs to, and the agent is not asked to say.
   * The catalog already holds every PR's threads, so it can answer, and that is
   * what lets a resolve show up as a card about a pull request rather than an
   * opaque node id.
   *
   * Linear over the roster, which is fine: the roster is bounded by open PRs and
   * this runs once per human-initiated resolve, not on any sweep.
   */
  async findByThread(threadId: string): Promise<PrRecord | null> {
    if (!threadId) return null;
    const all = await this.store.listPrRecords();
    return all.find((p) => p.threads.some((t) => t.id === threadId)) ?? null;
  }

  /**
   * The display half of a row — what a PR tool freezes into its result.
   *
   * Strips the tracking bookkeeping deliberately: a snapshot in a transcript is
   * a record of what a PR looked like, and `nextPollAt` is not part of that.
   */
  async snapshot(repo: string, number: number): Promise<PrSnapshot | null> {
    const row = await this.store.getPrRecord(prRecordKey(repo, number));
    return row ? toSnapshot(row) : null;
  }

  /**
   * Dispatch's own reviewer on this row — the bookkeeping half {@link snapshot}
   * deliberately strips.
   *
   * Read rather than polled, because none of it comes from GitHub: the round
   * count and the cap are written here, by the sweep. That is what makes it
   * cheap enough for `watch_pr` to ask on every poll, which it must — the round
   * that spends the cap is claimed while the author is already blocked.
   */
  async reviewAgent(repo: string, number: number): Promise<PrReviewAgentState | null> {
    const row = await this.store.getPrRecord(prRecordKey(repo, number));
    return row?.reviewAgent ?? null;
  }

  /**
   * Note that a poll failed, ON the row. A stale row that says why it's stale is
   * honest; one that keeps presenting five-minute-old state as current is not.
   * The row is still re-polled on the hot cadence — a failure is not a reason to
   * stop looking.
   */
  async noteError(repo: string, number: number, error: string): Promise<void> {
    const key = prRecordKey(repo, number);
    const prev = await this.store.getPrRecord(key);
    if (!prev) return;
    const now = this.now();
    this.publish(
      await this.store.upsertPrRecord(key, { ...prev }, {
        lastPolledAt: now,
        nextPollAt: now + PR_POLL_HOT_MS,
        pollError: error.slice(0, 300),
      }),
    );
  }

  /** Poll one row now (the catalog's per-row "check now"). */
  async refresh(key: string, scope: PrScope = {}): Promise<PrRecord | null> {
    const prev = await this.store.getPrRecord(key);
    if (!prev) return null;
    if (!this.poll) return prev;
    const snapshot = await this.poll(prev.repo, prev.number).catch((err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
    if (!snapshot) {
      await this.noteError(prev.repo, prev.number, "GitHub could not be read for this PR");
      return this.store.getPrRecord(key);
    }
    return this.record(snapshot, { chatId: prev.chatId, projectId: prev.projectId, ...scope });
  }

  /**
   * Seed the catalog from every chat's `Chat.prs` at boot, so PRs opened before
   * this registry existed appear without anyone doing anything. Cheap: no
   * GitHub calls, one store read per chat.
   */
  async backfill(): Promise<number> {
    const chats = await this.store.listChats().catch(() => []);
    let n = 0;
    for (const chat of chats) {
      for (const ref of chat.prs ?? []) {
        const rec = await this.track(ref, {
          chatId: chat.id,
          projectId: chat.projectId || undefined,
        }).catch(() => null);
        if (rec) n++;
      }
    }
    return n;
  }

  /* -------------------------------------------------------------- internals */

  /** The PR fields a snapshot supplies, separated from tracking bookkeeping. */
  private fieldsFrom(s: PrPollSnapshot): Omit<
    PrRecord,
    | "key"
    | "firstSeenAt"
    | "lastPolledAt"
    | "lastChangedAt"
    | "nextPollAt"
    | "quietPolls"
    | "watchedUntil"
  > {
    return {
      repo: s.repo,
      number: s.number,
      url: s.url,
      title: s.title,
      branch: s.branch,
      baseBranch: s.baseBranch,
      state: s.state,
      isDraft: s.isDraft,
      author: s.author,
      labels: s.labels,
      hold: isHeldByLabel(s.labels),
      mergeable: s.mergeable,
      mergeStateStatus: s.mergeStateStatus,
      reviewDecision: s.reviewDecision,
      reviewers: s.reviewers,
      threads: s.threads,
      checks: s.checks,
      commentCount: s.commentCount,
      headRefOid: s.headRefOid,
      additions: s.additions,
      deletions: s.deletions,
      changedFiles: s.changedFiles,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      mergedAt: s.mergedAt,
      closedAt: s.closedAt,
    };
  }

  /**
   * How long until this row's next poll.
   *
   * HOT whenever news is expected — somebody is on the hook to review, a review
   * is actually running, CI is in flight, or something changed in the last few
   * minutes. Only a genuinely parked PR walks the backoff ladder.
   */
  private cadenceFor(
    fields: ReturnType<PrRegistry["fieldsFrom"]>,
    lastChangedAt: number,
    quietPolls: number,
    now: number,
    watchedUntil = 0,
  ): number {
    if (fields.state !== "open") return PR_POLL_BACKOFF_MS[PR_POLL_BACKOFF_MS.length - 1]!;
    // An agent is blocked on this PR right now. Nothing else outranks that.
    if (now < watchedUntil) return PR_POLL_WATCHED_MS;
    const awaited = fields.reviewers.some(
      (r) => r.state === "requested" || r.state === "in_progress",
    );
    const ciInFlight = fields.checks.some((c) => c.status !== "completed");
    const recentlyActive = now - lastChangedAt < PR_ACTIVE_WINDOW_MS;
    if (awaited || ciInFlight || recentlyActive) return PR_POLL_HOT_MS;
    const idx = Math.min(quietPolls, PR_POLL_BACKOFF_MS.length - 1);
    return PR_POLL_BACKOFF_MS[idx]!;
  }

  private publish(record: PrRecord, announce = true): PrRecord {
    if (announce) this.bus.publish({ type: "pr-record-update", record });
    return record;
  }
}

/**
 * What counts as a CHANGE worth announcing and resetting the cadence for.
 *
 * The rule is: **everything the catalog RENDERS goes in here.** This value gates
 * the `pr-record-update` broadcast, so a rendered field left out of it can move
 * on the stored row without ever reaching a connected client — the roster would
 * then sit stale until some unrelated change or a reconnect happened to flush
 * it. `isOutdated` is in for exactly that reason: the roster's unresolved-thread
 * count filters on it, so a thread going outdated is a visible change.
 *
 * `updatedAt` and `lastPolledAt` are deliberately OUT. GitHub bumps `updatedAt`
 * for things this catalog doesn't show, and treating every bump as activity
 * would pin every PR to the hot cadence and make the backoff ornamental.
 */
function fingerprint(p: {
  state: string;
  isDraft: boolean;
  title: string;
  branch: string;
  baseBranch: string;
  author?: string;
  labels: string[];
  mergeable: boolean | null;
  reviewDecision: string | null;
  headRefOid?: string;
  commentCount?: number;
  reviewers: Array<{ login: string; state: string; stale?: boolean }>;
  threads: Array<{ id: string; isResolved: boolean; isOutdated?: boolean }>;
  checks: Array<{ name: string; status: string; conclusion?: string | null }>;
}): string {
  return JSON.stringify([
    p.state,
    p.isDraft,
    p.title,
    p.branch,
    p.baseBranch,
    p.author ?? "",
    [...p.labels].sort(),
    p.mergeable,
    p.reviewDecision,
    p.headRefOid ?? "",
    p.commentCount ?? 0,
    p.reviewers.map((r) => `${r.login}:${r.state}:${r.stale ? 1 : 0}`).sort(),
    p.threads.map((t) => `${t.id}:${t.isResolved ? 1 : 0}:${t.isOutdated ? 1 : 0}`).sort(),
    p.checks.map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}`).sort(),
  ]);
}

/**
 * A row reduced to its display half.
 *
 * Parsed through the snapshot schema rather than hand-picked, so adding a field
 * to what the catalog shows automatically adds it to what a tool freezes —
 * hand-picking is how the two drift until a card is missing something the
 * roster has shown for months.
 */
function toSnapshot(row: PrRecord): PrSnapshot {
  return PrSnapshotSchema.parse(row);
}
