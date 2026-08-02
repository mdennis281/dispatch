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

/** The sentence shape: "You've hit your session limit", "usage limit", … */
const LIMIT_RE = /\b(?:hit|reached)\s+your\s+[\w\s-]*\blimit\b/i;
/** "resets 4:50pm (America/Chicago)" / "resets at 16:50" / "resets 4pm". */
const RESET_RE =
  /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z0-9_+\-/]+)\))?/i;

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
 * The sentence gives a wall clock and (usually) a zone but no date, so the
 * answer is the NEXT time that clock comes around — "resets 4:50pm" seen at
 * 5pm means 4:50pm tomorrow, not four hours ago.
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

  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(rawHour) || rawHour > 23 || minute > 59) return null;
  const hour = to24h(rawHour, m[3]);
  const clock = m[3] ? `${rawHour}:${String(minute).padStart(2, "0")}${m[3].toLowerCase()}` : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const zone = m[4] ?? fallbackZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  let timeZone = zone;
  let today;
  try {
    today = zonedParts(timeZone, now);
  } catch {
    // An unrecognised zone name must not sink the whole notice.
    timeZone = "UTC";
    today = zonedParts(timeZone, now);
  }

  let at = zonedToEpoch(timeZone, today.year, today.month, today.day, hour, minute);
  if (at <= now) {
    const next = zonedParts(timeZone, at + 24 * 60 * 60_000);
    at = zonedToEpoch(timeZone, next.year, next.month, next.day, hour, minute);
  }
  return { resetsAt: at, timeZone: m[4] ?? undefined, clock };
}
