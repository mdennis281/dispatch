import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

export type Tone =
  | "neutral"
  | "accent"
  | "success"
  | "warn"
  | "danger"
  | "muted";

const tones: Record<Tone, string> = {
  neutral: "bg-hover text-secondary border-line",
  accent: "bg-accent-ghost text-accent-hi border-accent-line",
  success: "bg-success-ghost text-success border-transparent",
  warn: "bg-warn-ghost text-warn border-transparent",
  danger: "bg-danger-ghost text-danger border-transparent",
  muted: "bg-transparent text-muted border-line-soft",
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  icon?: ReactNode;
  mono?: boolean;
}

/** A compact status/label pill. */
export function Chip({ tone = "neutral", icon, mono, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10.5px] font-medium leading-4",
        mono && "cm-mono !text-[10.5px]",
        tones[tone],
        className,
      )}
      {...rest}
    >
      {icon && <span className="[&_svg]:size-3">{icon}</span>}
      {children}
    </span>
  );
}

/** A small numeric badge (attention count etc). */
export function Badge({ count, tone = "accent" }: { count: number; tone?: Tone }) {
  if (count <= 0) return null;
  // One foreground for all three fills. `-fg` tokens are the ink for a
  // SATURATED fill, and every saturated colour in a given theme shares the same
  // polarity (light fills on dark, dark fills on light) — so the accent's ink
  // is correct on the semantic fills too, and stays correct across a switch.
  // The old `text-white` / `text-black` pair was right in exactly one theme.
  const toneCls =
    tone === "danger"
      ? "bg-danger text-accent-fg"
      : tone === "warn"
        ? "bg-warn text-accent-fg"
        : "bg-accent text-accent-fg";
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
        toneCls,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
