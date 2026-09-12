import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * One reading in the header's status line: what it is, its shape, its number.
 *
 * ONE grammar, three metrics. CPU, memory and subscription usage used to be
 * two bordered pills sitting against each other — a capsule holding two
 * metrics, then a capsule holding one — which read as two unrelated widgets
 * that happened to be adjacent, and spent ~24px of a 33px title bar on
 * borders and padding drawing boxes nobody needed to see. The bar is now the
 * box: micro-label, shape, figure, with hairlines between metrics and no
 * chrome until you point at one.
 *
 * The LABEL is what the borders were really doing — telling you where one
 * metric stops and the next starts. Three characters of 9px uppercase does it
 * in a third of the width, and answers "which number is that" at the same
 * time, which the icons it replaces never quite did: a chip glyph in front of
 * a bar that belonged to memory is exactly how the old pill came to be
 * misread.
 */
export function Gauge({
  label,
  value,
  tone,
  children,
}: {
  /** Two or three characters — `CPU`, `MEM`, `5H`. */
  label: string;
  /** The figure, already formatted. */
  value: string;
  /** Text colour for the figure, from `lib/resourceTone`. */
  tone: string;
  /** The bar, ring or sparkline. */
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-2xs font-semibold uppercase leading-none tracking-[0.09em] text-faint">
        {label}
      </span>
      {children}
      <span className={cn("cm-mono text-xs font-semibold tabular-nums", tone)}>{value}</span>
    </span>
  );
}

/**
 * The hairline between two gauges.
 *
 * `h-3` rather than full height: a rule that reaches the ends of a 33px strip
 * cuts the bar into cells, and the gauges are one group of readings, not a
 * table.
 */
export function GaugeSep() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-line" />;
}

/**
 * Shared trigger shape for the gauge groups.
 *
 * Borderless until hovered — in a status line every border is noise — but it
 * must still be obvious that pointing at it does something, hence the
 * background on hover rather than nothing at all.
 */
export const GAUGE_TRIGGER =
  "flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-active";
