/**
 * A speedometer that actually reads the speed.
 *
 * The effort picker used lucide's static `<Gauge/>`, whose needle sits at the
 * same angle whether you're on "low" or "max" — the one control whose whole
 * point is "how hard is this thinking?" showed nothing until you opened it.
 * This sweeps the needle and burns the arc behind it green→red, so the level is
 * legible at 14px without reading the word next to it.
 */
import { useId } from "react";
import type { Effort } from "@dispatch/shared";
import { EFFORT_OPTIONS } from "../../lib/efforts.js";
import { cn } from "../../lib/cn.js";

const LEVELS = EFFORT_OPTIONS.map((o) => o.value);

/**
 * Needle tint per level. The arc gets these as gradient stops, in this order.
 *
 * The palette's ORDINAL ramp, not the categorical set: the whole point of the
 * gauge is that the colours are ranked, so they have to come from a scale whose
 * order is part of its contract. Referencing the vars (rather than the hexes
 * they used to be) is also what lets the needle re-tint on a light theme, where
 * the raw yellow of `gauge-3` would be invisible against white chrome.
 */
const COLORS: Record<Effort, string> = {
  low: "var(--p-gauge-1)",
  medium: "var(--p-gauge-2)",
  high: "var(--p-gauge-3)",
  xhigh: "var(--p-gauge-4)",
  max: "var(--p-gauge-5)",
};

// Drawn in a 24×24 box because that's lucide's, so this drops in wherever a
// lucide icon does and inherits the same `size-*` sizing rules.
const CX = 12;
const CY = 12.5;
const R = 8;
const START = -125;
const END = 125;

const pt = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)] as const;
};

const [ax, ay] = pt(START, R);
const [bx, by] = pt(END, R);
// large-arc=1: the sweep is 250°, so the *long* way round is the one we want.
const ARC = `M ${ax} ${ay} A ${R} ${R} 0 1 1 ${bx} ${by}`;

export function EffortGauge({ effort, className }: { effort: Effort; className?: string }) {
  const id = useId();
  const idx = Math.max(0, LEVELS.indexOf(effort));
  // (idx+1)/n, not idx/(n-1): "low" still deserves a visible green sliver
  // rather than an empty gauge that reads as "off".
  const frac = (idx + 1) / LEVELS.length;
  const angle = START + frac * (END - START);

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      <defs>
        {/* userSpaceOnUse across the dial's width (x = CX±R, the sweep's own
            extremes at ±90°): a plain horizontal gradient then lands each
            level's colour under its own stretch of arc. Only the two tails past
            ±90° double back in x, and both sit under the end caps where a level
            boundary never falls. objectBoundingBox would be wrong here — the
            lit arc must keep the colour it has at full sweep, not restretch the
            ramp across whatever fraction is currently showing. */}
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={CX - R} y1="0" x2={CX + R} y2="0">
          {EFFORT_OPTIONS.map((o, i) => (
            <stop
              key={o.value}
              offset={`${(i / (LEVELS.length - 1)) * 100}%`}
              // `style`, not the `stop-color` attribute: `var()` is only
              // resolved when it arrives through CSS, and an SVG presentation
              // ATTRIBUTE holding a var() is silently dropped (black stops).
              style={{ stopColor: COLORS[o.value] }}
            />
          ))}
        </linearGradient>
      </defs>

      {/* unlit track */}
      <path
        d={ARC}
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={2.25}
        strokeLinecap="round"
      />

      {/* lit arc — pathLength=100 makes the dash maths independent of the
          arc's real length, so the transition is a plain number tween. */}
      <path
        d={ARC}
        stroke={`url(#${id})`}
        strokeWidth={2.25}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${frac * 100} 100`}
        style={{ transition: "stroke-dasharray 300ms cubic-bezier(.34,1.56,.64,1)" }}
      />

      <g
        style={{
          transform: `rotate(${angle}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transition: "transform 300ms cubic-bezier(.34,1.56,.64,1)",
        }}
      >
        <line
          x1={CX}
          y1={CY}
          x2={CX}
          y2={CY - R + 3.5}
          style={{ stroke: COLORS[effort] }}
          strokeWidth={1.75}
          strokeLinecap="round"
        />
      </g>
      <circle cx={CX} cy={CY} r={1.5} style={{ fill: COLORS[effort] }} />
    </svg>
  );
}
