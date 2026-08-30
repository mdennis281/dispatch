/**
 * A meter that shows a whole AND our slice of it in one bar.
 *
 * WHY ONE BAR AND NOT TWO. The resource surfaces used to draw "the machine" and
 * "Dispatch" as separate bars stacked down the panel, each against its own
 * full-width track. That is two bars to answer one question — "how much of that
 * is us" — and it answers it badly: two independently-scaled bars have to be
 * read as numbers and mentally divided, which is exactly the arithmetic a bar
 * chart exists to remove. Nested in one track the answer is the picture.
 *
 * OVERLAY, NOT SEGMENTS. The `used` fill is drawn full width from zero and the
 * `share` fill is drawn OVER its leading edge, rather than laying two abutting
 * segments side by side. Two segments have to sum exactly, and sub-pixel
 * rounding on a 24 px header bar leaves a hairline of track showing THROUGH the
 * fill at the seam, which reads as a rendering fault rather than a boundary.
 * Overlaid, the seam is one fill ending on top of another and cannot gap.
 *
 * INTENSITY, NOT HUE, separates the two. The dim layer is the same colour at
 * low alpha, so the pair survives every theme without picking a second hue per
 * metric, and stays legible to a reader who cannot separate the hues at all.
 */
import { cn } from "../../lib/cn.js";

/** Track heights. `xs` is the header pill; `sm` rows; `md` hero cards. */
const HEIGHT = {
  xs: "h-1",
  sm: "h-[3px]",
  md: "h-1.5",
  lg: "h-2",
} as const;

export interface SplitBarProps {
  /** Everything in use, 0–100. */
  usedPct: number;
  /**
   * Our slice of the same 0–100 scale, or `null` for "not measured".
   *
   * `null` is not zero, and must not draw as zero: the header pill genuinely
   * has no breakdown (it never scans the process table), and a bar with no
   * bright leading segment would claim Dispatch is using nothing. With `null`
   * the used fill is drawn at FULL strength instead — one honest quantity —
   * so the dim treatment only ever appears where a real split is behind it.
   */
  sharePct?: number | null;
  /** Background utility for the fill, e.g. `bg-accent`. */
  tone?: string;
  size?: keyof typeof HEIGHT;
  className?: string;
  /** Native tooltip, since the bar itself carries no text. */
  title?: string;
}

export function SplitBar({
  usedPct,
  sharePct = null,
  tone = "bg-accent",
  size = "md",
  className,
  title,
}: SplitBarProps) {
  const split = sharePct !== null;
  // Animated because these bars re-render on every poll with a new number: a
  // bar that JUMPS reads as a fresh render, one that slides reads as the same
  // quantity moving, which is what makes a 5 s poll feel like a live reading.
  const grow = "transition-[width] duration-500 ease-[var(--ease-out)]";
  return (
    <div
      title={title}
      // NO `w-full` HERE, deliberately. `cn` is clsx, not tailwind-merge, so a
      // width in the base class does not lose to one passed by a caller — it
      // wins or loses on stylesheet order, and `w-full` beat the header pill's
      // `w-6`, stretched the bar to the button's whole width and pushed the
      // memory half of the pill out of view. Every other caller renders this in
      // a block or flex-column context where a plain div already fills the
      // line, so the base needs no width at all.
      className={cn(
        "relative shrink-0 overflow-hidden rounded-full bg-line",
        HEIGHT[size],
        className,
      )}
    >
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", grow, tone, split && "opacity-30")}
        style={{ width: `${clamp(usedPct)}%` }}
      />
      {split && (
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", grow, tone)}
          style={{ width: `${clamp(sharePct)}%` }}
        />
      )}
    </div>
  );
}

/**
 * The legend swatch for a {@link SplitBar} layer.
 *
 * Shares the bar's three-way vocabulary exactly — solid is our slice, dim is
 * everything else in use, hollow is free — so the legend is read off the
 * picture rather than learned from the words next to it.
 */
export function SplitDot({
  layer,
  tone = "bg-accent",
}: {
  layer: "share" | "other" | "free";
  tone?: string;
}) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        layer === "free" ? "bg-line-strong" : tone,
        layer === "other" && "opacity-30",
      )}
    />
  );
}

const clamp = (p: number) => (Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0);
