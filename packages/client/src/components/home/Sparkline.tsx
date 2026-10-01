/**
 * A project card's activity sparkline — daily counts, one path, no library.
 *
 * NOT Recharts, which every other chart in this app is. A `<ResponsiveContainer>`
 * brings a ResizeObserver, a layout pass and a few hundred DOM nodes with it,
 * and the point of this surface is that it paints in one frame; multiply that by
 * one card per project and the cheapest thing on the page becomes the most
 * expensive. The whole job here is "is this project warming up or cooling down",
 * which is a shape, not a readable chart — no axes, no ticks, no tooltip, so
 * there is nothing a chart library would be doing for it.
 *
 * The scale is PER CARD, deliberately. A shared y-axis across the grid would
 * flatten every project but the busiest one into a straight line at zero, which
 * answers the comparison question the numbers beside it already answer, and
 * destroys the only question this mark is here for. The numbers compare; the
 * shape describes.
 *
 * IT IS NOT DECORATIVE, which is what it was first marked. The card prints the
 * window TOTAL beside it, never the shape, so `aria-hidden` deleted the only
 * thing this element contributes — "warming up or cooling down" — from anyone
 * reading by voice. It is a `role="img"` with the series spelled out instead:
 * the counts are the information, and there is no honest way to summarise a
 * trend in fewer words that does not also editorialise.
 */
import { useId } from "react";
import { cn } from "../../lib/cn.js";

const W = 96;
const H = 22;

export function Sparkline({
  values,
  label,
  className,
}: {
  values: readonly number[];
  /** What one bucket spans ("hourly" / "daily"), for the text alternative. */
  label: string;
  className?: string;
}) {
  // The gradient needs a document-unique id — several of these render at once.
  const gradient = useId();
  const peak = Math.max(1, ...values);

  // A single point has no line to draw; centre it so the card doesn't show an
  // empty box on a project whose window is one day wide.
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const points = values.map((v, i) => {
    const x = values.length > 1 ? i * step : W / 2;
    // 1px of headroom top and bottom so a peak isn't clipped by the viewBox and
    // a zero still sits ON the floor rather than under it.
    const y = H - 1 - (v / peak) * (H - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = points.join(" ");
  const area = `${W / 2},${H} ${line} ${values.length > 1 ? W : W / 2},${H}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={
        values.some((v) => v > 0)
          ? `${label} activity, oldest to newest: ${values.join(", ")}`
          : `No ${label} activity in this window`
      }
      preserveAspectRatio="none"
      className={cn("h-5 w-full", className)}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--p-chart-1)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--p-chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && <polygon points={area} fill={`url(#${gradient})`} />}
      <polyline
        points={line}
        fill="none"
        stroke="var(--p-chart-1)"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        // `preserveAspectRatio: none` stretches the stroke with the box, which
        // thins the line on a wide card. Opting out keeps it 1.25px everywhere.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
