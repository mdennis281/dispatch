/**
 * One store's loads, run so that only the LATEST one costs anything.
 *
 * WHY. Every metrics read is synchronous SQLite on the server's event loop, so
 * a read the browser no longer wants still holds up every other route while it
 * runs, chat streaming included. The Metrics stores used to fire a full batch
 * (four to five requests, ~17 queries) on EVERY click and only discard stale
 * replies on arrival. A few quick clicks stacked several batches, and the
 * stable instance's request log recorded 8–71 s stalls of the whole UI.
 *
 * So a load here is:
 *  - DEBOUNCED: `schedule()` waits for the controls to settle, so three quick
 *    clicks cost one batch rather than three.
 *  - ABORTED when superseded: each run gets a fresh `AbortSignal` and the
 *    previous run's is aborted first. A request still queued in the browser
 *    never leaves it, and the server skips one whose client has gone (see
 *    `routes/metrics.ts`).
 *  - GENERATION-GUARDED: `current()` is false once a newer run started. Abort
 *    alone is not enough, because a reply can already be parsed and waiting on
 *    a microtask when the abort lands, and must still not overwrite the newer
 *    query's result.
 *  - FRESHNESS-AWARE: `fresh(key)` reports whether the last result that landed
 *    was for the same query and recent. A tab flip re-mounts the subpage, and
 *    re-running a batch the store already holds just to show the same numbers
 *    is the cheapest freeze to avoid.
 */

export interface LoadContext {
  /** Aborted as soon as a newer run starts (or `cancel()` is called). */
  signal: AbortSignal;
  /** False once this run has been superseded — drop its result. */
  current: () => boolean;
  /** Record that a result for `key` landed now, for {@link LatestLoad.fresh}. */
  landed: (key: string) => void;
}

export interface LatestLoad {
  /** Run after the debounce. A call while one is pending restarts the wait. */
  schedule: () => void;
  /** Run now: cancels a pending schedule and supersedes any run in flight. */
  run: () => Promise<void>;
  /** Supersede whatever is pending or in flight without starting anything. */
  cancel: () => void;
  /** True when the last result to land was for `key`, under `maxAgeMs` ago. */
  fresh: (key: string, maxAgeMs: number) => boolean;
  /** True while a run is in flight (not merely scheduled). */
  inFlight: () => boolean;
}

export interface LatestLoadOptions {
  debounceMs?: number;
  now?: () => number;
}

/** Long enough to swallow a burst of chip clicks, short enough to feel live. */
export const LOAD_DEBOUNCE_MS = 250;

/** How old a held result may be before a re-mount fetches it again. */
export const REMOUNT_FRESH_MS = 30_000;

/**
 * Whether a scope-only read held from an earlier load can stand in for a new
 * one: same window + filter, and fetched under {@link REMOUNT_FRESH_MS} ago.
 * The age cap matters because windows are relative to `Date.now()` — a hero
 * row held for ten minutes beside a chart fetched just now would disagree with
 * it by ten minutes of activity.
 */
export function heldFresh(
  held: { key: string; at: number } | null,
  key: string,
  now: number = Date.now(),
): boolean {
  return !!held && held.key === key && now - held.at < REMOUNT_FRESH_MS;
}

export function latestLoad(
  job: (ctx: LoadContext) => Promise<void>,
  opts: LatestLoadOptions = {},
): LatestLoad {
  const debounceMs = opts.debounceMs ?? LOAD_DEBOUNCE_MS;
  const now = opts.now ?? (() => Date.now());
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { key: string; at: number } | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  // Bump the generation BEFORE aborting: the aborted run's rejection reaches
  // its catch on a later tick, and by then `current()` must already be false
  // or it would write an "aborted" error over the newer query's state.
  const supersede = (): number => {
    const gen = ++generation;
    controller?.abort();
    controller = undefined;
    return gen;
  };

  const run = async (): Promise<void> => {
    clearTimer();
    const gen = supersede();
    const ctl = new AbortController();
    controller = ctl;
    try {
      await job({
        signal: ctl.signal,
        current: () => gen === generation,
        landed: (key) => {
          if (gen === generation) last = { key, at: now() };
        },
      });
    } finally {
      if (controller === ctl) controller = undefined;
    }
  };

  return {
    schedule: () => {
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        void run();
      }, debounceMs);
    },
    run,
    cancel: () => {
      clearTimer();
      supersede();
    },
    fresh: (key, maxAgeMs) => !!last && last.key === key && now() - last.at < maxAgeMs,
    inFlight: () => controller !== undefined,
  };
}
