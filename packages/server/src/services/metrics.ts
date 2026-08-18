/**
 * MetricsService — the append-only usage ledger behind the Metrics view.
 *
 * ONE row per thing an agent actually reached for: a tool call, a manager MCP
 * endpoint, a skill, a third-party MCP tool, a durable memory that was surfaced
 * or recalled, a block of project instructions that got injected. Each row
 * carries WHO (agent/subagent/model/runtime), WHERE (project/chat) and WHEN, so
 * one table answers both "which agent leans on which tool" and "is anyone
 * actually reading these memories".
 *
 * It lives in the STATE database (`metric` table, migration 2) rather than in a
 * file of its own — same connection, same migration list, same close-before-you-
 * delete story on Windows. The aggregation SQL lives HERE rather than on `Store`
 * because it stores no entity and reads nothing whole; see `Store.stateDb`.
 *
 * WRITES ARE BUFFERED. `record()` pushes onto an in-memory queue and returns; a
 * timer flushes the queue in one transaction. A tool call must never wait on an
 * fsync, and telemetry must never be able to fail a turn — every path here
 * swallows its own errors.
 *
 * IDEMPOTENCY. Every row carries a derived `event_key` under a UNIQUE index and
 * inserts are `INSERT OR IGNORE`, so re-importing a transcript, or a live
 * recording racing the one-time backfill, can only ever produce one row.
 */
import {
  METRIC_OTHER_KEY,
  resolveBucket,
  type MetricDimension,
  type MetricEvent,
  type MetricFacetsResponse,
  type MetricFilter,
  type MetricQueryInput,
  type MetricSeriesResponse,
  type MetricTotalsResponse,
} from "@dispatch/shared";
import type { StateDb } from "../store/db.js";

/** How long a partly-filled write buffer waits before it's flushed. */
const FLUSH_INTERVAL_MS = 1_000;
/** Flush immediately once the buffer reaches this many rows. */
const FLUSH_AT_ROWS = 250;
/**
 * Hard cap on the buffer. If flushing keeps failing (a locked file, a full
 * disk) we drop the OLDEST rows rather than grow without bound — losing
 * telemetry is survivable, exhausting the heap is not.
 */
const MAX_BUFFERED_ROWS = 20_000;
/** Widest window a `facets` call will offer values for, per dimension. */
const FACET_LIMIT = 200;
/** Ceiling on gap-filled buckets, so a silly window can't allocate forever. */
const MAX_BUCKETS = 1_000;

/**
 * Wire dimension → ledger column. One map, so a dimension can't be filterable
 * but not groupable — and so no caller can put a raw string where a column name
 * goes. Every SQL fragment below indexes through this; the VALUES are always
 * bound, never interpolated.
 */
const COLUMN: Record<MetricDimension, string> = {
  category: "category",
  identifier: "identifier",
  projectId: "project_id",
  chatId: "chat_id",
  agent: "agent",
  subagent: "subagent",
  model: "model",
  harness: "harness",
  detail: "detail",
  source: "source",
};

const DIMENSIONS = Object.keys(COLUMN) as MetricDimension[];

/**
 * Dimensions the filter UI does NOT offer as a pick-list. Both are unbounded —
 * every tool name that ever ran, every chat that ever existed — so the UI
 * narrows them by typing instead, and computing 200 facet values for them on
 * every page load would be pure waste.
 */
const UNFACETED: ReadonlySet<MetricDimension> = new Set<MetricDimension>(["identifier", "chatId"]);

