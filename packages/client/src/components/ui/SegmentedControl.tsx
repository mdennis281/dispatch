import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}

/** A compact inset segmented toggle (mode switch: plan / auto / edit). */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  size = "sm",
  className,
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
        return (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-[5px] px-2 text-[11.5px] font-medium " +
                "transition-colors duration-150 ease-[var(--ease-out)] [&_svg]:size-3",
              h,
              active
                ? "bg-panel-2 text-primary shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] border border-line"
                : "border border-transparent text-muted hover:text-secondary",
            )}
          >
            {s.icon}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
