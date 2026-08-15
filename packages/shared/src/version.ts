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

/** Exactly the shape `buildVersion` emits — four fields, the last padded to five. */
const BUILD_STAMP_RE = /^\d{4}\.\d{2}\.\d{2}\.\d{5}$/;

/** Does `value` look like a build stamp? Tag inputs may carry a leading `v`. */
export function isBuildVersion(value: string): boolean {
  return BUILD_STAMP_RE.test(value.startsWith("v") ? value.slice(1) : value);
}

/**
 * Order two build stamps: -1 if `a` is older, 1 if newer, 0 if equal.
 *
 * `null` means "not comparable" — one side is a semver tag, a hand-cut tag, or
 * junk. Callers MUST treat that as "no update known" rather than as an update:
 * the repo's own release notes reserve the right to publish a `v0.1.0`-style
 * semver tag before the first public release, and answering "newer" for a tag
 * whose ordering we cannot establish would offer an install that might be a
 * downgrade.
 *
 * A plain `<` on the padded stamps would give the same answer, which is the
 * whole point of the padding in `buildVersion`. It is spelled out field by field
 * anyway so that a malformed input is REJECTED rather than silently ordered as a
 * string — `"2026.8.4.5" < "2026.08.14.81160"` is false, and a lexicographic
 * shortcut would report the stale build as the newer one.
 */
export function compareBuildVersions(a: string, b: string): -1 | 0 | 1 | null {
  if (!isBuildVersion(a) || !isBuildVersion(b)) return null;
  const left = a.startsWith("v") ? a.slice(1) : a;
  const right = b.startsWith("v") ? b.slice(1) : b;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
