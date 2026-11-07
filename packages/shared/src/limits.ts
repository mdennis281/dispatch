/**
 * USAGE-LIMIT DETECTION + AUTO-RESUME PLANS.
 *
 * When a subscription window runs out the SDK ends the turn with a plain
 * sentence — "You've hit your session limit · resets 4:50pm (America/Chicago)"
 * — carried both as an assistant message and as an errored `result` row. That
 * is the only machine-readable thing we get: no structured field, no retry
 * hint. This module turns that sentence into an instant, so the UI can say
 * "continuing at 4:50pm" and the server can schedule the chat to pick itself
 * back up when the window reopens.
 *
 * Shared because BOTH sides need the same answer: the server decides when to
 * resume, the client decides which transcript row to reframe.
 */
import * as z from "zod";

/** A scheduled auto-resume: the chat continues itself once the limit lifts. */
export const ResumePlanSchema = z.object({
  /** When the window reopens (epoch ms) — when the resume fires. */
  at: z.number().int(),
  /** The limit sentence verbatim, so the card can show what paused it. */
  reason: z.string(),
  /** The prompt sent to pick the work back up. */
  prompt: z.string(),
  /** Set when the user cancels — the plan is kept so the card can say so. */
  cancelledAt: z.number().int().optional(),
  /** Set once it has fired, so a restart can't re-fire a spent plan. */
  firedAt: z.number().int().optional(),
});
export type ResumePlan = z.infer<typeof ResumePlanSchema>;

/** What a limit sentence resolved to. */
export interface SessionLimit {
  /** Epoch ms of the next reset. */
  resetsAt: number;
  /** IANA zone the sentence named, when it named one. */
  timeZone?: string;
  /** The clock time as written ("4:50pm"). */
  clock: string;
}

/**
 * The sentence shape: "You've hit your session limit", "usage limit", …
 *
 * Bounded, because `\s+your\s+[\w\s-]*` lets three adjacent runs share the
 * same whitespace, which backtracks polynomially on a long run of it (CodeQL
 * js/polynomial-redos) — and this now runs on every errored turn's text via
 * `isLimitSentence`. The longest real qualifier is a few words.
 */
const LIMIT_RE = /\b(?:hit|reached)\s{1,3}your\s{1,3}[\w -]{0,40}\blimit\b/i;
/**
 * "resets 4:50pm (America/Chicago)" / "resets at 16:50" / "resets 4pm" /
 * "resets Nov 11, 6pm (America/Chicago)".
 *
 * The optional month-and-day is the WEEKLY limit's shape. Without it the regex
 * demanded a digit straight after "resets", so the weekly sentence parsed as no
 * limit at all: the turn ended as a plain `failed`, and neither failover to the
 * configured fallback account nor the park-and-resume ever ran.
 *
 * Every whitespace run is BOUNDED ({1,3}) rather than `\s+`/`\s*`. Adjacent
 * unbounded runs separated only by optional groups backtrack polynomially on a
 * long run of whitespace (CodeQL js/polynomial-redos), and this runs on
 * provider text we don't control. Real sentences use one space.
 */
const RESET_RE =
  /\bresets?\s{1,3}(?:(?:at|on)\s{1,3})?(?:([A-Za-z]{3,9})\.?\s{1,3}(\d{1,2})(?:st|nd|rd|th)?,?\s{1,3}(?:at\s{1,3})?)?(\d{1,2})(?::(\d{2}))?\s{0,3}(am|pm)?\s{0,3}(?:\(([A-Za-z0-9_+\-/]{1,64})\))?/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Nov" / "November" / "sept" → 1-12, or null for a word that isn't a month. */
