/**
 * Metrics — the usage ledger behind the Metrics view.
 *
 * ONE row per thing an agent actually reached for: a tool call, a manager MCP
 * endpoint, a skill, a third-party MCP tool, a durable memory that was surfaced
 * or recalled, a block of project instructions that got injected. Every row
 * carries WHO (agent/subagent/model/harness), WHERE (project/chat) and WHEN, so
 * the same table answers "which agent leans on which tool" and "is anyone
 * actually reading these memories" without a second store.
 *
 * The rows live in the state database's `metric` table, not in the JSON/JSONL
 * store: this is the one dataset that is append-heavy, unbounded, and only ever
 * read through aggregates — exactly what a whole-file read-modify-write map is
 * worst at. See `server/services/metrics.ts`.
 */
import * as z from "zod";

/**
 * What kind of thing was used. Each row gets the MOST SPECIFIC category that
 * applies, never two — a `Skill` call is `skill`, not `skill` + `tool`, so
 * summing every category gives the true total instead of double-counting.
 *
 *   tool        — a built-in harness tool (Read, Bash, Edit, Task, …)
 *   mcp         — a third-party MCP tool (`mcp__<server>__<tool>`)
 *   manager     — a Dispatch manager MCP endpoint (`mcp__manager__<tool>`)
 *   skill       — a skill invoked through the `Skill` tool
 *   subagent    — a subagent spawned through `Agent`/`Task`
 *   memory      — a durable project memory surfaced or recalled
 *   instruction — a block of authored project instructions injected into a turn
 */
export const MetricCategorySchema = z.enum([
  "tool",
  "mcp",
  "manager",
  "skill",
  "subagent",
  "memory",
  "instruction",
]);
export type MetricCategory = z.infer<typeof MetricCategorySchema>;

/** Every category, in the order the UI lists them. */
export const METRIC_CATEGORIES = MetricCategorySchema.options;

/** Display labels for the categories (client chrome + chart legends). */
export const METRIC_CATEGORY_LABELS: Record<MetricCategory, string> = {
  tool: "Tools",
  mcp: "MCP tools",
  manager: "Manager MCP",
  skill: "Skills",
  subagent: "Subagents",
  memory: "Memories",
  instruction: "Instructions",
};

/**
 * How a row got into the table. `backfill` rows were reconstructed from chat
 * transcripts on the one-time import and carry no duration/outcome; `live` rows
 * were recorded as they happened. Kept so a chart can tell the difference
 * between "nobody used this" and "this predates the ledger".
 */
export const MetricSourceSchema = z.enum(["live", "backfill"]);
export type MetricSource = z.infer<typeof MetricSourceSchema>;

/** One recorded use. `identifier` is the uid WITHIN its category. */
export const MetricEventSchema = z.object({
  /** Rowid, assigned on insert. Absent on the way in. */
  id: z.number().int().optional(),
  /** When it happened, epoch ms. */
  ts: z.number().int(),
  category: MetricCategorySchema,
  /**
   * The uid within the category: a tool name, an `mcp__manager__` endpoint
   * (prefix stripped), a skill name, a memory name, an instruction source.
   */
  identifier: z.string(),
  /**
   * Category-specific qualifier — the MCP server for `mcp`, `surfaced`/`recalled`
   * for `memory`, the tool that carried a `skill`/`subagent`. Never used as an
   * identity, only as a breakdown.
   */
  detail: z.string().optional(),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  /** The chat's configured agent id, or undefined when it runs the default. */
  agent: z.string().optional(),
  /** Subagent type, when the call came from a spawned subagent rather than the main loop. */
  subagent: z.string().optional(),
  /** SDK model id backing the session. */
  model: z.string().optional(),
  /** Which runtime ran it ("claude" | "codex"). */
  harness: z.string().optional(),
  /** The turn number within the chat, when known. */
  turn: z.number().int().optional(),
  /** Outcome, when the row is one that has one (tool results). */
  ok: z.boolean().optional(),
  source: MetricSourceSchema.default("live"),
  /**
   * Idempotency key. Two rows with the same key are the same event, so an
   * import can run twice (or race a live recording) without double-counting.
   * Derived, never authored: see `eventKey` in `services/metrics.ts`.
   */
  eventKey: z.string().optional(),
});
export type MetricEvent = z.infer<typeof MetricEventSchema>;

