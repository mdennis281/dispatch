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
import type {
  LimitEvent,
  LimitEventKind,
  LimitPoint,
  LimitQuery,
  LimitReading,
  LimitWindowSeries,
} from "@dispatch/shared";
import type { StateDb } from "../store/db.js";
import { classifyStep, readingChanged, type Seen } from "./limit-detect.js";

/** Longest an unchanged reading goes unstored. */
export const HOLD_MS = 30 * 60_000;

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

  windows(q: LimitQuery, label: LimitAccountLabeller): LimitWindowSeries[] {
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

  events(q: LimitQuery, limit = 500): LimitEvent[] {
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

  stats(): { rows: number; oldest: number | null } {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(ts) AS lo FROM limit_samples")
      .get() as { n: number; lo: number | null } | undefined;
    return { rows: Number(r?.n ?? 0), oldest: r?.lo === null || r?.lo === undefined ? null : Number(r.lo) };
  }
}
