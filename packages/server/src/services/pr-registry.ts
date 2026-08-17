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
  type PrRecord,
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
          nextPollAt: now + this.cadenceFor(next, lastChangedAt, quietPolls, now),
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
    "key" | "firstSeenAt" | "lastPolledAt" | "lastChangedAt" | "nextPollAt" | "quietPolls"
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
  ): number {
    if (fields.state !== "open") return PR_POLL_BACKOFF_MS[PR_POLL_BACKOFF_MS.length - 1]!;
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
 * What counts as a CHANGE worth resetting the cadence for.
 *
 * Deliberately excludes `updatedAt`: GitHub bumps it for things this catalog
 * doesn't show, and treating every bump as activity would pin every PR to the
 * hot cadence and make the backoff ornamental.
 */
function fingerprint(p: {
  state: string;
  isDraft: boolean;
  title: string;
  labels: string[];
  mergeable: boolean | null;
  reviewDecision: string | null;
  headRefOid?: string;
  commentCount?: number;
  reviewers: Array<{ login: string; state: string; stale?: boolean }>;
  threads: Array<{ id: string; isResolved: boolean }>;
  checks: Array<{ name: string; status: string; conclusion?: string | null }>;
}): string {
  return JSON.stringify([
    p.state,
    p.isDraft,
    p.title,
    [...p.labels].sort(),
    p.mergeable,
    p.reviewDecision,
    p.headRefOid ?? "",
    p.commentCount ?? 0,
    p.reviewers.map((r) => `${r.login}:${r.state}:${r.stale ? 1 : 0}`).sort(),
    p.threads.map((t) => `${t.id}:${t.isResolved ? 1 : 0}`).sort(),
    p.checks.map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}`).sort(),
  ]);
}