/** The columns a query may group or filter by (and the chart may split on). */
export const MetricDimensionSchema = z.enum([
  "category",
  "identifier",
  "projectId",
  "chatId",
  "agent",
  "subagent",
  "model",
  "harness",
  "detail",
  "source",
]);
export type MetricDimension = z.infer<typeof MetricDimensionSchema>;

/** Display labels for the dimensions. */
export const METRIC_DIMENSION_LABELS: Record<MetricDimension, string> = {
  category: "Category",
  identifier: "Name",
  projectId: "Project",
  chatId: "Chat",
  agent: "Agent",
  subagent: "Subagent",
  model: "Model",
  harness: "Runtime",
  detail: "Detail",
  source: "Source",
};

/** Time bucket for a series query. `auto` picks one from the window's width. */
export const MetricBucketSchema = z.enum(["auto", "hour", "day", "week", "month"]);
export type MetricBucket = z.infer<typeof MetricBucketSchema>;

/**
 * A filter is dimension → allowed values (OR within a dimension, AND across
 * them), which is exactly how the UI's filter chips read: "project A or B, and
 * agent X".
 */
export const MetricFilterSchema = z.partialRecord(MetricDimensionSchema, z.array(z.string()));
export type MetricFilter = z.infer<typeof MetricFilterSchema>;

/** The query behind every chart on the page. */
export const MetricQuerySchema = z.object({
  /** Window start, epoch ms (inclusive). */
  from: z.number().int().optional(),
  /** Window end, epoch ms (exclusive). */
  to: z.number().int().optional(),
  filter: MetricFilterSchema.optional(),
  /** What each series is split by. Omit for a single total series. */
  groupBy: MetricDimensionSchema.optional(),
  bucket: MetricBucketSchema.default("auto"),
  /**
   * Keep only the N biggest groups; the rest fold into one "Other" series so a
   * long tail of one-off tool names can't render 400 lines.
   */
  limit: z.number().int().min(1).max(50).default(8),
});
export type MetricQuery = z.infer<typeof MetricQuerySchema>;

/**
 * The query as a CALLER writes it.
 *
 * `bucket` and `limit` carry schema defaults, so the parsed (output) type has
 * them as REQUIRED — correct for anything reading a validated query, and wrong
 * for everything constructing one. Server methods and the API client take this
 * shape and apply the same fallbacks the schema would, so a caller never has to
 * restate a default just to satisfy the type.
 */
export type MetricQueryInput = z.input<typeof MetricQuerySchema>;

/** One group's total plus its per-bucket counts, aligned to `buckets`. */
export const MetricSeriesSchema = z.object({
  /** The `groupBy` value, or "" for the single-series case. `__other__` is the fold. */
  key: z.string(),
  label: z.string(),
  total: z.number().int(),
  /** One count per entry in the response's `buckets`, same order. */
  values: z.array(z.number().int()),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

/** The key the long tail folds into when `limit` truncates the groups. */
export const METRIC_OTHER_KEY = "__other__";

/** A bucketed series response — everything a time chart needs. */
export const MetricSeriesResponseSchema = z.object({
  /** Bucket start times, epoch ms, ascending and gap-filled. */
  buckets: z.array(z.number().int()),
  /** The bucket width actually used (never "auto"). */
  bucket: z.enum(["hour", "day", "week", "month"]),
  series: z.array(MetricSeriesSchema),
  /** Rows matching the filter across the whole window. */
  total: z.number().int(),
  /** Groups that existed but folded into "Other" (0 when nothing was truncated). */
  truncated: z.number().int(),
});
export type MetricSeriesResponse = z.infer<typeof MetricSeriesResponseSchema>;

/** One row of the leaderboard — a group and how much of the window it owns. */
export const MetricTotalSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  /** Distinct chats this group appeared in — "how widely used", not just "how loud". */
  chats: z.number().int(),
  /** Most recent occurrence in the window, epoch ms. */
  lastAt: z.number().int(),
});
export type MetricTotal = z.infer<typeof MetricTotalSchema>;

/** The leaderboard response (the table + pie/bar charts). */
export const MetricTotalsResponseSchema = z.object({
  totals: z.array(MetricTotalSchema),
  /** Rows matching the filter across the whole window. */
  total: z.number().int(),
  /** Distinct groups that existed, before `limit` truncated the list. */
  groups: z.number().int(),
  /**
   * Distinct chats the whole filtered window touched.
   *
   * NOT derivable from `totals` — one chat appears under many groups, so summing
   * their `chats` over-reports its reach and taking the max under-reports it. It
   * has to be counted across the set, which is why it rides on the response.
   */
  chats: z.number().int(),
});
export type MetricTotalsResponse = z.infer<typeof MetricTotalsResponseSchema>;

