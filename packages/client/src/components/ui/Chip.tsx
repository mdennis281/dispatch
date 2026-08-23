import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.js";

/**
 * A chip's tone says what KIND of thing it is, and each one owns exactly one
 * meaning. `accent` used to own six — selected, merged, PR number, custom
 * agent, live, brand — which read as mush in the old indigo and shouts in the
 * brand amber, because amber is the one colour the eye goes to first. So:
 *
 *   accent  — amber. Live and yours: this is happening NOW, or it's the thing
 *             you have selected. Rare on purpose; if half the row is amber,
 *             none of it is.
 *   agent   — violet. Something the machine did on your behalf: a subagent, an
 *             MCP tool server, context Dispatch attached for you.
 *   info    — blue. Cool metadata that is true rather than urgent: branch
 *             names, PR numbers, refs, profiles, ports.
 *   success / warn / danger — outcomes.
 *   neutral / muted — no semantic claim at all.
 */
export type Tone =
  | "neutral"
  | "accent"
  | "agent"
  | "info"
  | "success"
  | "warn"
  | "danger"
  | "muted";

const tones: Record<Tone, string> = {
  neutral: "bg-hover text-secondary border-line",
  accent: "bg-accent-ghost text-accent-hi border-accent-line",
  agent: "bg-accent-2-ghost text-accent-2-hi border-accent-2-line",
  info: "bg-info-ghost text-info-hi border-info-line",
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
        "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-2xs font-medium leading-4",
        mono && "cm-mono !text-2xs",
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

/**
 * A small numeric badge (attention count etc).
 *
 * `size="sm"` is for a badge PINNED TO A GLYPH rather than sitting beside a
 * label: at the default 16px it is as wide as a 16px icon, so anchoring one to
 * an icon's corner covers the icon instead of annotating it. 13px leaves the
 * glyph readable underneath. Still `text-2xs`, which is the smallest step on the
 * scale — the box shrinks, the digits don't, because 10px is already the floor
 * for something meant to be read at a glance.
 */
export function Badge({
  count,
  tone = "accent",
  size = "md",
}: {
  count: number;
  tone?: Tone;
  size?: "md" | "sm";
}) {
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
        : tone === "agent"
          ? "bg-accent-2 text-accent-2-fg"
          : tone === "info"
            ? "bg-info text-accent-fg"
            : "bg-accent text-accent-fg";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full text-2xs font-semibold tabular-nums",
        size === "sm" ? "h-[13px] min-w-[13px] px-[3px]" : "h-4 min-w-4 px-1",
        toneCls,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
