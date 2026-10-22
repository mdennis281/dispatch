/**
 * TokenLedger — what agents CONSUMED, by account and model (`metric_tokens`,
 * migration 9). The Metrics view's Tokens tab reads it; see
 * `shared/metrics-tokens.ts` for why a row is (turn × model).
 *
 * WRITES ARE DIRECT, not buffered like `MetricsService`. That buffer exists
 * because a tool call can't wait on an fsync and there are thousands of them a
 * minute; this writes one or two rows per TURN, after the turn has already
 * ended, which is a rate the event ledger's buffer would only add a second
 * failure mode to. Every write still swallows its own errors — telemetry is
 * never allowed to fail a turn.
 *
 * Same idempotency discipline as the rest of the ledger: a derived
 * `usage_key` under a UNIQUE index and `INSERT OR IGNORE`, so the transcript
 * import and the live recorder converge on one row per (result row × model).
 */
import {
  METRIC_OTHER_KEY,
  isKnownProvider,
  accountLabel,
  findSubscription,
  providerFor,
  type HarnessKind,
  type SubscriptionSettings,
  TokenQuerySchema,
  resolveBucket,
  type TokenDimension,
  type TokenFigures,
  type TokenFilter,
  type TokenMeasure,
  type TokenQueryInput,
  type TokenReport,
  type TokenRow,
} from "@dispatch/shared";
import type { StateDb } from "../store/db.js";
import { bucketSql, fillBuckets } from "./metrics.js";

/** One model's share of one turn, on the way in. */
export interface TokenLine extends TokenFigures {
  ts: number;
  /** The result row's id — with `chatId` and `model`, the dedup key. */
  resultId: string;
  projectId?: string;
  chatId?: string;
  harness?: string;
  subscriptionId?: string;
  model?: string;
  turn?: number;
  source?: "live" | "backfill";
}

/** Wire dimension → column. Only these names ever reach the SQL text. */
const COLUMN: Record<TokenDimension, string> = {
  subscription: "subscription_id",
  model: "model",
  harness: "harness",
  projectId: "project_id",
};
const DIMENSIONS = Object.keys(COLUMN) as TokenDimension[];

/** Measure → SQL expression. `cost` sums as 0 for unpriced rows in a CHART only. */
const MEASURE: Record<TokenMeasure, string> = {
  total: "(input + output + cache_read + cache_write)",
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  cost: "COALESCE(cost_usd, 0)",
};

