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
  METRIC_ACTIVITY_CLASS_LABELS,
  METRIC_MAX_BUCKETS,
  METRIC_OTHER_KEY,
  METRIC_STATE_LABELS,
  activityClass,
  resolveBucket,
  type ChatRuntimeResponse,
  type MetricActivityClass,
  type MetricDimension,
  type MetricEvent,
  type MetricFacetsResponse,
  type MetricFilter,
  type MetricQueryInput,
  type MetricSeriesResponse,
  type MetricSource,
  type MetricSpan,
  type MetricSpanDimension,
  type MetricSpanFacetsResponse,
  type MetricSpanFilter,
  type MetricSpanQueryInput,
  type MetricSpanSeriesResponse,
  type MetricSpanSummary,
  type MetricSpanTotalsResponse,
  type MetricState,
  type MetricTotalsResponse,
} from "@dispatch/shared";
import {
  SPAN_COLUMN,
  SPAN_DIMENSIONS,
  bucketStart,
  distributeSpan,
  spanKey,
  unionByGroup,
  unionUnder,
  type UnionRow,
} from "./metrics-spans.js";
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

const INSERT_SPAN_SQL = `
INSERT OR IGNORE INTO metric_span
  (start_ts, end_ts, state, identifier, detail, project_id, chat_id, run_id, agent, subagent,
   model, harness, turn, ok, reported_ms, truncated, source, span_key)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

/**
 * Close an open span.
 *
 * `AND end_ts IS NULL` is what makes closing idempotent: a duplicate close, or a
 * transcript import re-deriving a span the live recorder already finished, is a
 * no-op rather than a rewrite. `MAX(start_ts, ?)` refuses to record a negative
 * duration — a close whose timestamp precedes its open means the clock moved,
 * not that time ran backwards.
 */
const CLOSE_SPAN_SQL = `
UPDATE metric_span
   SET end_ts      = MAX(start_ts, ?),
       ok          = COALESCE(?, ok),
       reported_ms = COALESCE(?, reported_ms)
 WHERE span_key = ? AND end_ts IS NULL
