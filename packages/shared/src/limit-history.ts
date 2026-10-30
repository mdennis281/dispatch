/**
 * Subscription limits over TIME — the history the usage meter never kept.
 *
 * The header meter shows each account's windows as they are right now and
 * forgets them on the next poll. That answers "can I keep going" and nothing
 * else: whether a weekly window reset halfway through the week, whether a 5-hour
 * window fell from 80% to 20% with no reset due, or how much a 1% step is worth
 * this week compared with last — all of that needs the readings KEPT, and the
 * transitions between them named.
 *
 * Provider-neutral on purpose. Claude reports up to six windows per account
 * (`five_hour`, `seven_day`, per-model weekly ones…), Codex reports one or more
 * metered buckets each with a primary and secondary window — and a `prolite`
 * plan's only window is a WEEKLY one reported as `primary`. So a window is an
 * opaque, account-stable `windowId` plus whatever length the provider states;
 * nothing here assumes "primary means 5 hours".
 */
import * as z from "zod";
import { HarnessKindSchema } from "./common.js";

/** One window as read at one instant. */
export const LimitReadingSchema = z.object({
  /**
   * Stable for the account across reads: Claude's own key (`five_hour`,
   * `seven_day_opus`), Codex's `<limitId>:<minutes>m`. Never a slot name like
   * "primary", which a plan change can point at a different window.
   */
  windowId: z.string(),
  /** As a person would say it: "5-hour session", "Weekly · Opus". */
  title: z.string(),
  /** The window's length when the provider states or implies it. */
  windowMinutes: z.number().int().positive().nullable(),
  /** Percent of the window used, 0–100 (can briefly exceed 100). */
  percent: z.number(),
  /** When the window resets, epoch ms; null when the provider omits it. */
  resetsAt: z.number().int().nullable(),
});
export type LimitReading = z.infer<typeof LimitReadingSchema>;

/**
 * What a transition between two readings MEANT.
 *
 *   reset        — the window's announced reset time passed and it emptied.
 *                  Expected; recorded so a window's periods have edges.
 *   early_reset  — it emptied BEFORE its announced reset, and came back with a
 *                  new reset time: the window was restarted early.
 *   drop         — usage FELL inside the same window (same reset time), the
 *                  "80% → 20% for no reason" case.
 *   reset_moved  — the announced reset time shifted, usage didn't fall.
 *   window_added / window_removed — the provider started/stopped reporting
 *                  a window for this account (a plan or policy change).
 *   plan_changed — the plan the provider reports changed.
 *   credits_changed — Codex's count of backend-granted reset credits changed;
 *                  a consumed credit is a LEGITIMATE early reset.
 */
export const LimitEventKindSchema = z.enum([
  "reset",
  "early_reset",
  "drop",
  "reset_moved",
  "window_added",
  "window_removed",
  "plan_changed",
  "credits_changed",
]);
export type LimitEventKind = z.infer<typeof LimitEventKindSchema>;

export const LIMIT_EVENT_LABELS: Record<LimitEventKind, string> = {
  reset: "Reset",
  early_reset: "Early reset",
  drop: "Usage dropped",
  reset_moved: "Reset time moved",
  window_added: "Window appeared",
  window_removed: "Window disappeared",
  plan_changed: "Plan changed",
  credits_changed: "Reset credits changed",
};

/** The kinds nobody would expect — what the tab highlights. */
export const UNEXPECTED_LIMIT_EVENTS: readonly LimitEventKind[] = [
  "early_reset",
  "drop",
  "reset_moved",
  "window_added",
  "window_removed",
  "plan_changed",
];

export const LimitEventSchema = z.object({
  seq: z.number().int(),
  /** The read that saw it. */
  ts: z.number().int(),
  /**
   * The previous read. The change happened somewhere in (prevTs, ts] — a reset
   * seen across a 25-minute gap is reported as that gap, never as an instant.
   */
  prevTs: z.number().int().nullable(),
  subscriptionId: z.string(),
  provider: z.string(),
  /** Null for account-level events (plan, credits). */
  windowId: z.string().nullable(),
  title: z.string(),
  kind: LimitEventKindSchema,
  fromPercent: z.number().nullable(),
  toPercent: z.number().nullable(),
  prevResetsAt: z.number().int().nullable(),
  resetsAt: z.number().int().nullable(),
  /** Free text: the old/new plan, the credit counts, how far a reset moved. */
  detail: z.string().nullable(),
});
export type LimitEvent = z.infer<typeof LimitEventSchema>;

/* ------------------------------------------------------------------ query */

/**
 * How wide a yield period is. Hours, aligned to local midnight, so a "6h"
 * period is always 00–06, 06–12, … and a day is a calendar day.
 */
export const LimitPeriodSchema = z.enum(["1h", "3h", "6h", "1d"]);
export type LimitPeriod = z.infer<typeof LimitPeriodSchema>;
export const LIMIT_PERIOD_HOURS: Record<LimitPeriod, number> = { "1h": 1, "3h": 3, "6h": 6, "1d": 24 };

/**
 * The local-time period containing `ts`: hours aligned to midnight, or the day.
 * Shared so the client lays its period grid on exactly the server's edges —
 * an empty column has to land where a missing row would have been.
 */
