/**
 * The Growth tab's chart — two forms over one shaped dataset.
 *
 *   size   a stacked area: each series' line count at the end of each bucket,
 *          piled so the top edge is the whole repo. A stack rather than lines
 *          because the question is "how big, and made of what", and a stack
 *          answers both at once; the same series unstacked would be six lines
 *          crossing each other for no gain.
 *   churn  bars above the axis for lines added in the bucket and below it for
 *          lines deleted, stacked by series on each side (`stackOffset="sign"`
 *          keeps the two piles apart). This is the form GitHub's own graph
 *          uses, and for the same reason: net alone cannot tell a quiet month
 *          from a rewrite that happened to land at the same size.
 *
 * NOT `MetricsChart`. That component is measure-agnostic but shape-specific —
 * one value per series per bucket, all positive. Churn needs two values per
 * series with opposite signs, and the size form needs a stacked area whose
 * tooltip can total the stack. Forking the marks is cheaper than making the
 * shared chart carry a second data model, and the marks here follow the same
 * house spec (2px round-capped strokes, ~12–22% fills, 24px bar cap, 2px
 * surface gaps, hairline horizontal grid, no numbers on points).
 *
 * Deleted bars wear the series colour at reduced opacity rather than a second
 * hue: the direction is already carried by which side of the axis they sit on,
 * and a red/green pair would put a status colour on a category.
 */
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Readout, stampFor, tickFor, type ChartColorer } from "./MetricsChart.js";
import { compact, count } from "./chrome.js";
import { lineTicks, type GrowthMeasure, type GrowthShape } from "./growth-shape.js";
import type { ChartPalette } from "./palette.js";

const MAX_BAR = 24;
const GAP = 2;

/** A signed compact figure for an axis that runs below zero. */
function signedCompact(v: number): string {
  if (v < 0) return `−${compact(-v)}`;
  return compact(v);
}

interface Props {
  measure: GrowthMeasure;
  shape: GrowthShape;
  palette: ChartPalette;
  color: ChartColorer;
  height?: number;
}