function monthOf(word: string): number | null {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

/**
 * Is this a usage-limit sentence at all, whether or not its reset time reads?
 *
 * Separate from `parseSessionLimit` because the two questions have different
 * consumers: failover only needs to know the account is out (it assumes an hour
 * when no reset is given), while parking the chat needs an instant to wait for.
 */
export function isLimitSentence(text: string | undefined): boolean {
  return !!text && LIMIT_RE.test(text);
}

/**
 * A zone's UTC offset (ms) at a given instant. Intl is the only DST-correct
 * source available without pulling in a date library.
 */
function zoneOffsetMs(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // `formatToParts` renders hour 24 for midnight under hour12:false in some ICU
  // builds; normalise so the arithmetic can't jump a day.
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - atMs;
}

/** Wall-clock fields of an instant, as seen in `timeZone`. */
function zonedParts(timeZone: string, atMs: number) {
  const off = zoneOffsetMs(timeZone, atMs);
  const d = new Date(atMs + off);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    offset: off,
  };
}

/** The instant at which `timeZone`'s wall clock reads the given date/time. */
function zonedToEpoch(
  timeZone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffsetMs(timeZone, guess);
  // One correction pass covers a DST edge, where the offset at the guess
  // differs from the offset at the answer.
  const second = guess - zoneOffsetMs(timeZone, first);
  return second;
}

/** Normalise a 12-hour clock reading to 24-hour. */
function to24h(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour % 24;
  const pm = meridiem.toLowerCase() === "pm";
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

/**
 * Parse a usage-limit sentence into the instant the window reopens.
 *
 * The session sentence gives a wall clock and (usually) a zone but no date, so
 * the answer is the NEXT time that clock comes around — "resets 4:50pm" seen at
 * 5pm means 4:50pm tomorrow, not four hours ago. The weekly sentence adds a
 * month and day, which is used as given.
 *
 * Returns null when the text isn't a limit notice or carries no readable time,
 * which is the signal to leave the row rendering as an ordinary error.
 */
export function parseSessionLimit(
  text: string | undefined,
  now: number,
  fallbackZone?: string,
): SessionLimit | null {
  if (!text || !LIMIT_RE.test(text)) return null;
  const m = RESET_RE.exec(text);
  if (!m) return null;
  const [, monthWord, dayStr, hourStr, minuteStr, meridiem, namedZone] = m;

  const rawHour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  if (!Number.isFinite(rawHour) || rawHour > 23 || minute > 59) return null;
  const hour = to24h(rawHour, meridiem);
  const clock = meridiem ? `${rawHour}:${String(minute).padStart(2, "0")}${meridiem.toLowerCase()}` : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  // A date that names no real month ("resets Soon 5, 4pm") is not a date we can
  // trust, and guessing one would schedule a resume at a made-up instant.
  const month = monthWord ? monthOf(monthWord) : null;
  const day = dayStr ? Number(dayStr) : null;
  if (monthWord && (month === null || day === null || day < 1 || day > 31)) return null;

  const zone = namedZone ?? fallbackZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  let timeZone = zone;
  let today;
  try {
    today = zonedParts(timeZone, now);
  } catch {
    // An unrecognised zone name must not sink the whole notice.
    timeZone = "UTC";
    today = zonedParts(timeZone, now);
  }

  if (month !== null && day !== null) {
    // The sentence names the day, so trust it — but it names no YEAR, so a
    // date already behind us ("resets Jan 2" seen on Dec 30) is next year's.
    let at = zonedToEpoch(timeZone, today.year, month, day, hour, minute);
    if (at <= now) at = zonedToEpoch(timeZone, today.year + 1, month, day, hour, minute);
    return { resetsAt: at, timeZone: namedZone ?? undefined, clock };
  }

  let at = zonedToEpoch(timeZone, today.year, today.month, today.day, hour, minute);
  if (at <= now) {
    const next = zonedParts(timeZone, at + 24 * 60 * 60_000);
    at = zonedToEpoch(timeZone, next.year, next.month, next.day, hour, minute);
  }
  return { resetsAt: at, timeZone: namedZone ?? undefined, clock };
}
