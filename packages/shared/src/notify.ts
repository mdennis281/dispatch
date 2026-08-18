/**
 * Notification preferences — WHICH attention events are allowed to interrupt a
 * human, and when.
 *
 * ── Why this lives in shared, and why the server evaluates it ───────────────
 * The preferences are per-DEVICE (the phone wants review pings, the desk
 * machine already has the badge on screen), so they are stored in that device's
 * localStorage and are never part of server-side AppSettings. But they cannot
 * be *applied* on the device, because of a hard iOS rule: a Web Push handler
 * MUST call `showNotification` for every push it receives, or WebKit counts the
 * push as silent and revokes the subscription after a handful of them. Filtering
 * inside the service worker would therefore un-subscribe the phone within a day.
 *
 * So the device owns the preference and ships a copy to the server alongside its
 * push subscription; the server decides whether to send a push at all. This
 * module is the single predicate both sides run — the client for the in-page
 * toast path, the server for the push path — so they can never disagree about
 * what "muted" means.
 */
import { z } from "zod";
import type { AttentionItem } from "./messages.js";

/** `HH:MM`, 24-hour. */
const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * The PR-watcher's activity, split so "a check went red" can wake you at 2am
 * while "someone left a nit" does not.
 *
 * One attention item can carry several of these at once — a single poll can find
 * a failed check AND a new comment — which is why the item holds an array and
 * the filter passes when ANY of them is enabled. Dropping a bundled item because
 * one of its reasons is muted would lose the reason that wasn't.
 */
export const REVIEW_KINDS = ["check", "comment", "review", "settled"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const NotificationPrefsSchema = z.object({
  /** Master switch for this device. */
  enabled: z.boolean().default(true),
  /** Per attention kind. Unset means allowed — a kind added later is not silently muted. */
  kinds: z
    .object({
      permission: z.boolean().default(true),
      question: z.boolean().default(true),
      idle: z.boolean().default(true),
      done: z.boolean().default(true),
      review: z.boolean().default(true),
    })
    .partial()
    .default({}),
  /** Per review sub-kind. Only consulted for `kind === "review"`. */
  reviewKinds: z
    .object({
      check: z.boolean().default(true),
      comment: z.boolean().default(true),
      review: z.boolean().default(true),
      settled: z.boolean().default(true),
    })
    .partial()
    .default({}),
  /**
   * A nightly window where nothing fires.
   *
   * `tz` is an IANA zone captured from the device (`Intl.…resolvedOptions()`),
   * not a fixed UTC offset: the server evaluates this, the phone travels, and
   * DST would otherwise slide the window by an hour twice a year.
   */
  quietHours: z
    .object({
      enabled: z.boolean().default(false),
      start: TimeSchema.default("22:00"),
      end: TimeSchema.default("07:00"),
      tz: z.string().default("UTC"),
    })
    .optional(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Everything on, no quiet hours — what a device gets before it touches Settings. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  kinds: {},
  reviewKinds: {},
};

/** Minutes past local midnight for `now` in `tz`, or null if the zone is bogus. */
function localMinutes(now: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    // `hour12: false` yields 24 for midnight in some ICU versions.
    return (hour % 24) * 60 + minute;
  } catch {
    return null; // unknown zone — treated as "not quiet", never as "silence everything"
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Whether `now` falls inside the configured quiet window.
 *
 * The window normally wraps midnight (22:00 → 07:00), so the comparison is
 * `start <= t || t < end` in that case and the plain range otherwise. `start ===
 * end` is treated as an EMPTY window rather than a full day: a mis-set pair of
 * equal times should fail open and let notifications through, not silently
 * swallow every one of them.
 */
export function inQuietHours(prefs: NotificationPrefs, now: number): boolean {
  const q = prefs.quietHours;
  if (!q?.enabled) return false;
  const t = localMinutes(now, q.tz);
  if (t === null) return false;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * The one predicate. True when this device wants to be interrupted by this item.
 *
 * Deliberately fails OPEN on anything it doesn't recognise: an attention kind
 * added server-side that predates a device's stored prefs must still ring,
 * because the alternative is a new class of alert that is silently invisible on
 * every phone that hasn't reopened Settings.
 */
export function shouldNotify(
  prefs: NotificationPrefs,
  item: Pick<AttentionItem, "kind" | "reviewKinds">,
  now: number,
): boolean {
  if (!prefs.enabled) return false;
  if (prefs.kinds[item.kind] === false) return false;
  if (item.kind === "review") {
    const subs = item.reviewKinds ?? [];
    // An untagged review item (older server, or a reason we didn't classify)
    // is not filterable — let it through rather than swallow it.
    if (subs.length && !subs.some((s) => prefs.reviewKinds[s] !== false)) return false;
  }
  if (inQuietHours(prefs, now)) return false;
  return true;
}