export function GrowthChart({ measure, shape, palette, color, height = 300 }: Props) {
  const tick = useMemo(() => tickFor(shape.bucket), [shape.bucket]);
  const { series, buckets } = shape;

  // Recharts wants one object per X. Size rows carry `s:<key>`; churn rows
  // carry `a:<key>` (positive) and `d:<key>` (negative).
  const rows = useMemo(() => {
    return buckets.map((ts, b) => {
      const row: Record<string, number> = { ts, commits: shape.commits[b] ?? 0 };
      series.forEach((s, i) => {
        if (measure === "size") row[`s:${s.key}`] = shape.size[i]![b] ?? 0;
        else {
          row[`a:${s.key}`] = shape.added[i]![b] ?? 0;
          row[`d:${s.key}`] = -(shape.deleted[i]![b] ?? 0);
        }
      });
      return row;
    });
  }, [buckets, series, shape, measure]);

  // The axis extent: a stack's height is the SUM at that X (size), or the
  // tallest positive and deepest negative pile (churn).
  const [lo, hi] = useMemo(() => {
    let top = 0;
    let bottom = 0;
    for (let b = 0; b < buckets.length; b++) {
      let up = 0;
      let down = 0;
      for (let i = 0; i < series.length; i++) {
        if (measure === "size") up += shape.size[i]![b] ?? 0;
        else {
          up += shape.added[i]![b] ?? 0;
          down += shape.deleted[i]![b] ?? 0;
        }
      }
      if (up > top) top = up;
      if (down > bottom) bottom = down;
    }
    return [-bottom, top] as const;
  }, [buckets, series, shape, measure]);
  const ticks = useMemo(() => lineTicks(lo, hi), [lo, hi]);

  if (!series.length || !buckets.length) {
    return (
      <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
        Nothing in this window.
      </div>
    );
  }

  const axis = {
    stroke: palette.grid,
    tick: { fill: palette.ink, fontSize: 11 },
    tickLine: false,
    axisLine: false,
  } as const;

  const tooltip = (
    <Tooltip
      cursor={
        measure === "churn"
          ? { fill: palette.grid }
          : { stroke: palette.grid, strokeWidth: 1 }
      }
      isAnimationActive={false}
      content={({ active, payload, label: x }) => {
        if (!active || !payload?.length) return null;
        const row = payload[0]!.payload as Record<string, number>;
        const title = stampFor(shape.bucket, Number(x));
        const commits = row.commits ?? 0;
        if (measure === "size") {
          const total = series.reduce((n, s) => n + (row[`s:${s.key}`] ?? 0), 0);
          return (
            <Readout
              title={title}
              // Top of the stack first, so the tooltip reads in the order the
              // eye meets the bands.
              rows={series
                .map((s, i) => ({
                  key: s.key,
                  label: s.label,
                  value: count(row[`s:${s.key}`] ?? 0),
                  color: color(s.key, i),
                }))
                .reverse()}
              footer={`${count(total)} lines · ${count(commits)} commit${commits === 1 ? "" : "s"}`}
            />
          );
        }
        const added = series.reduce((n, s) => n + (row[`a:${s.key}`] ?? 0), 0);
        const deleted = series.reduce((n, s) => n - (row[`d:${s.key}`] ?? 0), 0);
        const net = added - deleted;
        return (
          <Readout
            title={title}
            rows={series
              .map((s, i) => ({
                key: s.key,
                label: s.label,
                value: `+${count(row[`a:${s.key}`] ?? 0)} −${count(-(row[`d:${s.key}`] ?? 0))}`,
                color: color(s.key, i),
              }))
              .filter((r) => r.value !== "+0 −0")}
            footer={`net ${net >= 0 ? "+" : "−"}${count(Math.abs(net))} · ${count(commits)} commit${commits === 1 ? "" : "s"}`}
          />
        );
      }}
    />
  );

  const common = (
    <>
      <CartesianGrid stroke={palette.grid} strokeWidth={1} vertical={false} />
      <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tick} {...axis} />
      <YAxis
        width={52}
        ticks={ticks}
        domain={[ticks[0]!, ticks[ticks.length - 1]!]}
        tickFormatter={(v) => signedCompact(Number(v))}
        {...axis}
      />
      {tooltip}
    </>
  );

  if (measure === "size") {
    const single = series.length === 1;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          {common}
          {series.map((s, i) => {
            const hue = color(s.key, i);
            return (
              <Area
                key={s.key}
                dataKey={`s:${s.key}`}
                stackId="all"
                type="linear"
                stroke={hue}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={hue}
                fillOpacity={single ? 0.12 : 0.22}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, fill: hue, stroke: palette.surface, strokeWidth: GAP }}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
        stackOffset="sign"
        margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
        barGap={GAP}
      >
        {common}
        <ReferenceLine y={0} stroke={palette.ink} strokeWidth={1} strokeOpacity={0.5} />
        {series.map((s, i) => {
          const hue = color(s.key, i);
          const last = i === series.length - 1;
          return [
            <Bar
              key={`a:${s.key}`}
              dataKey={`a:${s.key}`}
              stackId="all"
              fill={hue}
              maxBarSize={MAX_BAR}
              isAnimationActive={false}
              stroke={palette.surface}
              strokeWidth={GAP}
              radius={last ? [4, 4, 0, 0] : 0}
            />,
            <Bar
              key={`d:${s.key}`}
              dataKey={`d:${s.key}`}
              stackId="all"
              fill={hue}
              fillOpacity={0.55}
              maxBarSize={MAX_BAR}
              isAnimationActive={false}
              stroke={palette.surface}
              strokeWidth={GAP}
              radius={last ? [0, 0, 4, 4] : 0}
            />,
          ];
        })}
      </BarChart>
    </ResponsiveContainer>
  );
}
