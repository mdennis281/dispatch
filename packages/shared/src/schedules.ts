/**
 * Scheduled chats — a prompt the app launches as a fresh chat on a cron.
 *
 * AUTHORED as one markdown file per schedule under `.dispatch/schedules/`:
 *
 *   ---
 *   name: Morning dependency audit
 *   cron: "0 9 * * 1-5"          # 5-field cron; the editor's presets compile to it
 *   timezone: America/Chicago    # optional, defaults to the server's own zone
 *   persona: reviewer            # optional — persona id
 *   model: claude-opus-5-5       # optional — unset tracks the project default
 *   effort: high                 # optional
 *   enabled: true                # optional, default true
 *   catchUp: true                # optional, default true — see below
 *   ---
 *   The prompt. Everything after the frontmatter is sent as the run's ask.
 *
 * The FILE STEM is the schedule's id, not a slug of `name`. Run state and every
 * past run's chat are keyed on it, so retitling a schedule in the editor must
 * not orphan its history — which a name-derived id would do on the first edit.
 *
 * Two things live elsewhere on purpose:
 *
 *   - Run state (`lastFireAt`, the last chat) is per-INSTANCE, in `state.db`
 *     ({@link ScheduleStateSchema}). The file is committed config; a timestamp
 *     rewritten on every run would make the repo dirty every morning.
 *   - Past runs are not a list anywhere: each run's chat carries
 *     `Chat.scheduleId`, so "previous runs" is a query over chats, and deleting
 *     a run's chat removes it from history the way a human would expect.
 */
import * as z from "zod";
import { Cron } from "croner";
import { EffortSchema, HarnessKindSchema } from "./common.js";

/** The `.dispatch/` sub-directory schedules are authored in. */
export const DEFAULT_SCHEDULES_DIR = "schedules";

/** `Chat.purpose.kind` of a chat a schedule launched. Persisted — don't rename. */
export const SCHEDULE_RUN_PURPOSE = "schedule:run";

/**
 * Closest two consecutive runs may be. A schedule is a whole chat per fire —
 * a model turn, a worktree, a slot under the concurrency cap — so `* * * * *`
 * is almost certainly a typo for `0 * * * *`, and taking it literally would
 * spawn 1,440 chats a day before anyone noticed. Refused at load instead.
 */
export const MIN_SCHEDULE_SPACING_MS = 5 * 60_000;

/** A schedule id: the file stem. Same rules as every other authored name. */
export const SCHEDULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/* ----------------------------------------------------------------- schema */

