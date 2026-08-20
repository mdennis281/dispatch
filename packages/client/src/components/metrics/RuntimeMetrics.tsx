/**
 * The Runtime subpage — where the agent-time went, not what was reached for.
 *
 * Same skeleton as the Usage tab (filter row, hero, chart, breakdown, activity
 * tail) over the SPAN ledger, which answers in milliseconds. The layout is
 * ordered by the questions the data can now answer:
 *
 *   1. where did the window's agent-time go        → hero + the split card
 *   2. how much of it was actually generating      → the class meter
 *   3. how did it move                             → the configurable chart
 *   4. which chat / subagent / tool owns it        → the breakdown, by dimension
 *   5. what just happened                          → the span tail
 *
 * THE TWO MEASURES, and the one rule this page must not break.
 *
 *   busyMs        the union of each actor's intervals. TRUE WALL CLOCK: an
 *                 actor running five tool calls at once is still one actor for
 *                 one stretch of time. This is the hero figure.
 *   attributedMs  the plain sum. Exceeds busy by exactly as much as work ran in
 *                 parallel. This is what every BREAKDOWN uses, because a stack
 *                 or a share has to sum to its whole, and only the plain sum
 *                 decomposes — the per-state unions don't add up to the overall
 *                 union.
 *
 * Neither is "the" number and neither is hidden. Their ratio — the parallelism
 * factor — rides in a tile between them, so the reader is handed the
 * reconciliation rather than left to notice the gap. On real data it runs ~1.05x
 * for a chat and ~1.12x inside a busy subagent.
 *
 * Every duration-shaped label on this page says which measure it is. "Time" in
 * the breakdown is attributed and the column beside it is busy; the hero says
 * wall clock under it. A figure labelled just "time" would be the exact fudge
 * the two measures exist to prevent.
 */
import { useEffect, useMemo } from "react";
import { Clock, Database } from "lucide-react";
import type { MetricSpan, MetricSpanDimension, MetricState } from "@dispatch/shared";
import {
  METRIC_OTHER_KEY,
  METRIC_SPAN_DIMENSION_LABELS,
  METRIC_STATE_LABELS,
} from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import {
  CHART_KIND_LABELS,
  isTimeChart,
  type ChartKind,
} from "../../stores/metrics.js";
import { SPAN_SORT_LABELS, useSpanMetrics, type SpanSort } from "../../stores/metrics-spans.js";
import { ChartLegend, MetricsChart, type ChartShareRow } from "./MetricsChart.js";
import { FacetRow } from "./MetricsFilters.js";
import { TimeSplit } from "./TimeSplit.js";
import { Card, Hero, StatTile, ago, count } from "./chrome.js";
import {
  axisDuration,
  durationTicks,
  formatDuration,
  formatParallelism,
  formatShare,
  share,
} from "./duration.js";
import { useSpanLabel, useSpanLabels } from "./labels.js";
import { spanColorFor, useChartPalette } from "./palette.js";
import { cn } from "../../lib/cn.js";

/** Dimensions offered as pick-lists, in the order they read. */
const FILTERABLE: readonly MetricSpanDimension[] = [
  "state",
  "class",
  "projectId",
  "chatId",
  "agent",
  "subagent",
  "model",
  "harness",
  "source",
];

