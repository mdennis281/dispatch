import { cn } from "../../lib/cn.js";
import type { ChatStatus } from "@dispatch/shared";

export type DotTone =
  | "success"
  | "accent"
  | "info"
  | "warn"
  | "danger"
  | "muted"
  | "working";

const toneColor: Record<DotTone, string> = {
  success: "bg-success",
  accent: "bg-accent",
  info: "bg-info",
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
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full transition-colors duration-300",
            toneColor[tone],
            "cm-anim-pulse opacity-60",
          )}
        />
      )}
      <span
        className={cn("relative rounded-full transition-colors duration-300", toneColor[tone])}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

/**
 * Map a chat status to a dot tone + whether it pulses + a label.
 *
 * `prSettled` = a `watch_pr` on this chat ran to a terminal PR state and hasn't
 * been superseded by a new message; on an otherwise-idle chat it flips the dot
 * from neutral gray to green ("PR done"). It's ignored for any active status
 * (running still pulses purple), so the green only shows once the agent is quiet.
 */
export function statusMeta(
  status: ChatStatus | undefined,
  prSettled = false,
): {
  tone: DotTone;
  pulse: boolean;
  label: string;
} {
  if (status === "idle" && prSettled) {
    return { tone: "success", pulse: false, label: "PR done" };
  }
  switch (status) {
    case "running":
      return { tone: "working", pulse: true, label: "Running" };
    case "waiting":
      return { tone: "info", pulse: true, label: "Waiting" };
    case "awaiting-input":
      return { tone: "warn", pulse: true, label: "Awaiting input" };
    case "queued":
      return { tone: "accent", pulse: false, label: "Queued" };
    case "done":
      return { tone: "success", pulse: false, label: "Done" };
    case "failed":
      return { tone: "danger", pulse: false, label: "Failed" };
    case "error":
      return { tone: "danger", pulse: false, label: "Error" };
    case "idle":
    default:
      return { tone: "muted", pulse: false, label: "Idle" };
  }
}
