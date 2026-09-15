/**
 * IssueWatcher — polls each enrolled project's tracker for issues opened since
 * the project was enrolled, claims the ones its filters admit, and starts ONE
 * chat per batch to handle them.
 *
 * What it is careful about, in the order that has bitten similar things:
 *
 * - **Two instances, one repo.** Stable and dev share `config/` (so both see a
 *   project enrolled) but not `data/` (so neither sees the other's claims). The
 *   lock that both can see is the claim LABEL on the issue: a poll skips any
 *   issue already carrying it, and labels before it spawns. This instance only
 *   runs the watcher at all when `active` says so — the installed app, never
 *   `pnpm dev` — but the label is what makes that a belt rather than the braces.
 * - **The backlog.** Enrolling a project records a baseline, and only an issue
 *   opened AFTER it is ever taken. Without that, flipping the switch on a repo
 *   with 40 open issues would spawn for all 40 at once.
 * - **Concurrency.** `maxConcurrent` bounds the issues in flight per project
 *   (claimed or working, with a chat that still exists), so a busy tracker
 *   fills the cap and waits rather than fanning out.
 * - **The poll cadence is per project**, not global: the timer ticks every
 *   minute, but a project is only read when its own `intervalMinutes` are up.
 *   The forced "poll now" from the pane bypasses that one check and nothing else.
 *
 * It notices and hands off. Spawning goes through an injected `spawn` (the
 * container wires it to `launchAgentTask`), the same shape as the PR watcher's
 * reviewer hook, so this file never learns what a chat is.
 */