const INSERT_SQL = `
INSERT OR IGNORE INTO metric
  (ts, category, identifier, detail, project_id, chat_id, agent, subagent, model, harness, turn, ok, source, event_key)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

/**
 * The identity of an event, for dedup. Built from the fields that make two
 * recordings the SAME occurrence rather than two similar ones.
 *
 * A tool call has a natural key — the runtime's `toolUseId`, unique within its
 * chat — which is exactly what makes re-importing a transcript safe. Rows with
 * no such id (a memory surface, an instruction injection) fall back to their
 * coordinates plus the timestamp: that collapses a genuine double-record within
 * one millisecond and keeps everything else distinct.
 */
export function eventKey(
  event: Pick<MetricEvent, "category" | "identifier" | "chatId" | "detail"> & { ts: number },
  toolUseId?: string,
): string {
  const chat = event.chatId ?? "-";
  if (toolUseId) return `${event.category}:${chat}:${toolUseId}`;
  return `${event.category}:${chat}:${event.identifier}:${event.detail ?? "-"}:${event.ts}`;
}

/** A row on the way in: the event, plus the natural id that makes it dedupable. */
export interface MetricInput extends Omit<MetricEvent, "id" | "ts" | "source" | "eventKey"> {
  /** Defaults to now when omitted — which every live call site does. */
  ts?: number;
  source?: MetricEvent["source"];
  /** The runtime's tool_use id, when this row came from a tool call. */
  toolUseId?: string;
}

export interface MetricsServiceDeps {
  /** The state database. Shared with `Store` — same file, same connection. */
  db: StateDb;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Buffer flush cadence; 0 disables the timer so tests flush by hand. */
  flushMs?: number;
}

/** A `ts >= ? AND ts < ?` window plus its narrowing clauses and bind values. */
interface Where {
  sql: string;
  params: (string | number)[];
}

export class MetricsService {
  private readonly db: StateDb;
  private readonly now: () => number;
  private readonly flushMs: number;
  private buffer: MetricInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rows dropped because the buffer overflowed a persistently failing flush. */
  private dropped = 0;

  constructor(deps: MetricsServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.flushMs = deps.flushMs ?? FLUSH_INTERVAL_MS;
  }

  /**
   * Arm the flush timer. The database itself opens lazily on first use (see
   * `StateDb`), so there is nothing to connect here.
   */
  start(): void {
    if (this.timer || this.flushMs <= 0) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    // Never hold the process open just to write telemetry.
    this.timer.unref?.();
  }

  /**
   * Flush what's buffered and disarm. Does NOT close the database — `Store`
   * owns that handle and closes it in its own teardown.
   */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /**
   * Buffer one row. Returns immediately — nothing on a turn's hot path waits on
   * the disk. `ts` defaults to now.
   *
   * Returns the rows written IF this call tripped the size cap, else 0. Live
   * callers ignore that; a bulk importer totalling its own writes must not (see
   * {@link recordMany}).
   */
  record(event: MetricInput): number {
    this.buffer.push(event.ts === undefined ? { ...event, ts: this.now() } : event);
    return this.buffer.length >= FLUSH_AT_ROWS ? this.flush() : 0;
  }

  /**
   * Buffer several rows at once (one injection that names ten memories, one
   * chat's whole transcript).
   *
   * Returns what an auto-flush wrote ON THE WAY THROUGH. That return value is
   * the whole reason this isn't a bare loop: a batch longer than the size cap
   * flushes mid-way, and a caller that only counted its own trailing `flush()`
   * reported a fraction of what it actually imported — the first transcript
   * import claimed 1,616 rows for a ledger holding 55,116.
   */
  recordMany(events: readonly MetricInput[]): number {
    let written = 0;
    for (const e of events) written += this.record(e);
    return written;
  }

  /**
   * Write the buffer in one transaction. Called on the timer, at the size cap,
   * on dispose, and at the top of every read — so a chart never omits a number
   * that is already in memory but not yet on disk.
   *
   * Returns rows actually WRITTEN, which can be fewer than were offered:
   * `INSERT OR IGNORE` drops duplicates silently. That's the dedup working, not
   * an error.
   */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const rows = this.buffer;
    this.buffer = [];
    try {
      return this.db.tx(() => {
        const insert = this.db.prepare(INSERT_SQL);
        let written = 0;
        for (const row of rows) {
          const ts = row.ts ?? this.now();
          const res = insert.run(
            ts,
            row.category,
            row.identifier,
            row.detail ?? null,
            row.projectId ?? null,
            row.chatId ?? null,
            row.agent ?? null,
            row.subagent ?? null,
            row.model ?? null,
            row.harness ?? null,
            row.turn ?? null,
            row.ok === undefined ? null : row.ok ? 1 : 0,
            row.source ?? "live",
            eventKey({ ...row, ts }, row.toolUseId),
          );
          written += Number(res.changes ?? 0);
        }
        return written;
      });
    } catch (err) {
      // Put them back, so a transient failure (a busy lock) doesn't lose them —
      // but BOUNDED, so a persistent one can't eat the heap. Oldest go first:
      // recent activity is the part anyone is actually looking at.
      this.buffer = [...rows, ...this.buffer];
      if (this.buffer.length > MAX_BUFFERED_ROWS) {
        const overflow = this.buffer.length - MAX_BUFFERED_ROWS;
        this.buffer = this.buffer.slice(overflow);
        this.dropped += overflow;
      }
      console.error("[Dispatch] metrics: flush failed:", err);
      return 0;
    }
  }

  /* ------------------------------------------------------------- meta */

  /** Read a `metric_meta` value (the backfill watermark). */
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM metric_meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Write a `metric_meta` value. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO metric_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /* ------------------------------------------------------------ query */

  /**
   * WHERE for a window + filter.
   *
   * Filters are OR within a dimension and AND across them — which is how the
   * chips read: "project A or B, and agent X". Values go in as BIND PARAMETERS;
   * only the column name comes from {@link COLUMN}, so nothing a client sends
   * ever reaches the SQL text.
   */
  private where(from: number, to: number, filter: MetricFilter | undefined): Where {
    const clauses = ["ts >= ?", "ts < ?"];
    const params: (string | number)[] = [from, to];
    for (const dim of DIMENSIONS) {
      const values = filter?.[dim];
      if (!values || values.length === 0) continue;
      const col = COLUMN[dim];
      // An explicit "" selects rows where the column is NULL. "(default agent)"
      // is a real group in every chart, so it has to be a selectable one too.
      const hasNull = values.includes("");
      const concrete = values.filter((v) => v !== "");
      const parts: string[] = [];
      if (concrete.length) {
        parts.push(`${col} IN (${concrete.map(() => "?").join(",")})`);
        params.push(...concrete);
      }
      if (hasNull) parts.push(`${col} IS NULL`);
      clauses.push(`(${parts.join(" OR ")})`);
    }
    return { sql: clauses.join(" AND "), params };
  }

  /** Default the window to the last 30 days when the caller doesn't state one. */
  private window(q: { from?: number; to?: number }): { from: number; to: number } {
    // `+1` so a default window is inclusive of a row recorded this very ms —
    // `to` is exclusive, and "now" is exactly when the newest row lands.
    const to = q.to ?? this.now() + 1;
    const from = q.from ?? to - 30 * 86_400_000;
    return { from: Math.min(from, to), to };
  }

  /**
   * The time chart. Buckets are GAP-FILLED, so a quiet day renders as a zero
   * rather than as a straight line drawn between its neighbours.
   */
  series(query: MetricQueryInput): MetricSeriesResponse {
    this.flush();
    const { from, to } = this.window(query);
    const bucket = resolveBucket(query.bucket ?? "auto", from, to);
    const empty: MetricSeriesResponse = { buckets: [], bucket, series: [], total: 0, truncated: 0 };

    const w = this.where(from, to, query.filter);
    const groupCol = query.groupBy ? COLUMN[query.groupBy] : null;
    const rows = this.db
      .prepare(
        `SELECT ${bucketSql(bucket)} AS b, ${groupCol ? `COALESCE(${groupCol}, '')` : "''"} AS g,
                COUNT(*) AS c
         FROM metric WHERE ${w.sql} GROUP BY b, g`,
      )
      .all(...w.params) as { b: number; g: string; c: number }[];
    if (rows.length === 0) return empty;

    // Rank the groups by total and keep the top `limit`; the rest fold into one
    // "Other" series. A long tail of one-off tool names would otherwise render
    // as hundreds of unreadable lines.
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.g, (totals.get(r.g) ?? 0) + Number(r.c));
    const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const limit = query.limit ?? 8;
    const kept = new Set(ranked.slice(0, limit).map(([k]) => k));
    const truncated = Math.max(0, ranked.length - kept.size);

    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const r of rows) {
      lo = Math.min(lo, Number(r.b));
      hi = Math.max(hi, Number(r.b));
    }
    const buckets = fillBuckets(lo, hi, bucket);
    const index = new Map(buckets.map((b, i) => [b, i]));

    const byKey = new Map<string, number[]>();
    for (const r of rows) {
      const key = kept.has(r.g) ? r.g : METRIC_OTHER_KEY;
      let values = byKey.get(key);
      if (!values) byKey.set(key, (values = new Array<number>(buckets.length).fill(0)));
      const i = index.get(Number(r.b));
      if (i !== undefined) values[i]! += Number(r.c);
    }

    const series = [...byKey]
      .map(([key, values]) => ({
        key,
        label: labelFor(key, query.groupBy),
        total: values.reduce((a, b) => a + b, 0),
        values,
      }))
      // "Other" always sorts last, whatever its size — it's a residue, not a group.
      .sort((a, b) =>
        a.key === METRIC_OTHER_KEY ? 1 : b.key === METRIC_OTHER_KEY ? -1 : b.total - a.total,
      );

    return {
      buckets,
      bucket,
      series,
      total: series.reduce((sum, s) => sum + s.total, 0),
      truncated,
    };
  }

  /** The leaderboard behind the pie/bar charts and the breakdown table. */
  totals(query: MetricQueryInput & { groupBy: MetricDimension }): MetricTotalsResponse {
    this.flush();
    const { from, to } = this.window(query);
    const w = this.where(from, to, query.filter);
    const col = COLUMN[query.groupBy];
    const rows = this.db
      .prepare(
        `SELECT COALESCE(${col}, '') AS g, COUNT(*) AS c,
                COUNT(DISTINCT chat_id) AS chats, MAX(ts) AS last
         FROM metric WHERE ${w.sql}
         GROUP BY g ORDER BY c DESC, g ASC`,
      )
      .all(...w.params) as { g: string; c: number; chats: number; last: number }[];

    const limit = query.limit ?? 8;
    const totals = rows.slice(0, limit).map((r) => ({
      key: r.g,
      label: labelFor(r.g, query.groupBy),
      count: Number(r.c),
      chats: Number(r.chats),
      lastAt: Number(r.last),
    }));
    const rest = rows.slice(limit);
    if (rest.length) {
      totals.push({
        key: METRIC_OTHER_KEY,
        label: `Other (${rest.length})`,
        count: rest.reduce((sum, r) => sum + Number(r.c), 0),
        // NOT summed: one chat can appear in several folded groups, so adding
        // their chat counts would over-report reach. The widest single folded
        // group is the strongest claim this query can honestly support.
        chats: rest.reduce((max, r) => Math.max(max, Number(r.chats)), 0),
        lastAt: rest.reduce((max, r) => Math.max(max, Number(r.last)), 0),
      });
    }
    // Counted across the whole filtered set rather than folded out of `rows`:
    // one chat shows up under many groups, so a sum over-reports its reach and
    // a max under-reports it.
    const reach = this.db
      .prepare(`SELECT COUNT(DISTINCT chat_id) AS chats FROM metric WHERE ${w.sql}`)
      .get(...w.params) as { chats: number } | undefined;
    return {
      totals,
      total: rows.reduce((sum, r) => sum + Number(r.c), 0),
      groups: rows.length,
      chats: Number(reach?.chats ?? 0),
    };
  }

  /**
   * Distinct values per dimension, for the filter controls — computed from the
   * LEDGER, not from the projects/agents stores. A filter that offers a project
   * with no rows is a dead end, and one that omits a DELETED project hides
   * history which still exists.
   */
  facets(opts: { from?: number; to?: number; filter?: MetricFilter } = {}): MetricFacetsResponse {
    this.flush();
    const { from, to } = this.window(opts);
    const facets: MetricFacetsResponse["facets"] = {};
    for (const dim of DIMENSIONS) {
      if (UNFACETED.has(dim)) continue;
      // Each dimension's options are computed WITHOUT its own filter applied, so
      // selecting "agent: X" doesn't make every other agent vanish from the list
      // you'd need in order to change your mind.
      const filter = { ...(opts.filter ?? {}) };
      delete filter[dim];
      const w = this.where(from, to, filter);
      const rows = this.db
        .prepare(
          // `v ASC` is a tie-break, not a nicety. Without it SQLite may return
          // equal-count values in any order, so a pick-list would reshuffle
          // between loads — and worse, at the LIMIT boundary the tie decides
          // which values are in the list at all. Matches `totals()`, which
          // already breaks its ties the same way.
          `SELECT COALESCE(${COLUMN[dim]}, '') AS v, COUNT(*) AS c FROM metric
           WHERE ${w.sql} GROUP BY v ORDER BY c DESC, v ASC LIMIT ${FACET_LIMIT}`,
        )
        .all(...w.params) as { v: string; c: number }[];
      facets[dim] = rows.map((r) => ({ value: r.v, count: Number(r.c) }));
    }
    const span = this.db.prepare("SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM metric").get() as
      | { lo: number | null; hi: number | null; n: number }
      | undefined;
    return {
      facets,
      range: { from: span?.lo ?? null, to: span?.hi ?? null },
      rows: Number(span?.n ?? 0),
    };
  }

  /** The most recent matching rows — the activity tail under the charts. */
  recent(
    opts: { from?: number; to?: number; filter?: MetricFilter; limit?: number } = {},
  ): MetricEvent[] {
    this.flush();
    const { from, to } = this.window(opts);
    const w = this.where(from, to, opts.filter);
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const rows = this.db
      .prepare(`SELECT * FROM metric WHERE ${w.sql} ORDER BY ts DESC, seq DESC LIMIT ?`)
      .all(...w.params, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  /** Ledger size + write health, for the page footer. */
  stats(): { rows: number; buffered: number; dropped: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM metric").get() as
      | { n: number }
      | undefined;
    return { rows: Number(row?.n ?? 0), buffered: this.buffer.length, dropped: this.dropped };
  }

  /**
   * Drop rows older than `before`. Deliberately NOT on a timer: a metrics ledger
   * that silently forgets last quarter is worse than a large one, so retention
   * is a button someone presses, not a policy that runs behind them.
   */
  prune(before: number): number {
    this.flush();
    const res = this.db.prepare("DELETE FROM metric WHERE ts < ?").run(before);
    return Number(res.changes ?? 0);
  }
}

/* --------------------------------------------------------------- helpers */

/**
 * SQL that snaps `ts` to the start of its bucket, back in epoch ms.
 *
 * All four widths go through SQLite's date functions rather than integer
 * division, because two of them cannot be done any other way: months are not a
 * fixed number of ms, and weeks need an anchor. Everything is UTC, including the
 * client's rendering of the result — a bucket boundary that moved with the
 * viewer's timezone would make the same query disagree with itself.
 */
function bucketSql(bucket: "hour" | "day" | "week" | "month"): string {
  const t = "ts / 1000, 'unixepoch'";
  switch (bucket) {
    case "hour":
      return `unixepoch(strftime('%Y-%m-%d %H:00:00', ${t})) * 1000`;
    case "day":
      return `unixepoch(date(${t})) * 1000`;
    // `weekday 1` moves FORWARD to the next Monday (or stays put on one), so the
    // -7 days walks back to the Monday on or before the timestamp.
    case "week":
      return `unixepoch(date(${t}, 'weekday 1', '-7 days')) * 1000`;
    case "month":
      return `unixepoch(date(${t}, 'start of month')) * 1000`;
  }
}

/** Every bucket start from `first` to `last` inclusive, so gaps render as zeros. */
function fillBuckets(
  first: number,
  last: number,
  bucket: "hour" | "day" | "week" | "month",
): number[] {
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  const out: number[] = [];
  if (bucket === "month") {
    // Months aren't a fixed width, so step the calendar rather than the clock.
    const start = new Date(first);
    let cur = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    while (cur <= last && out.length < MAX_BUCKETS) {
      out.push(cur);
      const c = new Date(cur);
      cur = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
    }
    return out;
  }
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? 86_400_000 : 604_800_000;
  for (let t = first; t <= last && out.length < MAX_BUCKETS; t += step) out.push(t);
  return out;
}

/** Human label for a group key. `""` means the column was NULL. */
function labelFor(key: string, dim: MetricDimension | undefined): string {
  if (key === METRIC_OTHER_KEY) return "Other";
  if (key !== "") return key;
  switch (dim) {
    case "agent":
      return "(default agent)";
    case "subagent":
      return "(main loop)";
    case "model":
      return "(default model)";
    default:
      return "(none)";
  }
}

/** A DB row back into the wire shape (nulls dropped, `ok` back to a boolean). */
function rowToEvent(row: Record<string, unknown>): MetricEvent {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  return {
    id: Number(row.seq),
    ts: Number(row.ts),
    category: row.category as MetricEvent["category"],
    identifier: String(row.identifier),
    detail: str(row.detail),
    projectId: str(row.project_id),
    chatId: str(row.chat_id),
    agent: str(row.agent),
    subagent: str(row.subagent),
    model: str(row.model),
    harness: str(row.harness),
    turn: num(row.turn),
    ok: row.ok === null || row.ok === undefined ? undefined : Number(row.ok) === 1,
    source: (str(row.source) ?? "live") as MetricEvent["source"],
    eventKey: str(row.event_key),
  };
}