export function limitPeriodStart(ts: number, hours: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  d.setHours(hours >= 24 ? 0 : Math.floor(d.getHours() / hours) * hours);
  return d.getTime();
}

/** Where the period starting at `start` ends — calendar arithmetic, so DST-safe. */
export function limitPeriodEnd(start: number, hours: number): number {
  const d = new Date(start);
  if (hours >= 24) d.setDate(d.getDate() + 1);
  else d.setHours(d.getHours() + hours);
  return d.getTime();
}

export const LimitQuerySchema = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  /** Narrow to these accounts; absent = all. */
  subscriptionIds: z.array(z.string()).optional(),
  /** Width of the yield periods. */
  period: LimitPeriodSchema.default("1d"),
});
export type LimitQuery = z.infer<typeof LimitQuerySchema>;
export type LimitQueryInput = z.input<typeof LimitQuerySchema>;

/** One stored reading, as a chart point. */
export interface LimitPoint {
  ts: number;
  percent: number;
  resetsAt: number | null;
}

/** One account's one window over the queried range. */
export interface LimitWindowSeries {
  subscriptionId: string;
  subscriptionLabel: string;
  provider: string;
  windowId: string;
  title: string;
  windowMinutes: number | null;
  /** Ascending. Includes the last reading BEFORE `from`, so a line has a start. */
  points: LimitPoint[];
}

/** How the sampler is treating one account right now. */
export const LimitAccountStatusSchema = z.object({
  subscriptionId: z.string(),
  label: z.string(),
  provider: HarnessKindSchema,
  /** Last read attempt, ok or not. */
  lastAt: z.number().int().nullable(),
  /** Last read that produced numbers. */
  lastOkAt: z.number().int().nullable(),
  nextAt: z.number().int().nullable(),
  /** Why the last read failed, when it did. */
  error: z.string().nullable(),
  planType: z.string().nullable(),
  resetCredits: z.number().int().nullable(),
});
export type LimitAccountStatus = z.infer<typeof LimitAccountStatusSchema>;

/**
 * One account over one period: how far each window moved, and what was spent.
 *
 * A turn's tokens are spread evenly over the time it RAN (its end minus its
 * duration), not dropped on the instant it ended. Booked at the end, a
 * 90-minute turn lands whole in its last hour — and one 33M-token turn booked
 * a minute after a reset made one 5-hour window look 40× more generous than
 * the next. Spread over its run, it is accurate to the hour; turns booked
 * before durations were recorded still land at their end.
 */
export interface LimitYield {
  /** Period start/end, epoch ms. */
  start: number;
  end: number;
  subscriptionId: string;
  subscriptionLabel: string;
  provider: string;
  /** Percentage points each window was driven up during the period. */
  windows: { windowId: string; title: string; windowMinutes: number | null; points: number }[];
  /** What the account's turns spent during the period (once tracking had begun). */
  tokens: {
    total: number;
    output: number;
    /** Null when nothing in the period carried a price (Codex). */
    costUsd: number | null;
    /** Turns that overlap the period (a turn spanning two periods counts in both). */
    turns: number;
    /** Of those, turns with no price — their API value is missing from `costUsd`. */
    unpriced: number;
  };
  /**
   * How much of the period (0–1) the account was actually being read — of the
   * part that has happened, for the period still running. A period nobody read
   * has no row at all; a row at 0 is spend booked while reads were failing.
   * This is what separates "idle" from "we weren't looking".
   */
  coverage: number;
  /** `coverage` fell short of the whole period: the app was off, or reads failed, inside it. */
  partial: boolean;
}

export interface LimitReport {
  windows: LimitWindowSeries[];
  /** Per account per period, newest first. */
  yields: LimitYield[];
  period: LimitPeriod;
  /** Newest first. */
  events: LimitEvent[];
  accounts: LimitAccountStatus[];
  /** Rows in `limit_samples`, and the oldest — "tracking since". */
  sampleRows: number;
  oldest: number | null;
}

/**
 * Claude's usage key → its window. `five_hour` → 300 min, `seven_day_opus` →
 * 10080 min titled "Weekly · Opus". Keys we've never seen still parse — the
 * number word and unit give the length, the rest becomes the qualifier — so a
 * window Anthropic adds next month is tracked without a code change.
 */
export function claudeWindowOf(key: string): Pick<LimitReading, "windowId" | "title" | "windowMinutes"> {
  const m = /^(one|two|three|five|seven|fourteen|thirty|\d+)_(hour|day|week|month)s?(?:_(.+))?$/.exec(key);
  if (!m) return { windowId: key, title: key.replace(/_/g, " "), windowMinutes: null };
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    five: 5,
    seven: 7,
    fourteen: 14,
    thirty: 30,
  };
  const count = words[m[1]!] ?? Number(m[1]);
  const unit = { hour: 60, day: 1440, week: 10080, month: 43200 }[m[2] as "hour"]!;
  const minutes = count * unit;
  const base = limitWindowTitle(minutes, key);
  const qualifier = m[3]
    ?.split("_")
    .map((w) => (w === "oauth" ? "OAuth" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return { windowId: key, title: qualifier ? `${base} · ${qualifier}` : base, windowMinutes: minutes };
}

/** A window length as a person would say it. */
export function limitWindowTitle(minutes: number | null | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === 300) return "5-hour session";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}