import {
  issueKey,
  issueSourceLabel,
  matchIssue,
  resolveIssuePolicy,
  type Issue,
  type IssueClaim,
  type IssueConfig,
  type IssueWatch,
  type ResolvedIssuePolicy,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import type { BoundIssueTracker } from "./issues/service.js";

/** How often the timer ticks. Each project then decides whether it is due. */
export const ISSUE_TICK_MS = 60_000;

/** Issues read per poll — enough that a burst since the last poll all fits. */
const POLL_LIMIT = 100;

/**
 * How long a row may sit at `claimed` with no chat before it is treated as an
 * interrupted claim. Claim → label → spawn spans several awaits, and a restart
 * in that window (every app upgrade is one) leaves the row parked there with
 * nothing that would ever move it. Generous, because a slow spawn is not a
 * dead one: launching a chat reads GitHub and starts a runtime.
 */
export const CLAIM_GRACE_MS = 10 * 60_000;

export interface IssueWatcherSpawn {
  projectId: string;
  issues: Issue[];
  policy: ResolvedIssuePolicy;
  sourceLabel: string;
}

export interface IssueWatcherOptions {
  store: Pick<
    Store,
    | "listProjects"
    | "getProject"
    | "getSettings"
    | "listIssueClaims"
    | "claimIssues"
    | "updateIssueClaim"
    | "deleteIssueClaim"
    | "getIssueWatch"
    | "saveIssueWatch"
  >;
  bus: Pick<EventBus, "publish" | "on">;
  /** The project's authored `issues:` block — null when it has none. */
  configFor: (projectId: string) => IssueConfig | null;
  /** The project's tracker, or null when nothing claims its remote. */
  trackerFor: (projectId: string) => Promise<BoundIssueTracker | null>;
  /** Start the chat for a batch. Null = it could not be started. */
  spawn: (input: IssueWatcherSpawn) => Promise<{ chatId: string } | null>;
  /** Does this chat still exist? Undefined = unknown (treated as alive). */
  chatExists?: (chatId: string) => Promise<boolean>;
  /**
   * Whether THIS process should poll at all. False on a dev checkout, where a
   * poll would race the installed instance for the same issues. Read per tick,
   * never cached, so a test can flip it.
   */
  active?: () => boolean;
  tickMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What one project's poll did — returned to "poll now", recorded for the pane. */
export interface IssuePollResult {
  projectId: string;
  /** Why nothing was read at all, when nothing was. */
  skipped?: "disabled" | "not-due" | "no-source" | "baseline-set" | "at-capacity" | "inactive";
  seen: NonNullable<IssueWatch["lastSeen"]>;
  taken: number[];
  chatId?: string;
  error?: string;
}

export class IssueWatcher {
  private readonly store: IssueWatcherOptions["store"];
  private readonly bus: IssueWatcherOptions["bus"];
  private readonly opts: IssueWatcherOptions;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<IssueWatcherOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<IssueWatcherOptions["clearTimer"]>;

  private timer: unknown;
  private running = false;
  private disposed = false;
  private inflight: Promise<void> | undefined;
  /** Polls run one at a time, project by project, in the order asked. */
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(opts: IssueWatcherOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.bus = opts.bus;
    this.tickMs = opts.tickMs ?? ISSUE_TICK_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  /** Is this instance the one that polls? */
  get active(): boolean {
    return this.opts.active?.() ?? true;
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.timer = this.setTimer(() => void this.sweep().catch(() => {}), this.tickMs);
    // A deleted chat releases what it was holding. The claim row stays, marked
    // released, so the poll does not hand the same issue straight back out —
    // deleting the chat was the human saying stop.
    this.unsubscribe = this.bus.on("chat-deleted", (evt) => {
      void this.releaseChat(evt.chatId).catch(() => {});
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async drain(): Promise<void> {
    await this.inflight?.catch(() => {});
  }

  /** One pass over every project. Serialised behind any pass already running. */
  async sweep(): Promise<IssuePollResult[]> {
    const run = this.chain.then(() => this.runSweep());
    this.chain = run.catch(() => undefined);
    this.inflight = this.chain.then(() => undefined);
    return run;
  }

  /**
   * Poll one project NOW, ignoring its interval. The pane's button. Still
   * respects everything else — enrolment, the master switch, the baseline, the
   * cap — because "now" is about when, not about what.
   */
  async pollNow(projectId: string): Promise<IssuePollResult> {
    const run = this.chain.then(() => this.pollProject(projectId, { force: true }));
    this.chain = run.catch(() => undefined);
    this.inflight = this.chain.then(() => undefined);
    return run;
  }

  private async runSweep(): Promise<IssuePollResult[]> {
    if (this.disposed) return [];
    const out: IssuePollResult[] = [];
    for (const project of await this.store.listProjects().catch(() => [])) {
      if (this.disposed) break;
      out.push(await this.pollProject(project.id, { force: false }));
    }
    return out;
  }

  private async globallyEnabled(): Promise<boolean> {
    const settings = await this.store.getSettings().catch(() => null);
    return settings?.issueWatcher?.enabled ?? true;
  }

  private async pollProject(projectId: string, { force }: { force: boolean }): Promise<IssuePollResult> {
    const result: IssuePollResult = { projectId, seen: [], taken: [] };
    if (!this.active) return { ...result, skipped: "inactive" };
    const policy = resolveIssuePolicy(this.opts.configFor(projectId));
    if (!policy.enabled || !(await this.globallyEnabled())) return { ...result, skipped: "disabled" };

    const now = this.now();
    const watch = await this.store.getIssueWatch(projectId).catch(() => null);
    if (!watch) {
      // First sight of this project enrolled: mark where "new" starts and take
      // nothing. The backlog is the human's to hand over, one issue at a time.
      await this.store.saveIssueWatch({ projectId, baselineAt: now, lastPolledAt: now });
      return { ...result, skipped: "baseline-set" };
    }
    if (!force && watch.lastPolledAt && now - watch.lastPolledAt < policy.intervalMinutes * 60_000) {
      return { ...result, skipped: "not-due" };
    }

    const save = async (patch: Partial<IssueWatch>) => {
      await this.store.saveIssueWatch({ ...watch, ...patch, projectId, lastPolledAt: now }).catch(() => {});
    };

    let tracker: BoundIssueTracker | null;
    try {
      tracker = await this.opts.trackerFor(projectId);
    } catch (err) {
      const error = msg(err);
      await save({ lastError: error });
      return { ...result, error };
    }
    if (!tracker) {
      await save({ lastError: "no issue source: set issues.source or point origin at a supported host" });
      return { ...result, skipped: "no-source" };
    }
    const sourceLabel = issueSourceLabel(tracker.source);

    let open: Issue[];
    try {
      open = await tracker.list({ state: "open", limit: POLL_LIMIT });
    } catch (err) {
      const error = msg(err);
      await save({ lastError: error });
      this.bus.publish({ type: "notice", level: "warn", text: `Issue poll failed for ${sourceLabel}: ${error}` });
      return { ...result, error };
    }

    const claims = await this.reapInterrupted(
      tracker,
      policy,
      await this.store.listIssueClaims(projectId).catch(() => []),
      now,
    );
    const claimed = new Map(claims.map((c) => [c.key, c]));
    // Settle BEFORE counting: an issue the last chat closed is a slot this poll
    // can use, not one it should wait a full interval to notice.
    await this.settleClosed(tracker, claims, open, now);
    // Anything this instance took and is not finished with, whose chat is
    // still around. A chat that vanished without a `chat-deleted` (a crash, a
    // hand-deleted file) drops out of the count here rather than holding a
    // slot forever.
    let inFlight = 0;
    for (const c of claims) {
      if (c.state !== "claimed" && c.state !== "working") continue;
      if (c.chatId && this.opts.chatExists && !(await this.opts.chatExists(c.chatId).catch(() => true))) {
        await this.store.updateIssueClaim(c.key, { state: "released", note: "chat gone", updatedAt: now });
        continue;
      }
      inFlight++;
    }

    const candidates: Issue[] = [];
    for (const issue of open) {
      const key = issueKey(tracker.source, issue.number);
      const entry = { number: issue.number, title: issue.title, url: issue.url, taken: false as boolean, reason: "" };
      const prior = claimed.get(key);
      if (prior) entry.reason = `${prior.state} by this instance`;
      else if (Date.parse(issue.createdAt) <= watch.baselineAt) entry.reason = "opened before enrolment";
      else {
        const m = matchIssue(issue, policy);
        if (!m.ok) entry.reason = m.reason;
        else candidates.push(issue);
      }
      result.seen.push(entry.reason ? entry : { ...entry, reason: undefined });
    }
    // Oldest first: the batch is capped, and the issue that has waited longest
    // should not lose its place to one opened a minute ago.
    candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const room = Math.max(0, policy.maxConcurrent - inFlight);
    const overflow = candidates.splice(room);
    for (const issue of overflow) mark(result.seen, issue.number, `at capacity (${policy.maxConcurrent} in flight)`);
    if (!candidates.length) {
      await save({ lastError: undefined, lastSeen: result.seen });
      return { ...result, skipped: room === 0 && overflow.length ? "at-capacity" : undefined };
    }

    // Claim in the store first: a second poll landing right now gets the rest.
    const taken = await this.store.claimIssues(
      candidates.map((issue) => ({
        key: issueKey(tracker.source, issue.number),
        projectId,
        source: tracker.source,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: "claimed",
        mode: policy.mode,
        claimedAt: now,
        updatedAt: now,
      })),
    );
    const takenNumbers = new Set(taken.map((c) => c.number));
    const batch: Issue[] = [];
    for (const issue of candidates) {
      if (!takenNumbers.has(issue.number)) {
        mark(result.seen, issue.number, "claimed by a concurrent poll");
        continue;
      }
      // The label is the lock the OTHER instance sees. Labelling fails → that
      // issue is out of this batch and its claim is dropped, so the next poll
      // (or the other instance) can try again.
      try {
        await tracker.update(issue.number, { addLabels: [policy.claimLabel] });
        batch.push(issue);
      } catch (err) {
        const key = issueKey(tracker.source, issue.number);
        await this.store.updateIssueClaim(key, { state: "failed", note: `label: ${msg(err)}`, updatedAt: now });
        mark(result.seen, issue.number, `could not label: ${msg(err)}`);
      }
    }
    if (!batch.length) {
      await save({ lastError: undefined, lastSeen: result.seen });
      return result;
    }

    const spawned = await this.opts
      .spawn({ projectId, issues: batch, policy, sourceLabel })
      .catch((err: unknown) => {
        result.error = msg(err);
        return null;
      });
    for (const issue of batch) {
      const key = issueKey(tracker.source, issue.number);
      if (spawned) {
        await this.store.updateIssueClaim(key, { state: "working", chatId: spawned.chatId, updatedAt: now });
        mark(result.seen, issue.number, undefined, true);
        result.taken.push(issue.number);
      } else {
        // Spawn failed: give the issue back. The label comes off so nothing
        // reads it as being worked, and the row records why.
        await this.store.updateIssueClaim(key, {
          state: "failed",
          note: `spawn: ${result.error ?? "unknown"}`,
          updatedAt: now,
        });
        await tracker.update(issue.number, { removeLabels: [policy.claimLabel] }).catch(() => {});
        mark(result.seen, issue.number, `chat could not be started: ${result.error ?? "unknown"}`);
      }
    }
    if (spawned) {
      result.chatId = spawned.chatId;
      const n = batch.length;
      this.bus.publish({
        type: "notice",
        chatId: spawned.chatId,
        level: "info",
        text: `Started a chat for ${n === 1 ? `issue #${batch[0]!.number}` : `${n} new issues`} in ${sourceLabel}`,
      });
    }
    await save({ lastError: result.error, lastSeen: result.seen });
    return result;
  }

  /**
   * Drop claims a crash or restart left at `claimed` with no chat. The row is
   * DELETED rather than released: released means a human ended it and it must
   * not come back, whereas this one was never handed to anyone — the issue is
   * still new, and the next poll should take it again. The label comes off so
   * that poll (or the other instance) is not turned away by our own lock.
   */
  private async reapInterrupted(
    tracker: BoundIssueTracker,
    policy: ResolvedIssuePolicy,
    claims: IssueClaim[],
    now: number,
  ): Promise<IssueClaim[]> {
    const kept: IssueClaim[] = [];
    for (const c of claims) {
      if (c.state === "claimed" && !c.chatId && now - c.claimedAt > CLAIM_GRACE_MS) {
        await tracker.update(c.number, { removeLabels: [policy.claimLabel] }).catch(() => {});
        await this.store.deleteIssueClaim(c.key).catch(() => {});
        continue;
      }
      kept.push(c);
    }
    return kept;
  }

  /**
   * A working claim whose issue is no longer open is done — the PR merged and
   * `Fixes #n` closed it, or the chat closed it, or a human did. One `get` per
   * working claim not in the open list, which is a handful at most.
   */
  private async settleClosed(
    tracker: BoundIssueTracker,
    claims: IssueClaim[],
    open: Issue[],
    now: number,
  ): Promise<void> {
    const openNumbers = new Set(open.map((i) => i.number));
    for (const c of claims) {
      if (c.state !== "working" || openNumbers.has(c.number)) continue;
      const issue = await tracker.get(c.number).catch(() => null);
      if (issue && issue.state === "open") continue;
      c.state = "done";
      await this.store.updateIssueClaim(c.key, { state: "done", updatedAt: now });
    }
  }

  /** Release every claim a deleted chat held, and take the label back off. */
  async releaseChat(chatId: string): Promise<void> {
    const now = this.now();
    for (const c of await this.store.listIssueClaims().catch(() => [])) {
      if (c.chatId !== chatId || (c.state !== "claimed" && c.state !== "working")) continue;
      await this.store.updateIssueClaim(c.key, { state: "released", note: "chat deleted", updatedAt: now });
      const tracker = await this.opts.trackerFor(c.projectId).catch(() => null);
      const label = resolveIssuePolicy(this.opts.configFor(c.projectId)).claimLabel;
      await tracker?.update(c.number, { removeLabels: [label] }).catch(() => {});
    }
  }

  /** The pane's view of one project: the watch row plus its claims. */
  async status(projectId: string): Promise<{ watch: IssueWatch | null; claims: IssueClaim[]; active: boolean }> {
    const [watch, claims] = await Promise.all([
      this.store.getIssueWatch(projectId).catch(() => null),
      this.store.listIssueClaims(projectId).catch(() => []),
    ]);
    return { watch, claims: claims.slice().reverse(), active: this.active };
  }
}

function mark(seen: IssuePollResult["seen"], number: number, reason: string | undefined, taken = false): void {
  const entry = seen.find((s) => s.number === number);
  if (entry) {
    entry.reason = reason;
    entry.taken = taken;
  }
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
