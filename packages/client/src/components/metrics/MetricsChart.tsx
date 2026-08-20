/**
 * The configurable chart — seven forms over one dataset.
 *
 * Two shapes, one control. The time forms (line / area / stacked area / stacked
 * bars / grouped bars) plot the bucketed series; the share forms (ranked bars /
 * donut) plot the window's totals with no time axis at all. The reader picks a
 * QUESTION ("how did this move" vs "how much of the whole") and the geometry
 * follows, which is why both live behind one picker instead of two.
 *
 * Marks follow the house spec: 2px lines with round caps, ≥8px active markers
 * with a 2px surface ring, area fills as a ~12% wash rather than a block, bars
 * capped at 24px with a 2px surface gap between touching segments, hairline
 * solid gridlines one step off the surface, and no number printed on any point
 * (the tooltip and the breakdown table carry those).
 *
 * Text never wears a series colour — labels, ticks and tooltip rows use the
 * theme's ink tokens and identity comes from the coloured key beside them. On
 * light three of the eight hues sit below 3:1 on white, so this is not a
 * nicety: it is the relief the palette's contrast WARN requires, together with
 * the always-present legend and the breakdown table beside the chart.
 *
 * ---
 *
 * MEASURE-AGNOSTIC, on purpose. This file used to read the usage store directly
 * for its labeller and hardcode `Intl.NumberFormat` on every axis and tooltip.
 * The runtime page plots MILLISECONDS through these same seven forms, and a
 * duration rendered by a count formatter reads `19,847,213` — technically the
 * value, and unreadable as the thing it measures. So the data arrives here
 * NORMALISED ({@link ChartTime} / {@link ChartShareRow}) and the caller supplies
 * `format`, `label` and `color`. Neither page can silently borrow the other's
 * units, and neither has to fork the marks to avoid it.
 */
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { isTimeChart, type ChartKind } from "../../stores/metrics.js";
import type { MetricLabeller } from "./labels.js";
import { useChartPalette, type ChartPalette } from "./palette.js";

/** Bar thickness cap — never let a bar fill its whole band. */
const MAX_BAR = 24;
/** The surface gap/ring width that separates touching marks. */
const GAP = 2;

/** The bucket widths a series response can come back at. */
type BucketWidth = "hour" | "day" | "week" | "month";

/** One group's value per bucket, aligned to {@link ChartTime.buckets}. */
export interface ChartSeries {
  key: string;
  label: string;
  total: number;
  values: number[];
}

/** Everything a time form plots, with the measure's units left to `format`. */
export interface ChartTime {
  buckets: number[];
  bucket: BucketWidth;
  series: ChartSeries[];
}

/**
 * One row of a share form.
 *
 * `note` is the row's supporting fact for the tooltip — "12 chats" on the usage
 * page, "busy 3h 12m · 4 actors" on the runtime one. A string rather than a
 * number because the two pages support their totals with different things, and
 * a shared numeric field would have to be labelled by the chart, which is
 * exactly the knowledge this file no longer has.
 */
export interface ChartShareRow {
  key: string;
  label: string;
  value: number;
  note: string;
}

/** Resolve a group key + its position to a mark colour. */
export type ChartColorer = (key: string, index: number) => string;

/** Render one value in the measure's own units. */
export type ChartFormatter = (value: number) => string;

/**
 * Choose the tick VALUES for a value axis, given the largest value plotted.
 *
 * Optional, and the usage page passes nothing — decimal-nice ticks are already
 * right for counts. Durations need it: a round millisecond count is never a
 * round duration, so no formatter can rescue `0 / 58m / 1.9h / 2.9h`. The last
 * tick returned also becomes the axis domain, so the top gridline is labelled.
 */
export type ChartTicker = (max: number) => number[];

/** Format a bucket start for an axis tick, at the width the bucket implies. */
function tickFor(bucket: BucketWidth): (ms: number) => string {
  // UTC throughout, matching the server's bucketing — a boundary that moved
  // with the viewer's timezone would make the axis disagree with the numbers.
  const opts: Intl.DateTimeFormatOptions =
    bucket === "hour"
      ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
      : bucket === "month"
        ? { month: "short", year: "2-digit", timeZone: "UTC" }
        : { month: "short", day: "numeric", timeZone: "UTC" };
  const fmt = new Intl.DateTimeFormat(undefined, opts);
  return (ms: number) => fmt.format(new Date(ms));
}

