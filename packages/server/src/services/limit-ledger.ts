/**
 * LimitLedger — every limit window's readings over time, and the transitions
 * that meant something (`limit_samples` / `limit_events` / `limit_accounts`,
 * migration 11). The sampler feeds it; the Metrics view's Limits tab reads it.
 *
 * THE PREVIOUS READING IS THE WHOLE GAME. A reset, an early reset or a drop is
 * only visible as the difference between this read and the last one, so the
 * last one per window is held in memory and re-hydrated from the table on the
 * first read after a restart. Without that, a reset that happened while the
 * server was down would be invisible — the first post-restart read would have
 * nothing to compare against.
 *
 * STORAGE IS COMPRESSED, LOSSLESSLY FOR THE LINE. An idle account reads the
 * same figures all night; a row per read would be thousands of identical rows.
 * So an unchanged reading is stored at most every {@link HOLD_MS}, and when the
 * figure finally does change, the last unchanged reading is written FIRST — the
 * "hold point". Without it the chart would draw a slow ramp across a gap that
 * was really flat-then-jump, which is precisely the shape a sudden drop has.
 */
import {
  LIMIT_PERIOD_HOURS,
  limitPeriodEnd,
  limitPeriodStart,
  type LimitEvent,
  type LimitEventKind,
  type LimitPeriod,
  type LimitPoint,
  type LimitQueryInput,
  type LimitReading,
  type LimitWindowSeries,
  type LimitYield,
} from "@dispatch/shared";
import type { StateDb } from "../store/db.js";
import { classifyStep, readingChanged, type Seen } from "./limit-detect.js";

/** Longest an unchanged reading goes unstored. */
export const HOLD_MS = 30 * 60_000;

/**
 * Two stored readings further apart than this mean nobody was reading the
 * account in between — the app was off, or every read failed. A live idle
 * account is stored every HOLD_MS, read at most every 15 minutes, and a failing
 * one backs off to 30: so a healthy gap tops out near 45 minutes, and an hour
 * is the first span that can't be explained by compression alone.
 */
export const COVER_GAP_MS = 60 * 60_000;

/**
 * Most yield rows one response carries. Idle periods are rows (that is how
 * idle is told from unwatched), so an hourly 90 days is ~2160 per account —
 * and the page re-fetches every minute.
 */
export const YIELD_ROW_CAP = 3000;

/**
 * Consecutive successful reads a window must be missing from before it is
 * declared gone. Claude reports some per-model windows as `null` on and off;
 * one absent read is noise, three in a row is the provider having stopped.
 */
export const REMOVE_AFTER_MISSES = 3;

/** One account's read, on the way in. */
export interface LimitObservation {
  ts: number;
  subscriptionId: string;
  provider: string;
  readings: readonly LimitReading[];
  planType?: string | null;
  resetCredits?: number | null;
  /** `poll` (the sampler asked) or `push` (the runtime told us unasked). */
  source?: "poll" | "push";
}

interface WindowState extends Seen {
  title: string;
  windowMinutes: number | null;
  /** Whether this exact reading is in the table (false = held back). */
  stored: boolean;
  lastStoredTs: number;
  /** Successful reads in a row this window was absent from. */
  misses: number;
}

interface AccountState {
  windows: Map<string, WindowState>;
  planType: string | null;
  resetCredits: number | null;
  /** True when any reading existed before this process's first read. */
  known: boolean;
}

/** Labeller for account ids — supplied per request, settings move. */
export type LimitAccountLabeller = (subscriptionId: string) => string;

const SAMPLE_SQL = `
INSERT INTO limit_samples
  (ts, subscription_id, provider, window_id, title, window_minutes, percent, resets_at, source)
VALUES (?,?,?,?,?,?,?,?,?)`;

