import { useId } from "react";
import { cn } from "../../lib/cn.js";

export interface SparklineProps {
  /** Readings oldest → newest. */
  values: number[];
  /** Top of the scale; readings above it clamp. */
  max?: number;
  /** Colour comes from `currentColor` — pass a `text-*` class. */
  className?: string;
  width?: number;
  height?: number;
  /** Native tooltip, since the line carries no text of its own. */
  title?: string;
}

/**
 * A tiny history line, for a figure whose SHAPE says more than its value.
 *
 * The header's CPU reading is the case it exists for. A bar says "37% right
 * now", which is the one thing about CPU that is never interesting — a build
 * pegs it and a machine at rest doesn't. What a reader actually wants is "has
 * it been like that for a while", and the only way a widget this size can
 * answer that is by drawing the last minute or so.
 *
 * WHY THE WHOLE WIDTH, ALWAYS. The points are spread across the full box even
 * when the buffer is half full, rather than growing in from the left. The line
 * appears at its final size the moment the app opens and simply gains
 * resolution; filling in from the left would read as a loading animation on a
 * widget whose whole job is to be already there.
 *
 * `vector-effect: non-scaling-stroke` because the box is sized in px by the
 * caller but the path is drawn in a unit viewBox — without it the stroke
 * scales with the box and a 28×10 sparkline draws a 3px-thick line.
 */
export function Sparkline({
  values,
  max = 100,
  className,
  width = 28,
  height = 10,
  title,
}: SparklineProps) {
  // Stripped to a plain token: React's ids carry `:` or `«»`, which a `url(#…)`
  // reference would need escaped, and `CSS.escape` does not exist in the node
  // environment the client's tests render in.
  const fill = `spark${useId().replace(/[^\w-]/g, "")}`;
  // One point cannot be a line, and an empty buffer must not draw a flat zero —
  // that reads as a measured idle rather than as "no readings yet".
  if (values.length < 2) {
    return <span className="shrink-0" style={{ width, height }} aria-hidden />;
  }

  const step = 1 / (values.length - 1);
  const y = (v: number) => 1 - Math.max(0, Math.min(1, v / max));
  const pts = values.map((v, i) => `${(i * step).toFixed(4)},${y(v).toFixed(4)}`);

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className={cn("shrink-0 overflow-visible", className)}
      style={{ width, height }}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {/* Area first, so the line draws over its own edge, FADING to nothing at
          the floor. A flat 20% fill was fine under a jagged CPU line, but under
          memory — which sits level for minutes — it drew a solid tinted slab
          that read as a fat progress bar rather than as a chart. The gradient
          keeps the weight at the line and lets the shape, not the area, carry
          it. `useId` because gradients are referenced by document-wide id and
          the header draws two of these. */}
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={0.32} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,1 ${pts.join(" ")} 1,1`} fill={`url(#${fill})`} />
      <polyline
        points={pts.join(" ")}
        className="fill-none stroke-current"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