/** One schedule, as loaded from `.dispatch/schedules/<id>.md`. */
export const ScheduleSchema = z.object({
  /** The file stem — stable identity for run state and past runs. */
  id: z.string().regex(SCHEDULE_ID_RE),
  /** Display name; defaults to the id. Also the run chat's title prefix. */
  name: z.string().min(1),
  /** Five-field cron (minute hour day-of-month month day-of-week). */
  cron: z.string().min(1),
  /** IANA zone the cron is read in. Unset → the server's own zone. */
  timezone: z.string().optional(),
  /** The ask — the markdown body. */
  prompt: z.string().min(1),
  personaId: z.string().optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  harness: HarnessKindSchema.optional(),
  modeId: z.string().optional(),
  enabled: z.boolean().default(true),
  /**
   * When a fire was missed (the app was off), run ONCE on startup rather than
   * waiting for the next slot. Never once per missed slot — a laptop shut for a
   * week on an hourly schedule would otherwise wake up to 168 chats.
   */
  catchUp: z.boolean().default(true),
  /** The file it was loaded from, relative to the schedules dir. */
  file: z.string(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/** What the editor writes. `file` is derived from `id`; defaults are filled in. */
export const ScheduleInputSchema = ScheduleSchema.omit({ file: true }).extend({
  enabled: z.boolean().optional(),
  catchUp: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/** How a run was started. */
export const ScheduleTriggerSchema = z.enum(["schedule", "catch-up", "manual"]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

/**
 * Per-instance run state, one row per (project, schedule) in `state.db`.
 *
 * `lastFireAt` is the SLOT that was last honoured, not the wall-clock time the
 * chat started — the next fire is `nextRun(lastFireAt)`, so measuring from the
 * slot keeps a slow launch from drifting the schedule.
 */
export const ScheduleStateSchema = z.object({
  projectId: z.string(),
  scheduleId: z.string(),
  /**
   * When this instance first saw the schedule. The catch-up baseline for a
   * schedule that has never fired: without it, a newly-authored daily schedule
   * would count every slot since the epoch as "missed" and fire on save.
   */
  firstSeenAt: z.number(),
  lastFireAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastChatId: z.string().optional(),
  lastTrigger: ScheduleTriggerSchema.optional(),
  /** Why the most recent attempt did not start a chat. Cleared by the next success. */
  lastError: z.string().optional(),
  /** Why the most recent due slot was passed over (overlap, disabled…). */
  lastSkip: z.string().optional(),
});
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

/** One past run, as the pane lists it — a projection of the run's chat. */
export const ScheduleRunSchema = z.object({
  chatId: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.number(),
  archived: z.boolean().optional(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

/** A schedule as `GET /api/projects/:id/schedules` returns it. */
export const ScheduleViewSchema = z.object({
  schedule: ScheduleSchema,
  state: ScheduleStateSchema.nullable(),
  /** Next fire, epoch ms. Null when disabled or the cron never fires again. */
  nextRunAt: z.number().nullable(),
  /** Newest first, capped. */
  runs: z.array(ScheduleRunSchema),
});
export type ScheduleView = z.infer<typeof ScheduleViewSchema>;

export const SchedulesResponseSchema = z.object({
  schedules: z.array(ScheduleViewSchema),
  /**
   * Whether THIS instance fires schedules. False on a dev checkout — stable and
   * dev share the repo's `.dispatch/`, so both firing would double every run.
   * "Run now" still works either way: it is a human asking, not a timer.
   */
  active: z.boolean(),
  /** The server's zone — what an unset `timezone` means. */
  serverTimeZone: z.string(),
  /**
   * Schedule files that failed to load, and why. A schedule that does not load
   * does not run, so the pane lists these instead of letting one vanish.
   */
  errors: z.array(z.object({ file: z.string().optional(), message: z.string() })),
});
export type SchedulesResponse = z.infer<typeof SchedulesResponseSchema>;

/* ------------------------------------------------------------------- cron */

/** A cron that parsed, or the reason it didn't. */
export type CronCheck = { ok: true } | { ok: false; error: string };

function cronOf(expr: string, timezone?: string): Cron {
  // `paused` — this object only ever answers "when next", it never schedules.
  return new Cron(expr, { paused: true, ...(timezone ? { timezone } : {}) });
}

/**
 * Expand one plain cron field (`*`, `a`, `a-b`, any of them `/n`, comma lists)
 * to its sorted values, or null for syntax this doesn't model (names, `L`,
 * `#`…) — the caller then falls back to walking real fires.
 */
function expandField(field: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(item);
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) return null;
    const start = m[1] === "*" ? lo : Number(m[1]);
    // `a/n` (no range) runs from a to the top, as in Vixie cron.
    const end = m[1] === "*" ? hi : m[2] ? Number(m[2]) : m[3] ? hi : start;
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The smallest gap between two consecutive fires, in minutes, from the
 * minute and hour fields alone — independent of WHEN it is asked.
 *
 * Asking croner for "the next two fires from now" was the first version, and
 * its answer depended on the clock: `0,3 * * * *` checked at :01 sees :03 then
 * the next :00 (57 minutes, accepted) and checked at :04 sees :00 then :03 (3
 * minutes, refused). So the same file saved fine and then failed to load an
 * hour later. A gap under the floor can only come from two fires in one hour,
 * or from the last minute of one firing hour to the first of the next — both
 * readable straight off the fields.
 */
function minGapMinutes(minuteField: string, hourField: string): number | null {
  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  if (!minutes?.length || !hours?.length) return null;
  let gap = Infinity;
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, minutes[i]! - minutes[i - 1]!);
  // Wrap from one firing hour into the next, counting 23 → 0 (the day fields
  // may well allow consecutive days, and assuming so only errs strict).
  const firing = new Set(hours);
  if (hours.some((h) => firing.has((h + 1) % 24))) {
    gap = Math.min(gap, 60 - minutes[minutes.length - 1]! + minutes[0]!);
  }
  return gap;
}

/**
 * Is this a usable schedule cron? Five fields only: croner also takes a leading
 * seconds field, and a six-field pattern pasted from a Quartz example would
 * otherwise be read as seconds-first and fire at a completely different time.
 */
export function checkCron(expr: string, timezone?: string): CronCheck {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `expected 5 fields (minute hour day month weekday), got ${fields.length}`,
    };
  }
  let cron: Cron;
  try {
    cron = cronOf(expr, timezone);
    // Construction is lazy about the zone; resolving one fire is what throws on a bad one.
    cron.nextRun();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const floor = MIN_SCHEDULE_SPACING_MS / 60_000;
  let gap = minGapMinutes(fields[0]!, fields[1]!);
  if (gap === null) {
    // Syntax the field reader doesn't model: walk real fires instead, from a
    // FIXED reference (so the verdict can't depend on the clock either) and
    // bounded, because each step costs ~0.3ms and this runs as you type.
    const runs = cron.nextRuns(300, new Date(Date.UTC(2026, 0, 5)));
    gap = Infinity;
    for (let i = 1; i < runs.length; i++) {
      gap = Math.min(gap, (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 60_000);
    }
  }
  if (gap < floor) {
    return {
      ok: false,
      error: `fires more often than every ${floor} minutes — each run is a whole chat`,
    };
  }
  return { ok: true };
}

/** The first fire strictly AFTER `after`, epoch ms — null if it never fires again or won't parse. */
export function nextFireAfter(expr: string, after: number, timezone?: string): number | null {
  try {
    return cronOf(expr, timezone).nextRun(new Date(after))?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** The next `n` fires after `after`, for the editor's preview. */
export function nextFires(expr: string, n: number, after: number, timezone?: string): number[] {
  try {
    return cronOf(expr, timezone)
      .nextRuns(n, new Date(after))
      .map((d) => d.getTime());
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- presets */

/**
 * The editor's friendly frequencies. Each compiles to exactly one cron, and
 * {@link cronToPreset} reads a cron back when it is one of these shapes — so a
 * schedule saved from a preset reopens on that preset, and anything else
 * reopens on the raw cron field rather than being "simplified" into something
 * it isn't.
 */
export type SchedulePreset =
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "monthly"; date: number; hour: number; minute: number };

export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const;
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function presetToCron(p: SchedulePreset): string {
  switch (p.kind) {
    case "minutes":
      return `*/${p.every} * * * *`;
    case "hours":
      return p.every === 1 ? `${p.minute} * * * *` : `${p.minute} */${p.every} * * *`;
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekdays":
      return `${p.minute} ${p.hour} * * 1-5`;
    case "weekly":
      return `${p.minute} ${p.hour} * * ${p.day}`;
    case "monthly":
      return `${p.minute} ${p.hour} ${p.date} * *`;
  }
}

const INT = /^\d+$/;
const int = (s: string, lo: number, hi: number): number | null => {
  if (!INT.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
};
const step = (s: string): number | null => (s.startsWith("*/") ? int(s.slice(2), 1, 59) : null);

/** Read a cron back as a preset, or null when it isn't one of their shapes. */
export function cronToPreset(expr: string): SchedulePreset | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (mon !== "*") return null;

  const everyMin = step(mi);
  if (everyMin !== null && h === "*" && dom === "*" && dow === "*") {
    return (MINUTE_STEPS as readonly number[]).includes(everyMin) ? { kind: "minutes", every: everyMin } : null;
  }
  const minute = int(mi, 0, 59);
  if (minute === null) return null;
  if (dom === "*" && dow === "*") {
    if (h === "*") return { kind: "hours", every: 1, minute };
    const everyH = step(h);
    if (everyH !== null) {
      return (HOUR_STEPS as readonly number[]).includes(everyH) ? { kind: "hours", every: everyH, minute } : null;
    }
  }
  const hour = int(h, 0, 23);
  if (hour === null) return null;
  if (dom === "*" && dow === "*") return { kind: "daily", hour, minute };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", hour, minute };
  if (dom === "*") {
    const day = int(dow, 0, 6);
    return day === null ? null : { kind: "weekly", day, hour, minute };
  }
  if (dow === "*") {
    const date = int(dom, 1, 28);
    return date === null ? null : { kind: "monthly", date, hour, minute };
  }
  return null;
}

const clock = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** One line a human reads: "Weekdays at 09:00", or the raw cron when it isn't a preset. */
export function describeCron(expr: string): string {
  const p = cronToPreset(expr);
  if (!p) return `cron ${expr.trim()}`;
  switch (p.kind) {
    case "minutes":
      return `Every ${p.every} minutes`;
    case "hours":
      return p.every === 1
        ? `Hourly at :${String(p.minute).padStart(2, "0")}`
        : `Every ${p.every} hours at :${String(p.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${clock(p.hour, p.minute)}`;
    case "weekdays":
      return `Weekdays at ${clock(p.hour, p.minute)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[p.day]}s at ${clock(p.hour, p.minute)}`;
    case "monthly":
      return `Monthly on the ${ordinal(p.date)} at ${clock(p.hour, p.minute)}`;
  }
}

/* ------------------------------------------------------------- due-ness */

/**
 * How stale the newest due slot may be and still count as an ordinary fire.
 * Past this, the runner wasn't there when it came due — the app was off, or the
 * machine was asleep (timers don't run through sleep either) — and it is a
 * MISSED slot, which `catchUp` decides about. Two ticks, so one slow tick never
 * turns a punctual fire into a "catch-up".
 */
export const SCHEDULE_FIRE_GRACE_MS = 2 * 60_000;

/**
 * What the runner should do for a schedule right now.
 *
 *   - `fire`     — a slot came due while we were watching; `slot` is the newest.
 *   - `catch-up` — slot(s) were missed and the schedule wants one make-up run.
 *   - `skip`     — slot(s) were missed and it doesn't: record `slot` as
 *                  honoured without running, so the NEXT slot is the next fire.
 *   - `wait`     — nothing due.
 *
 * Pure, so the boundary cases (the slot exactly at `now`, a schedule that has
 * never fired, a week of missed slots) are unit tests rather than timer tests.
 */
export type ScheduleDue =
  | { action: "wait" }
  | { action: "fire" | "catch-up" | "skip"; slot: number; missed: number };

/**
 * `missed` stops counting here. It is only ever shown to a human ("missed 12
 * runs"), and counting means stepping the cron one slot at a time — about half
 * a millisecond each, on every tick, for every schedule. A 5-minute cron off for
 * a month is ~8,900 steps; an uncapped walk took over five seconds.
 */
export const MISSED_COUNT_CAP = 50;

export function scheduleDue(
  schedule: Pick<Schedule, "cron" | "timezone" | "catchUp">,
  state: Pick<ScheduleState, "firstSeenAt" | "lastFireAt"> | null,
  now: number,
): ScheduleDue {
  // Measured from the last honoured slot, else from when we first saw it — never
  // from the epoch (see ScheduleState.firstSeenAt).
  const since = state?.lastFireAt ?? state?.firstSeenAt ?? now;
  let cron: Cron;
  try {
    cron = cronOf(schedule.cron, schedule.timezone);
  } catch {
    return { action: "wait" };
  }
  const first = cron.nextRun(new Date(since))?.getTime() ?? null;
  if (first === null || first > now) return { action: "wait" };
  // The NEWEST due slot, found backwards in one step rather than by walking
  // forward from `first`. croner's reference is exclusive at second
  // granularity, so ask from the start of the NEXT second: every slot sits on a
  // whole minute, which makes that exactly "every slot <= now".
  const ref = new Date(Math.floor(now / 1000) * 1000 + 1000);
  const newest = cron.previousRuns(1, ref)[0]?.getTime() ?? first;
  const slot = Math.max(first, newest);
  let missed = 1;
  for (let at = first; missed < MISSED_COUNT_CAP; missed++) {
    const next = cron.nextRun(new Date(at))?.getTime();
    if (next === undefined || next > slot) break;
    at = next;
  }
  if (missed === 1 && now - slot < SCHEDULE_FIRE_GRACE_MS) return { action: "fire", slot, missed };
  return { action: schedule.catchUp ? "catch-up" : "skip", slot, missed };
}