`;

/**
 * `metric_meta` key holding the last flush's wall clock.
 *
 * The only thing crash recovery has to go on. A span left open by a process
 * that died is closed at this stamp rather than at boot time, so a crash on
 * Friday doesn't read as a tool call that ran all weekend.
 */
const SPAN_HEARTBEAT_KEY = "span.heartbeat";

/**
 * Span dimensions the filter UI does NOT offer as a pick-list — unbounded sets
 * the UI narrows by typing instead. Same three reasons as {@link UNFACETED},
 * plus `runId`: there is one value per subagent run ever spawned.
 */
const SPAN_UNFACETED: ReadonlySet<MetricSpanDimension> = new Set<MetricSpanDimension>([
  "identifier",
  "chatId",
  "runId",
]);

/**
 * Distinct ACTORS — chats plus the subagent runs inside them.
 *
 * `char(31)` is a unit separator: it cannot occur in a chat id or a tool_use id,
 * so two different pairs can never concatenate into the same string. Counting
 * distinct chats and distinct runs separately would answer neither question.
 */
const ACTOR_COUNT_SQL = "COUNT(DISTINCT COALESCE(chat_id, '') || char(31) || COALESCE(run_id, ''))";

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

/**
 * A span on the way in.
 *
 * `endTs` is normally omitted — a live recorder opens a span when the work
 * starts and closes it by key when the work ends, because at open time nobody
 * knows how long a shell command will take. A caller that already knows the
 * whole extent (a transcript import; a tool whose call and result arrived in
 * the same tick) passes both and the span is written closed.
 */
export interface MetricSpanInput
  extends Omit<MetricSpan, "id" | "startTs" | "endTs" | "source" | "spanKey" | "truncated"> {
  /** Defaults to now when omitted — which every live call site does. */
  startTs?: number;
  /** Set only when the span's end is already known. */
  endTs?: number | null;
  source?: MetricSource;
  /** The runtime's tool_use id, when this span is one tool call. */
  toolUseId?: string;
  /** Override the derived key. The transcript import supplies its own. */
  spanKey?: string;
}

/** A buffered span row, mutable until it is flushed. */
interface BufferedSpan {
  startTs: number;
  endTs: number | null;
  state: MetricState;
  identifier: string;
  detail?: string;
  projectId?: string;
  chatId?: string;
  runId?: string;
  agent?: string;
  subagent?: string;
  model?: string;
  harness?: string;
  turn?: number;
  ok?: boolean;
  reportedMs?: number;
  source: MetricSource;
  spanKey: string;
}

/** A close waiting to be applied to a span already on disk. */
interface BufferedClose {
  endTs: number;
  ok?: boolean;
  reportedMs?: number;
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
  /** Spans not yet inserted, in insertion order. */
  private spanBuffer: BufferedSpan[] = [];
  /**
   * The same rows by key, so a close arriving before the flush edits the row in
   * place instead of queueing an UPDATE against one that isn't there yet. Most
   * tool calls finish inside a flush interval, so most spans are written once,
   * complete, and never cost a second statement.
   */
  private spanPending = new Map<string, BufferedSpan>();
  /** Closes for spans already on disk, applied as UPDATEs on the next flush. */
  private spanCloses = new Map<string, BufferedClose>();
  /** Keys this process opened and hasn't closed — what the heartbeat is for. */
  private readonly openKeys = new Set<string>();

  constructor(deps: MetricsServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.flushMs = deps.flushMs ?? FLUSH_INTERVAL_MS;
  }

  /**
   * Close out the previous process's open spans, then arm the flush timer. The
   * database itself opens lazily on first use (see `StateDb`), so there is
   * nothing to connect here.
   *
   * Recovery runs BEFORE the timer and before any session can open a span, so
   * it can safely treat every open row in the table as abandoned.
   */
  start(): void {
    try {
      const recovered = this.recoverOpenSpans();
      if (recovered > 0) {
        console.log(`[Dispatch] metrics: closed ${recovered} span(s) left open by a crash.`);
      }
    } catch (err) {
      console.error("[Dispatch] metrics: span recovery failed:", err);
    }
    if (this.timer || this.flushMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.flushMs);
    // Never hold the process open just to write telemetry.
    this.timer.unref?.();
  }

  /**
   * One timer beat: write what's buffered, and keep the heartbeat moving while
   * anything is still open even when there was nothing to write. An idle agent
   * asleep in `wait` for an hour buffers nothing for that hour — and is exactly
   * the span crash recovery must not truncate back to the start of it.
   */
  private tick(): void {
    this.flush();
    if (this.openKeys.size > 0) this.stampHeartbeat();
  }

  /**
   * Flush what's buffered and disarm. Does NOT close the database — `Store`
   * owns that handle and closes it in its own teardown.
   */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A clean shutdown KNOWS when its open spans ended: now. Leaving them for
    // the next boot's recovery sweep would mark perfectly good measurements
    // `truncated` and clamp them back to the last heartbeat.
    const at = this.now();
    for (const key of [...this.openKeys]) this.closeSpan(key, at);
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
    if (this.buffer.length === 0 && this.spanBuffer.length === 0 && this.spanCloses.size === 0) {
      return 0;
    }
    const rows = this.buffer;
    const spans = this.spanBuffer;
    const closes = this.spanCloses;
    this.buffer = [];
    this.spanBuffer = [];
    this.spanPending.clear();
    this.spanCloses = new Map();
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
        if (spans.length) {
          const insertSpan = this.db.prepare(INSERT_SPAN_SQL);
          for (const s of spans) {
            const res = insertSpan.run(
              s.startTs,
              s.endTs,
              s.state,
              s.identifier,
              s.detail ?? null,
              s.projectId ?? null,
              s.chatId ?? null,
              s.runId ?? null,
              s.agent ?? null,
              s.subagent ?? null,
              s.model ?? null,
              s.harness ?? null,
              s.turn ?? null,
              s.ok === undefined ? null : s.ok ? 1 : 0,
              s.reportedMs ?? null,
              null,
              s.source,
              s.spanKey,
            );
            written += Number(res.changes ?? 0);
          }
        }
        // Closes are applied AFTER the inserts in the same transaction, so a
        // span opened and closed across a flush boundary lands in either order
        // of arrival with the same result.
        if (closes.size) {
          const close = this.db.prepare(CLOSE_SPAN_SQL);
          for (const [key, c] of closes) {
            close.run(c.endTs, c.ok === undefined ? null : c.ok ? 1 : 0, c.reportedMs ?? null, key);
          }
        }
        this.setMeta(SPAN_HEARTBEAT_KEY, String(this.now()));
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
      this.spanBuffer = [...spans, ...this.spanBuffer];
      if (this.spanBuffer.length > MAX_BUFFERED_ROWS) {
        const overflow = this.spanBuffer.length - MAX_BUFFERED_ROWS;
        this.spanBuffer = this.spanBuffer.slice(overflow);
        this.dropped += overflow;
      }
      for (const s of this.spanBuffer) this.spanPending.set(s.spanKey, s);
      // A close recorded WHILE this flush was failing is newer than the one it
      // is being merged with, so it wins.
      for (const [key, c] of closes) if (!this.spanCloses.has(key)) this.spanCloses.set(key, c);
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
  stats(): {
    rows: number;
    buffered: number;
    dropped: number;
    spans: number;
    spansBuffered: number;
    openSpans: number;
  } {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM metric").get() as
      | { n: number }
      | undefined;
    const spans = this.db.prepare("SELECT COUNT(*) AS n FROM metric_span").get() as
      | { n: number }
      | undefined;
    return {
      rows: Number(row?.n ?? 0),
      buffered: this.buffer.length,
      dropped: this.dropped,
      spans: Number(spans?.n ?? 0),
      spansBuffered: this.spanBuffer.length + this.spanCloses.size,
      openSpans: this.openKeys.size,
    };
  }

  /**
   * Total recorded runtime for EVERY chat, keyed by id — the sidebar's per-row
   * figure. See {@link ChatRuntimeResponse} for what the number means.
   *
   * Deliberately not `spanTotals({ groupBy: "chatId" })`, which is the obvious
   * reuse and the wrong one twice over: it caps at 50 groups and folds the rest
   * into `__other__`, and it ships every clipped span row out to Node to union
   * them into `busyMs`. Neither is survivable on a poll that has to label every
   * row in the list.
   *
   * One statement, answered from `metric_span_chat` without touching the table.
   * `MAX(end, start)` floors the pathological row whose end precedes its start;
   * `COALESCE(end_ts, at)` counts a span still running up to now, which is what
   * makes a live chat's number climb while you watch it.
   */
  chatRuntime(): ChatRuntimeResponse {
    this.flush();
    const at = this.now();
    const rows = this.db
      .prepare(
        `SELECT chat_id AS id,
                SUM(MAX(COALESCE(end_ts, ?), start_ts) - start_ts) AS ms
           FROM metric_span
          WHERE chat_id IS NOT NULL
          GROUP BY chat_id`,
      )
      .all(at) as { id: string; ms: number | null }[];
    const byChat: Record<string, number> = {};
    for (const row of rows) {
      const ms = Number(row.ms ?? 0);
      // Absent rather than 0: the row renders nothing for a chat it has no
      // reading for, and "0s" is a claim that it ran and took no time.
      if (ms > 0) byChat[row.id] = ms;
    }
    return { byChat, at };
  }

  /**
   * Drop rows older than `before`. Deliberately NOT on a timer: a metrics ledger
   * that silently forgets last quarter is worse than a large one, so retention
   * is a button someone presses, not a policy that runs behind them.
   */
  prune(before: number): number {
    this.flush();
    return this.db.tx(() => {
      const events = this.db.prepare("DELETE FROM metric WHERE ts < ?").run(before);
      // A span is history once it ENDED before the cut-off. One still running,
      // or one that started last month and is still going, is not.
      const spans = this.db
        .prepare("DELETE FROM metric_span WHERE end_ts IS NOT NULL AND end_ts < ?")
        .run(before);
      return Number(events.changes ?? 0) + Number(spans.changes ?? 0);
    });
  }

  /* ------------------------------------------------------- span recording */

  /**
   * Open a span and return its key — the handle {@link closeSpan} takes.
   *
   * Buffered like every other write: opening a span must never make a tool call
   * wait on the disk. The row is written with `end_ts` NULL, so a span that is
   * still running is VISIBLE (clipped to now on read) rather than invisible
   * until it finishes. That matters most for exactly the spans this feature
   * exists to show: the four-hour sleep, the build that hasn't come back.
   */
  openSpan(input: MetricSpanInput): string {
    const startTs = input.startTs ?? this.now();
    const key = input.spanKey ?? spanKey({ ...input, startTs }, input.toolUseId);
    const endTs = input.endTs ?? null;
    const row: BufferedSpan = {
      startTs,
      endTs: endTs === null ? null : Math.max(endTs, startTs),
      state: input.state,
      identifier: input.identifier,
      detail: input.detail,
      projectId: input.projectId,
      chatId: input.chatId,
      runId: input.runId,
      agent: input.agent,
      subagent: input.subagent,
      model: input.model,
      harness: input.harness,
      turn: input.turn,
      ok: input.ok,
      reportedMs: input.reportedMs,
      source: input.source ?? "live",
      spanKey: key,
    };
    this.spanBuffer.push(row);
    this.spanPending.set(key, row);
    if (row.endTs === null) this.openKeys.add(key);
    this.maybeFlushSpans();
    return key;
  }

  /**
   * Close the span with this key. Unknown keys are harmless — a close for a span
   * that was never opened (or that a previous process opened and recovery
   * already truncated) updates nothing.
   *
   * `reportedMs` is the RUNTIME's own duration for the same stretch, recorded
   * beside the observed one and never in place of it. Mixing the two would mean
   * a window's total was measured on two different clocks.
   */
  closeSpan(
    key: string,
    at?: number,
    extra?: { ok?: boolean; reportedMs?: number },
  ): void {
    const endTs = at ?? this.now();
    this.openKeys.delete(key);
    const pending = this.spanPending.get(key);
    if (pending) {
      // Still in the buffer — close it in place, and the row is written once,
      // complete. The common case by far: most tool calls finish inside a flush
      // interval, so most spans never cost an UPDATE at all.
      //
      // A span that already has an end is LEFT ALONE, matching what
      // `AND end_ts IS NULL` does on the disk path. Without this the same
      // duplicate close would extend a span or not depending purely on whether
      // a flush happened to land between the two calls.
      if (pending.endTs !== null) return;
      pending.endTs = Math.max(endTs, pending.startTs);
      if (extra?.ok !== undefined) pending.ok = extra.ok;
      if (extra?.reportedMs !== undefined) pending.reportedMs = extra.reportedMs;
      return;
    }
    // Likewise first-close-wins for a row already on disk: a second close
    // queued behind the first would overwrite it before either is applied.
    if (this.spanCloses.has(key)) return;
    this.spanCloses.set(key, { endTs, ok: extra?.ok, reportedMs: extra?.reportedMs });
    this.maybeFlushSpans();
  }

  /**
   * Open several spans at once — a transcript import, or a batch whose extents
   * are all already known. Returns their keys, in order.
   */
  recordSpans(inputs: readonly MetricSpanInput[]): string[] {
    return inputs.map((input) => this.openSpan(input));
  }

  /** Flush once the span buffers reach the same size cap events use. */
  private maybeFlushSpans(): void {
    if (this.spanBuffer.length + this.spanCloses.size >= FLUSH_AT_ROWS) this.flush();
  }

  /**
   * Close every span left open by a process that is no longer running, at the
   * last heartbeat it wrote.
   *
   * Called once at {@link start}, before anything can open a new one. Without
   * it a crash mid-turn leaves rows whose `end_ts` is NULL forever, and every
   * read clips them to NOW — so a tool call interrupted on Friday grows by a
   * day every day until someone notices the chart.
   *
   * Clamped to the heartbeat rather than to boot time because that stamp is the
   * last moment the span is KNOWN to have been running; anything after it is a
   * guess. The rows are marked `truncated` so a reader can tell a measured
   * duration from a floor.
   */
  recoverOpenSpans(): number {
    const stamped = Number(this.getMeta(SPAN_HEARTBEAT_KEY) ?? 0);
    const now = this.now();
    const end = stamped > 0 ? Math.min(stamped, now) : now;
    const res = this.db
      .prepare(
        "UPDATE metric_span SET end_ts = MAX(start_ts, ?), truncated = 1 WHERE end_ts IS NULL",
      )
      .run(end);
    return Number(res.changes ?? 0);
  }

  /** Stamp the heartbeat. Called on every flush that wrote, and on idle ticks
   * while spans are open — see {@link recoverOpenSpans} for why it matters. */
  private stampHeartbeat(): void {
    try {
      this.setMeta(SPAN_HEARTBEAT_KEY, String(this.now()));
    } catch {
      /* telemetry bookkeeping must never throw into a caller */
    }
  }

  /* ---------------------------------------------------------- span query */

  /**
   * WHERE for a window + filter, over spans.
   *
   * Note the test: a span is in the window when it OVERLAPS it, not when it
   * started in it. An eight-hour run that began yesterday is part of today, and
   * the event ledger's `ts >= from AND ts < to` would drop it entirely.
   *
   * `live` is what an open span's missing end is read as — now, clamped by the
   * window's own end downstream.
   */
  private spanWhere(
    from: number,
    to: number,
    live: number,
    filter: MetricSpanFilter | undefined,
  ): Where {
    const clauses = ["start_ts < ?", "COALESCE(end_ts, ?) > ?"];
    const params: (string | number)[] = [to, live, from];
    for (const dim of SPAN_DIMENSIONS) {
      const values = filter?.[dim];
      if (!values || values.length === 0) continue;
      const col = SPAN_COLUMN[dim];
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

  /**
   * The CTE every span read opens with: matching rows, CLIPPED to the window.
   *
   * Clipping here rather than in each query is what lets the four readers below
   * be simple sums — by the time they see a row, `e - s` is already the part of
   * it that belongs to this window and nothing else. `MAX(e0, s0)` is a floor at
   * zero for the pathological row whose end precedes its start.
   */
  private clipped(
    from: number,
    to: number,
    live: number,
    filter: MetricSpanFilter | undefined,
    groupExpr: string,
  ): Where {
    const w = this.spanWhere(from, to, live, filter);
    // COALESCE, because "" IS the NULL group everywhere else in the feature —
    // `spanLabelFor` renders it, and a filter chip sends it back to select the
    // NULL rows. Without it the commonest group of all leaks out as a literal
    // null: `run_id` is NULL for every main-loop span, so grouping by run would
    // key the whole main loop on nothing.
    const sql = `WITH raw AS (
      SELECT COALESCE(${groupExpr}, '') AS g, state, chat_id, run_id,
             CASE WHEN end_ts IS NULL THEN 1 ELSE 0 END AS still_open,
             MAX(start_ts, ?) AS s0, MIN(COALESCE(end_ts, ?), ?) AS e0
      FROM metric_span WHERE ${w.sql}
    ), clipped AS (
      SELECT g, state, chat_id, run_id, still_open, s0 AS s, MAX(e0, s0) AS e FROM raw
    )`;
    return { sql, params: [from, live, to, ...w.params] };
  }

  /**
   * The runtime time chart: milliseconds per bucket, per group.
   *
   * Two queries rather than one, and the split is the point. A span that lies
   * inside a single bucket can be summed in SQL, which is nearly all of them; a
   * span that STRADDLES a boundary has to be cut up, which SQL cannot do without
   * a recursive walk, so those few come back as rows and are distributed here.
   * The alternative — banking every span whole against the bucket it started in
   * — is wrong by exactly the amount that matters, because the spans that
   * straddle are the long ones.
   */
  spanSeries(query: MetricSpanQueryInput): MetricSpanSeriesResponse {
    this.flush();
    const { from, to } = this.window(query);
    const live = this.now();
    const bucket = resolveBucket(query.bucket ?? "auto", from, to);
    const groupExpr = query.groupBy ? SPAN_COLUMN[query.groupBy] : "''";
    const cte = this.clipped(from, to, live, query.filter, groupExpr);
    // The bucket a clipped span starts in, and the one its LAST millisecond
    // falls in. Equal ⇒ it fits in one bucket. `MAX(s, e - 1)` keeps a
    // zero-length span (a tool whose call and result arrived in the same tick)
    // on the contained side instead of sending it round the split for 0 ms.
    const startB = bucketSql(bucket, "s");
    const endB = bucketSql(bucket, "MAX(s, e - 1)");

    const contained = this.db
      .prepare(
        `${cte.sql} SELECT g, ${startB} AS b, SUM(e - s) AS ms, COUNT(*) AS n
         FROM clipped WHERE ${startB} = ${endB} GROUP BY g, b`,
      )
      .all(...cte.params) as { g: string; b: number; ms: number; n: number }[];
    const straddling = this.db
      .prepare(`${cte.sql} SELECT g, s, e FROM clipped WHERE ${startB} <> ${endB}`)
      .all(...cte.params) as { g: string; s: number; e: number }[];

    const empty: MetricSpanSeriesResponse = {
      buckets: [],
      bucket,
      series: [],
      total: 0,
      spans: 0,
      truncated: 0,
    };
    if (contained.length === 0 && straddling.length === 0) return empty;

    // Rank the groups by time spent, keep the top `limit`, fold the rest into
    // "Other" — same policy as the event series, for the same reason.
    const totals = new Map<string, number>();
    const counts = new Map<string, number>();
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    const seen = (g: string, ms: number, n: number) => {
      totals.set(g, (totals.get(g) ?? 0) + ms);
      counts.set(g, (counts.get(g) ?? 0) + n);
    };
    for (const r of contained) {
      seen(r.g, Number(r.ms), Number(r.n));
      lo = Math.min(lo, Number(r.b));
      hi = Math.max(hi, Number(r.b));
    }
    for (const r of straddling) {
      seen(r.g, r.e - r.s, 1);
      lo = Math.min(lo, bucketStart(r.s, bucket));
      hi = Math.max(hi, bucketStart(Math.max(r.s, r.e - 1), bucket));
    }
    const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const limit = query.limit ?? 8;
    const kept = new Set(ranked.slice(0, limit).map(([k]) => k));
    const truncated = Math.max(0, ranked.length - kept.size);
    const fold = (g: string) => (kept.has(g) ? g : METRIC_OTHER_KEY);

    const buckets = fillBuckets(lo, hi, bucket);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const byKey = new Map<string, number[]>();
    const valuesFor = (key: string): number[] => {
      let values = byKey.get(key);
      if (!values) byKey.set(key, (values = new Array<number>(buckets.length).fill(0)));
      return values;
    };
    for (const r of contained) {
      const i = index.get(Number(r.b));
      if (i !== undefined) valuesFor(fold(r.g))[i]! += Number(r.ms);
    }
    for (const r of straddling) distributeSpan(r.s, r.e, buckets, bucket, valuesFor(fold(r.g)));

    const foldedCounts = new Map<string, number>();
    for (const [g, n] of counts) foldedCounts.set(fold(g), (foldedCounts.get(fold(g)) ?? 0) + n);

    const series = [...byKey]
      .map(([key, values]) => ({
        key,
        label: spanLabelFor(key, query.groupBy),
        // Summed from the distributed buckets rather than carried alongside
        // them, so the headline of a series can never disagree with the points
        // drawn for it.
        total: values.reduce((a, b) => a + b, 0),
        count: foldedCounts.get(key) ?? 0,
        values,
      }))
      .sort((a, b) =>
        a.key === METRIC_OTHER_KEY ? 1 : b.key === METRIC_OTHER_KEY ? -1 : b.total - a.total,
      );

    return {
      buckets,
      bucket,
      series,
      total: series.reduce((sum, s) => sum + s.total, 0),
      spans: series.reduce((sum, s) => sum + s.count, 0),
      truncated,
    };
  }

  /**
   * The runtime leaderboard — "which chat / subagent / tool owns this window".
   *
   * Carries BOTH measures per row, because they answer different questions and
   * the gap between them is itself informative: `ms` is attributed time (a plain
   * sum, which parallel tool calls inflate) and `busyMs` is wall clock (each
   * actor's intervals unioned first). For a chat that runs five agents at once
   * the first is agent-hours and the second is hours.
   */
  spanTotals(
    query: MetricSpanQueryInput & { groupBy: MetricSpanDimension },
  ): MetricSpanTotalsResponse {
    this.flush();
    const { from, to } = this.window(query);
    const live = this.now();
    const cte = this.clipped(from, to, live, query.filter, SPAN_COLUMN[query.groupBy]);
    const rows = this.db
      .prepare(
        `${cte.sql} SELECT g, SUM(e - s) AS ms, COUNT(*) AS n,
                COUNT(DISTINCT chat_id) AS chats, ${ACTOR_COUNT_SQL} AS actors, MAX(e) AS last
         FROM clipped GROUP BY g ORDER BY ms DESC, g ASC`,
      )
      .all(...cte.params) as {
      g: string;
      ms: number;
      n: number;
      chats: number;
      actors: number;
      last: number;
    }[];
    const unionRows = this.db
      .prepare(
        `${cte.sql} SELECT g, COALESCE(chat_id, '') AS c, COALESCE(run_id, '') AS r, s, e
         FROM clipped ORDER BY g, c, r, s`,
      )
      .all(...cte.params) as UnionRow[];
    const busy = unionByGroup(unionRows);

    const limit = query.limit ?? 8;
    const head = rows.slice(0, limit);
    const totals = head.map((r) => ({
      key: r.g,
      label: spanLabelFor(r.g, query.groupBy),
      ms: Number(r.ms),
      busyMs: busy.get(r.g) ?? 0,
      count: Number(r.n),
      chats: Number(r.chats),
      actors: Number(r.actors),
      lastAt: Number(r.last),
    }));
    const rest = rows.slice(limit);
    if (rest.length) {
      const kept = new Set(head.map((r) => r.g));
      totals.push({
        key: METRIC_OTHER_KEY,
        label: `Other (${rest.length})`,
        ms: rest.reduce((sum, r) => sum + Number(r.ms), 0),
        // RE-UNIONED across the folded groups rather than summed from them: one
        // actor can appear in several, and adding their wall clocks would report
        // it twice. Same trap the `chats` column below sidesteps by taking a max.
        busyMs: unionUnder(unionRows, METRIC_OTHER_KEY, (g) => !kept.has(g)),
        count: rest.reduce((sum, r) => sum + Number(r.n), 0),
        chats: rest.reduce((max, r) => Math.max(max, Number(r.chats)), 0),
        actors: rest.reduce((max, r) => Math.max(max, Number(r.actors)), 0),
        lastAt: rest.reduce((max, r) => Math.max(max, Number(r.last)), 0),
      });
    }
    const reach = this.db
      .prepare(
        `${cte.sql} SELECT COUNT(DISTINCT chat_id) AS chats, ${ACTOR_COUNT_SQL} AS actors FROM clipped`,
      )
      .get(...cte.params) as { chats: number; actors: number } | undefined;
    return {
      totals,
      ms: rows.reduce((sum, r) => sum + Number(r.ms), 0),
      busyMs: unionUnder(unionRows, ""),
      groups: rows.length,
      chats: Number(reach?.chats ?? 0),
      actors: Number(reach?.actors ?? 0),
    };
  }

  /** The headline numbers for a window — one call, everything a hero row needs. */
  spanSummary(
    opts: { from?: number; to?: number; filter?: MetricSpanFilter } = {},
  ): MetricSpanSummary {
    this.flush();
    const { from, to } = this.window(opts);
    const live = this.now();
    const cte = this.clipped(from, to, live, opts.filter, "''");
    const byState = this.db
      .prepare(
        `${cte.sql} SELECT state, SUM(e - s) AS ms, COUNT(*) AS n, SUM(still_open) AS open
         FROM clipped GROUP BY state`,
      )
      .all(...cte.params) as { state: MetricState; ms: number; n: number; open: number }[];
    const reach = this.db
      .prepare(
        `${cte.sql} SELECT COUNT(DISTINCT chat_id) AS chats, ${ACTOR_COUNT_SQL} AS actors FROM clipped`,
      )
      .get(...cte.params) as { chats: number; actors: number } | undefined;
    // One group, so SQL's own ordering is already actor-then-time and the union
    // is a single pass with no sort on this side.
    const unionRows = this.db
      .prepare(
        `${cte.sql} SELECT g, COALESCE(chat_id, '') AS c, COALESCE(run_id, '') AS r, s, e
         FROM clipped ORDER BY c, r, s`,
      )
      .all(...cte.params) as UnionRow[];

    const states: MetricSpanSummary["byState"] = {};
    const classes: Partial<Record<MetricActivityClass, number>> = {};
    let attributedMs = 0;
    let spans = 0;
    let open = 0;
    for (const row of byState) {
      const ms = Number(row.ms);
      states[row.state] = (states[row.state] ?? 0) + ms;
      const cls = activityClass(row.state);
      classes[cls] = (classes[cls] ?? 0) + ms;
      attributedMs += ms;
      spans += Number(row.n);
      open += Number(row.open);
    }
    return {
      from,
      to,
      busyMs: unionByGroup(unionRows).get("") ?? 0,
      attributedMs,
      byState: states,
      byClass: classes,
      spans,
      chats: Number(reach?.chats ?? 0),
      actors: Number(reach?.actors ?? 0),
      open,
    };
  }

  /** Distinct values per span dimension, for the runtime filter controls. */
  spanFacets(
    opts: { from?: number; to?: number; filter?: MetricSpanFilter } = {},
  ): MetricSpanFacetsResponse {
    this.flush();
    const { from, to } = this.window(opts);
    const live = this.now();
    const facets: MetricSpanFacetsResponse["facets"] = {};
    for (const dim of SPAN_DIMENSIONS) {
      if (SPAN_UNFACETED.has(dim)) continue;
      // A dimension's own filter is dropped before computing its options, so
      // picking one value doesn't hide the others you'd need to change your mind.
      const filter = { ...(opts.filter ?? {}) };
      delete filter[dim];
      const w = this.spanWhere(from, to, live, filter);
      const rows = this.db
        .prepare(
          `SELECT COALESCE(${SPAN_COLUMN[dim]}, '') AS v, COUNT(*) AS c FROM metric_span
           WHERE ${w.sql} GROUP BY v ORDER BY c DESC, v ASC LIMIT ${FACET_LIMIT}`,
        )
        .all(...w.params) as { v: string; c: number }[];
      facets[dim] = rows.map((r) => ({ value: r.v, count: Number(r.c) }));
    }
    // An open span's effective end is NOW, exactly as every read treats it —
    // falling back to its START would leave the range short of the present for
    // as long as anything is running, which is when someone is most likely to
    // be looking.
    const range = this.db
      .prepare(
        "SELECT MIN(start_ts) AS lo, MAX(COALESCE(end_ts, ?)) AS hi, COUNT(*) AS n FROM metric_span",
      )
      .get(live) as { lo: number | null; hi: number | null; n: number } | undefined;
    return {
      facets,
      range: { from: range?.lo ?? null, to: range?.hi ?? null },
      rows: Number(range?.n ?? 0),
    };
  }

  /** The most recent matching spans — the runtime activity tail. */
  recentSpans(
    opts: { from?: number; to?: number; filter?: MetricSpanFilter; limit?: number } = {},
  ): MetricSpan[] {
    this.flush();
    const { from, to } = this.window(opts);
    const live = this.now();
    const w = this.spanWhere(from, to, live, opts.filter);
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM metric_span WHERE ${w.sql} ORDER BY start_ts DESC, seq DESC LIMIT ?`,
      )
      .all(...w.params, limit) as Record<string, unknown>[];
    return rows.map(rowToSpan);
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
function bucketSql(bucket: "hour" | "day" | "week" | "month", expr = "ts"): string {
  const t = `${expr} / 1000, 'unixepoch'`;
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

/**
 * Every bucket start from `first` to `last` inclusive, so gaps render as zeros.
 *
 * The `METRIC_MAX_BUCKETS` guard is a BACKSTOP against a runaway allocation,
 * not a policy: `resolveBucket` has already coarsened the width so the window
 * fits, and `first`/`last` come from the DATA (whose span can only be narrower
 * than the requested window), so it should never bind. It must not be relied on
 * to trim, because a row whose bucket got trimmed away is a row silently
 * dropped from both its series and the response total.
 */
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
    while (cur <= last && out.length < METRIC_MAX_BUCKETS) {
      out.push(cur);
      const c = new Date(cur);
      cur = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
    }
    return out;
  }
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? 86_400_000 : 604_800_000;
  for (let t = first; t <= last && out.length < METRIC_MAX_BUCKETS; t += step) out.push(t);
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

