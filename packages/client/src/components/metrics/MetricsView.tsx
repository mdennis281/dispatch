/**
 * The Metrics page — what agents in this install actually reached for.
 *
 * Reads one shared query (see stores/metrics): a window, a filter, a dimension
 * to split by. Everything below the filter row re-renders against that same
 * slice, so the hero figure, the chart, the breakdown and the activity tail can
 * never disagree with each other.
 *
 * The layout is the form heuristic applied top to bottom:
 *   - a HERO FIGURE for the one number the page leads with (total uses), with
 *     the supporting counts as stat tiles beside it — not a one-bar bar chart;
 *   - the configurable CHART for the shape of it over time, or its share;
 *   - a BREAKDOWN TABLE, which is not optional decoration. Three of the eight
 *     light-mode series colours sit below 3:1 on white, and the palette's
 *     contrast WARN is relieved by having every value reachable without relying
 *     on the mark's colour. Remove this table and the page stops being
 *     accessible on the light theme.
 *   - an ACTIVITY tail, because "what just happened" is the question a ledger
 *     gets asked when a number looks wrong.
 */
import { useEffect } from "react";
import { BarChart3, Database, RefreshCw } from "lucide-react";
import type { MetricDimension } from "@dispatch/shared";
import {
  METRIC_CATEGORY_LABELS,
  METRIC_DIMENSION_LABELS,
  METRIC_OTHER_KEY,
} from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { Select } from "../ui/Select.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import {
  CHART_KIND_LABELS,
  isTimeChart,
  useMetrics,
  type ChartKind,
} from "../../stores/metrics.js";
import { ChartLegend, MetricsChart } from "./MetricsChart.js";
import { MetricsFilters } from "./MetricsFilters.js";
import { useMetricLabel } from "./labels.js";
import { colorFor, useChartPalette } from "./palette.js";
import { cn } from "../../lib/cn.js";

const num = new Intl.NumberFormat();

/** Dimensions the chart may split by — every filterable column plus the name. */
const GROUPABLE: MetricDimension[] = [
  "identifier",
  "category",
  "agent",
  "subagent",
  "projectId",
  "model",
  "harness",
  "detail",
  "source",
];

/** Bucket widths as the note below the picker says them. */
const BUCKET_LABELS: Record<string, string> = {
  hour: "hourly",
  day: "daily",
  week: "weekly",
  month: "monthly",
};

const CHART_KINDS: ChartKind[] = [
  "line",
  "area",
  "stacked-area",
  "stacked-bar",
  "grouped-bar",
  "ranked-bar",
  "donut",
];

/** Compact big numbers (1,284 / 12.9K / 1.4M) — a hero figure isn't a receipt. */
function compact(n: number): string {
  if (n < 10_000) return num.format(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "3d ago" style stamp, matching the Memory view's. */
function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** A supporting number beside the hero figure. Proportional figures, no delta. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[92px] rounded-lg border border-line bg-panel px-3 py-2">
      <p className="text-2xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-primary">{value}</p>
    </div>
  );
}

/* ------------------------------------------------------------------- table */

/**
 * The breakdown — the table view the palette's light-mode contrast WARN
 * requires, and independently the fastest way to read a leaderboard.
 *
 * `tabular-nums` here and NOT on the hero figure: these are columns that must
 * align vertically, which is exactly what tabular figures are for, while a large
 * standalone number set in them looks loose.
 */