/** Full stamp for the tooltip header, where there is room to be unambiguous. */
function stampFor(bucket: BucketWidth, ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(bucket === "hour" ? { timeStyle: "short" } : {}),
    timeZone: "UTC",
  }).format(new Date(ms));
}

/* ----------------------------------------------------------------- tooltip */

interface TooltipRow {
  key: string;
  label: string;
  value: string;
  color: string;
}

/**
 * One readout for every series at this X — the pointer never has to land on a
 * line to get a value. Values lead and labels follow: here the reader already
 * has the series and wants the number, which inverts the legend's hierarchy.
 *
 * Labels come from tool names, agent ids and memory names — untrusted strings —
 * and are rendered as React children (text nodes), never as markup.
 */
function Readout({ title, rows }: { title: string; rows: TooltipRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="pointer-events-none rounded-md border border-line bg-elevated px-2.5 py-2 shadow-lg">
      <p className="mb-1.5 text-2xs font-medium text-muted">{title}</p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-2">
            {/* A short stroke, not a filled box: at tooltip density a box is
                data-weight ink doing a label's job. */}
            <span
              aria-hidden
              className="mt-1 h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: r.color }}
            />
            <span className="cm-mono text-xs font-semibold text-primary tabular-nums">
              {r.value}
            </span>
            <span className="min-w-0 flex-1 truncate text-2xs text-secondary">{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- time charts */

/** Recharts wants one object per X; the wire ships one array per series. */
function toRows(data: ChartTime): Record<string, number>[] {
  return data.buckets.map((ts, i) => {
    const row: Record<string, number> = { ts };
    for (const s of data.series) row[s.key] = s.values[i] ?? 0;
    return row;
  });
}

interface TimeProps {
  kind: ChartKind;
  data: ChartTime;
  palette: ChartPalette;
  label: MetricLabeller;
  format: ChartFormatter;
  formatTick: ChartFormatter;
  ticker?: ChartTicker;
  color: ChartColorer;
}

function TimeChart({ kind, data, palette, label, format, formatTick, ticker, color }: TimeProps) {
  const rows = useMemo(() => toRows(data), [data]);
  const tick = useMemo(() => tickFor(data.bucket), [data.bucket]);
  const keys = data.series;
  const stackedForm = kind === "stacked-area" || kind === "stacked-bar";
  // The tallest thing the axis has to clear. A stack's height is the SUM of its
  // segments at that X, not its biggest one — sizing the domain off the biggest
  // would cut the top off every stacked bar.
  const peak = useMemo(() => {
    let max = 0;
    for (const row of rows) {
      let stack = 0;
      for (const s of keys) {
        const v = row[s.key] ?? 0;
        stack += v;
        if (!stackedForm && v > max) max = v;
      }
      if (stackedForm && stack > max) max = stack;
    }
    return max;
  }, [rows, keys, stackedForm]);
  const ticks = useMemo(() => ticker?.(peak), [ticker, peak]);

  const bars = kind === "stacked-bar" || kind === "grouped-bar";

  const axis = {
    stroke: palette.grid,
    tick: { fill: palette.ink, fontSize: 11 },
    tickLine: false,
    axisLine: false,
  } as const;

  const tooltip = (
    <Tooltip
      // The cursor finds the X. On a line or an area that is a hairline snapped
      // to the nearest bucket, so the reader aims at a date rather than at a 2px
      // line. On a BAR chart Recharts draws a RECTANGLE instead, and it does not
      // take the same prop: given only a `stroke` its fill falls back to an
      // opaque light grey that covers half the plot on the dark theme. The band
      // gets the gridline colour — the same one-step-off-surface grey every
      // other recessive mark on this chart wears.
      cursor={bars ? { fill: palette.grid } : { stroke: palette.grid, strokeWidth: 1 }}
      isAnimationActive={false}
      // Recharts calls the X value `label`; renamed on the way in so it can't
      // shadow the series LABELLER this tooltip actually needs.
      content={({ active, payload, label: x }) => {
        if (!active || !payload?.length) return null;
        return (
          <Readout
            title={stampFor(data.bucket, Number(x))}
            rows={payload.map((p) => {
              const key = String(p.dataKey);
              const i = keys.findIndex((s) => s.key === key);
              return {
                key,
                label: label(key, keys[i]?.label),
                value: format(Number(p.value ?? 0)),
                color: color(key, i),
              };
            })}
          />
        );
      }}
    />
  );

  const common = (
    <>
      {/* Horizontal only, hairline, solid. Vertical rules would fight the
          crosshair for the same job. */}
      <CartesianGrid stroke={palette.grid} strokeWidth={1} vertical={false} />
      <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tick} {...axis} />
      {/* 52px of gutter rather than 44: a duration tick ("990ms") is wider than
          a count tick, and a clipped axis label costs more than the 8px does. */}
      {/* With a ticker the tick VALUES are chosen for the measure, and the top
          one is pinned as the domain so the plot's ceiling is a labelled
          gridline. Without one, `allowDecimals={false}` is the right default for
          BOTH measures: a count is an integer and so is a millisecond, so a
          fractional tick would be a value neither ledger can hold. */}
      <YAxis
        {...(ticks?.length
          ? { ticks, domain: [0, ticks[ticks.length - 1]!] }
          : { allowDecimals: false })}
        width={52}
        tickFormatter={(v) => formatTick(Number(v))}
        {...axis}
      />
      {tooltip}
    </>
  );

  if (kind === "line" || kind === "area" || kind === "stacked-area") {
    const stacked = kind === "stacked-area";
    const filled = kind !== "line";
    const Chart = filled ? AreaChart : LineChart;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          {common}
          {keys.map((s, i) => {
            const hue = color(s.key, i);
            const shape = {
              dataKey: s.key,
              stroke: hue,
              strokeWidth: 2,
              strokeLinecap: "round" as const,
              strokeLinejoin: "round" as const,
              isAnimationActive: false,
              // ≥8px, and ringed in the surface colour so it stays legible where
              // it crosses another line. The ring is part of the hit target too.
              activeDot: { r: 4, fill: hue, stroke: palette.surface, strokeWidth: GAP },
              dot: false as const,
            };
            return filled ? (
              <Area
                key={s.key}
                {...shape}
                // `linear`, not a spline. A monotone curve through daily counts
                // draws values BETWEEN the buckets that were never measured, and
                // overshoots on either side of a spike — which is exactly the
                // shape of this data. Straight segments say only what was counted.
                type="linear"
                fill={hue}
                // A wash, never a saturated block — stacked or not, the fill is
                // context and the stroke is the data.
                fillOpacity={stacked ? 0.22 : 0.12}
                stackId={stacked ? "all" : undefined}
              />
            ) : (
              <Line key={s.key} {...shape} type="linear" />
            );
          })}
        </Chart>
      </ResponsiveContainer>
    );
  }

  // Bars: stacked (part-to-whole per bucket) or grouped (compare series within
  // a bucket). Both cap thickness and leave the band's remainder as air.
  const stacked = kind === "stacked-bar";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barGap={GAP}>
        {common}
        {keys.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={color(s.key, i)}
            stackId={stacked ? "all" : undefined}
            maxBarSize={MAX_BAR}
            isAnimationActive={false}
            // The 2px surface gap between touching segments — drawn as a stroke
            // in the SURFACE colour, which is white doing the separating rather
            // than a border adding ink.
            {...(stacked ? { stroke: palette.surface, strokeWidth: GAP } : {})}
            // Rounded data-end, square at the baseline. Only the topmost segment
            // of a stack has a free end to round.
            radius={stacked && i < keys.length - 1 ? 0 : [4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------- share charts */

interface ShareProps {
  kind: ChartKind;
  rows: ChartShareRow[];
  palette: ChartPalette;
  label: MetricLabeller;
  format: ChartFormatter;
  formatTick: ChartFormatter;
  ticker?: ChartTicker;
  color: ChartColorer;
}

function ShareChart({ kind, rows, palette, label, format, formatTick, ticker, color }: ShareProps) {
  const total = rows.reduce((n, r) => n + r.value, 0);
  const ticks = ticker?.(rows.reduce((max, r) => Math.max(max, r.value), 0));

  const tooltip = (
    <Tooltip
      cursor={{ fill: palette.grid }}
      isAnimationActive={false}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const p = payload[0]!;
        const row = p.payload as ChartShareRow;
        const pct = total ? Math.round((row.value / total) * 100) : 0;
        const i = rows.indexOf(row);
        return (
          <Readout
            title={`${label(row.key, row.label)} · ${pct}% of ${format(total)}`}
            rows={[
              {
                key: row.key,
                label: row.note,
                value: format(row.value),
                color: color(row.key, i),
              },
            ]}
          />
        );
      }}
    />
  );

  if (kind === "donut") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          {tooltip}
          <Pie
            data={rows}
            dataKey="value"
            nameKey="label"
            // A donut, not a pie: the hole removes the centre wedge-angle the eye
            // is worst at judging, and leaves somewhere for the total to live.
            innerRadius="52%"
            outerRadius="80%"
            // The 2px surface gap again — between slices this time.
            paddingAngle={1}
            stroke={palette.surface}
            strokeWidth={GAP}
            isAnimationActive={false}
          >
            {rows.map((r, i) => (
              <Cell key={r.key} fill={color(r.key, i)} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // Ranked bars, horizontal: category names here are tool ids and file paths,
  // which do not fit under a vertical column and would have to be rotated.
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid stroke={palette.grid} strokeWidth={1} horizontal={false} />
        <XAxis
          type="number"
          {...(ticks?.length
            ? { ticks, domain: [0, ticks[ticks.length - 1]!] }
            : { allowDecimals: false })}
          tickFormatter={(v) => formatTick(Number(v))}
          stroke={palette.grid}
          tick={{ fill: palette.ink, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          tickFormatter={(v: string) => label(v, v)}
          width={140}
          stroke={palette.grid}
          tick={{ fill: palette.ink, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        {tooltip}
        <Bar dataKey="value" maxBarSize={MAX_BAR} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={r.key} fill={color(r.key, i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ legend */

/**
 * Always rendered for two or more series — the dependable identity channel,
 * so nothing on this page relies on colour-matching alone. A single series
 * needs no legend: there is one colour and the card's title already names it.
 */
export function ChartLegend({
  entries,
  label,
  format,
  color,
}: {
  entries: { key: string; label: string; total: number }[];
  label: MetricLabeller;
  format: ChartFormatter;
  color: ChartColorer;
}) {
  if (entries.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {entries.map((e, i) => (
        <li key={e.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-sm"
            style={{ background: color(e.key, i) }}
          />
          <span className="max-w-[180px] truncate text-2xs text-secondary">
            {label(e.key, e.label)}
          </span>
          <span className="cm-mono !text-2xs text-faint tabular-nums">{format(e.total)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- entry */

export function MetricsChart({
  kind,
  time,
  share,
  label,
  format,
  formatTick = format,
  ticker,
  color,
  height = 280,
}: {
  kind: ChartKind;
  time: ChartTime | null;
  share: ChartShareRow[] | null;
  label: MetricLabeller;
  /** Values a reader looks AT — tooltip rows and the legend. Readable, not terse. */
  format: ChartFormatter;
  /** Values on an axis tick, where several share a 52px gutter. Defaults to `format`. */
  formatTick?: ChartFormatter;
  ticker?: ChartTicker;
  color: ChartColorer;
  height?: number;
}) {
  const palette = useChartPalette();
  const timeForm = isTimeChart(kind);
  const empty = timeForm ? !time?.series.length : !share?.length;

  if (empty) {
    return (
      <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
        Nothing recorded in this window.
      </div>
    );
  }
  return (
    <div style={{ height }}>
      {timeForm ? (
        <TimeChart
          kind={kind}
          data={time!}
          palette={palette}
          label={label}
          format={format}
          formatTick={formatTick}
          ticker={ticker}
          color={color}
        />
      ) : (
        <ShareChart
          kind={kind}
          rows={share!}
          palette={palette}
          label={label}
          format={format}
          formatTick={formatTick}
          ticker={ticker}
          color={color}
        />
      )}
    </div>
  );
}
