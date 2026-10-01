/**
 * HomeService — the cross-project overview behind `GET /api/home`.
 *
 * The brief for this surface was one word: SNAPPY. Everything below is in
 * service of that, so it is worth writing down what it refuses to do as much as
 * what it does.
 *
 * NO SUBPROCESSES, EVER, ON THIS PATH. Not `git status`, not `git log`, not
 * `gh pr list`. Every number comes from the state database (two indexed
 * aggregates — see `MetricsService.projectRollup`), from chat records that are
 * already resident in memory, or from the in-memory attention queue. A
 * homepage that shells out is a homepage whose arrival time is set by whichever
 * repo happens to be mid-fetch, and that is not a tradeoff worth making for
 * facts the Workspace view already shows on demand.
 *
 * STALE-WHILE-REVALIDATE, NOT A PLAIN TTL. A plain TTL is a cache that makes
 * one unlucky visitor in every window pay the full cost. This keeps the last
 * snapshot and serves it IMMEDIATELY whenever one exists, kicking off a refresh
 * behind the response when it has gone stale. Only the very first caller after
 * boot ever waits — and {@link start} primes it so that caller is usually
 * nobody. The snapshot carries `computedAt`, so a reading a few seconds old is
 * a reading the page can label rather than a lie.
 *
 * The one caller that DOES wait is the Reload button, which passes `force`.
 * Everything above is why it has to: without it, a control whose entire job is
 * "give me a newer number" would answer from the same cache as everything else
 * and finish holding the snapshot it started with.
 *
 * ONE WINDOW CACHED PER WIDTH. The window picker offers three widths and each
 * gets its own slot, because switching width must not evict the one you came
 * back to.
 *
 * WHAT IS DELIBERATELY NOT HERE. Live PR / CI state: it is a `gh` call per
 * repo, i.e. the single slowest thing the app can ask for. If it is ever wanted
 * on this page it loads lazily from `/api/prs` after first paint and never
 * blocks the view. And the Growth tab's git walk (`GET /api/metrics/growth`) is
 * nowhere near this: it streams NDJSON precisely because it takes long enough
 * to need a progress bar.
 */