const EVENT_SQL = `
INSERT INTO limit_events
  (ts, prev_ts, subscription_id, provider, window_id, title, kind,
   from_percent, to_percent, prev_resets_at, resets_at, detail)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

export class LimitLedger {
  private readonly accounts = new Map<string, AccountState>();

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one account's read and return the events it revealed. Never throws:
   * a failed write is logged, and the read is simply lost.
   */
  observe(obs: LimitObservation): LimitEvent[] {
    try {
      return this.db.tx(() => this.observeTx(obs));
    } catch (err) {
      console.error("[Dispatch] limits: write failed:", err);
      // The in-memory state may now be ahead of the table; drop it so the next
      // read re-hydrates from what was actually committed.
      this.accounts.delete(obs.subscriptionId);
      return [];
    }
  }

  private observeTx(obs: LimitObservation): LimitEvent[] {
    const acct = this.hydrate(obs.subscriptionId);
    const events: LimitEvent[] = [];
    const insertSample = this.db.prepare(SAMPLE_SQL);
    const source = obs.source ?? "poll";
    const store = (windowId: string, w: Omit<WindowState, "stored" | "lastStoredTs" | "misses">) =>
      insertSample.run(
        w.ts,
        obs.subscriptionId,
        obs.provider,
        windowId,
        w.title,
        w.windowMinutes,
        w.percent,
        w.resetsAt,
        source,
      );
    const event = (e: Omit<LimitEvent, "seq" | "subscriptionId" | "provider">) => {
      const res = this.db
        .prepare(EVENT_SQL)
        .run(
          e.ts,
          e.prevTs,
          obs.subscriptionId,
          obs.provider,
          e.windowId,
          e.title,
          e.kind,
          e.fromPercent,
          e.toPercent,
          e.prevResetsAt,
          e.resetsAt,
          e.detail,
        );
      events.push({
        ...e,
        seq: Number(res.lastInsertRowid),
        subscriptionId: obs.subscriptionId,
        provider: obs.provider,
      });
    };

    const present = new Set<string>();
    for (const r of obs.readings) {
      present.add(r.windowId);
      const next = { ts: obs.ts, percent: r.percent, resetsAt: r.resetsAt };
      const prev = acct.windows.get(r.windowId);
      const base = { ...next, title: r.title, windowMinutes: r.windowMinutes };
      if (!prev) {
        store(r.windowId, base);
        acct.windows.set(r.windowId, { ...base, stored: true, lastStoredTs: obs.ts, misses: 0 });
        // A window on an account we've read before is news; every window on
        // the very first read of an account is just the starting inventory.
        if (acct.known) {
          event({
            ts: obs.ts,
            prevTs: null,
            windowId: r.windowId,
            title: r.title,
            kind: "window_added",
            fromPercent: null,
            toPercent: r.percent,
            prevResetsAt: null,
            resetsAt: r.resetsAt,
            detail: null,
          });
        }
        continue;
      }
      // Out-of-order (a push racing a poll): the older figure is not news.
      if (obs.ts <= prev.ts) continue;

      const kind = classifyStep(prev, next, r.windowMinutes ?? prev.windowMinutes);
      if (kind) {
        event({
          ts: obs.ts,
          prevTs: prev.ts,
          windowId: r.windowId,
          title: r.title,
          kind,
          fromPercent: prev.percent,
          toPercent: r.percent,
          prevResetsAt: prev.resetsAt,
          resetsAt: r.resetsAt,
          detail: null,
        });
      }

      let stored = false;
      let lastStoredTs = prev.lastStoredTs;
      if (kind || readingChanged(prev, next)) {
        if (!prev.stored) store(r.windowId, prev);
        store(r.windowId, base);
        stored = true;
        lastStoredTs = obs.ts;
      } else if (obs.ts - prev.lastStoredTs >= HOLD_MS) {
        store(r.windowId, base);
        stored = true;
        lastStoredTs = obs.ts;
      }
      acct.windows.set(r.windowId, { ...base, stored, lastStoredTs, misses: 0 });
    }

    // Windows this read didn't mention. Only a POLL that mentioned something
    // counts: an empty one is a partial failure, and a push carries one bucket
    // at a time (Codex announces `premium` without restating `codex`).
    if (source === "poll" && obs.readings.length) {
      for (const [id, w] of acct.windows) {
        if (present.has(id)) continue;
        w.misses += 1;
        if (w.misses < REMOVE_AFTER_MISSES) continue;
        if (!w.stored) store(id, w);
        event({
          ts: obs.ts,
          prevTs: w.ts,
          windowId: id,
          title: w.title,
          kind: "window_removed",
          fromPercent: w.percent,
          toPercent: null,
          prevResetsAt: w.resetsAt,
          resetsAt: null,
          detail: null,
        });
        acct.windows.delete(id);
      }
    }

    const accountEvent = (kind: LimitEventKind, title: string, detail: string) =>
      event({
        ts: obs.ts,
        prevTs: null,
        windowId: null,
        title,
        kind,
        fromPercent: null,
        toPercent: null,
        prevResetsAt: null,
        resetsAt: null,
        detail,
      });
    const plan = obs.planType ?? null;
    if (plan !== null && acct.planType !== null && plan !== acct.planType) {
      accountEvent("plan_changed", "Plan", `${acct.planType} → ${plan}`);
    }
    const credits = obs.resetCredits ?? null;
    if (credits !== null && acct.resetCredits !== null && credits !== acct.resetCredits) {
      accountEvent("credits_changed", "Reset credits", `${acct.resetCredits} → ${credits}`);
    }
    if (plan !== null) acct.planType = plan;
    if (credits !== null) acct.resetCredits = credits;
    this.db
      .prepare(
        `INSERT INTO limit_accounts (subscription_id, provider, plan_type, reset_credits, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(subscription_id) DO UPDATE SET
           provider = excluded.provider,
           plan_type = COALESCE(excluded.plan_type, plan_type),
           reset_credits = COALESCE(excluded.reset_credits, reset_credits),
           updated_at = excluded.updated_at`,
      )
      .run(obs.subscriptionId, obs.provider, plan, credits, obs.ts);
    acct.known = true;
    return events;
  }

  /** Load an account's last known state from the table, once per process. */
  private hydrate(subscriptionId: string): AccountState {
    const cached = this.accounts.get(subscriptionId);
    if (cached) return cached;
    const windows = new Map<string, WindowState>();
    // The newest sample per window, unless a `window_removed` came after it —
    // otherwise every restart would resurrect a dead window and then, three
    // reads later, report it removed all over again.
    const rows = this.db
      .prepare(
        `SELECT s.window_id AS id, s.ts, s.title, s.window_minutes AS wm,
                s.percent, s.resets_at AS ra
           FROM limit_samples s
           JOIN (SELECT window_id, MAX(seq) AS seq FROM limit_samples
                  WHERE subscription_id = ? GROUP BY window_id) last
             ON last.seq = s.seq
          WHERE NOT EXISTS (
            SELECT 1 FROM limit_events e
             WHERE e.subscription_id = s.subscription_id AND e.window_id = s.window_id
               AND e.kind = 'window_removed' AND e.ts >= s.ts)`,
      )
      .all(subscriptionId) as {
      id: string;
      ts: number;
      title: string;
      wm: number | null;
      percent: number;
      ra: number | null;
    }[];
    for (const r of rows) {
      windows.set(r.id, {
        ts: Number(r.ts),
        percent: Number(r.percent),
        resetsAt: r.ra === null ? null : Number(r.ra),
        title: r.title,
        windowMinutes: r.wm === null ? null : Number(r.wm),
        stored: true,
        lastStoredTs: Number(r.ts),
        misses: 0,
      });
    }
    const acct = this.db
      .prepare("SELECT plan_type AS p, reset_credits AS c FROM limit_accounts WHERE subscription_id = ?")
      .get(subscriptionId) as { p: string | null; c: number | null } | undefined;
    const state: AccountState = {
      windows,
      planType: acct?.p ?? null,
      resetCredits: acct?.c === null || acct?.c === undefined ? null : Number(acct.c),
      known: rows.length > 0 || acct !== undefined,
    };
    this.accounts.set(subscriptionId, state);
    return state;
  }

  /* ------------------------------------------------------------------ read */

  windows(q: LimitQueryInput, label: LimitAccountLabeller): LimitWindowSeries[] {
    const to = q.to ?? this.now() + 1;
    const from = q.from ?? 0;
    const subs = q.subscriptionIds?.length ? q.subscriptionIds : null;
    const subSql = subs ? ` AND subscription_id IN (${subs.map(() => "?").join(",")})` : "";
    const params = subs ?? [];
    const rows = this.db
      .prepare(
        `SELECT subscription_id AS s, provider AS p, window_id AS w, title, window_minutes AS wm,
                ts, percent, resets_at AS ra
           FROM limit_samples
          WHERE ts >= ? AND ts < ?${subSql}
          UNION ALL
         -- The last reading before the range, so a line starts at the left edge
         -- instead of at whenever the figure next happened to change.
         SELECT s.subscription_id, s.provider, s.window_id, s.title, s.window_minutes,
                s.ts, s.percent, s.resets_at
           FROM limit_samples s
           JOIN (SELECT subscription_id, window_id, MAX(seq) AS seq FROM limit_samples
                  WHERE ts < ?${subSql} GROUP BY subscription_id, window_id) b
             ON b.seq = s.seq
          ORDER BY ts ASC`,
      )
      .all(from, to, ...params, from, ...params) as {
      s: string;
      p: string;
      w: string;
      title: string;
      wm: number | null;
      ts: number;
      percent: number;
      ra: number | null;
    }[];
    const out = new Map<string, LimitWindowSeries>();
    for (const r of rows) {
      const key = `${r.s}\u0000${r.w}`;
      let series = out.get(key);
      if (!series) {
        series = {
          subscriptionId: r.s,
          subscriptionLabel: label(r.s),
          provider: r.p,
          windowId: r.w,
          title: r.title,
          windowMinutes: r.wm === null ? null : Number(r.wm),
          points: [],
        };
        out.set(key, series);
      }
      // The newest title wins: a provider renaming a window renames its line.
      series.title = r.title;
      series.points.push({
        ts: Number(r.ts),
        percent: Number(r.percent),
        resetsAt: r.ra === null ? null : Number(r.ra),
      });
    }
    // Extend each line to the newest reading even when that one was held back
    // as unchanged — otherwise an idle account's line stops up to HOLD_MS short
    // of now and reads as "the sampler stopped".
    for (const series of out.values()) {
      const held = this.accounts.get(series.subscriptionId)?.windows.get(series.windowId);
      const last = series.points.at(-1);
      if (held && !held.stored && last && held.ts > last.ts && held.ts < to) {
        series.points.push({ ts: held.ts, percent: held.percent, resetsAt: held.resetsAt });
      }
    }
    return [...out.values()].sort(
      (a, b) =>
        a.subscriptionLabel.localeCompare(b.subscriptionLabel) ||
        (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity) ||
        a.windowId.localeCompare(b.windowId),
    );
  }

  events(q: LimitQueryInput, limit = 500): LimitEvent[] {
    const to = q.to ?? this.now() + 1;
    const from = q.from ?? 0;
    const subs = q.subscriptionIds?.length ? q.subscriptionIds : null;
    const subSql = subs ? ` AND subscription_id IN (${subs.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `SELECT seq, ts, prev_ts, subscription_id, provider, window_id, title, kind,
                from_percent, to_percent, prev_resets_at, resets_at, detail
           FROM limit_events WHERE ts >= ? AND ts < ?${subSql}
          ORDER BY ts DESC, seq DESC LIMIT ?`,
      )
      .all(from, to, ...(subs ?? []), limit) as Record<string, unknown>[];
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      prevTs: num(r.prev_ts),
      subscriptionId: String(r.subscription_id),
      provider: String(r.provider),
      windowId: r.window_id === null ? null : String(r.window_id),
      title: String(r.title),
      kind: r.kind as LimitEventKind,
      fromPercent: num(r.from_percent),
      toPercent: num(r.to_percent),
      prevResetsAt: num(r.prev_resets_at),
      resetsAt: num(r.resets_at),
      detail: r.detail === null ? null : String(r.detail),
    }));
  }

  /**
   * Per account per period: the points each window climbed, beside what the
   * account's turns spent — the "what did 1% buy" table.
   *
   * POINTS are summed step by step. A rise counts as itself; a reset (or early
   * reset) counts the post-reset figure, since that much was spent after the
   * window emptied; a mid-window DROP counts nothing — usage didn't go
   * negative, and what was spent across it is unknowable. A step lands in the
   * period of the reading that saw it.
   *
   * TOKENS are spread evenly over the time each turn ran (`duration_ms`), so a
   * long turn's spend is shared by every period it overlapped rather than
   * dumped on the one it ended in. Only spend from the account's first reading
   * onward counts: before it there are no points to set it against.
   */
  yields(q: LimitQueryInput, label: LimitAccountLabeller, period: LimitPeriod = "1d"): LimitYield[] {
    return this.yieldPeriods(q, label, period).rows;
  }

  /**
   * {@link yields}, plus where the row cap cut it. The cut is always on a
   * period boundary and always reported: a period silently missing from the
   * response is drawn as "nobody was reading", which is precisely the claim
   * `coverage` exists to keep honest.
   */
  yieldPeriods(
    q: LimitQueryInput,
    label: LimitAccountLabeller,
    period: LimitPeriod = "1d",
    cap = YIELD_ROW_CAP,
  ): { rows: LimitYield[]; truncatedBefore: number | null } {
    const hours = LIMIT_PERIOD_HOURS[period];
    const to = Math.min(q.to ?? this.now() + 1, this.now() + 1);
    const cover = new Map(
      (
        this.db
          .prepare(
            "SELECT subscription_id AS s, MIN(ts) AS lo, MAX(ts) AS hi FROM limit_samples GROUP BY s",
          )
          .all() as { s: string; lo: number; hi: number }[]
      ).map((r) => [r.s, { lo: Number(r.lo), hi: Number(r.hi) }]),
    );
    const wanted = q.subscriptionIds?.length ? new Set(q.subscriptionIds) : null;
    const subs = [...cover.keys()].filter((s) => !wanted || wanted.has(s));
    if (!subs.length) return { rows: [], truncatedBefore: null };
    const from = q.from ?? Math.min(...subs.map((s) => cover.get(s)!.lo));

    interface Cell {
      sub: string;
      start: number;
      points: Map<string, number>;
      total: number;
      output: number;
      cost: number;
      priced: boolean;
      turns: number;
      unpriced: number;
    }
    const cells = new Map<string, Cell>();
    const cell = (sub: string, start: number): Cell => {
      const key = `${sub}|${start}`;
      let c = cells.get(key);
      if (!c) {
        c = { sub, start, points: new Map(), total: 0, output: 0, cost: 0, priced: false, turns: 0, unpriced: 0 };
        cells.set(key, c);
      }
      return c;
    };

    /* ---- points ---- */
    const meta = new Map<
      string,
      { provider: string; windows: Map<string, { title: string; windowMinutes: number | null }> }
    >();
    for (const series of this.windows({ from, to, subscriptionIds: subs }, label)) {
      let m = meta.get(series.subscriptionId);
      if (!m) meta.set(series.subscriptionId, (m = { provider: series.provider, windows: new Map() }));
      m.windows.set(series.windowId, { title: series.title, windowMinutes: series.windowMinutes });
      const pts = series.points;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1]!;
        const next = pts[i]!;
        if (next.ts < from || next.ts >= to) continue;
        const kind = classifyStep(prev, next, series.windowMinutes);
        const gained =
          kind === "reset" || kind === "early_reset"
            ? next.percent
            : kind === "drop"
              ? 0
              : Math.max(0, next.percent - prev.percent);
        if (gained <= 0) continue;
        const c = cell(series.subscriptionId, limitPeriodStart(next.ts, hours));
        c.points.set(series.windowId, (c.points.get(series.windowId) ?? 0) + gained);
      }
    }

    /* ---- tokens, spread over each turn's run ---- */
    // A day of lookahead on `ts`: a turn that ENDED after the range may have
    // run inside it.
    const rows = this.db
      .prepare(
        `SELECT subscription_id AS s, ts, duration_ms AS d,
                input + output + cache_read + cache_write AS tot, output AS out, cost_usd AS c
           FROM metric_tokens
          WHERE ts >= ? AND ts < ? AND subscription_id IN (${subs.map(() => "?").join(",")})`,
      )
      .all(from, to + 86_400_000, ...subs) as {
      s: string;
      ts: number;
      d: number | null;
      tot: number;
      out: number;
      c: number | null;
    }[];
    for (const r of rows) {
      const end = Number(r.ts);
      const run = r.d ? Number(r.d) : 0;
      const begin = end - run;
      const lo = Math.max(begin, from, cover.get(r.s)!.lo);
      const hi = Math.min(end, to);
      // A point-in-time row (no duration) counts only if its instant is in range.
      if (run === 0 ? end < lo || end >= to : hi <= lo) continue;
      for (let p = limitPeriodStart(lo, hours); p <= hi; p = limitPeriodEnd(p, hours)) {
        const share = run === 0 ? 1 : (Math.min(hi, limitPeriodEnd(p, hours)) - Math.max(lo, p)) / run;
        if (share <= 0) continue;
        const c = cell(r.s, p);
        c.total += Number(r.tot) * share;
        c.output += Number(r.out) * share;
        c.turns += 1;
        if (r.c === null) c.unpriced += 1;
        else {
          c.cost += Number(r.c) * share;
          c.priced = true;
        }
        if (run === 0) break;
      }
    }

    /* ---- coverage: when was anyone actually reading each account ---- */
    // Without this an idle period and a period the app was OFF are the same
    // thing — both simply have no row — and a day the sampler missed reads as
    // a day nothing was used. Every period the account was watched gets a row,
    // zeros and all, and each row says how much of itself was watched.
    const now = this.now();
    const watched = this.watchedSpans(subs, from, to, now);
    for (const [sub, spans] of watched) {
      for (const [lo, hi] of spans) {
        for (let p = limitPeriodStart(lo, hours); p < hi; p = limitPeriodEnd(p, hours)) cell(sub, p);
      }
    }

    const out: LimitYield[] = [];
    for (const c of cells.values()) {
      const m = meta.get(c.sub);
      const end = limitPeriodEnd(c.start, hours);
      // Against the part of the period that has HAPPENED: today at noon, read
      // all morning, is fully covered so far rather than half missing.
      const span = Math.min(end, now) - c.start;
      let seen = 0;
      for (const [lo, hi] of watched.get(c.sub) ?? []) {
        seen += Math.max(0, Math.min(hi, end, now) - Math.max(lo, c.start));
      }
      const coverage = span > 0 ? Math.min(1, seen / span) : 0;
      out.push({
        start: c.start,
        end,
        subscriptionId: c.sub,
        subscriptionLabel: label(c.sub),
        provider: m?.provider ?? "",
        // Every window the account has, zero or not — a period in which the
        // weekly window didn't move is information, not a gap.
        windows: [...(m?.windows ?? [])].map(([windowId, w]) => ({
          windowId,
          title: w.title,
          windowMinutes: w.windowMinutes,
          points: c.points.get(windowId) ?? 0,
        })),
        tokens: {
          total: Math.round(c.total),
          output: Math.round(c.output),
          costUsd: c.priced ? c.cost : null,
          turns: c.turns,
          unpriced: c.unpriced,
        },
        coverage,
        // A couple of percent of slack: the first read after midnight lands a
        // few minutes in, and that isn't a gap anyone needs flagged.
        partial: coverage < 0.98,
      });
    }
    out.sort((a, b) => b.start - a.start || a.subscriptionLabel.localeCompare(b.subscriptionLabel));
    if (out.length <= cap) return { rows: out, truncatedBefore: null };
    // Newest survive. Drop the WHOLE period the cap lands in, so no period
    // comes back with some accounts' rows and not others'.
    const cut = out[cap]!.start;
    return { rows: out.filter((y) => y.start > cut), truncatedBefore: limitPeriodEnd(cut, hours) };
  }

  /**
   * Per account, the merged spans of [from, to) during which it was being read:
   * consecutive stored readings no more than COVER_GAP_MS apart cover the time
   * between them. The newest reading also covers up to `now` while it is still
   * that fresh — the sampler holds an unchanged figure back for up to HOLD_MS,
   * and an idle account's last half hour is watched, not missing.
   */
  private watchedSpans(subs: string[], from: number, to: number, now: number): Map<string, [number, number][]> {
    const rows = this.db
      .prepare(
        `SELECT subscription_id AS s, ts FROM limit_samples
          WHERE ts >= ? AND ts < ? AND subscription_id IN (${subs.map(() => "?").join(",")})
          GROUP BY s, ts ORDER BY s, ts`,
      )
      // A gap's look-behind: a read just before `from` covers its start.
      .all(from - COVER_GAP_MS, to, ...subs) as { s: string; ts: number }[];
    const stamps = new Map<string, number[]>();
    for (const r of rows) {
      let list = stamps.get(r.s);
      if (!list) stamps.set(r.s, (list = []));
      list.push(Number(r.ts));
    }
    const out = new Map<string, [number, number][]>();
    for (const [sub, list] of stamps) {
      // Held-back reads are in memory, not the table; they are reads all the same.
      for (const w of this.accounts.get(sub)?.windows.values() ?? []) {
        if (!w.stored && w.ts < to && w.ts > list.at(-1)!) list.push(w.ts);
      }
      const last = list.at(-1)!;
      if (now - last <= COVER_GAP_MS && now > last) list.push(Math.min(now, to));
      const spans: [number, number][] = [];
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]!;
        const b = list[i]!;
        if (b - a > COVER_GAP_MS) continue;
        const lo = Math.max(a, from);
        const hi = Math.min(b, to);
        if (hi <= lo) continue;
        const prev = spans.at(-1);
        if (prev && prev[1] >= lo) prev[1] = Math.max(prev[1], hi);
        else spans.push([lo, hi]);
      }
      out.set(sub, spans);
    }
    return out;
  }

  stats(): { rows: number; oldest: number | null } {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(ts) AS lo FROM limit_samples")
      .get() as { n: number; lo: number | null } | undefined;
    return { rows: Number(r?.n ?? 0), oldest: r?.lo === null || r?.lo === undefined ? null : Number(r.lo) };
  }
}
