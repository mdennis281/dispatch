/**
 * "What 1% buys" over time — a bar per period, a row per account per window.
 *
 * Small multiples, never one shared y-axis: a point of the weekly window costs
 * roughly ten times a point of the 5-hour one, so on one scale the 5-hour row
 * is a flat line along the floor.
 *
 * The page exists to answer "did 1% get cheaper this week", and an absent bar
 * means very different things depending on why it's absent. Every period
 * therefore lands in exactly one state, each drawn differently:
 *
 *   untracked — before this account was first read. Blank: nothing was lost.
 *   unwatched — after tracking began, but nothing read it (app off, reads
 *               failing). Hatched, because THIS is the missing data.
 *   idle      — read the whole time; nothing moved, nothing spent. A floor tick.
 *   elsewhere — the window moved but no Dispatch turn ran: claude.ai, another
 *               machine. A hollow ring — a ratio here would read $0 per 1%.
 *   flat      — spend, but the window didn't move a whole point. A tick at the
 *               ceiling: the ratio is "more than the scale", not infinity.
 *   value     — a bar. Faded when it can't be trusted (under 3 points, or only
 *               partly watched); dashed when its period is still running.
 */
import { useMemo } from "react";
import {
  LIMIT_PERIOD_HOURS,
  limitPeriodEnd,
  limitPeriodStart,
  type LimitPeriod,
  type LimitWindowSeries,
  type LimitYield,
} from "@dispatch/shared";
import { compact } from "./chrome.js";
import { colorFor, useChartPalette } from "./palette.js";
import { cn } from "../../lib/cn.js";

/** Under this many points moved, ±1-point rounding is most of the figure. */
export const WEAK_POINTS = 3;

const usdFmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
export const usd = (v: number) => usdFmt.format(v);

interface Span {
  start: number;
  end: number;
}
interface Watched extends Span {
  y: LimitYield;
  points: number;
}
// One member per kind: TypeScript won't narrow a member whose `kind` is itself a union.
type Cell =
  | (Span & { kind: "untracked" })
  | (Span & { kind: "unwatched" })
  | (Watched & { kind: "idle" })
  | (Watched & { kind: "elsewhere" })
  | (Watched & { kind: "flat" })
  | (Watched & { kind: "value"; value: number; weak: boolean; live: boolean });

interface Row {
  key: string;
  account: string;
  window: string;
  color: string;
  priced: boolean;
  cells: Cell[];
  /**
   * Range-wide: everything spent ÷ every point moved, over the bars only. A
   * point moved outside Dispatch has no spend to set against it, so counting
   * it would make 1% look cheaper the more someone used claude.ai.
   */
  average: number | null;
  /** The points behind `average`. */
  moved: number;
  /** The y-scale's top. Fitted to the bars that can be trusted. */
  ceiling: number;
}

/** "$1.20" when priced, else tokens — Codex has no price, only tokens. */
export function formatPerPoint(value: number, priced: boolean): string {
  return priced ? usd(value) : `${compact(value)} tok`;
}

/**
 * The windows worth a row: the account's shortest and longest timed windows.
 * Each is the right gauge at a different scale (see `limit-yield-spreads-
 * turns-over-duration`): the 5-hour window is fine-grained by the hour, the
 * weekly one by the day. Per-model weeklies would be a third and fourth row of
 * the same story.
 */
export function gaugeWindows<W extends { windowMinutes: number | null }>(series: W[]): W[] {
  const timed = series.filter((w) => w.windowMinutes !== null);
  if (timed.length <= 1) return timed;
  const lengths = timed.map((w) => w.windowMinutes!);
  // FIRST of each length, in the server's order (length, then id): Claude has
  // `seven_day` and `seven_day_opus` at the same 10080 minutes, and the plain
  // weekly window is the account's gauge; the per-model one is a slice of it.
  const short = timed.find((w) => w.windowMinutes === Math.min(...lengths))!;
  const long = timed.find((w) => w.windowMinutes === Math.max(...lengths))!;
  return short === long ? [short] : [short, long];
}

