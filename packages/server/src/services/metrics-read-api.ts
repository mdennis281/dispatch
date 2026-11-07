/**
 * The Metrics routes' read surface, as ONE table of named methods — run either
 * on the metrics worker thread (services/metrics-worker.ts) or, as a fallback,
 * in-process. One table so the two can't drift: a method added for the worker
 * is a method the fallback has too.
 *
 * Every argument and result crosses a `postMessage`, so they are plain data.
 * That is why the token and limit reads take the SETTINGS rather than a
 * labeller function: the labeller is rebuilt on the far side from them.
 */
import type {
  ChatRuntimeResponse,
  LimitQueryInput,
  MetricDimension,
  MetricEvent,
  MetricFacetsResponse,
  MetricFilter,
  MetricQueryInput,
  MetricSeriesResponse,
  MetricSpan,
  MetricSpanDimension,
  MetricSpanFacetsResponse,
  MetricSpanFilter,
  MetricSpanQueryInput,
  MetricSpanSeriesResponse,
  MetricSpanSummary,
  MetricSpanTotalsResponse,
  MetricTotalsResponse,
  TokenQueryInput,
  TokenReport,
} from "@dispatch/shared";
import type { MetricsService } from "./metrics.js";
import { tokenLabeller, type TokenLedger } from "./metrics-tokens.js";
import type { HeldReading, LimitLedger } from "./limit-ledger.js";

type Settings = Parameters<typeof tokenLabeller>[0];
type Scope = { from?: number; to?: number; filter?: MetricFilter };
type SpanScope = { from?: number; to?: number; filter?: MetricSpanFilter };
type LimitPart = {
  windows: ReturnType<LimitLedger["windows"]>;
  yields: ReturnType<LimitLedger["yieldPeriods"]>["rows"];
  yieldsTruncatedBefore: ReturnType<LimitLedger["yieldPeriods"]>["truncatedBefore"];
  events: ReturnType<LimitLedger["events"]>;
  stats: ReturnType<LimitLedger["stats"]>;
};

/** Method name → [argument, result]. */
export interface MetricsReadMethods {
  series: [MetricQueryInput, MetricSeriesResponse];
  totals: [MetricQueryInput & { groupBy: MetricDimension }, MetricTotalsResponse];
  facets: [Scope, MetricFacetsResponse];
  recent: [Scope & { limit?: number }, MetricEvent[]];
  spanSeries: [MetricSpanQueryInput, MetricSpanSeriesResponse];
  spanTotals: [MetricSpanQueryInput & { groupBy: MetricSpanDimension }, MetricSpanTotalsResponse];
  spanSummary: [SpanScope, MetricSpanSummary];
  spanFacets: [SpanScope, MetricSpanFacetsResponse];
  recentSpans: [SpanScope & { limit?: number }, MetricSpan[]];
  chatRuntime: [void, ChatRuntimeResponse];
  ledgerCounts: [void, { rows: number; spans: number }];
  tokens: [{ query: TokenQueryInput; settings: Settings }, TokenReport];
  limits: [
    {
      query: LimitQueryInput & { period: Parameters<LimitLedger["yieldPeriods"]>[2] };
      settings: Settings;
      /** The OWNING ledger's held-back readings (see LimitLedger.heldReadings):
       * in its memory, not the table, so they travel with the request. */
      held: HeldReading[];
    },
    LimitPart,
  ];
}

export type MetricsReadMethod = keyof MetricsReadMethods;

export interface MetricsReadDeps {
  metrics: MetricsService;
  tokens: TokenLedger;
  limits: LimitLedger;
}

export type MetricsReadTable = {
  [K in MetricsReadMethod]: (arg: MetricsReadMethods[K][0]) => MetricsReadMethods[K][1];
};

export function createReadMethods({ metrics, tokens, limits }: MetricsReadDeps): MetricsReadTable {
  return {
    series: (q) => metrics.series(q),
    totals: (q) => metrics.totals(q),
    facets: (q) => metrics.facets(q),
    recent: (q) => metrics.recent(q),
    spanSeries: (q) => metrics.spanSeries(q),
    spanTotals: (q) => metrics.spanTotals(q),
    spanSummary: (q) => metrics.spanSummary(q),
    spanFacets: (q) => metrics.spanFacets(q),
    recentSpans: (q) => metrics.recentSpans(q),
    chatRuntime: () => metrics.chatRuntime(),
    ledgerCounts: () => {
      const s = metrics.stats();
      return { rows: s.rows, spans: s.spans };
    },
    // Labels resolve against the settings AS THEY ARE NOW, so renaming an
    // account renames its history — the id is what the ledger stored.
    tokens: ({ query, settings }) => tokens.report(query, tokenLabeller(settings)),
    limits: ({ query, settings, held }) => {
      const label = tokenLabeller(settings);
      const account = (id: string) => label("subscription", id);
      return limits.withHeld(held, () => {
        const yields = limits.yieldPeriods(query, account, query.period);
        return {
          windows: limits.windows(query, account),
          yields: yields.rows,
          yieldsTruncatedBefore: yields.truncatedBefore,
          events: limits.events(query),
          stats: limits.stats(),
        };
      });
    },
  };
}