const INSERT_SQL = `
INSERT OR IGNORE INTO metric_tokens
  (ts, project_id, chat_id, harness, subscription_id, model, turn,
   input, output, cache_read, cache_write, cost_usd, source, usage_key)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

/**
 * `claude-opus-5[1m]` → `claude-opus-5`. The bracket is a context-window
 * variant Claude Code appends to the id it reports on assistant messages, while
 * `modelUsage` keys the same model without it — left alone, one model splits
 * into two series depending on which path booked the turn.
 */
export function ledgerModel(model: string | undefined): string | undefined {
  return model?.replace(/\[[^\]]*\]$/, "") || undefined;
}

export function usageKey(line: Pick<TokenLine, "chatId" | "resultId" | "model">): string {
  return `${line.chatId ?? "-"}:${line.resultId}:${line.model ?? "-"}`;
}

/** Turns a group key into a display name. Supplied per request (settings move). */
export type TokenLabeller = (dim: TokenDimension, key: string) => string;

// Known providers only: an uninstalled provider's history must not render as
// a live account, and `providerFor` would label it by its bare id anyway.
const isProvider = (key: string): key is HarnessKind => isKnownProvider(key);

/**
 * Names for the ledger's keys, resolved against the settings AS THEY ARE NOW —
 * so renaming an account renames its history; the id is what the ledger stored.
 */
export function tokenLabeller(settings: SubscriptionSettings | null | undefined): TokenLabeller {
  return (dim, key) => {
    if (dim === "subscription") {
      if (!key) return "(unknown account)";
      const sub = findSubscription(settings, key);
      if (sub) return accountLabel(sub);
      // An IMPLICIT account's id is its provider id, and it stops resolving the
      // moment the stored list names any account for that provider (see
      // `pinnedIdOf`). History booked under it was the provider's default
      // directory, not a deleted account — so it must not read "(removed)".
      if (isProvider(key)) return providerFor(key).shortLabel;
      return `${key} (removed)`;
    }
    if (dim === "harness") return isProvider(key) ? providerFor(key).shortLabel : key || "(unknown)";
    if (dim === "model") return key || "(unknown model)";
    return key || "(none)";
  };
}

export class TokenLedger {
  /**
   * Told about every write, after it lands. The limit sampler hangs off this:
   * a turn that just spent from an account is the best reason to read that
   * account's windows again.
   */
  onRecord?: (lines: readonly TokenLine[]) => void;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Insert lines; returns rows actually written (duplicates are absorbed). */
  record(lines: readonly TokenLine[]): number {
    if (lines.length === 0) return 0;
    try {
      const written = this.db.tx(() => {
        const insert = this.db.prepare(INSERT_SQL);
        let written = 0;
        for (const raw of lines) {
          const l = { ...raw, model: ledgerModel(raw.model) };
          const res = insert.run(
            l.ts,
            l.projectId ?? null,
            l.chatId ?? null,
            l.harness ?? null,
            l.subscriptionId ?? null,
            l.model ?? null,
            l.turn ?? null,
            Math.round(l.input),
            Math.round(l.output),
            Math.round(l.cacheRead),
            Math.round(l.cacheWrite),
            l.costUsd ?? null,
            l.source ?? "live",
            usageKey(l),
          );
          written += Number(res.changes ?? 0);
        }
        return written;
      });
      try {
        this.onRecord?.(lines);
      } catch {
        // A listener's failure is its own; the rows are already written.
      }
      return written;
    } catch (err) {
      console.error("[Dispatch] metrics: token write failed:", err);
      return 0;
    }
  }

  /**
   * Result rows of one chat already in the ledger, under ANY model.
   *
   * The transcript import needs this because its key and the live recorder's
   * only coincide when they agree on the model — and they don't: live splits a
   * turn across the models that actually ran, the import guesses the main one.
   * Keying on (chat, result) alone is what stops a turn booked live from being
   * booked a second time under the guess.
   */
  bookedResults(chatId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT usage_key AS k FROM metric_tokens WHERE chat_id = ?")
      .all(chatId) as { k: string }[];
    const prefix = `${chatId}:`;
    const out = new Set<string>();
    for (const r of rows) {
      // The key is `chat:result:model`; a model id never contains ':' before
      // the result id does, so the result id is the segment after the prefix.
      const rest = r.k.startsWith(prefix) ? r.k.slice(prefix.length) : r.k;
      out.add(rest.slice(0, rest.indexOf(":")));
    }
    return out;
  }

  private where(from: number, to: number, filter: TokenFilter | undefined) {
    const clauses = ["ts >= ?", "ts < ?"];
    const params: (string | number)[] = [from, to];
    for (const dim of DIMENSIONS) {
      const values = filter?.[dim];
      if (!values?.length) continue;
      const col = COLUMN[dim];
      // "" selects NULL, as in `MetricsService.where` — "(unknown account)" is a
      // real group in the table, so it has to be a selectable one too.
      const concrete = values.filter((v) => v !== "");
      const parts: string[] = [];
      if (concrete.length) {
        parts.push(`${col} IN (${concrete.map(() => "?").join(",")})`);
        params.push(...concrete);
      }
      if (values.includes("")) parts.push(`${col} IS NULL`);
      clauses.push(`(${parts.join(" OR ")})`);
    }
    return { sql: clauses.join(" AND "), params };
  }

  report(input: TokenQueryInput, label: TokenLabeller): TokenReport {
    const q = TokenQuerySchema.parse(input);
    const ledger = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(ts) AS lo FROM metric_tokens")
      .get() as { n: number; lo: number | null } | undefined;
    const to = q.to ?? this.now() + 1;
    // No `from` means ALL TIME, anchored at the oldest row so the auto bucket
    // sizes itself to the history that actually exists rather than to 1970.
    const from = Math.min(q.from ?? ledger?.lo ?? to - 30 * 86_400_000, to);
    const bucket = resolveBucket(q.bucket, from, to);
    const w = this.where(from, to, q.filter);
    const measure = MEASURE[q.measure];
    const groupCol = COLUMN[q.groupBy];

    /* ---- series: measure per bucket per group, top N + Other ---- */
    const points = this.db
      .prepare(
        `SELECT ${bucketSql(bucket)} AS b, COALESCE(${groupCol}, '') AS g, SUM(${measure}) AS v
           FROM metric_tokens WHERE ${w.sql} GROUP BY b, g`,
      )
      .all(...w.params) as { b: number; g: string; v: number }[];
    const groupTotals = new Map<string, number>();
    for (const p of points) groupTotals.set(p.g, (groupTotals.get(p.g) ?? 0) + Number(p.v));
    const ranked = [...groupTotals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const kept = new Set(ranked.slice(0, q.limit).map(([k]) => k));
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const p of points) {
      lo = Math.min(lo, Number(p.b));
      hi = Math.max(hi, Number(p.b));
    }
    const buckets = points.length ? fillBuckets(lo, hi, bucket) : [];
    const index = new Map(buckets.map((b, i) => [b, i]));
    const byKey = new Map<string, number[]>();
    for (const p of points) {
      const key = kept.has(p.g) ? p.g : METRIC_OTHER_KEY;
      let values = byKey.get(key);
      if (!values) byKey.set(key, (values = new Array<number>(buckets.length).fill(0)));
      const i = index.get(Number(p.b));
      if (i !== undefined) values[i]! += Number(p.v);
    }
    const series = [...byKey]
      .map(([key, values]) => ({
        key,
        label: key === METRIC_OTHER_KEY ? "Other" : label(q.groupBy, key),
        total: values.reduce((a, b) => a + b, 0),
        values,
      }))
      .sort((a, b) =>
        a.key === METRIC_OTHER_KEY ? 1 : b.key === METRIC_OTHER_KEY ? -1 : b.total - a.total,
      );

    /* ---- the (account × model) breakdown ---- */
    // `COUNT(cost_usd)` beside the SUM so a group with NO priced row reports
    // null rather than $0.00 — "unpriced" and "free" are different answers.
    const SUMS = `SUM(input) AS i, SUM(output) AS o, SUM(cache_read) AS cr, SUM(cache_write) AS cw,
                  SUM(cost_usd) AS cost, COUNT(cost_usd) AS priced,
                  COUNT(DISTINCT COALESCE(chat_id, '') || char(31) || COALESCE(turn, '')) AS turns,
                  COUNT(DISTINCT chat_id) AS chats`;
    const raw = this.db
      .prepare(
        `SELECT COALESCE(subscription_id, '') AS s, COALESCE(harness, '') AS h,
                COALESCE(model, '') AS m, ${SUMS}, MAX(ts) AS last
           FROM metric_tokens WHERE ${w.sql}
          GROUP BY s, h, m`,
      )
      .all(...w.params) as Record<string, number | string | null>[];
    const rows: TokenRow[] = raw
      .map((r) => {
        const f = figures(r);
        return {
          subscriptionId: String(r.s),
          subscriptionLabel: label("subscription", String(r.s)),
          harness: String(r.h),
          model: String(r.m),
          ...f,
          lastAt: Number(r.last),
        };
      })
      .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));

    const whole = this.db
      .prepare(`SELECT ${SUMS} FROM metric_tokens WHERE ${w.sql}`)
      .get(...w.params) as Record<string, number | string | null>;

    /* ---- facets, each computed without its own filter ---- */
    const facets: TokenReport["facets"] = {};
    for (const dim of DIMENSIONS) {
      const filter = { ...(q.filter ?? {}) };
      delete filter[dim];
      const fw = this.where(from, to, filter);
      const vals = this.db
        .prepare(
          `SELECT COALESCE(${COLUMN[dim]}, '') AS v, COUNT(*) AS c FROM metric_tokens
            WHERE ${fw.sql} GROUP BY v ORDER BY c DESC, v ASC LIMIT 200`,
        )
        .all(...fw.params) as { v: string; c: number }[];
      facets[dim] = vals.map((v) => ({
        value: v.v,
        label: label(dim, v.v),
        count: Number(v.c),
      }));
    }

    return {
      bucket,
      buckets,
      series,
      truncated: Math.max(0, ranked.length - kept.size),
      rows,
      totals: figures(whole),
      facets,
      ledgerRows: Number(ledger?.n ?? 0),
      oldest: ledger?.lo ?? null,
    };
  }
}

function figures(r: Record<string, number | string | null>) {
  const input = Number(r.i ?? 0);
  const output = Number(r.o ?? 0);
  const cacheRead = Number(r.cr ?? 0);
  const cacheWrite = Number(r.cw ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd: Number(r.priced ?? 0) > 0 ? Number(r.cost ?? 0) : null,
    total: input + output + cacheRead + cacheWrite,
    turns: Number(r.turns ?? 0),
    chats: Number(r.chats ?? 0),
  };
}
