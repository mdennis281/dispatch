/**
 * Hourly rollups of the two metrics ledgers — what lets a 30- or 90-day
 * Metrics read stop walking every raw row in the window.
 *
 * WHY. The live ledger is ~600k usage rows and ~900k spans. Every Usage read
 * re-aggregated the raw rows in its window (0.3–1.7 s per query at 30–90 days),
 * and the Runtime reads shipped every span in the window into JS to union
 * busy time (~2–2.6 s per read at 7 days). Moving that onto a worker thread
 * stops it freezing the UI; this stops it costing seconds at all.
 *
 * THE READ (services/metrics.ts). A window [from, to) is cut on hour
 * boundaries into a left edge, a run of whole hours, and a right edge. The
 * whole hours below the frontier (`sealed_to`) come from here; the edges, and
 * any hour at or past the frontier, come from raw rows exactly as before.
 * Nothing is approximated: every figure below is ADDITIVE across disjoint time
 * slices, so the pieces sum to what one raw pass would have produced.
 *
 * WHAT A ROW HOLDS, AND WHY EACH IS EXACT.
 *   - Usage (`metric_hour`): count + last ts per hour × every dimension. Every
 *     filter and group-by the raw table answers, this answers, because no
 *     dimension was dropped — including chat_id, which costs compression (598k
 *     rows → 138k) but is what keeps `COUNT(DISTINCT chat_id)` exact.
 *   - Runtime (`metric_span_hour`): per hour × actor × every span dimension,
 *     `ms` = the attributed time INSIDE the hour (a span is sliced at hour
 *     boundaries, so sums across hours are exact), `n` = spans that STARTED in
 *     the hour (so a span crossing six hours is still counted once), `last` =
 *     the latest clipped end.
 *   - Busy time (`metric_span_seg` + `_key`). Wall clock is the union of each
 *     actor's intervals, and a union of selected rows is NOT the sum of their
 *     unions — in the live data 57% of actor-hours have rows of different keys
 *     overlapping (parallel tool calls). So each actor-hour's timeline is cut
 *     wherever the set of active rows changes, and each distinct SET is stored
 *     once with its total length (a "segment"). For ANY selection of rows, the
 *     union is exactly the sum of the segments containing at least one
 *     selected row; for a group, the segments containing a row of that group.
 *     Unions over disjoint hour slices add, so hours sum too. 908k span slices
 *     become 105k segments.
 *
 * OPEN SPANS ARE NEVER ROLLED UP. Their end is "now", which moves. Reads take
 * them raw, and the hours an open span overlaps are read raw for its actor's
 * busy time, since the union of an open interval with stored segments is not
 * recoverable from lengths alone.
 *
 * WHO WRITES WHAT.
 *   - The main thread never computes a rollup. SQLite triggers (migration 21)
 *     record WHERE a raw row changed inside an already-sealed hour, into
 *     `metric_rollup_dirty`. That covers flush, crash recovery, the legacy
 *     column migrations and prune without any of them knowing about this file.
 *   - The metrics worker does everything else: the background build (oldest
 *     hour first), sealing each new hour as it ends, and recomputing dirty
 *     actor-hours. A read that finds a dirty row below the frontier ignores
 *     the rollup entirely, so a stale hour is never served as current.
 *
 * NEVER HOLD THE WRITE LOCK FOR LONG. A worker transaction blocks the main
 * thread's next flush for as long as it runs (busy_timeout is a synchronous
 * wait on the event loop). So every step computes from a read snapshot first
 * and only then opens a short write transaction to store the result. A change
 * that lands between the two is caught by the triggers, because `sealing_to`
 * is published BEFORE the snapshot is taken.
 */
import { SPAN_LONG_MS, SPAN_LONG_SQL, type StateDb } from "../store/db.js";

export const HOUR_MS = 3_600_000;

/**
 * Bump to make every install rebuild its rollups from scratch — whenever what
 * a row MEANS changes. The worker sees the mismatch, discards the old rows in
 * small batches, and rebuilds; reads ignore the rollup until it has.
 */
export const ROLLUP_VERSION = 1;

/**
 * How long after an hour ends before it is sealed. Rows are buffered up to a
 * second before they reach the disk, and a row landing in an hour just sealed
 * costs a dirty-recompute; a minute's grace makes that the exception.
 */
