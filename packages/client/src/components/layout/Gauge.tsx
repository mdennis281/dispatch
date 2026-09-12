import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * One reading in the top bar: what it is, its shape, its number.
 *
 * ONE grammar, three metrics. CPU, memory and usage used to be bordered pills
 * sitting against each other, which read as unrelated widgets that happened to
 * be adjacent and spent the bar's height on borders. The bar is the box now:
 * micro-label, shape, figure, and no chrome until you point at one.
 *
 * STACKED, the label and the figure have FIXED widths: the two-line title bar
 * puts CPU over memory with usage beside CPU, and gauges whose charts start
 * wherever their label happened to end are a ragged column rather than a
 * little table. `w-7` fits `CPU`/`MEM` in
 * the micro-label face; `w-8` fits `100%`. INLINE, the same widths spent 20px of
 * air after a two-character `5H`, so there the label is its natural width and
 * the figure only keeps a floor — enough that `9%` → `10%` on a poll doesn't
 * shove everything to its right.
 */
export function Gauge({
  label,
  value,
  tone,
  layout,
  className,
  children,
}: {
  /** Two or three characters — `CPU`, `MEM`, `5H`. */
  label: string;
  /** The figure, already formatted. */
  value: string;
  /** Text colour for the figure, from `lib/resourceTone`. */
  tone: string;
  layout: GaugeLayout;
  className?: string;
  /** The bar or sparkline. */
  children: ReactNode;
}) {
  return (
    <span className={cn("flex items-center", layout === "stacked" ? "gap-2" : "gap-1.5", className)}>
      <span
        className={cn(
          "text-2xs font-semibold uppercase leading-none tracking-[0.09em] text-faint",
          layout === "stacked" && "w-7",
        )}
      >
        {label}
      </span>
      {children}
      <span
        className={cn(
          "cm-mono text-right text-xs font-semibold tabular-nums",
          layout === "stacked" ? "w-8" : "min-w-7",
          tone,
        )}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * How a group of gauges is laid out, decided by the bar rather than the meter.
 *
 * `stacked` is the installed window's two-line title bar: one gauge per line,
 * each line exactly as tall as the bar's own (see `--tb-l1` in index.css), so a
 * reading sits level with the icons beside it instead of floating between them.
 * `inline` is the single row everywhere else.
 */
export type GaugeLayout = "stacked" | "inline";

/**
 * Chart size per layout.
 *
 * Stacked gets the height a title bar line can give — 18px against the 11px the
 * one-row strip allowed, which is the difference between a line you can read a
 * trend off and a squiggle. Inline stays short enough for a 44px row to keep its
 * air.
 */
export const CHART: Record<GaugeLayout, { width: number; height: number }> = {
  stacked: { width: 76, height: 18 },
  inline: { width: 48, height: 14 },
};

/** Bar width per layout, matched to the chart so the columns line up. */
export const BAR_W: Record<GaugeLayout, string> = {
  stacked: "w-[76px]",
  inline: "w-12",
};

/**
 * The trigger around a gauge group.
 *
 * Borderless until hovered — every border in a title bar is noise — but it must
 * still be obvious that pointing at it does something, hence a background.
 *
 * STACKED puts that background on a pseudo-element inset from the bar's edges.
 * The button itself has to be the full height of both lines so its rows can be
 * exactly line-tall, and a hover fill that ran to the very top of the window and
 * down onto the hairline looked like a selected tab rather than a control.
 */
export const GAUGE_TRIGGER: Record<GaugeLayout, string> = {
  stacked: cn(
    "relative isolate flex flex-col px-2",
    "before:absolute before:inset-x-0 before:inset-y-1.5 before:-z-10 before:rounded-md",
    "before:transition-colors hover:before:bg-active",
  ),
  inline: "flex items-center gap-3 rounded-md px-1.5 py-1 transition-colors hover:bg-active",
};

/**
 * A ONE-line trigger in the title bar — the usage gauge, which shares line one
 * with CPU and has the attention queue under it on line two.
 *
 * Same inset hover fill as the two-line trigger, and exactly a line tall so its
 * reading sits level with CPU's.
 */
export const GAUGE_LINE_TRIGGER = cn(
  "relative isolate flex h-(--tb-l1) items-center px-2",
  "before:absolute before:inset-x-0 before:inset-y-1 before:-z-10 before:rounded-md",
  "before:transition-colors hover:before:bg-active",
);

/**
 * The row classes inside a stacked trigger.
 *
 * The first row is the title bar strip's height and the second takes the rest,
 * so line one of every gauge is centred on the window buttons and line two on
 * the icons under them.
 */
export const STACK_ROW = ["h-(--tb-l1)", "flex-1"] as const;

/**
 * The hairline between two gauge groups.
 *
 * Short rather than full height: a rule that reaches the ends of the bar cuts it
 * into cells, and the gauges are one set of readings, not a table.
 */
export function GaugeSep({ layout }: { layout: GaugeLayout }) {
  return (
    <span
      aria-hidden
      className={cn(
        "w-px shrink-0 self-center bg-line",
        layout === "stacked" ? "h-9" : "h-3",
      )}
    />
  );
}
