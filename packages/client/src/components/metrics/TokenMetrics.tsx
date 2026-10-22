/**
 * The Tokens subpage — what agents CONSUMED, by account and model.
 *
 * Same furniture as Usage and Runtime (filter row, hero, configurable chart,
 * breakdown) over the third ledger, `metric_tokens`. Two things differ:
 *
 *   - A MEASURE picker. A token is not one quantity: a long Claude chat is 95%
 *     cache reads, which are cheap, so "all tokens" and "cost" can rank the same
 *     accounts in opposite orders. The chart plots one; the table shows every
 *     one, so the picker never hides a number.
 *   - The breakdown is always ACCOUNT × MODEL, whatever the chart splits by.
 *     That pair is the question this tab exists for ("Opus on claude2"), and a
 *     table keyed by the chart's one dimension could only ever answer half of it.
 */
import { useEffect, useMemo } from "react";
import { Info } from "lucide-react";
import {
  METRIC_OTHER_KEY,
  TOKEN_DIMENSION_LABELS,
  TOKEN_MEASURE_LABELS,
  type TokenDimension,
  type TokenMeasure,
  type TokenRow,
} from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { CHART_KIND_LABELS, isTimeChart, type ChartKind } from "../../stores/metrics.js";
import { useTokenMetrics } from "../../stores/metrics-tokens.js";
import { useProjects } from "../../stores/projects.js";
import { ChartLegend, MetricsChart, type ChartShareRow } from "./MetricsChart.js";
import { FacetRow } from "./MetricsFilters.js";
import { Card, Hero, StatTile, ago, compact, count } from "./chrome.js";
import type { DimLabeller } from "./labels.js";
import { colorFor, useChartPalette } from "./palette.js";
import { cn } from "../../lib/cn.js";

const DIMS: readonly TokenDimension[] = ["subscription", "model", "harness", "projectId"];
const MEASURES: readonly TokenMeasure[] = [
  "total",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
];
const CHART_KINDS: ChartKind[] = [
  "stacked-bar",
  "stacked-area",
  "line",
  "area",
  "grouped-bar",
  "ranked-bar",
  "donut",
];

const usdFmt = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

/** Dollars, or a dash for a group nobody priced — unpriced is not free. */
function usd(v: number | null): string {
  return v === null ? "—" : usdFmt.format(v);
}

/**
 * Resolve keys for this page. The server has already named accounts (against
 * the CURRENT settings) and providers; projects are named here, from the
 * client's store, exactly as the other tabs do.
 */
function useTokenLabels(): DimLabeller<TokenDimension> {
  const projects = useProjects((s) => s.projects);
  const facets = useTokenMetrics((s) => s.report?.facets);
  return (dim, key, fallback) => {
    if (key === METRIC_OTHER_KEY) return fallback ?? "Other";
    if (dim === "projectId" && key) return projects.find((p) => p.id === key)?.name ?? key;
    return fallback ?? facets?.[dim]?.find((f) => f.value === key)?.label ?? (key || "(none)");
  };
}

/* ------------------------------------------------------------------- table */

/** Hoisted: a fresh `[]` from a selector is a new snapshot every render, and
 *  zustand re-renders on it forever ("getSnapshot should be cached"). */
const NO_ROWS: TokenRow[] = [];

