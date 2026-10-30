/**
 * Wall-clock time for callers that read it as TEXT — an integration polling
 * from a phone, a model summarising a chat for its human.
 *
 * Epoch ms alone made a connector do timezone arithmetic it got wrong (a chat
 * "finished 5 hours ago" that finished just now: the bot read the epoch as UTC
 * and the owner lives in Central). A bare "14:03" is no better — it is ambiguous
 * the moment the reader is anywhere else. So every rendering here carries its
 * zone explicitly: the abbreviation in the human string, the numeric offset in
 * the ISO one.
 *
 * The zone is the SERVER's own (its `Intl` resolution), because the server is
 * the owner's machine and its clock is the one they live by; `timeZone` is
 * there for tests and for a caller that knows better.
 */

/** The server's IANA zone, e.g. `America/Chicago`. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFor(ms: number, timeZone: string, zoneName: "short" | "longOffset"): Record<string, string> {
  const key = `${timeZone}|${zoneName}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: zoneName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(key, fmt);
  }
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(ms)) out[p.type] = p.value;
  return out;
}

/**
 * `2026-10-29 14:03:12 CDT` — the zone abbreviation is part of the string.
 * `seconds: false` gives `2026-10-29 14:03 CDT`, for listings where a second
 * is noise.
 */
export function formatLocalTime(ms: number, timeZone = serverTimeZone(), opts: { seconds?: boolean } = {}): string {
  const p = partsFor(ms, timeZone, "short");
  const sec = opts.seconds === false ? "" : `:${p.second}`;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${sec} ${p.timeZoneName}`;
}

/** `2026-10-29T14:03:12-05:00` — ISO 8601 with the zone's offset, never `Z`-shifted. */
export function isoLocalTime(ms: number, timeZone = serverTimeZone()): string {
  const p = partsFor(ms, timeZone, "longOffset");
  // `longOffset` renders `GMT-05:00`, and plain `GMT` at a zero offset.
  const offset = (p.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