function Breakdown() {
  const totals = useMetrics((s) => s.totals);
  const groupBy = useMetrics((s) => s.groupBy);
  const toggle = useMetrics((s) => s.toggleFilter);
  const palette = useChartPalette();
  const label = useMetricLabel(groupBy);
  if (!totals?.totals.length) return null;

  const grand = totals.total || 1;

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-2xs text-muted">
          <th className="px-2 py-1.5 text-left font-medium">
            {METRIC_DIMENSION_LABELS[groupBy]}
          </th>
          <th className="px-2 py-1.5 text-right font-medium">Uses</th>
          <th className="px-2 py-1.5 text-right font-medium">Share</th>
          <th className="px-2 py-1.5 text-right font-medium">Chats</th>
          <th className="px-2 py-1.5 text-right font-medium">Last</th>
        </tr>
      </thead>
      <tbody>
        {totals.totals.map((row, i) => {
          const other = row.key === METRIC_OTHER_KEY;
          const swatch = (
            // `inline-block`, not bare `size-2`: width/height do nothing on an
            // inline element, and `Button`'s icon slot is a plain `<span>` — so
            // the swatch collapsed to nothing there while the identical one in
            // the legend (a flex child, blockified) rendered fine.
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-sm"
              style={{ background: colorFor(palette, row.key, i) }}
            />
          );
          return (
            <tr key={row.key} className="border-t border-line-soft">
              <td className="px-2 py-1.5">
                {/* Filtering to a row is a BUTTON, not a click handler on the
                    `<tr>`: a clickable row is unreachable by keyboard, and this
                    table is the page's accessible fallback for the three light-
                    mode series colours that don't clear 3:1. Making the fallback
                    itself keyboard-hostile would defeat the point.
                    "Other" is a fold rather than a value, so it has nothing to
                    filter to and stays inert text. */}
                {other ? (
                  <span className="flex items-center gap-2">
                    {swatch}
                    <span className="min-w-0 truncate text-muted">{row.label}</span>
                  </span>
                ) : (
                  <Button
                    variant="link"
                    leftIcon={swatch}
                    onClick={() => toggle(groupBy, row.key)}
                    title={`Filter to ${label(row.key, row.label)}`}
                    className="max-w-full text-secondary"
                  >
                    <span className="min-w-0 truncate">{label(row.key, row.label)}</span>
                  </Button>
                )}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-primary tabular-nums">
                {num.format(row.count)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {Math.round((row.count / grand) * 100)}%
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {num.format(row.chats)}
              </td>
              <td className="px-2 py-1.5 text-right text-muted">{ago(row.lastAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- activity */

function Activity() {
  const recent = useMetrics((s) => s.recent);
  if (!recent.length) return null;
  return (
    <ul className="divide-y divide-line-soft">
      {recent.map((e) => (
        <li key={e.id} className="flex items-baseline gap-2 px-2 py-1.5 text-xs">
          <span className="w-[74px] shrink-0 text-2xs text-faint">
            {METRIC_CATEGORY_LABELS[e.category]}
          </span>
          <span className="min-w-0 flex-1 truncate text-secondary">{e.identifier}</span>
          {e.subagent && (
            <span className="shrink-0 text-2xs text-accent-2">{e.subagent}</span>
          )}
          <span className="w-[70px] shrink-0 text-right text-2xs text-muted">{ago(e.ts)}</span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------- page */

export function MetricsView() {
  const {
    series,
    totals,
    chart,
    groupBy,
    bucket,
    limit,
    loading,
    refetching,
    error,
    ledgerRows,
    setChart,
    setGroupBy,
    setBucket,
    setLimit,
    load,
  } = useMetrics();

  // One load on mount. Every control re-queries itself (see the store), so
  // there is deliberately no dependency array chasing the query here — that
  // would fire a second request for every change the setters already made.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeForm = isTimeChart(chart);
  // The server coarsens a bucket the window can't accommodate (hourly over two
  // years is ~17,500 points), so the width it USED can differ from the pick.
  const coarsened = !!series && bucket !== "auto" && series.bucket !== bucket;
  const legend = timeForm
    ? (series?.series ?? []).map((s) => ({ key: s.key, label: s.label, total: s.total }))
    : (totals?.totals ?? []).map((t) => ({ key: t.key, label: t.label, total: t.count }));
  const windowTotal = timeForm ? (series?.total ?? 0) : (totals?.total ?? 0);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 cm-hairline-b">
        <BarChart3 className="size-4 text-muted" />
        <span className="text-base font-semibold text-primary">Metrics</span>
        <span className="cm-mono !text-2xs text-faint">{num.format(ledgerRows)} rows</span>
        <div className="flex-1" />
        <IconButton size="sm" tip="Reload" onClick={() => void load()}>
          <RefreshCw className={cn(refetching && "animate-spin")} />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-3">
          {/* Filters: one row, above everything they scope. */}
          <MetricsFilters />

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
            // While a refetch is in flight the previous render is HELD at reduced
            // opacity — no skeleton, no layout jump, no flash of an empty chart.
            <div
              className={cn(
                "flex flex-col gap-3 transition-opacity",
                refetching && "opacity-60",
              )}
            >
              {/* Hero figure + supporting tiles. Exactly one hero on the page. */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="rounded-lg border border-line bg-panel px-4 py-3">
                  <p className="text-2xs text-muted">Uses in this window</p>
                  <p className="mt-0.5 text-5xl font-semibold leading-none text-primary">
                    {compact(windowTotal)}
                  </p>
                </div>
                <StatTile
                  label={METRIC_DIMENSION_LABELS[groupBy]}
                  value={num.format(totals?.groups ?? 0)}
                />
                {/* The server's own COUNT(DISTINCT chat_id) over the filtered
                    set. Folding it out of the breakdown rows would be wrong in
                    both directions — one chat appears under many groups. */}
                <StatTile label="Chats" value={num.format(totals?.chats ?? 0)} />
              </div>

              {/* The configurable chart. */}
              <section className="rounded-lg border border-line bg-panel">
                <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 cm-hairline-b">
                  <Select
                    options={CHART_KINDS.map((k) => ({ value: k, label: CHART_KIND_LABELS[k] }))}
                    value={chart}
                    onChange={setChart}
                    label="Chart"
                    width={180}
                  />
                  <Select
                    options={GROUPABLE.map((d) => ({
                      value: d,
                      label: METRIC_DIMENSION_LABELS[d],
                    }))}
                    value={groupBy}
                    onChange={setGroupBy}
                    label="Split by"
                    width={180}
                  />
                  {/* Bucket only exists for the time forms; a donut has no time
                      axis to bucket, so the control would be inert. */}
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
                      onChange={setBucket}
                      label="Bucket"
                      width={150}
                    />
                  )}
                  <Select
                    options={[4, 6, 8].map((n) => ({ value: String(n), label: `Top ${n}` }))}
                    value={String(limit)}
                    onChange={(v) => setLimit(Number(v))}
                    label="Series"
                    width={140}
                  />
                  {timeForm && (series?.truncated || coarsened) && (
                    <span className="ml-auto text-2xs text-faint">
                      {/* Never let the page bound what it shows without saying
                          so. Both of these are the chart quietly showing less
                          than was asked for, and an unexplained one reads as
                          "that's all there was". */}
                      {[
                        series?.truncated
                          ? `${series.truncated} more folded into Other`
                          : null,
                        coarsened ? `bucketed ${BUCKET_LABELS[series!.bucket]} to fit` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </div>

                <div className="p-3">
                  <MetricsChart kind={chart} series={series} totals={totals} height={300} />
                  <div className="mt-3">
                    <ChartLegend entries={legend} />
                  </div>
                </div>
              </section>

              {/* The breakdown. Load-bearing for accessibility — see the file
                  header before removing it. */}
              <section className="overflow-hidden rounded-lg border border-line bg-panel">
                <div className="px-3 py-2 text-2xs font-medium text-muted cm-hairline-b">
                  Breakdown by {METRIC_DIMENSION_LABELS[groupBy].toLowerCase()}
                </div>
                <div className="p-1">
                  <Breakdown />
                </div>
              </section>

              <section className="overflow-hidden rounded-lg border border-line bg-panel">
                <div className="flex items-center gap-2 px-3 py-2 cm-hairline-b">
                  <Database className="size-3.5 text-faint" />
                  <span className="text-2xs font-medium text-muted">Recent activity</span>
                </div>
                <div className="p-1">
                  <Activity />
                </div>
              </section>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