function buildRows(
  yields: LimitYield[],
  windows: LimitWindowSeries[],
  period: LimitPeriod,
  from: number,
  to: number,
  palette: ReturnType<typeof useChartPalette>,
): { grid: { start: number; end: number }[]; rows: Row[] } {
  const hours = LIMIT_PERIOD_HOURS[period];
  const grid: { start: number; end: number }[] = [];
  for (let p = limitPeriodStart(from, hours); p < to; p = limitPeriodEnd(p, hours)) {
    grid.push({ start: p, end: limitPeriodEnd(p, hours) });
  }
  const now = Date.now();

  const bySub = new Map<string, LimitWindowSeries[]>();
  for (const w of windows) bySub.set(w.subscriptionId, [...(bySub.get(w.subscriptionId) ?? []), w]);

  const rows: Row[] = [];
  for (const [sub, series] of bySub) {
    // Series carry the reading just before the range, so their first point is
    // the earliest anyone ever read this account — or earlier than `from`.
    const trackedSince = Math.min(...series.map((w) => w.points[0]?.ts ?? Infinity));
    const mine = new Map(yields.filter((y) => y.subscriptionId === sub).map((y) => [y.start, y]));
    const priced = [...mine.values()].some((y) => y.tokens.costUsd !== null);
    const gauges = gaugeWindows(series);
    // Coloured by position among ALL the account's windows, exactly as the
    // line chart above does, so a window is the same colour in both.
    series.forEach((w, index) => {
      if (!gauges.includes(w)) return;
      let spent = 0;
      let moved = 0;
      const cells: Cell[] = grid.map(({ start, end }) => {
        const y = mine.get(start);
        if (!y || y.coverage === 0) {
          // A period that ENDED before the first read was never going to have
          // data; one that ends after it should have.
          return end <= trackedSince ? { start, end, kind: "untracked" } : { start, end, kind: "unwatched" };
        }
        const points = y.windows.find((x) => x.windowId === w.windowId)?.points ?? 0;
        const amount = priced ? (y.tokens.costUsd ?? 0) : y.tokens.total;
        if (points <= 0 && y.tokens.total <= 0) return { start, end, kind: "idle", y, points };
        if (y.tokens.total <= 0) return { start, end, kind: "elsewhere", y, points };
        if (points <= 0) return { start, end, kind: "flat", y, points };
        spent += amount;
        moved += points;
        return {
          start,
          end,
          kind: "value",
          y,
          points,
          value: amount / points,
          weak: points < WEAK_POINTS || y.partial,
          live: end > now,
        };
      });
      const bars = cells.filter((c): c is Extract<Cell, { kind: "value" }> => c.kind === "value");
      const average = moved > 0 ? spent / moved : null;
      // Fit to the trusted bars: one faint 1-point period would otherwise read
      // $40 and press every honest bar flat against the floor. Taller ones are
      // drawn broken at the ceiling, and their tooltip still says the number.
      const trusted = bars.filter((b) => !b.weak && !b.live).map((b) => b.value);
      const basis = trusted.length ? trusted : bars.map((b) => b.value);
      const ceiling = Math.max(...basis, average ?? 0, Number.MIN_VALUE) * 1.15;
      rows.push({
        key: `${sub}|${w.windowId}`,
        account: w.subscriptionLabel,
        window: w.title,
        color: colorFor(palette, w.windowId, index),
        priced,
        cells,
        average,
        moved,
        ceiling,
      });
    });
  }
  return { grid, rows };
}

function periodName(start: number, end: number, period: LimitPeriod): string {
  const day = new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (period === "1d") return day;
  const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric" });
  return `${day}, ${hm(start)}–${hm(end)}`;
}

function tooltip(row: Row, c: Cell, period: LimitPeriod): string {
  const head = `${periodName(c.start, c.end, period)}\n${row.account} · ${row.window}`;
  if (c.kind === "untracked" || c.kind === "unwatched") {
    return c.kind === "untracked"
      ? `${head}\nBefore tracking began for this account`
      : `${head}\nNo readings — the app was off or every read failed`;
  }
  const pts = `${Math.round(c.points)} point(s)`;
  const watched = c.y.partial ? `\nOnly ${Math.round(c.y.coverage * 100)}% of this period was watched` : "";
  if (c.kind === "idle") return `${head}\nIdle — nothing moved, nothing spent${watched}`;
  if (c.kind === "elsewhere") {
    return `${head}\nMoved ${pts} with no Dispatch turns — used outside Dispatch${watched}`;
  }
  const spend =
    c.y.tokens.costUsd !== null ? `${usd(c.y.tokens.costUsd)} API value · ` : "";
  const toks = `${compact(c.y.tokens.total)} tokens`;
  if (c.kind === "flat") return `${head}\n${spend}${toks}, but under 1 point moved — off the scale${watched}`;
  return (
    `${head}\n${formatPerPoint(c.value, row.priced)} per 1% — ${pts}, ${spend}${toks}` +
    (c.points < WEAK_POINTS ? `\nUnder ${WEAK_POINTS} points: ±1-point rounding dominates` : "") +
    watched +
    (c.live ? "\nStill running — so far" : "")
  );
}

/** Diagonal hatch for unwatched periods. CSS, so it doesn't stretch with the plot. */
const HATCH = "repeating-linear-gradient(135deg, var(--p-line-strong) 0 1px, transparent 1px 5px)";

