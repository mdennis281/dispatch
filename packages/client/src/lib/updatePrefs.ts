/**
 * Which release the user has waved away.
 *
 * Stored in localStorage rather than in app settings on purpose. `PUT
 * /api/settings` is a FULL REPLACE (see `routes/settings.ts`), so a flag written
 * by the update banner would be silently wiped the next time any unrelated
 * Settings save round-tripped a body that predates the field — the exact bug
 * `auth` is hand-preserved in that route to avoid. A dismissal is per-browser
 * anyway: it says "this tab's user has seen it", not "this machine has decided".
 *
 * Keyed by VERSION, not by a boolean or a timestamp. Dismissing 2026.08.14.85068
 * must not also dismiss whatever ships tomorrow, and a time-based snooze would
 * either nag about a release you rejected or hide one you never saw.
 */

const KEY = "cm:update-dismissed";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

/** The version the user last dismissed, or null. */
export function dismissedVersion(): string | null {
  try {
    return backing()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function dismissVersion(version: string): void {
  try {
    backing()?.setItem(KEY, version);
  } catch {
    /* storage unavailable — the nudge simply comes back on reload */
  }
}
