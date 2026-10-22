/**
 * Token accounting — the third half of the Metrics ledger.
 *
 * The event ledger counts what agents reached for and the span ledger measures
 * where the time went; neither says what any of it CONSUMED. Tokens and cost
 * were only ever written into each chat's transcript as a raw `usage` blob on
 * the result row — untyped, unattributed to a model, and silent about which
 * account paid — so "how much of my Max plan did Opus eat this week, and on
 * which login" was unanswerable without hand-reading JSONL.
 *
 * One row per (turn × model). Per MODEL rather than per turn because a single
 * Claude turn routinely spends on two: the main loop on Opus and an Explore
 * subagent on Haiku. Folding those into the session's headline model would book
 * Haiku's tokens at Opus's name — exactly the split this view exists to show.
 *
 * `input` is UNCACHED input everywhere. Anthropic already reports it that way;
 * OpenAI-shaped counters (Codex) include cached tokens in their input figure, so
 * the adapters subtract them. Without one convention, "input" on a Claude row
 * and on a Codex row would be two different quantities summed into one total.
 */
import * as z from "zod";
import { MetricBucketSchema } from "./metrics.js";

/** The four token counters plus what they cost, for one model over one turn. */
export const TokenFiguresSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  /** Absent when the runtime reports no price (Codex, local models). */
  costUsd: z.number().nonnegative().optional(),
});
export type TokenFigures = z.infer<typeof TokenFiguresSchema>;

/** Every token a figure counts, cached or not. */
export function tokenTotal(
  f: Pick<TokenFigures, "input" | "output" | "cacheRead" | "cacheWrite">,
): number {
  return f.input + f.output + f.cacheRead + f.cacheWrite;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A runtime's raw usage payload → {@link TokenFigures}, or undefined when it
 * carries no counters at all.
 *
 * Accepts both spellings that reach a transcript: Anthropic's snake_case result
 * `usage` (`input_tokens`, `cache_read_input_tokens`, …) and the camelCase shape
 * ACP and Codex use (`inputTokens`, `cachedReadTokens` / `cachedInputTokens`).
 * Shared because the live broker and the transcript backfill both read it, and
 * two readers would eventually disagree about which field means "input".
 */
export function figuresOfUsage(usage: unknown): TokenFigures | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  if ("input_tokens" in u || "output_tokens" in u) {
    const f = {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    };
    return tokenTotal(f) > 0 ? f : undefined;
  }
  if ("inputTokens" in u || "outputTokens" in u || "totalTokens" in u) {
    // Codex's `cachedInputTokens` is a SUBSET of `inputTokens` (OpenAI's
    // convention); ACP's `cachedReadTokens` is reported beside it. Subtracting
    // only the Codex one keeps `input` meaning "uncached" for both.
    const codexCached = n(u.cachedInputTokens);
    const f = {
      input: Math.max(0, n(u.inputTokens) - codexCached),
      output: n(u.outputTokens),
      cacheRead: codexCached + n(u.cachedReadTokens),
      cacheWrite: n(u.cachedWriteTokens),
    };
    // A bare `totalTokens` with no split still counts — as input, the larger
    // side of any real turn — rather than vanishing from the totals.
    if (tokenTotal(f) === 0 && n(u.totalTokens) > 0) f.input = n(u.totalTokens);
    return tokenTotal(f) > 0 ? f : undefined;
  }
  return undefined;
}

/**
 * Claude's per-model `modelUsage` (session-cumulative, camelCase, `costUSD`)
 * → a model-keyed map of {@link TokenFigures}.
 */
export function figuresOfModelUsage(raw: unknown): Record<string, TokenFigures> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, TokenFigures> = {};
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    out[model] = {
      input: n(m.inputTokens),
      output: n(m.outputTokens),
      cacheRead: n(m.cacheReadInputTokens),
      cacheWrite: n(m.cacheCreationInputTokens),
      ...(typeof m.costUSD === "number" ? { costUsd: n(m.costUSD) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ query */

/** What the token view can split and narrow by. */
export const TokenDimensionSchema = z.enum(["subscription", "model", "harness", "projectId"]);
export type TokenDimension = z.infer<typeof TokenDimensionSchema>;

export const TOKEN_DIMENSION_LABELS: Record<TokenDimension, string> = {
  subscription: "Account",
  model: "Model",
  harness: "Provider",
  projectId: "Project",
};

/** Which number the chart plots. The table always shows all of them. */
export const TokenMeasureSchema = z.enum([
  "total",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
]);
export type TokenMeasure = z.infer<typeof TokenMeasureSchema>;

export const TOKEN_MEASURE_LABELS: Record<TokenMeasure, string> = {
  total: "All tokens",
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  cost: "API equivalent value",
};

export const TokenFilterSchema = z.partialRecord(TokenDimensionSchema, z.array(z.string()));
export type TokenFilter = z.infer<typeof TokenFilterSchema>;

export const TokenQuerySchema = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  filter: TokenFilterSchema.optional(),
  groupBy: TokenDimensionSchema.default("model"),
  measure: TokenMeasureSchema.default("total"),
  bucket: MetricBucketSchema.default("auto"),
  limit: z.number().int().min(1).max(50).default(8),
});
export type TokenQuery = z.infer<typeof TokenQuerySchema>;
export type TokenQueryInput = z.input<typeof TokenQuerySchema>;

/** One (account × model) line of the breakdown table. */
export interface TokenRow extends Required<Omit<TokenFigures, "costUsd">> {
  subscriptionId: string;
  /** The account's display name, resolved against the CURRENT settings. */
  subscriptionLabel: string;
  harness: string;
  model: string;
  /** Null when no row in the group carried a price. */
  costUsd: number | null;
  total: number;
  turns: number;
  chats: number;
  lastAt: number;
}

export interface TokenReport {
  bucket: "hour" | "day" | "week" | "month";
  /** Bucket starts, ascending and gap-filled. */
  buckets: number[];
  /** The chosen measure per bucket, split by `groupBy`, top `limit` + Other. */
  series: { key: string; label: string; total: number; values: number[] }[];
  /** Groups folded into "Other". */
  truncated: number;
  /** Every (account × model) pair in the window, largest first. */
  rows: TokenRow[];
  /** The whole filtered window. */
  totals: Required<Omit<TokenFigures, "costUsd">> & {
    costUsd: number | null;
    total: number;
    turns: number;
    chats: number;
  };
  /** Values per dimension for the filter pick-lists (own filter excluded). */
  facets: Partial<Record<TokenDimension, { value: string; label: string; count: number }[]>>;
  /** Rows in the whole token ledger, and the oldest — the header's figure. */
  ledgerRows: number;
  oldest: number | null;
}
