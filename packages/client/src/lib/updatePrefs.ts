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

/* ------------------------------------------------------------------------- */

const FLIGHT_KEY = "cm:update-inflight";

/**
 * A marker stops the update screen from being lost to a reload.
 *
 * The server's own `installing` flag lives in the memory of the process the
 * installer is about to kill, so it answers "yes" right up until the moment the
 * answer matters and then stops existing. Anything that reloads the tab after
 * that — the user hitting refresh, a crash, the browser restoring the session —
 * came back to a login form or a dead shell with no hint that an update was
 * running. This is the client's own record, and it survives both.
 *
 * `fromPid`/`fromStartedAt` are the identity of the server that ACCEPTED the
 * install: the process the installer is going to stop. They are the whole point
 * of the file. Without them the screen cannot tell "the server is back" from
 * "the server never went away", and since `tools/install.mjs` downloads,
 * verifies and runs a full `pnpm install` before it stops anything, the old
 * server answers healthily for minutes — which is exactly how the old poll
 * managed to reload the page every two seconds for the entire install.
 */
export interface UpdateFlight {
  tag: string | null;
  version: string | null;
  /** `pid` from `/api/health` on the server that accepted the install. */
  fromPid: number | null;
  /** `startedAt` (ms epoch) from that same health report. */
  fromStartedAt: number | null;
  /**
   * `version` from that same health report — the build being LEFT. The one
   * identity that survives a lost baseline: a marker written with neither pid
   * nor start time (the probe was dropped mid-`pnpm install`, or the old build
   * did not report them) used to be undecidable, and an undecidable marker held
   * the updating screen over the login form until the 24h expiry — the only way
   * out was clearing localStorage by hand. A health report naming any OTHER
   * version settles it.
   */
  fromVersion: string | null;
  /** Client clock when the install was accepted. */
  startedAt: number;
}

/**
 * Beyond this, a marker is junk left by a browser profile restored much later,
 * not an update in progress. The screen self-heals long before this (a server
 * with a different pid or version resolves it on the first poll); this only
 * bounds the case where the marker outlives the machine's memory of the whole
 * affair.
 *
 * Thirty minutes, down from a day. The marker's only job on a reload is to hold
 * the screen up across the minutes the server is DOWN; once anything answers,
 * the outcome is decided from that answer, and a server that still says
 * `installing` gets a fresh marker adopted from its own identity. A marker old
 * enough to have outlived all of that is not protecting an update any more — it
 * is standing between the user and the sign-in form.
 */
const FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;

export function readFlight(): UpdateFlight | null {
  try {
    const raw = backing()?.getItem(FLIGHT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdateFlight>;
    if (typeof parsed.startedAt !== "number") return null;
    if (Date.now() - parsed.startedAt > FLIGHT_MAX_AGE_MS) {
      clearFlight();
      return null;
    }
    return {
      tag: typeof parsed.tag === "string" ? parsed.tag : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      fromPid: typeof parsed.fromPid === "number" ? parsed.fromPid : null,
      fromStartedAt: typeof parsed.fromStartedAt === "number" ? parsed.fromStartedAt : null,
      fromVersion: typeof parsed.fromVersion === "string" ? parsed.fromVersion : null,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function writeFlight(flight: UpdateFlight): void {
  try {
    backing()?.setItem(FLIGHT_KEY, JSON.stringify(flight));
  } catch {
    /* storage unavailable — the screen still works, it just won't survive a reload */
  }
}

export function clearFlight(): void {
  try {
    backing()?.removeItem(FLIGHT_KEY);
  } catch {
    /* nothing to clean up */
  }
}