const SEAL_GRACE_MS = 60_000;

/** Raw rows one seal step may read, per ledger. Sized so a step's write
 * transaction stays in the tens of ms (see "never hold the write lock"). */
const SEAL_SPAN_ROWS = 4_000;
const SEAL_EVENT_ROWS = 8_000;
/** Dirty rows consumed per step. */
const DIRTY_BATCH = 500;
/** Rows deleted per transaction when a version change discards a rollup. */
const RESET_BATCH = 20_000;

/** `metric_meta` key: the full ANALYZE of the metric tables has run. */
const ANALYZED_KEY = "rollup.analyzed";
const ANALYZE_VERSION = "1";

export function floorHour(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/* ------------------------------------------------------------------ state */

export interface RollupState {
  sealedTo: number;
  sealingTo: number;
  version: number;
}

export function readRollupState(db: StateDb): RollupState {
  const row = db
    .prepare("SELECT sealed_to AS s, sealing_to AS g, version AS v FROM metric_rollup_state WHERE id = 1")
    .get() as { s: number; g: number; v: number } | undefined;
  return { sealedTo: Number(row?.s ?? 0), sealingTo: Number(row?.g ?? 0), version: Number(row?.v ?? 0) };
}

/**
 * The hour before which a read may take whole hours from the rollup; 0 when it
 * may not use the rollup at all. Call inside the read's snapshot
 * (`StateDb.read`) so the answer and the rows it licenses are the same
 * database.
 */
export function rollupFrontier(db: StateDb): number {
  const row = db
    .prepare(
      `SELECT sealed_to AS s, version AS v,
              EXISTS (SELECT 1 FROM metric_rollup_dirty d WHERE d.lo < r.sealed_to) AS dirty
         FROM metric_rollup_state r WHERE id = 1`,
    )
    .get() as { s: number; v: number; dirty: number } | undefined;
  if (!row || Number(row.v) !== ROLLUP_VERSION || Number(row.dirty)) return 0;
  return Number(row.s);
}

/**
 * Throw the rollup away (inside the caller's write transaction). Prune calls
 * this: it deletes history wholesale, and recomputing every hour it touched
 * one dirty row at a time would be slower than rebuilding. Version 0 makes the
 * worker discard the old rows and start again; until it has, reads go raw.
 */
export function invalidateRollups(db: StateDb): void {
  db.prepare("UPDATE metric_rollup_state SET sealed_to = 0, sealing_to = 0, version = 0 WHERE id = 1").run();
  db.prepare("DELETE FROM metric_rollup_dirty").run();
}

/* ------------------------------------------------------- span arithmetic */

/** A closed raw span, as the rollup reads it. */
export type RawSpan = {
  chat_id: string | null;
  run_id: string | null;
  state: string;
  identifier: string;
  detail: string | null;
  project_id: string | null;
  agent: string | null;
  subagent: string | null;
  model: string | null;
  harness: string | null;
  source: string;
  start_ts: number;
  end_ts: number;
};

/** The columns of a span that make up a rollup row's key, actor aside. */
const SPAN_KEY_COLS = [
  "state",
  "identifier",
  "detail",
  "project_id",
  "agent",
  "subagent",
  "model",
  "harness",
  "source",
] as const;

export interface SpanHourRow {
  hour: number;
  chat_id: string | null;
  run_id: string | null;
  state: string;
  identifier: string;
  detail: string | null;
  project_id: string | null;
  agent: string | null;
  subagent: string | null;
  model: string | null;
  harness: string | null;
  source: string;
  ms: number;
  n: number;
  last: number;
}

export interface SpanSegment {
  hour: number;
  chat_id: string | null;
  run_id: string | null;
  dur: number;
  /** Indexes into the `rows` array returned alongside. */
  members: number[];
}

/**
 * The hour slices a span covers: every hour it has a non-empty piece in, plus
 * the hour it starts in when it is zero-length. Matches the raw overlap test
 * (`start < to AND end > from`) on every whole hour that does not begin at the
 * window's own `from` — which the read never uses (see `spanSplit`).
 */
function spanHours(s: number, e: number): [number, number] {
  const first = floorHour(s);
  return [first, e > s ? floorHour(e - 1) : first];
}

/** Collision-free key for a row's dimension tuple; NULL and "" stay distinct,
 * because the raw filter treats them differently (`""` selects IS NULL). */
function dimKey(span: RawSpan): string {
  let out = "";
  for (const col of SPAN_KEY_COLS) {
    const v = span[col];
    out += v === null ? "\u0002" : `\u0003${v}`;
    out += "\u0001";
  }
  return out;
}

/**
 * Roll closed spans up into hour rows and busy-time segments, for the hours in
 * [lo, hi) only (a span reaching outside contributes just its inside slices).
 * Pure: no database, so the arithmetic is testable without one.
 */
export function rollSpans(
  spans: readonly RawSpan[],
  lo: number,
  hi: number,
): { rows: SpanHourRow[]; segs: SpanSegment[] } {
  const rows: SpanHourRow[] = [];
  /** actor-hour → (dim key → row index), plus the slices for segmentation. */
  const cells = new Map<string, { byKey: Map<string, number>; slices: [number, number, number][] }>();
  for (const span of spans) {
    const s = span.start_ts;
    const e = Math.max(s, span.end_ts);
    const [h0, h1] = spanHours(s, e);
    const key = dimKey(span);
    for (let h = Math.max(h0, lo); h <= h1 && h < hi; h += HOUR_MS) {
      const cellKey = `${span.chat_id ?? "\u0002"}\u0001${span.run_id ?? "\u0002"}\u0001${h}`;
      let cell = cells.get(cellKey);
      if (!cell) cells.set(cellKey, (cell = { byKey: new Map(), slices: [] }));
      let idx = cell.byKey.get(key);
      if (idx === undefined) {
        idx = rows.length;
        cell.byKey.set(key, idx);
        rows.push({
          hour: h,
          chat_id: span.chat_id,
          run_id: span.run_id,
          state: span.state,
          identifier: span.identifier,
          detail: span.detail,
          project_id: span.project_id,
          agent: span.agent,
          subagent: span.subagent,
          model: span.model,
          harness: span.harness,
          source: span.source,
          ms: 0,
          n: 0,
          last: h,
        });
      }
      const row = rows[idx]!;
      const ps = Math.max(s, h);
      const pe = Math.min(e, h + HOUR_MS);
      row.ms += pe - ps;
      if (h === h0) row.n += 1;
      row.last = Math.max(row.last, pe);
      if (pe > ps) cell.slices.push([ps, pe, idx]);
    }
  }

  const segs: SpanSegment[] = [];
  for (const cell of cells.values()) {
    if (cell.slices.length === 0) continue;
    // Sweep the actor-hour's boundaries; between two consecutive ones the set
    // of active rows is constant, and its length is banked against that set.
    const edges: [number, number, number][] = [];
    for (const [ps, pe, idx] of cell.slices) edges.push([ps, 1, idx], [pe, -1, idx]);
    edges.sort((a, b) => a[0] - b[0]);
    const active = new Map<number, number>();
    const bySet = new Map<string, { dur: number; members: number[] }>();
    let prev = edges[0]![0];
    for (const [t, delta, idx] of edges) {
      if (t > prev && active.size > 0) {
        const members = [...active.keys()].sort((a, b) => a - b);
        const sig = members.join(",");
        const seg = bySet.get(sig);
        if (seg) seg.dur += t - prev;
        else bySet.set(sig, { dur: t - prev, members });
      }
      prev = t;
      const c = (active.get(idx) ?? 0) + delta;
      if (c > 0) active.set(idx, c);
      else active.delete(idx);
    }
    const first = rows[cell.slices[0]![2]]!;
    for (const seg of bySet.values()) {
      segs.push({ hour: first.hour, chat_id: first.chat_id, run_id: first.run_id, ...seg });
    }
  }
  return { rows, segs };
}

/* ------------------------------------------------------------- raw reads */

const SPAN_COLS = `chat_id, run_id, state, identifier, detail, project_id, agent, subagent, model,
  harness, source, start_ts, end_ts`;

/** Closed spans with a slice in [a, b), all actors. Same three-way bound as a
 * window read: a closed span that started more than SPAN_LONG_MS before `a`
 * and is not long ended before it. */
function readSpansIn(db: StateDb, a: number, b: number): RawSpan[] {
  return db
    .prepare(
      `SELECT ${SPAN_COLS} FROM metric_span
        WHERE seq IN (SELECT seq FROM metric_span WHERE start_ts >= ? AND start_ts < ?
                      UNION ALL SELECT seq FROM metric_span WHERE ${SPAN_LONG_SQL} AND start_ts < ?)
          AND end_ts IS NOT NULL AND (end_ts > ? OR start_ts >= ?)`,
    )
    .all(a - SPAN_LONG_MS, b, a - SPAN_LONG_MS, a, a) as RawSpan[];
}

/** Closed spans of ONE actor with a slice in [a, b), off the actor index. */
function readActorSpansIn(
  db: StateDb,
  chat: string | null,
  run: string | null,
  a: number,
  b: number,
): RawSpan[] {
  return db
    .prepare(
      `SELECT ${SPAN_COLS} FROM metric_span
        WHERE chat_id IS ? AND run_id IS ? AND start_ts >= ? AND start_ts < ?
          AND end_ts IS NOT NULL AND (end_ts > ? OR start_ts >= ?)
       UNION ALL
       SELECT ${SPAN_COLS} FROM metric_span
        WHERE ${SPAN_LONG_SQL} AND start_ts < ? AND chat_id IS ? AND run_id IS ? AND end_ts > ?`,
    )
    .all(chat, run, a - SPAN_LONG_MS, b, a, a, a - SPAN_LONG_MS, chat, run, a) as RawSpan[];
}

type UsageRow = {
  hour: number;
  category: string;
  identifier: string;
  detail: string | null;
  project_id: string | null;
  chat_id: string | null;
  agent: string | null;
  subagent: string | null;
  model: string | null;
  harness: string | null;
  source: string;
  n: number;
  last: number;
};

const USAGE_DIMS = "category, identifier, detail, project_id, chat_id, agent, subagent, model, harness, source";

function readUsageIn(db: StateDb, a: number, b: number): UsageRow[] {
  return db
    .prepare(
      `SELECT ts - ts % ${HOUR_MS} AS hour, ${USAGE_DIMS}, COUNT(*) AS n, MAX(ts) AS last
         FROM metric WHERE ts >= ? AND ts < ? GROUP BY hour, ${USAGE_DIMS}`,
    )
    .all(a, b) as UsageRow[];
}

/* ------------------------------------------------------------ rollup writes */

function writeUsage(db: StateDb, rows: readonly UsageRow[]): void {
  const ins = db.prepare(
    `INSERT INTO metric_hour (hour, ${USAGE_DIMS}, n, last) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    ins.run(r.hour, r.category, r.identifier, r.detail, r.project_id, r.chat_id, r.agent, r.subagent,
      r.model, r.harness, r.source, r.n, r.last);
  }
}

function writeSpans(db: StateDb, roll: { rows: SpanHourRow[]; segs: SpanSegment[] }): void {
  const insRow = db.prepare(
    `INSERT INTO metric_span_hour (hour, chat_id, run_id, state, identifier, detail, project_id,
       agent, subagent, model, harness, source, ms, n, last) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const ids = roll.rows.map((r) =>
    Number(
      insRow.run(r.hour, r.chat_id, r.run_id, r.state, r.identifier, r.detail, r.project_id, r.agent,
        r.subagent, r.model, r.harness, r.source, r.ms, r.n, r.last).lastInsertRowid,
    ),
  );
  const insSeg = db.prepare("INSERT INTO metric_span_seg (hour, chat_id, run_id, dur) VALUES (?,?,?,?)");
  const insKey = db.prepare("INSERT INTO metric_span_seg_key (row_id, seg_id) VALUES (?,?)");
  for (const seg of roll.segs) {
    const segId = Number(insSeg.run(seg.hour, seg.chat_id, seg.run_id, seg.dur).lastInsertRowid);
    for (const m of seg.members) insKey.run(ids[m]!, segId);
  }
}

function deleteSpanRange(db: StateDb, a: number, b: number): void {
  db.prepare(
    `DELETE FROM metric_span_seg_key
      WHERE row_id IN (SELECT id FROM metric_span_hour WHERE hour >= ? AND hour < ?)`,
  ).run(a, b);
  db.prepare("DELETE FROM metric_span_hour WHERE hour >= ? AND hour < ?").run(a, b);
  db.prepare("DELETE FROM metric_span_seg WHERE hour >= ? AND hour < ?").run(a, b);
}

function deleteActorRange(db: StateDb, chat: string | null, run: string | null, a: number, b: number): void {
  const actor = "hour >= ? AND hour < ? AND chat_id IS ? AND run_id IS ?";
  db.prepare(
    `DELETE FROM metric_span_seg_key WHERE row_id IN (SELECT id FROM metric_span_hour WHERE ${actor})`,
  ).run(a, b, chat, run);
  db.prepare(`DELETE FROM metric_span_hour WHERE ${actor}`).run(a, b, chat, run);
  db.prepare(`DELETE FROM metric_span_seg WHERE ${actor}`).run(a, b, chat, run);
}

/* ------------------------------------------------------------------ builder */

/**
 * Builds and maintains the rollups. Runs in the metrics worker against its own
 * WRITABLE connection; every method is one bounded unit of work, so the worker
 * can interleave queries between steps.
 */
export class RollupBuilder {
  private analyzeQueue: { name: string; tbl: string; partial: boolean }[] | null = null;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One unit of work. Returns true when there is more to do right away, false
   * when the rollup is caught up (sealed to the last finished hour, nothing
   * dirty).
   */
  step(): boolean {
    const st = readRollupState(this.db);
    if (st.version !== ROLLUP_VERSION) return this.reset(st);
    if (this.processDirty(st)) return true;
    if (this.seal(st)) return true;
    return this.analyzeOnce();
  }

  /** Milliseconds until the next hour becomes sealable — the idle timer. */
  msUntilNextSeal(): number {
    const now = this.now();
    const next = floorHour(now - SEAL_GRACE_MS) + HOUR_MS + SEAL_GRACE_MS;
    return Math.max(1_000, next - now);
  }

  /** Whether anything below the frontier is waiting to be recomputed. Cheap:
   * what the worker checks before serving a read. */
  hasDirty(): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM metric_rollup_dirty d, metric_rollup_state r
                         WHERE r.id = 1 AND d.lo < r.sealed_to) AS d`,
      )
      .get() as { d: number } | undefined;
    return Number(row?.d ?? 0) === 1;
  }

  /** Discard a rollup built under another version, a batch at a time. */
  private reset(st: RollupState): boolean {
    if (st.sealedTo !== 0 || st.sealingTo !== 0) {
      this.db.tx(() => invalidateRollups(this.db));
      return true;
    }
    const deleted = this.db.tx(() => {
      let n = 0;
      for (const table of ["metric_hour", "metric_span_hour", "metric_span_seg"]) {
        n += Number(
          this.db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${RESET_BATCH})`)
            .run().changes ?? 0,
        );
      }
      n += Number(
        this.db
          .prepare(
            `DELETE FROM metric_span_seg_key WHERE (row_id, seg_id) IN
               (SELECT row_id, seg_id FROM metric_span_seg_key LIMIT ${RESET_BATCH})`,
          )
          .run().changes ?? 0,
      );
      return n;
    });
    if (deleted > 0) return true;
    this.db.tx(() => {
      // Re-checked inside the transaction: a prune landing between the reads
      // above and here must not be overwritten by a stale "all clear".
      const now = readRollupState(this.db);
      if (now.sealedTo === 0 && now.sealingTo === 0) {
        this.db.prepare("UPDATE metric_rollup_state SET version = ? WHERE id = 1").run(ROLLUP_VERSION);
      }
    });
    return true;
  }

  /** Recompute the hours that changed after they were sealed. */
  processDirty(st: RollupState = readRollupState(this.db)): boolean {
    const S = st.sealedTo;
    if (st.version !== ROLLUP_VERSION || S === 0) return false;
    const dirty = this.db
      .prepare(
        `SELECT rowid AS id, kind, chat_id, run_id, lo, hi FROM metric_rollup_dirty
          WHERE lo < ? ORDER BY rowid LIMIT ${DIRTY_BATCH}`,
      )
      .all(S) as { id: number; kind: string; chat_id: string | null; run_id: string | null; lo: number; hi: number }[];
    if (dirty.length === 0) return false;

    const usageHours = new Set<number>();
    const actors = new Map<string, { chat: string | null; run: string | null; lo: number; hi: number }>();
    /** Parts of a span reaching past the frontier: still owed a recompute
     * once a seal covers them, so they go back in the table. */
    const carry: { chat: string | null; run: string | null; hi: number }[] = [];
    for (const d of dirty) {
      if (d.kind === "u") {
        usageHours.add(floorHour(d.lo));
        continue;
      }
      const [h0, h1] = spanHours(d.lo, d.hi);
      const end = Math.min(h1 + HOUR_MS, S);
      const k = `${d.chat_id ?? "\u0002"}\u0001${d.run_id ?? "\u0002"}`;
      const cur = actors.get(k);
      if (cur) {
        cur.lo = Math.min(cur.lo, h0);
        cur.hi = Math.max(cur.hi, end);
      } else actors.set(k, { chat: d.chat_id, run: d.run_id, lo: h0, hi: end });
      if (h1 >= S) carry.push({ chat: d.chat_id, run: d.run_id, hi: d.hi });
    }

    // Compute from a snapshot, write in a short transaction (see the header).
    const computed = this.db.read(() => ({
      usage: [...usageHours].map((h) => ({ h, rows: readUsageIn(this.db, h, h + HOUR_MS) })),
      spans: [...actors.values()].map((a) => ({
        ...a,
        roll: rollSpans(readActorSpansIn(this.db, a.chat, a.run, a.lo, a.hi), a.lo, a.hi),
      })),
    }));
    this.db.tx(() => {
      const now = readRollupState(this.db);
      if (now.version !== ROLLUP_VERSION || now.sealedTo !== S) return;
      const del = this.db.prepare("DELETE FROM metric_rollup_dirty WHERE rowid = ?");
      for (const d of dirty) del.run(d.id);
      for (const u of computed.usage) {
        this.db.prepare("DELETE FROM metric_hour WHERE hour = ?").run(u.h);
        writeUsage(this.db, u.rows);
      }
      for (const a of computed.spans) {
        deleteActorRange(this.db, a.chat, a.run, a.lo, a.hi);
        writeSpans(this.db, a.roll);
      }
      const ins = this.db.prepare(
        "INSERT INTO metric_rollup_dirty (kind, chat_id, run_id, lo, hi) VALUES ('s', ?, ?, ?, ?)",
      );
      for (const c of carry) ins.run(c.chat, c.run, S, Math.max(S, c.hi));
    });
    return true;
  }

  /** Extend the frontier by one bounded chunk of hours. */
  private seal(st: RollupState): boolean {
    const limit = floorHour(this.now() - SEAL_GRACE_MS);
    let a = st.sealedTo;
    if (a === 0) {
      const lo = this.db
        .prepare(
          `SELECT MIN((SELECT MIN(ts) FROM metric), (SELECT MIN(start_ts) FROM metric_span)) AS lo,
                  (SELECT MIN(ts) FROM metric) AS e, (SELECT MIN(start_ts) FROM metric_span) AS s`,
        )
        .get() as { lo: number | null; e: number | null; s: number | null } | undefined;
      // MIN(a, NULL) is NULL in SQLite, so an empty table on one side would
      // hide the other's minimum.
      const first = [lo?.e, lo?.s].filter((v): v is number => v !== null && v !== undefined);
      if (first.length === 0) {
        // Nothing to roll up: the frontier moves to now vacuously, and the
        // triggers take it from there for anything written below it.
        if (limit <= 0) return false;
        this.db.tx(() => {
          const cur = readRollupState(this.db);
          if (cur.version === ROLLUP_VERSION && cur.sealedTo === 0) {
            this.db.prepare("UPDATE metric_rollup_state SET sealed_to = ? WHERE id = 1").run(limit);
          }
        });
        return false;
      }
      a = floorHour(Math.min(...first));
    }
    if (a >= limit) return false;
    const b = this.chunkEnd(a, limit);

    // (1) Publish the far edge first, so the triggers flag any change inside
    //     [a, b) from here on — including ones after the snapshot below.
    const announced = this.db.tx(() => {
      const cur = readRollupState(this.db);
      if (cur.version !== ROLLUP_VERSION || cur.sealedTo !== st.sealedTo) return false;
      this.db.prepare("UPDATE metric_rollup_state SET sealing_to = ? WHERE id = 1").run(b);
      return true;
    });
    if (!announced) return true;
    // (2) Compute from one snapshot, outside any write lock.
    const { usage, roll } = this.db.read(() => ({
      usage: readUsageIn(this.db, a, b),
      roll: rollSpans(readSpansIn(this.db, a, b), a, b),
    }));
    // (3) Store, unless the ground moved (a prune, a version reset).
    this.db.tx(() => {
      const cur = readRollupState(this.db);
      if (cur.version !== ROLLUP_VERSION || cur.sealedTo !== st.sealedTo || cur.sealingTo !== b) return;
      this.db.prepare("DELETE FROM metric_hour WHERE hour >= ? AND hour < ?").run(a, b);
      writeUsage(this.db, usage);
      deleteSpanRange(this.db, a, b);
      writeSpans(this.db, roll);
      this.db.prepare("UPDATE metric_rollup_state SET sealed_to = ?, sealing_to = 0 WHERE id = 1").run(b);
    });
    return b < limit;
  }

  /** Where a seal step starting at `a` stops: after ~SEAL_*_ROWS raw rows,
   * on an hour boundary, at least one hour on, never past `limit`. */
  private chunkEnd(a: number, limit: number): number {
    const nth = (sql: string, n: number): number | null => {
      const row = this.db.prepare(sql).get(a, n) as { t: number } | undefined;
      return row ? Number(row.t) : null;
    };
    let b = limit;
    const s = nth("SELECT start_ts AS t FROM metric_span WHERE start_ts >= ? ORDER BY start_ts LIMIT 1 OFFSET ?", SEAL_SPAN_ROWS);
    if (s !== null) b = Math.min(b, floorHour(s));
    const e = nth("SELECT ts AS t FROM metric WHERE ts >= ? ORDER BY ts LIMIT 1 OFFSET ?", SEAL_EVENT_ROWS);
    if (e !== null) b = Math.min(b, floorHour(e));
    return Math.min(limit, Math.max(b, a + HOUR_MS));
  }

  /**
   * Give the planner real statistics for the metric tables, once.
   *
   * A FULL analyze, one index per step, rather than `PRAGMA optimize`'s
   * sampled one: on the live ledger the sample put `metric_span_state` at 667
   * rows per state when the truth is ~100k, which steers `state IN (…)` reads
   * onto exactly the index plan that made them slower (see
   * metric-span-window-reads-need-subselect-not-or). One index at a time
   * because ANALYZE holds the write lock while it reads, and the main thread's
   * flush waits on that lock synchronously; warm, each index is 65–280 ms.
   */
  private analyzeOnce(): boolean {
    if (this.analyzeQueue === null) {
      const done = this.db.prepare("SELECT value FROM metric_meta WHERE key = ?").get(ANALYZED_KEY) as
        | { value?: string }
        | undefined;
      if (done?.value === ANALYZE_VERSION) {
        this.analyzeQueue = [];
        return false;
      }
      this.analyzeQueue = (
        this.db
          .prepare(
            `SELECT name, tbl_name AS tbl, sql LIKE '% WHERE %' AS partial FROM sqlite_master
              WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
                AND tbl_name IN ('metric', 'metric_span', 'metric_hour', 'metric_span_hour', 'metric_span_seg')
              ORDER BY name`,
          )
          .all() as { name: string; tbl: string; partial: number }[]
      ).map((r) => ({ name: r.name, tbl: r.tbl, partial: Number(r.partial) === 1 }));
      this.analyzeQueue.push({ name: "metric_span_seg_key", tbl: "metric_span_seg_key", partial: true });
    }
    const next = this.analyzeQueue.shift();
    if (next === undefined) return false;
    // Identifiers from sqlite_master and a literal, never from a caller.
    const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
    // Read the whole index first, with no lock held, so the ANALYZE that
    // follows finds it in cache. Cold, ANALYZE of metric_span_state took 2.9 s
    // on the live ledger — 2.9 s the main thread's next flush would have spent
    // waiting on the lock. Warm it is ~250 ms. (A partial index can't be named
    // in INDEXED BY without its WHERE, and those are tiny anyway.)
    if (!next.partial) {
      this.db.prepare(`SELECT COUNT(*) FROM ${q(next.tbl)} INDEXED BY ${q(next.name)}`).get();
    }
    this.db.exec(`ANALYZE ${q(next.name)}`);
    if (this.analyzeQueue.length === 0) {
      this.db
        .prepare(
          "INSERT INTO metric_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(ANALYZED_KEY, ANALYZE_VERSION);
    }
    return true;
  }
}
