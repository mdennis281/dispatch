/**
 * The build version stamp — `yyyy.mm.dd.sssss`, entirely in UTC.
 *
 * The last field is the number of whole seconds elapsed since UTC midnight,
 * zero-padded to five digits: five seconds in is `.00005`, the last second of
 * the day is `.86399`. Padding is what makes the stamp sort lexicographically
 * in build order — `.00005` before `.86399` — which an unpadded counter would
 * get backwards.
 *
 * UTC, not local time: two machines in different zones (or one machine either
 * side of a DST jump) must never produce stamps that go backwards for a later
 * build.
 */
export function buildVersion(at: Date = new Date()): string {
  const y = String(at.getUTCFullYear()).padStart(4, "0");
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const secondsIntoDay =
    at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds();
  return `${y}.${m}.${d}.${String(secondsIntoDay).padStart(5, "0")}`;
}
