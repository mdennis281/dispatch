/**
 * The homepage payload — everything the cross-project overview renders, in ONE
 * response.
 *
 * SPEED IS THE FEATURE, so the shape is dictated by it rather than by what is
 * tidy. Three rules this schema exists to hold:
 *
 *   1. ONE REQUEST. The page paints from a single GET. A homepage that fans out
 *      to five endpoints is a homepage that paints five times, and the slowest
 *      of the five sets the arrival time.
 *
 *   2. NOTHING HERE COSTS A SUBPROCESS. Every field is answerable from the
 *      state database, the chat records already resident in memory, or the
 *      in-memory attention queue. No `git`, no `gh`, no filesystem walk. Live
 *      PR and CI state is deliberately ABSENT: it is a `gh` call per repo, it
 *      is the slowest thing the app can ask for, and the overview is not worth
 *      waiting on it. Anything that needs a subprocess loads after first paint
 *      from its own endpoint, or does not go on this page.
 *
 *   3. IT IS ALREADY ROLLED UP. The client does no aggregation — no summing a
 *      per-chat list into a per-project figure, no re-bucketing. A homepage
 *      that arrives as rows and becomes numbers in React is one that janks on
 *      the install with 1,400 chats, which is the install it has to be fast on.
 *
 * `computedAt` rides along because the response is served from a short-TTL
 * cache (see `services/home.ts`) and may be a few seconds old. A figure whose
 * age you can see is honest; one that silently lags is not.
 */
import * as z from "zod";

/** How wide the rollup window is. Fixed set — it is a glance, not a report. */
export const HomeWindowSchema = z.enum(["24h", "7d", "30d"]);
export type HomeWindow = z.infer<typeof HomeWindowSchema>;

/** Window → width in ms. */
export const HOME_WINDOW_MS: Record<HomeWindow, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/**
 * How many points the per-project sparkline carries, per window.
 *
 * The buckets are EQUAL-WIDTH and ALIGNED TO THE WINDOW — `window / buckets`
 * wide, measured from `from` — not calendar days. Calendar days were the
 * obvious choice and they lie at both edges: a trailing 24-hour window read at
 * 01:00 splits into a 23-hour bucket and a 1-hour one, so steady activity draws
 * a cliff at the right-hand end and the eye reads "it stopped". The same bias
 * clips the first and last point of the 7d and 30d shapes, which is exactly
 * where a reader looks for a trend.
 *
 * Because `to - from` is always exactly the window width, every bucket is full
 * and no normalisation is needed. 24 hourly points over a day, one per day over
 * a week and a month.
 */
export const HOME_SPARK_BUCKETS: Record<HomeWindow, number> = {
  "24h": 24,
  "7d": 7,
  "30d": 30,
};

/** What one sparkline bucket spans, for labelling it. */
export const HOME_SPARK_UNIT: Record<HomeWindow, string> = {
  "24h": "hourly",
  "7d": "daily",
  "30d": "daily",
};

/** Display labels for the window picker. */
export const HOME_WINDOW_LABELS: Record<HomeWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * One project's row in the grid.
 *
 * `runtimeMs` is ATTRIBUTED time (the plain sum of span durations), not the
 * union of them — see `MetricsService.projectRollup` for why the overview takes
 * the cheap measure and the Metrics view keeps the exact one.
 */
export const HomeProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoPath: z.string(),
  /** Chats that exist in this project, archived ones excluded. */
  chats: z.number().int(),
  /** Chats with an agent on them right now (running / queued / waiting). */
  working: z.number().int(),
  /** Outstanding attention items across this project's chats. */
  attention: z.number().int(),
  /** Ledger rows in the window — "how much happened here". */
  events: z.number().int(),
  /** Attributed agent time in the window, ms. */
  runtimeMs: z.number().int(),
  /**
   * Event counts per bucket across the window, oldest first — the sparkline.
   * Buckets are equal-width and window-aligned; see {@link HOME_SPARK_BUCKETS}.
   */
  spark: z.array(z.number().int()),
  /** Most recent activity in this project, epoch ms. 0 when there is none. */
  lastActivityAt: z.number().int(),
});
export type HomeProject = z.infer<typeof HomeProjectSchema>;

/** One line of the cross-project activity tail. */
export const HomeActivitySchema = z.object({
  ts: z.number().int(),
  /** The ledger category, so the row can carry the right glyph. */
  category: z.string(),
  /** Tool / skill / endpoint name. */
  identifier: z.string(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  chatId: z.string().optional(),
  chatTitle: z.string().optional(),
});
export type HomeActivity = z.infer<typeof HomeActivitySchema>;

/** The whole page. */
export const HomeOverviewSchema = z.object({
  /** When this snapshot was computed, epoch ms. May be a few seconds ago. */
  computedAt: z.number().int(),
  /** How long computing it took, ms — surfaced in the footer, and honest. */
  computeMs: z.number().int(),
  window: HomeWindowSchema,
  /** Window bounds actually used, epoch ms. */
  from: z.number().int(),
  to: z.number().int(),
  /** Headline numbers, summed across every project. */
  totals: z.object({
    projects: z.number().int(),
    chats: z.number().int(),
    working: z.number().int(),
    attention: z.number().int(),
    events: z.number().int(),
    runtimeMs: z.number().int(),
  }),
  projects: z.array(HomeProjectSchema),
  recent: z.array(HomeActivitySchema),
});
export type HomeOverview = z.infer<typeof HomeOverviewSchema>;
