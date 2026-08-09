import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Tooltip } from "./Tooltip.js";

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /**
   * Trailing slot, for a count that must stay visible while the segment is
   * UNSELECTED — the whole reason a grouped strip is safe to collapse is that
   * the group you can't see can still say it wants you.
   */
  badge?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
  /** Icon-only rendering; the label moves into a hover tooltip. */
  compact?: boolean;
}

/** A compact inset segmented toggle (mode switch: plan / auto / edit). */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  size = "sm",
  className,
  compact = false,
}: SegmentedControlProps<T>) {
  const h = size === "sm" ? "h-6" : "h-7";
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-inset p-0.5",
        className,
      )}
    >
      {segments.map((s) => {
        const active = s.value === value;
        const btn = (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            aria-label={compact ? s.label : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded-[5px] text-[11.5px] font-medium " +
                "transition-colors duration-150 ease-[var(--ease-out)] [&_svg]:size-3",
              compact ? "justify-center px-1.5" : "px-2",
              h,
              active
                ? "bg-panel-2 text-primary shadow-[inset_0_1px_0_0_var(--p-sheen-soft)] border border-line"
                : "border border-transparent text-muted hover:text-secondary",
            )}
          >
            {s.icon}
            {!compact && s.label}
            {s.badge}
          </button>
        );
        return compact ? (
          <Tooltip key={s.value} label={s.label}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