/** One selectable filter value, with its count so the UI can order by weight. */
export const MetricFacetValueSchema = z.object({
  value: z.string(),
  count: z.number().int(),
});
export type MetricFacetValue = z.infer<typeof MetricFacetValueSchema>;

/**
 * Every distinct value each dimension actually has, for the filter controls.
 * Computed from the ledger rather than from the projects/agents stores on
 * purpose: a filter that offers a project with no rows is a dead end, and one
 * that omits a deleted project hides history that still exists.
 */
export const MetricFacetsResponseSchema = z.object({
  facets: z.partialRecord(MetricDimensionSchema, z.array(MetricFacetValueSchema)),
  /** Oldest and newest row in the whole ledger, epoch ms (null when empty). */
  range: z.object({ from: z.number().int().nullable(), to: z.number().int().nullable() }),
  /** Total rows in the ledger, ignoring every filter. */
  rows: z.number().int(),
});
export type MetricFacetsResponse = z.infer<typeof MetricFacetsResponseSchema>;

/** Bucket width in ms, for the widths that have a fixed one. */
export const METRIC_BUCKET_MS: Record<"hour" | "day" | "week", number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/**
 * The most buckets a series response may contain.
 *
 * This is a CORRECTNESS bound, not just a rendering one. The server gap-fills
 * the bucket list and indexes each row into it; a row whose bucket start isn't
 * in the list has nowhere to land, so a truncated list doesn't render fewer
 * points — it silently drops counts out of both the series and the total.
 * {@link resolveBucket} therefore guarantees the width it returns FITS, rather
 * than leaving anything to be trimmed afterwards.
 */
export const METRIC_MAX_BUCKETS = 1000;

/** Bucket widths, coarsest last — the order `resolveBucket` steps through. */
const BUCKET_ORDER = ["hour", "day", "week", "month"] as const;

/**
 * Roughly how many buckets of this width a span covers. Approximate on purpose:
 * a month is counted as 30 days, which is close enough to answer the only
 * question asked of it — "does this fit under the cap".
 */
function bucketsIn(width: (typeof BUCKET_ORDER)[number], span: number): number {
  const ms = width === "month" ? 30 * METRIC_BUCKET_MS.day : METRIC_BUCKET_MS[width];
  return Math.ceil(span / ms) + 1;
}

/**
 * The bucket width to actually use for a window.
 *
 * Two jobs, in order. `auto` picks by READABILITY — past ~180 points a line
 * chart is a texture, not a reading. Then ANY width, explicitly requested or
 * not, is coarsened until it fits under {@link METRIC_MAX_BUCKETS}.
 *
 * That second step is why an explicit pick isn't returned unchanged: "hourly"
 * over two years is ~17,500 buckets, and the alternative to coarsening is
 * either refusing a combination the UI legitimately offers, or truncating the
 * list and under-reporting the totals without saying so. The response carries
 * the width actually used, so the axis and the caller stay honest about it.
 */
export function resolveBucket(
  bucket: MetricBucket,
  from: number,
  to: number,
): "hour" | "day" | "week" | "month" {
  const span = Math.max(0, to - from);
  const preferred =
    bucket !== "auto"
      ? bucket
      : span <= 3 * METRIC_BUCKET_MS.day
        ? "hour"
        : span <= 120 * METRIC_BUCKET_MS.day
          ? "day"
          : span <= 730 * METRIC_BUCKET_MS.day
            ? "week"
            : "month";
  for (let i = BUCKET_ORDER.indexOf(preferred); i < BUCKET_ORDER.length; i++) {
    const width = BUCKET_ORDER[i]!;
    if (bucketsIn(width, span) <= METRIC_MAX_BUCKETS) return width;
  }
  return "month";
}

/* ==========================================================================
 *                          RUNTIME SPANS
 * ========================================================================== */

