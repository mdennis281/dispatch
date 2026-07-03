import { cn } from "../../lib/cn.js";
import type { ChatStatus } from "@cm/shared";

export type DotTone = "success" | "accent" | "warn" | "danger" | "muted" | "working";

const toneColor: Record<DotTone, string> = {
  success: "bg-success",
  accent: "bg-accent",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-faint",
  working: "bg-accent",
};

export interface StatusDotProps {
  tone: DotTone;
  /** Emit a soft expanding ring (for live/working states). */
  pulse?: boolean;
  size?: number;
  className?: string;
}

/** A single presence dot; optionally pulsing for live states. */
export function StatusDot({ tone, pulse, size = 7, className }: StatusDotProps) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {pulse && (
        <span
          className={cn("absolute inset-0 rounded-full", toneColor[tone], "cm-anim-pulse opacity-60")}
        />
      )}
      <span
        className={cn("relative rounded-full", toneColor[tone])}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

/** Map a chat status to a dot tone + whether it pulses + a label. */
export function statusMeta(status: ChatStatus | undefined): {
  tone: DotTone;
  pulse: boolean;
  label: string;
} {
  switch (status) {
    case "running":
      return { tone: "working", pulse: true, label: "Running" };
    case "awaiting-input":
      return { tone: "warn", pulse: true, label: "Awaiting input" };
    case "queued":
      return { tone: "accent", pulse: false, label: "Queued" };
    case "done":
      return { tone: "success", pulse: false, label: "Done" };
    case "error":
      return { tone: "danger", pulse: false, label: "Error" };
    case "idle":
    default:
      return { tone: "muted", pulse: false, label: "Idle" };
  }
}