import {
  HOME_WINDOW_MS,
  isChatWorking,
  type HomeActivity,
  type HomeOverview,
  type HomeProject,
  type HomeWindow,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { MetricsService } from "./metrics.js";
import type { AttentionQueue } from "./attention.js";

/**
 * How long a snapshot is served before a refresh is scheduled behind it, PER
 * WIDTH — because the three widths do not cost the same and do not go stale at
 * the same rate.
 *
 * Measured on the real install (338 MB, 298k events, 400k spans): the rollup is
 * 10 ms over 24 hours, 50 ms over 7 days and ~600 ms over 30 days, which is the
 * honest price of walking a quarter-million rows and is not something a covering
 * index can be added for in passing — migrating a ledger this size at boot is
 * its own (already-bitten) failure mode.
 *
 * But a 30-day total is also the figure that moves LEAST: one more tool call
 * shifts it by a part in a hundred thousand. So the wider and more expensive the
 * window, the longer its answer stands. The user never waits for any of it —
 * stale is served immediately and the refresh happens behind the response — so
 * what this table really buys is not latency, it is how often the event loop
 * every streaming chat shares gives up half a second.
 *
 * Nothing here is a live readout, which is what makes all three defensible: the
 * counts are "how much happened lately", and the one number that does move on
 * human timescales — chats working right now — is cheap and rides along with
 * whichever width is showing.
 */
const TTL_MS: Record<HomeWindow, number> = {
  "24h": 10_000,
  "7d": 30_000,
  "30d": 120_000,
};

/** How many lines the cross-project activity tail carries. */
const RECENT = 12;

export interface HomeServiceDeps {
  store: Store;
  metrics: MetricsService;
  attention: AttentionQueue;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Where a failed background refresh is reported. Injectable for tests. */
  onError?: (err: unknown) => void;
}

export class HomeService {
  private readonly store: Store;
  private readonly metrics: MetricsService;
  private readonly attention: AttentionQueue;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly cache = new Map<HomeWindow, HomeOverview>();
  /**
   * The recompute currently running for each width, so callers SHARE one.
   *
   * Keyed before the first `await`, which is the whole point: without it two
   * requests that arrive for a cold width — or a visitor who beats the boot
   * warm-up — each run the rollup, and over 30 days that is half a second of
   * blocked event loop twice over for one answer.
   */
  private readonly inFlight = new Map<HomeWindow, Promise<HomeOverview>>();

  constructor(deps: HomeServiceDeps) {
    this.store = deps.store;
    this.metrics = deps.metrics;
    this.attention = deps.attention;
    this.now = deps.now ?? (() => Date.now());
    this.onError =
      deps.onError ?? ((err) => console.error("[Dispatch] home overview failed:", err));
  }

  /**
   * Warm the default window so the first visitor doesn't pay for the cold read.
   *
   * Fire-and-forget on purpose: boot must not wait on it, and a failure here
   * costs one slow first load rather than a server that won't start.
   */
  start(): void {
    void this.overview("7d").catch(this.onError);
  }

  /**
   * The page. Returns the cached snapshot the instant one exists; computes
   * (and waits) only when there is nothing at all to serve, or when the caller
   * explicitly asked for a fresh one.
   *
   * `force` is what the Reload button sends. Without it that button cannot do
   * anything: a fresh cache answers from memory and a stale one answers from
   * memory too, refreshing behind the response — so one click always finished
   * holding exactly the snapshot it started with, which is a control that lies.
   * Forcing waits for the recompute, which is the one place on this surface
   * where waiting is what was asked for.
   */
  async overview(window: HomeWindow, opts: { force?: boolean } = {}): Promise<HomeOverview> {
    const hit = this.cache.get(window);
    if (opts.force || !hit) return this.refresh(window);
    if (this.now() - hit.computedAt > TTL_MS[window]) {
      // Behind the response, not in front of it. `setTimeout(0)` rather than an
      // un-awaited call so the reply is flushed before the recompute takes the
      // loop — otherwise "serve stale immediately" is only true on paper.
      //
      // `refresh` dedupes against `inFlight`, so a burst of stale requests
      // schedules one recompute, and its rejection is handled HERE: a `void`
      // on a promise with only a `finally` leaves a transient SQLite error as
      // an unhandled rejection, which under `--unhandled-rejections=strict`
      // takes the server down rather than continuing to serve the stale copy
      // that is sitting right there.
      setTimeout(() => void this.refresh(window).catch(this.onError), 0);
    }
    return hit;
  }

  /**
   * Recompute one window and replace its slot — or join the recompute already
   * running for it.
   */
  private refresh(window: HomeWindow): Promise<HomeOverview> {
    const running = this.inFlight.get(window);
    if (running) return running;
    const started = this.now();
    const task = this.compute(window, started)
      .then((overview) => {
        this.cache.set(window, overview);
        return overview;
      })
      .finally(() => this.inFlight.delete(window));
    this.inFlight.set(window, task);
    return task;
  }

  private async compute(window: HomeWindow, startedAt: number): Promise<HomeOverview> {
    const to = startedAt + 1;
    const from = to - HOME_WINDOW_MS[window];

    const [projects, chats] = await Promise.all([
      this.store.listProjects(),
      this.store.listChats(),
    ]);

    // Attention is an in-memory list of outstanding items; counting it per
    // project means mapping chat → project, which the chats pass above already
    // has. One pass, no lookups back into the store.
    const projectOfChat = new Map<string, string>();
    for (const chat of chats) projectOfChat.set(chat.id, chat.projectId);
    const attentionByProject = new Map<string, number>();
    for (const item of this.attention.list()) {
      const pid = projectOfChat.get(item.chatId);
      if (!pid) continue;
      attentionByProject.set(pid, (attentionByProject.get(pid) ?? 0) + 1);
    }

    const chatCount = new Map<string, number>();
    const workingCount = new Map<string, number>();
    const lastChatActivity = new Map<string, number>();
    const titleOfChat = new Map<string, string>();
    for (const chat of chats) {
      titleOfChat.set(chat.id, chat.title);
      // Archived chats are hidden everywhere else in the app; a project whose
      // only chats are archived should read as quiet, not as busy.
      if (chat.archived) continue;
      chatCount.set(chat.projectId, (chatCount.get(chat.projectId) ?? 0) + 1);
      if (isChatWorking(chat.status)) {
        workingCount.set(chat.projectId, (workingCount.get(chat.projectId) ?? 0) + 1);
      }
      const at = chat.updatedAt ?? chat.createdAt;
      lastChatActivity.set(
        chat.projectId,
        Math.max(lastChatActivity.get(chat.projectId) ?? 0, at),
      );
    }

    const { byProject, spark } = this.metrics.projectRollup(from, to);
    const days = dayRange(from, to);

    const rows: HomeProject[] = projects.map((p) => {
      const ledger = byProject[p.id];
      const perDay = spark[p.id] ?? {};
      return {
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        chats: chatCount.get(p.id) ?? 0,
        working: workingCount.get(p.id) ?? 0,
        attention: attentionByProject.get(p.id) ?? 0,
        events: ledger?.events ?? 0,
        runtimeMs: ledger?.runtimeMs ?? 0,
        spark: days.map((d) => perDay[d] ?? 0),
        // The ledger's newest row OR the newest chat touch, whichever is later:
        // a project whose last act was a human sending a message has no ledger
        // row for it, and reading "3 days ago" on a chat you typed in this
        // morning is the kind of wrong that makes the whole page suspect.
        lastActivityAt: Math.max(ledger?.lastAt ?? 0, lastChatActivity.get(p.id) ?? 0),
      };
    });

    // Busiest first, then by recency so a brand-new project with no rows yet
    // still lands above a year-dormant one.
    rows.sort((a, b) => b.events - a.events || b.lastActivityAt - a.lastActivityAt);

    const nameOfProject = new Map(projects.map((p) => [p.id, p.name]));
    const recent: HomeActivity[] = this.metrics
      .recent({ from, to, limit: RECENT })
      .map((e) => ({
        ts: e.ts,
        category: e.category,
        identifier: e.identifier,
        projectId: e.projectId,
        projectName: e.projectId ? nameOfProject.get(e.projectId) : undefined,
        chatId: e.chatId,
        chatTitle: e.chatId ? titleOfChat.get(e.chatId) : undefined,
      }));

    const sum = (pick: (r: HomeProject) => number): number =>
      rows.reduce((n, r) => n + pick(r), 0);

    return {
      computedAt: startedAt,
      computeMs: Math.max(0, this.now() - startedAt),
      window,
      from,
      to,
      totals: {
        projects: rows.length,
        chats: sum((r) => r.chats),
        working: sum((r) => r.working),
        // The queue's own size, not the per-project sum: an item on a chat
        // whose project has since been deleted is still something waiting on
        // you, and dropping it from the headline would hide it completely.
        attention: this.attention.size(),
        events: sum((r) => r.events),
        runtimeMs: sum((r) => r.runtimeMs),
      },
      projects: rows,
      recent,
    };
  }
}

/**
 * The day indices (`ts / 86_400_000`, floored) the window spans, oldest first.
 *
 * Computed from the window rather than from the rows so every project's spark
 * has the SAME length and the same x-axis — sparklines built from "the days
 * this project had activity" are not comparable to each other, which is the
 * only thing a column of them is for. A quiet day is a zero, not a gap.
 */
export function dayRange(from: number, to: number): number[] {
  const first = Math.floor(from / 86_400_000);
  const last = Math.floor((to - 1) / 86_400_000);
  const out: number[] = [];
  for (let d = first; d <= last; d++) out.push(d);
  return out;
}