/**
 * The second half of the ledger: WHERE THE TIME WENT, not just what was reached
 * for.
 *
 * An event row has no width — it answers "how many times" and can never answer
 * "for how long". A SPAN is one stretch of wall clock with a start, an end, and
 * a state, so the same window that counts 400 Bash calls can also say they cost
 * nine hours and that six of those were spent waiting on a shell rather than
 * generating tokens.
 *
 * THE ACTOR IS `(chatId, runId)`. A chat's main loop and each subagent run it
 * spawns are separate actors with separate timelines. That is what makes "the
 * runtime of each chat AND the subagents within it" answerable, and it is what
 * stops the obvious double count: a parent sitting in `waiting_agent` for ten
 * minutes while five children each burn eight is not fifty minutes of parent.
 *
 * OVERLAP WITHIN AN ACTOR IS ALLOWED, because it is real — a single assistant
 * turn can open five tool calls at once. Rather than invent a precedence rule
 * that silently discards four of them, spans are stored as observed and the
 * query layer offers two measures over them:
 *
 *   attributed  plain sum of span durations. What the state breakdown shows.
 *   busy        union of an actor's intervals. True wall clock, never
 *               double-counted. What the headline figure shows.
 *
 * Their ratio is the parallelism factor — a number worth having, rather than a
 * discrepancy to hide.
 */

/**
 * What an actor was doing for the length of one span.
 *
 * Same discipline as {@link MetricCategorySchema}: exactly ONE state per span,
 * the most specific that applies, so summing one actor's states gives its
 * attributed time instead of counting the interesting stretches twice.
 *
 *   generating     the model is producing text or reasoning — the only state
 *                  that burns tokens
 *   tool           a local tool is executing (Read, Edit, Grep, Write)
 *   shell          a shell command is running (Bash, manager terminal)
 *   sleeping       an explicit, deliberate wait with no work behind it
 *   waiting_agent  blocked on a child run or a peer chat
 *   waiting_human  blocked on a permission prompt or a question
 *   waiting_remote blocked on the network — a PR watch, a fetch, a remote MCP
 *   queued         input accepted, the runtime has not started on it yet
 *   paused_limit   the turn ended on a usage limit; waiting for the window
 */
export const MetricStateSchema = z.enum([
  "generating",
  "tool",
  "shell",
  "sleeping",
  "waiting_agent",
  "waiting_human",
  "waiting_remote",
  "queued",
  "paused_limit",
]);
export type MetricState = z.infer<typeof MetricStateSchema>;

/** Every state, in the order the UI stacks them. */
export const METRIC_STATES = MetricStateSchema.options;

/** Display labels for the states. */
export const METRIC_STATE_LABELS: Record<MetricState, string> = {
  generating: "Generating",
  tool: "Tools",
  shell: "Shell",
  sleeping: "Sleeping",
  waiting_agent: "Waiting on agents",
  waiting_human: "Waiting on human",
  waiting_remote: "Waiting on remote",
  queued: "Queued",
  paused_limit: "Paused (usage limit)",
};

/**
 * The coarse rollup — the distinction this whole half of the ledger exists to
 * draw.
 *
 *   thinking  the model is generating: the time that costs tokens
 *   working   something is executing on the agent's behalf, spending no tokens
 *   blocked   nothing is happening; the agent waits on someone or something
 *
 * `working` and `blocked` are both still agent use and both belong on the chart
 * — an agent that spent four hours asleep in `wait` was occupied for four hours
 * — they are just not the same KIND of hour as `thinking`.
 */
export const MetricActivityClassSchema = z.enum(["thinking", "working", "blocked"]);
export type MetricActivityClass = z.infer<typeof MetricActivityClassSchema>;

/** Every class, in reading order. */
export const METRIC_ACTIVITY_CLASSES = MetricActivityClassSchema.options;

/** Display labels for the classes. */
export const METRIC_ACTIVITY_CLASS_LABELS: Record<MetricActivityClass, string> = {
  thinking: "Thinking",
  working: "Working",
  blocked: "Blocked",
};

/**
 * State to class. The ONE place the rollup is defined; the server builds its SQL
 * `CASE` from this map rather than storing a `class` column, so re-classifying a
 * state later re-reads history correctly instead of leaving old rows on the old
 * answer.
 */
export const METRIC_STATE_CLASS: Record<MetricState, MetricActivityClass> = {
  generating: "thinking",
  tool: "working",
  shell: "working",
  sleeping: "blocked",
  waiting_agent: "blocked",
  waiting_human: "blocked",
  waiting_remote: "blocked",
  queued: "blocked",
  paused_limit: "blocked",
};

/** Roll one state up to its class. */
export function activityClass(state: MetricState): MetricActivityClass {
  return METRIC_STATE_CLASS[state];
}