/** Human label for a span group key. `""` means the column was NULL. */
function spanLabelFor(key: string, dim: MetricSpanDimension | undefined): string {
  if (key === METRIC_OTHER_KEY) return "Other";
  // The two derived dimensions have authored labels; everything else IS its
  // value, and inventing a prettier one would break the filter chip that has to
  // send the value back.
  if (dim === "state") return METRIC_STATE_LABELS[key as MetricState] ?? key;
  if (dim === "class") return METRIC_ACTIVITY_CLASS_LABELS[key as MetricActivityClass] ?? key;
  if (key !== "") return key;
  switch (dim) {
    case "agent":
      return "(default agent)";
    case "runId":
    case "subagent":
      return "(main loop)";
    case "model":
      return "(default model)";
    default:
      return "(none)";
  }
}

/** A span row back into the wire shape (nulls dropped, flags back to booleans). */
function rowToSpan(row: Record<string, unknown>): MetricSpan {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  const bool = (v: unknown) => (v === null || v === undefined ? undefined : Number(v) === 1);
  return {
    id: Number(row.seq),
    startTs: Number(row.start_ts),
    endTs: row.end_ts === null || row.end_ts === undefined ? null : Number(row.end_ts),
    state: row.state as MetricState,
    identifier: String(row.identifier),
    runId: str(row.run_id),
    detail: str(row.detail),
    projectId: str(row.project_id),
    chatId: str(row.chat_id),
    agent: str(row.agent),
    subagent: str(row.subagent),
    model: str(row.model),
    harness: str(row.harness),
    turn: num(row.turn),
    ok: bool(row.ok),
    source: (str(row.source) ?? "live") as MetricSpan["source"],
    reportedMs: num(row.reported_ms),
    truncated: bool(row.truncated),
    spanKey: str(row.span_key),
  };
}