/** Dimensions the chart may split by. */
const GROUPABLE: MetricSpanDimension[] = [
  "state",
  "class",
  "identifier",
  "chatId",
  "runId",
  "subagent",
  "agent",
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

const SORTS: SpanSort[] = ["ms", "busyMs", "avg", "count"];

/** How long a span ran — clipped to now while it is still open. */
function spanMs(span: MetricSpan, now: number): number {
  return Math.max(0, (span.endTs ?? now) - span.startTs);
}

/* ------------------------------------------------------------------- table */

/**
 * The breakdown — the table the palette's light-mode contrast WARN requires,
 * and independently the fastest way to read a leaderboard.
 *
 * BOTH measures get a column. For a chat that ran five agents at once, "Time"
 * is agent-hours and "Busy" is hours, and the gap between the two columns IS
 * the parallelism of that row — which is more useful per-row than the page-wide
 * factor in the tile above.
 *
 * "Avg" is attributed ÷ spans, which is what answers "which tool is SLOWEST"
 * rather than "which tool is used most". It is a derived column rather than a
 * server one because the ledger stores durations, not averages.
 */
function Breakdown() {
  const totals = useSpanMetrics((s) => s.totals);
  const groupBy = useSpanMetrics((s) => s.groupBy);
  const sort = useSpanMetrics((s) => s.sort);
  const toggle = useSpanMetrics((s) => s.toggleFilter);
  const palette = useChartPalette();
  const label = useSpanLabel(groupBy);

  // Sort the rows the server RETURNED. Which groups are in the list is the
  // server's call (top N by attributed time); this only chooses the order they
  // read in — the card's note says so, because a table that silently re-ranked
  // a pre-ranked set would look like "the slowest tools" when it is "the
  // slowest of the busiest tools".
  //
  // `slot` is each row's position in the SERVER's ordering, carried through the
  // sort, and it is what picks the colour. Colour follows the entity, never its
  // rank: without this, switching the sort to Average repainted every row, so
  // the swatch beside "Agent" in the table and the "Agent" series in the chart
  // six pixels above it were different hues.
  const rows = useMemo(() => {
    const list = (totals?.totals ?? []).map((row, slot) => ({ ...row, slot }));
    const value = (r: (typeof list)[number]) =>
      sort === "avg" ? (r.count ? r.ms / r.count : 0) : sort === "count" ? r.count : r[sort];
    return list.sort((a, b) =>
      // "Other" is a fold, not a group — it stays pinned at the bottom whatever
      // the sort, or the tail outranks the things it is the tail of.
      a.key === METRIC_OTHER_KEY ? 1 : b.key === METRIC_OTHER_KEY ? -1 : value(b) - value(a),
    );
  }, [totals, sort]);

  if (!rows.length) return null;
  const grand = totals?.ms || 1;

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-2xs text-muted">
          <th className="px-2 py-1.5 text-left font-medium">
            {METRIC_SPAN_DIMENSION_LABELS[groupBy]}
          </th>
          <th className="px-2 py-1.5 text-right font-medium">Time</th>
          <th className="px-2 py-1.5 text-right font-medium">Busy</th>
          <th className="px-2 py-1.5 text-right font-medium">Share</th>
          <th className="px-2 py-1.5 text-right font-medium">Avg</th>
          <th className="px-2 py-1.5 text-right font-medium">Spans</th>
          <th className="px-2 py-1.5 text-right font-medium">Actors</th>
          <th className="px-2 py-1.5 text-right font-medium">Last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const other = row.key === METRIC_OTHER_KEY;
          const swatch = (
            // `inline-block`, not bare `size-2`: width/height do nothing on an
            // inline element, and `Button`'s icon slot is a plain span.
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-sm"
              style={{ background: spanColorFor(palette, groupBy, row.key, row.slot) }}
            />
          );
          return (
            <tr key={row.key} className="border-t border-line-soft">
              <td className="px-2 py-1.5">
                {/* Filtering to a row is a link BUTTON, not a click handler on
                    the row: a clickable row is unreachable by keyboard, and this
                    table is the page's accessible fallback for the three light-
                    mode series colours that don't clear 3:1. "Other" is a fold
                    rather than a value, so it has nothing to filter to. */}
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
                {formatDuration(row.ms)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-secondary tabular-nums">
                {formatDuration(row.busyMs)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {formatShare(row.ms, grand)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {row.count ? formatDuration(row.ms / row.count) : "—"}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {count(row.count)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {count(row.actors)}
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

/**
 * The span tail — "what just happened", the question a ledger gets asked when a
 * number looks wrong.
 *
 * Two flags ride here that nothing else on the page shows, because both mean a
 * duration is not what it looks like: an OPEN span is still running and its
 * length is only true as of this render, and a TRUNCATED one was closed by
 * crash recovery at the last heartbeat, so its duration is a floor rather than
 * a measurement.
 */
function SpanTail() {
  const recent = useSpanMetrics((s) => s.recent);
  const now = Date.now();
  if (!recent.length) return null;
  return (
    <ul className="divide-y divide-line-soft">
      {recent.map((span) => (
        <li
          key={span.id ?? `${span.startTs}-${span.identifier}`}
          className="flex items-baseline gap-2 px-2 py-1.5 text-xs"
        >
          <span className="w-[104px] shrink-0 truncate text-2xs text-faint">
            {METRIC_STATE_LABELS[span.state]}
          </span>
          <span className="min-w-0 flex-1 truncate text-secondary">{span.identifier}</span>
          {span.subagent && (
            <span className="shrink-0 truncate text-2xs text-accent-2">{span.subagent}</span>
          )}
          {span.truncated && (
            <span className="shrink-0 text-2xs text-warn" title="Closed by crash recovery — this duration is a floor, not a measurement">
              floor
            </span>
          )}
          {span.endTs === null && (
            <span className="shrink-0 text-2xs text-accent" title="Still running — clipped to now">
              open
            </span>
          )}
          <span className="cm-mono w-[72px] shrink-0 text-right text-2xs text-primary tabular-nums">
            {formatDuration(spanMs(span, now))}
          </span>
          <span className="w-[70px] shrink-0 text-right text-2xs text-muted">
            {ago(span.startTs)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------- page */

export function RuntimeMetrics() {
  const {
    series,
    totals,
    summary,
    facets,
    filter,
    rangeId,
    chart,
    groupBy,
    bucket,
    limit,
    sort,
    loading,
    refetching,
    error,
    setRange,
    setChart,
    setGroupBy,
    setBucket,
    setLimit,
    setSort,
    toggleFilter,
    clearFilter,
    load,
  } = useSpanMetrics();

  const palette = useChartPalette();
  const labels = useSpanLabels();
  const label = useSpanLabel(groupBy);

  // One load on mount. Every control re-queries itself (see the store), so
  // there is deliberately no dependency array chasing the query here — that
  // would fire a second request for every change the setters already made.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeForm = isTimeChart(chart);
  // The server coarsens a bucket the window can't accommodate, so the width it
  // USED can differ from the pick.
  const coarsened = !!series && bucket !== "auto" && series.bucket !== bucket;
  const color = useMemo(
    () => (key: string, i: number) => spanColorFor(palette, groupBy, key, i),
    [palette, groupBy],
  );

  const legend = timeForm
    ? (series?.series ?? []).map((s) => ({ key: s.key, label: s.label, total: s.total }))
    : (totals?.totals ?? []).map((t) => ({ key: t.key, label: t.label, total: t.ms }));

  const shareRows: ChartShareRow[] = (totals?.totals ?? []).map((t) => ({
    key: t.key,
    label: t.label,
    value: t.ms,
    // The share form plots ATTRIBUTED time, so its tooltip carries the row's
    // busy figure — the one thing the wedge itself cannot say.
    note: `busy ${formatDuration(t.busyMs)} · ${count(t.actors)} actor${t.actors === 1 ? "" : "s"}`,
  }));

  const busyMs = summary?.busyMs ?? 0;
  const attributedMs = summary?.attributedMs ?? 0;
  const thinkingMs = summary?.byClass.thinking ?? 0;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-3">
      {/* Filters: one row, above everything they scope. */}
      <FacetRow
        rangeId={rangeId}
        setRange={setRange}
        dims={FILTERABLE}
        dimLabels={METRIC_SPAN_DIMENSION_LABELS}
        facets={facets?.facets}
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
        // While a refetch is in flight the previous render is HELD at reduced
        // opacity — no skeleton, no layout jump, no flash of an empty chart.
        <div className={cn("flex flex-col gap-3 transition-opacity", refetching && "opacity-60")}>
          {/* Hero + supporting tiles. Exactly one hero on the page, and it is
              the honest wall clock rather than the bigger number. */}
          <div className="flex flex-wrap items-end gap-3">
            <Hero
              label="Busy time in this window"
              value={formatDuration(busyMs)}
              hint={`wall clock across ${count(summary?.actors ?? 0)} actor${
                summary?.actors === 1 ? "" : "s"
              } in ${count(summary?.chats ?? 0)} chat${summary?.chats === 1 ? "" : "s"}`}
            />
            <StatTile
              label="Attributed"
              value={formatDuration(attributedMs)}
              hint="sum of every span"
            />
            <StatTile
              label="Parallelism"
              value={formatParallelism(attributedMs, busyMs)}
              hint="attributed ÷ busy"
            />
            <StatTile
              label="Generating"
              value={formatDuration(thinkingMs)}
              hint={`${Math.round(share(thinkingMs, attributedMs))}% of attributed`}
            />
            <StatTile label="Spans" value={count(summary?.spans ?? 0)} />
            {/* Only when there is one. A permanent "Open 0" tile is a slot that
                spends its whole life saying nothing. */}
            {!!summary?.open && (
              <StatTile
                label="Open now"
                value={count(summary.open)}
                hint="clipped to this instant"
              />
            )}
          </div>

          {/* The split. Attributed, and it says so. */}
          <Card title="Where the time went" icon={<Clock />} note="attributed, not wall clock">
            {summary ? (
              <TimeSplit
                summary={summary}
                selectedStates={filter.state}
                onPickState={(state: MetricState) => toggleFilter("state", state)}
              />
            ) : null}
          </Card>

          {/* The configurable chart. */}
          <Card
            controls={
              <>
                <Select
                  options={CHART_KINDS.map((k) => ({ value: k, label: CHART_KIND_LABELS[k] }))}
                  value={chart}
                  onChange={(v) => setChart(v as ChartKind)}
                  label="Chart"
                  width={180}
                />
                <Select
                  options={GROUPABLE.map((d) => ({
                    value: d,
                    label: METRIC_SPAN_DIMENSION_LABELS[d],
                  }))}
                  value={groupBy}
                  onChange={(v) => setGroupBy(v as MetricSpanDimension)}
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
                    onChange={(v) => setBucket(v as typeof bucket)}
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
              </>
            }
            note={
              // Never let the page bound what it shows without saying so. Both
              // of these are the chart quietly showing less than was asked for,
              // and an unexplained one reads as "that's all there was".
              timeForm && (series?.truncated || coarsened)
                ? [
                    series?.truncated ? `${series.truncated} more folded into Other` : null,
                    coarsened ? `bucketed ${BUCKET_LABELS[series!.bucket]} to fit` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
          >
            <div className="p-3">
              <MetricsChart
                kind={chart}
                time={series}
                share={shareRows}
                label={label}
                // The tooltip gets the readable form and the axis gets the terse
                // one: several ticks stacked in a 52px gutter cannot each say
                // "3h 12m", and a tooltip with room to spare should not say
                // "3.2h". `ticker` then chooses the tick VALUES on real duration
                // boundaries, which is the half a formatter cannot do.
                format={formatDuration}
                formatTick={axisDuration}
                ticker={durationTicks}
                color={color}
                height={300}
              />
              <div className="mt-3">
                <ChartLegend
                  entries={legend}
                  label={label}
                  format={formatDuration}
                  color={color}
                />
              </div>
            </div>
          </Card>

          {/* The breakdown. Load-bearing for accessibility — see the file header
              of MetricsChart before removing it. */}
          <Card
            title={`Breakdown by ${METRIC_SPAN_DIMENSION_LABELS[groupBy].toLowerCase()}`}
            controls={
              <Select
                options={SORTS.map((s) => ({ value: s, label: SPAN_SORT_LABELS[s] }))}
                value={sort}
                onChange={(v) => setSort(v as SpanSort)}
                label="Sort"
                width={150}
              />
            }
            note={`top ${totals?.totals.length ?? 0} of ${count(totals?.groups ?? 0)} by total time`}
          >
            <div className="p-1">
              <Breakdown />
            </div>
          </Card>

          <Card title="Recent spans" icon={<Database />}>
            <div className="p-1">
              <SpanTail />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