function Breakdown() {
  const rows = useTokenMetrics((s) => s.report?.rows ?? NO_ROWS);
  const toggle = useTokenMetrics((s) => s.toggleFilter);
  const labels = useTokenLabels();
  if (!rows.length) {
    return <p className="px-2 py-3 text-xs text-muted">Nothing recorded in this window.</p>;
  }
  const num = "cm-mono px-2 py-1.5 text-right tabular-nums";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-2xs text-muted">
            <th className="px-2 py-1.5 text-left font-medium">Account</th>
            <th className="px-2 py-1.5 text-left font-medium">Model</th>
            <th className="px-2 py-1.5 text-right font-medium">Input</th>
            <th className="px-2 py-1.5 text-right font-medium">Output</th>
            <th className="px-2 py-1.5 text-right font-medium">Cache read</th>
            <th className="px-2 py-1.5 text-right font-medium">Cache write</th>
            <th className="px-2 py-1.5 text-right font-medium">Total</th>
            <th className="px-2 py-1.5 text-right font-medium">Cost</th>
            <th className="px-2 py-1.5 text-right font-medium">Turns</th>
            <th className="px-2 py-1.5 text-right font-medium">Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: TokenRow) => (
            <tr
              key={`${r.subscriptionId}|${r.harness}|${r.model}`}
              className="border-t border-line-soft"
            >
              <td className="px-2 py-1.5">
                {/* Buttons, not clickable rows — the table is the page's
                    keyboard-reachable fallback (see UsageMetrics). */}
                <Button
                  variant="link"
                  onClick={() => toggle("subscription", r.subscriptionId)}
                  title={`Filter to ${r.subscriptionLabel}`}
                  className="max-w-full text-secondary"
                >
                  <span className="min-w-0 truncate">{r.subscriptionLabel}</span>
                </Button>
              </td>
              <td className="px-2 py-1.5">
                <Button
                  variant="link"
                  onClick={() => toggle("model", r.model)}
                  title={`Filter to ${labels("model", r.model)}`}
                  className="max-w-full text-secondary"
                >
                  <span className="min-w-0 truncate">{labels("model", r.model)}</span>
                </Button>
              </td>
              <td className={cn(num, "text-muted")}>{compact(r.input)}</td>
              <td className={cn(num, "text-muted")}>{compact(r.output)}</td>
              <td className={cn(num, "text-muted")}>{compact(r.cacheRead)}</td>
              <td className={cn(num, "text-muted")}>{compact(r.cacheWrite)}</td>
              <td className={cn(num, "text-primary")}>{compact(r.total)}</td>
              <td className={cn(num, "text-primary")}>{usd(r.costUsd)}</td>
              <td className={cn(num, "text-muted")}>{count(r.turns)}</td>
              <td className="px-2 py-1.5 text-right text-muted">{ago(r.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- subpage */

export function TokenMetrics() {
  const {
    report,
    filter,
    rangeId,
    chart,
    groupBy,
    measure,
    bucket,
    limit,
    loading,
    refetching,
    error,
    setRange,
    setChart,
    setGroupBy,
    setMeasure,
    setBucket,
    setLimit,
    toggleFilter,
    clearFilter,
    load,
  } = useTokenMetrics();
  const palette = useChartPalette();
  const labels = useTokenLabels();
  const label = (key: string, fallback?: string) => labels(groupBy, key, fallback);

  // One load on mount; every control re-queries itself (see the store).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const color = useMemo(() => (key: string, i: number) => colorFor(palette, key, i), [palette]);
  const format = measure === "cost" ? (v: number) => usdFmt.format(v) : compact;
  const timeForm = isTimeChart(chart);
  const series = report?.series ?? [];
  const share: ChartShareRow[] = series.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.total,
    note: TOKEN_MEASURE_LABELS[measure],
  }));
  const t = report?.totals;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-3">
      <FacetRow
        rangeId={rangeId}
        setRange={setRange}
        dims={DIMS}
        dimLabels={TOKEN_DIMENSION_LABELS}
        facets={report?.facets}
        filter={filter}
        toggle={toggleFilter}
        clear={clearFilter}
        label={labels}
      />

      {error && (
        <div className="rounded-lg border border-danger-line bg-danger-ghost px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-[360px] items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className={cn("flex flex-col gap-3 transition-opacity", refetching && "opacity-60")}>
          <div className="flex flex-wrap items-end gap-3">
            <Hero
              label="Tokens in this window"
              value={compact(t?.total ?? 0)}
              hint="Input + output + cache read + cache write"
            />
            <StatTile
              label="Cost"
              value={usd(t?.costUsd ?? null)}
              hint="As the runtime priced it"
            />
            <StatTile label="Input" value={compact(t?.input ?? 0)} />
            <StatTile label="Output" value={compact(t?.output ?? 0)} />
            <StatTile label="Cache read" value={compact(t?.cacheRead ?? 0)} />
            <StatTile label="Cache write" value={compact(t?.cacheWrite ?? 0)} />
            <StatTile label="Turns" value={count(t?.turns ?? 0)} />
          </div>

          <Card
            controls={
              <>
                <Select
                  options={CHART_KINDS.map((k) => ({
                    value: k,
                    label: CHART_KIND_LABELS[k],
                  }))}
                  value={chart}
                  onChange={(v) => setChart(v as ChartKind)}
                  label="Chart"
                  width={180}
                />
                <Select
                  options={MEASURES.map((m) => ({
                    value: m,
                    label: TOKEN_MEASURE_LABELS[m],
                  }))}
                  value={measure}
                  onChange={(v) => setMeasure(v as TokenMeasure)}
                  label="Measure"
                  width={180}
                />
                <Select
                  options={DIMS.map((d) => ({
                    value: d,
                    label: TOKEN_DIMENSION_LABELS[d],
                  }))}
                  value={groupBy}
                  onChange={(v) => setGroupBy(v as TokenDimension)}
                  label="Split by"
                  width={170}
                />
                {timeForm && (
                  <Select
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "hour", label: "Hourly" },
                      { value: "day", label: "Daily" },
                      { value: "week", label: "Weekly" },
                      { value: "month", label: "Monthly" },
                    ]}
                    value={bucket}
                    onChange={(v) => setBucket(v as typeof bucket)}
                    label="Bucket"
                    width={150}
                  />
                )}
                <Select
                  options={[4, 6, 8].map((n) => ({
                    value: String(n),
                    label: `Top ${n}`,
                  }))}
                  value={String(limit)}
                  onChange={(v) => setLimit(Number(v))}
                  label="Series"
                  width={140}
                />
              </>
            }
            note={report?.truncated ? `${report.truncated} more folded into Other` : null}
          >
            <div className="p-3">
              <MetricsChart
                kind={chart}
                time={report ? { buckets: report.buckets, bucket: report.bucket, series } : null}
                share={share}
                label={label}
                format={format}
                color={color}
                height={300}
              />
              <div className="mt-3">
                <ChartLegend
                  entries={series.map((s) => ({
                    key: s.key,
                    label: s.label,
                    total: s.total,
                  }))}
                  label={label}
                  format={format}
                  color={color}
                />
              </div>
            </div>
          </Card>

          <Card
            title="By account and model"
            icon={<Info />}
            // History imported from transcripts can't know two things a live row
            // does; saying so beats a table that quietly guesses.
            note="Turns before tracking began: account is the chat's current one, model is the main loop's"
          >
            <div className="p-1">
              <Breakdown />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