function Plot({ row, period, dense }: { row: Row; period: LimitPeriod; dense: boolean }) {
  const h = (v: number) => `${Math.min(1, v / row.ceiling) * 100}%`;
  return (
    <div className="relative h-16 border-b border-line">
      {row.average !== null && (
        <div
          className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-muted"
          style={{ bottom: h(row.average) }}
        />
      )}
      <div className="absolute inset-0 flex">
        {row.cells.map((c) => (
          <div
            key={c.start}
            title={tooltip(row, c, period)}
            className={cn("relative h-full min-w-0 flex-1 hover:bg-elevated", !dense && "px-px")}
            style={c.kind === "unwatched" ? { backgroundImage: HATCH } : undefined}
          >
            {c.kind === "idle" && <div className="absolute inset-x-px bottom-0 h-0.5 rounded-full bg-line-strong" />}
            {c.kind === "elsewhere" && (
              <div className="absolute bottom-0.5 left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-muted" />
            )}
            {c.kind === "flat" && (
              <div className="absolute inset-x-px top-0 h-0.5 rounded-full opacity-50" style={{ background: row.color }} />
            )}
            {c.kind === "value" && (
              <div
                className={cn(
                  "absolute bottom-0 rounded-t-[4px]",
                  dense ? "inset-x-0" : "inset-x-px",
                  c.live && "border border-b-0 border-dashed",
                )}
                style={{
                  height: h(c.value),
                  background: c.live ? "transparent" : row.color,
                  borderColor: c.live ? row.color : undefined,
                  opacity: c.weak && !c.live ? 0.4 : 1,
                }}
              >
                {/* Taller than the scale: broken a few px under the top. */}
                {c.value > row.ceiling && <div className="absolute inset-x-0 top-1.5 h-0.5 bg-panel" />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Axis({ grid, period }: { grid: { start: number; end: number }[]; period: LimitPeriod }) {
  // Six-ish labels, whatever the period count; a label per day at 7 days.
  const step = Math.max(1, Math.ceil(grid.length / 7));
  const fmt = (ms: number) =>
    period === "1d"
      ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  return (
    <div className="relative h-4 text-2xs text-faint">
      {grid.map((g, i) =>
        i % step === 0 ? (
          <span
            key={g.start}
            className="absolute top-0.5 -translate-x-1/2 whitespace-nowrap tabular-nums"
            style={{ left: `${((i + 0.5) / grid.length) * 100}%` }}
          >
            {fmt(g.start)}
          </span>
        ) : null,
      )}
    </div>
  );
}

function Key() {
  const swatch = "inline-block h-2.5 w-3 rounded-[2px]";
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, "bg-muted")} /> Per 1%
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, "bg-muted opacity-40")} /> Faded: under {WEAK_POINTS} points, or partly watched
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(swatch, "border border-dashed border-muted")} /> Still running
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block w-4 border-t border-dashed border-muted" /> Range average
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={swatch} style={{ backgroundImage: HATCH }} /> No readings
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3 rounded-full bg-line-strong" /> Idle
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full border-2 border-muted" /> Used outside Dispatch
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex h-2.5 w-3 items-start">
          <span className="h-0.5 w-full rounded-full bg-muted" />
        </span>
        Spent, under 1 point moved
      </span>
    </div>
  );
}

export function YieldChart({
  yields,
  windows,
  period,
  from,
  to,
}: {
  yields: LimitYield[];
  windows: LimitWindowSeries[];
  period: LimitPeriod;
  from: number;
  to: number;
}) {
  const palette = useChartPalette();
  const { grid, rows } = useMemo(
    () => buildRows(yields, windows, period, from, to, palette),
    [yields, windows, period, from, to, palette],
  );
  if (!rows.length || !grid.length) {
    return <p className="px-3 py-3 text-xs text-muted">Nothing yet — this fills in as accounts are read.</p>;
  }
  const dense = grid.length > 90;
  return (
    <div className="flex flex-col gap-3 px-3 pb-3 pt-2">
      <div className="grid grid-cols-[minmax(7rem,10rem)_1fr] gap-x-3 gap-y-2">
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <div className="flex min-w-0 flex-col justify-center gap-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-secondary">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: r.color }} />
                <span className="truncate">{r.account}</span>
              </span>
              <span className="truncate text-2xs text-muted">1% of {r.window.toLowerCase()}</span>
              <span className="cm-mono text-2xs tabular-nums text-faint">
                {r.average !== null
                  ? `avg ${formatPerPoint(r.average, r.priced)} · ${Math.round(r.moved)} pts`
                  : "no spend yet"}
              </span>
            </div>
            <Plot row={r} period={period} dense={dense} />
          </div>
        ))}
        <div />
        <Axis grid={grid} period={period} />
      </div>
      <Key />
    </div>
  );
}