/** One recorded stretch of an actor's wall clock. */
export const MetricSpanSchema = z.object({
  /** Rowid, assigned on insert. Absent on the way in. */
  id: z.number().int().optional(),
  /** When the span opened, epoch ms. */
  startTs: z.number().int(),
  /** When it closed, epoch ms. NULL means STILL OPEN — clipped to now on read. */
  endTs: z.number().int().nullable(),
  state: MetricStateSchema,
  /**
   * What was happening, within the state: a tool name for `tool`/`shell`, the
   * subagent type for `waiting_agent`, `"turn"` for `generating`.
   */
  identifier: z.string(),
  /**
   * The subagent run this span belongs to — the spawning `Task`/`Agent` call's
   * tool_use id. Absent means the chat's own main loop. Together with `chatId`
   * this is the ACTOR, and an actor's spans are its own timeline.
   */
  runId: z.string().optional(),
  detail: z.string().optional(),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  agent: z.string().optional(),
  subagent: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
  turn: z.number().int().optional(),
  /** Outcome, for spans that have one (a tool call that failed). */
  ok: z.boolean().optional(),
  source: MetricSourceSchema.default("live"),
  /**
   * The runtime's OWN duration for this span, when it reported one.
   *
   * Kept beside the observed wall clock, never mixed into it. Every harness is
   * timed on ONE clock — the server's, at event receipt — because that is the
   * only way a Claude hour and a Codex hour are comparable. This column is the
   * cross-check that says when the two disagree.
   */
  reportedMs: z.number().int().optional(),
  /**
   * The span was closed by crash recovery at the last known heartbeat, not by
   * observing it end. Its duration is a floor, not a measurement.
   */
  truncated: z.boolean().optional(),
  /** Idempotency key, and the handle a caller closes the span by. Derived. */
  spanKey: z.string().optional(),
});
export type MetricSpan = z.infer<typeof MetricSpanSchema>;

/**
 * The columns a span query may group or filter by.
 *
 * {@link MetricDimensionSchema} minus `category` (a span's equivalent axis is
 * `state`) plus the three only spans have: `state`, `class` and `runId`.
 */
export const MetricSpanDimensionSchema = z.enum([
  "state",
  "class",
  "identifier",
  "projectId",
  "chatId",
  "runId",
  "agent",
  "subagent",
  "model",
  "harness",
  "detail",
  "source",
]);
export type MetricSpanDimension = z.infer<typeof MetricSpanDimensionSchema>;

/** Display labels for the span dimensions. */
export const METRIC_SPAN_DIMENSION_LABELS: Record<MetricSpanDimension, string> = {
  state: "State",
  class: "Activity",
  identifier: "Name",
  projectId: "Project",
  chatId: "Chat",
  runId: "Run",
  agent: "Agent",
  subagent: "Subagent",
  model: "Model",
  harness: "Runtime",
  detail: "Detail",
  source: "Source",
};

/** Dimension to allowed values; OR within a dimension, AND across them. */
export const MetricSpanFilterSchema = z.partialRecord(
  MetricSpanDimensionSchema,
  z.array(z.string()),
);
export type MetricSpanFilter = z.infer<typeof MetricSpanFilterSchema>;

/** The query behind every runtime chart. Mirrors {@link MetricQuerySchema}. */
export const MetricSpanQuerySchema = z.object({
  /** Window start, epoch ms. A span is in the window if it OVERLAPS it. */
  from: z.number().int().optional(),
  /** Window end, epoch ms (exclusive). */
  to: z.number().int().optional(),
  filter: MetricSpanFilterSchema.optional(),
  groupBy: MetricSpanDimensionSchema.optional(),
  bucket: MetricBucketSchema.default("auto"),
  limit: z.number().int().min(1).max(50).default(8),
});
export type MetricSpanQuery = z.infer<typeof MetricSpanQuerySchema>;

/** The span query as a CALLER writes it — see {@link MetricQueryInput}. */
export type MetricSpanQueryInput = z.input<typeof MetricSpanQuerySchema>;

/** One group's milliseconds per bucket, aligned to the response's `buckets`. */
export const MetricSpanSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Attributed milliseconds across the whole window. */
  total: z.number().int(),
  /** Spans in this group — the count the event ledger would have given. */
  count: z.number().int(),
  /** Milliseconds per bucket, same order as `buckets`. */
  values: z.array(z.number().int()),
});
export type MetricSpanSeries = z.infer<typeof MetricSpanSeriesSchema>;

/**
 * A bucketed runtime series.
 *
 * Milliseconds, not counts — and a span that straddles a bucket boundary is
 * SPLIT across the buckets it actually covers rather than banked whole against
 * the one it started in. A four-hour sleep beginning at 23:00 is one hour of
 * that day and three of the next, because any other answer makes an overnight
 * agent look like a burst.
 */
export const MetricSpanSeriesResponseSchema = z.object({
  buckets: z.array(z.number().int()),
  bucket: z.enum(["hour", "day", "week", "month"]),
  series: z.array(MetricSpanSeriesSchema),
  /** Attributed milliseconds across every series. */
  total: z.number().int(),
  /** Spans matching the filter. */
  spans: z.number().int(),
  /** Groups that folded into "Other". */
  truncated: z.number().int(),
});
export type MetricSpanSeriesResponse = z.infer<typeof MetricSpanSeriesResponseSchema>;

/** One row of the runtime leaderboard. */
export const MetricSpanTotalSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Attributed milliseconds — the plain sum, which parallel work inflates. */
  ms: z.number().int(),
  /**
   * Wall clock: the union of each actor's intervals in this group, summed over
   * actors. Never exceeds `ms`, and is the honest answer to "how long was this
   * chat / this subagent actually running".
   */
  busyMs: z.number().int(),
  count: z.number().int(),
  chats: z.number().int(),
  /** Distinct actors — chats plus the subagent runs inside them. */
  actors: z.number().int(),
  lastAt: z.number().int(),
});
export type MetricSpanTotal = z.infer<typeof MetricSpanTotalSchema>;

/** The runtime leaderboard response. */
export const MetricSpanTotalsResponseSchema = z.object({
  totals: z.array(MetricSpanTotalSchema),
  ms: z.number().int(),
  busyMs: z.number().int(),
  groups: z.number().int(),
  chats: z.number().int(),
  actors: z.number().int(),
});
export type MetricSpanTotalsResponse = z.infer<typeof MetricSpanTotalsResponseSchema>;

/** The headline numbers for a window — everything a hero row needs at once. */
export const MetricSpanSummarySchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
  /** Wall clock, per-actor union. The figure the page leads with. */
  busyMs: z.number().int(),
  /** Plain sum. Exceeds `busyMs` exactly as much as work ran in parallel. */
  attributedMs: z.number().int(),
  byState: z.partialRecord(MetricStateSchema, z.number().int()),
  byClass: z.partialRecord(MetricActivityClassSchema, z.number().int()),
  spans: z.number().int(),
  chats: z.number().int(),
  actors: z.number().int(),
  /** Spans still open at read time, clipped to the window's end. */
  open: z.number().int(),
});
export type MetricSpanSummary = z.infer<typeof MetricSpanSummarySchema>;

/**
 * Total recorded runtime per chat, all time — the sidebar's per-row figure.
 *
 * ATTRIBUTED milliseconds, not busy time, because the question a row asks is
 * "how much agent time went into this", and two subagents working in parallel
 * for a minute really are two minutes of agent. A subagent's spans carry its
 * PARENT's `chatId` (the actor is `(chatId, runId)`; see this file's span
 * docblock), so one row already covers a chat's main loop and everything it
 * spawned.
 *
 * Every chat in one answer and no window, unlike {@link MetricSpanTotal}, which
 * caps at 50 groups and folds the rest into `__other__` — right for a top-N
 * chart, useless for labelling three hundred sidebar rows whose work finished
 * weeks ago.
 */
export const ChatRuntimeResponseSchema = z.object({
  /** chatId → summed milliseconds. A chat with no recorded spans is ABSENT, not 0. */
  byChat: z.record(z.string(), z.number()),
  /** When it was measured. Spans still open are counted up to this instant. */
  at: z.number().int(),
});
export type ChatRuntimeResponse = z.infer<typeof ChatRuntimeResponseSchema>;

/** Distinct values per span dimension, for the runtime filter controls. */
export const MetricSpanFacetsResponseSchema = z.object({
  facets: z.partialRecord(MetricSpanDimensionSchema, z.array(MetricFacetValueSchema)),
  range: z.object({ from: z.number().int().nullable(), to: z.number().int().nullable() }),
  rows: z.number().int(),
});
export type MetricSpanFacetsResponse = z.infer<typeof MetricSpanFacetsResponseSchema>;
