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

/**
 * Every tone's classes, dot and glyph TOGETHER — a status marker is a dot on
 * most rows but a glyph on a chat spawned for a job (it wears that job's icon),
 * and a status that reads green as a dot must read green as an icon or the
 * sidebar has two conflicting colour languages. One entry per tone means the two
 * can't be recoloured independently.
 *
 * The class names are spelled out rather than built from a family name because
 * Tailwind scans source for LITERAL candidates: a `bg-${family}` template
 * compiles to no CSS at all, and the failure is an invisible transparent dot.
 */
const toneClass: Record<DotTone, { bg: string; text: string }> = {
  success: { bg: "bg-success", text: "text-success" },
  accent: { bg: "bg-accent", text: "text-accent" },
  info: { bg: "bg-info", text: "text-info" },
  warn: { bg: "bg-warn", text: "text-warn" },
  danger: { bg: "bg-danger", text: "text-danger" },
  muted: { bg: "bg-faint", text: "text-faint" },
  working: { bg: "bg-accent", text: "text-accent" },
};

/** Exposed for the test that holds the dot and glyph halves of a tone together. */
export const TONE_CLASS = toneClass;

/** A tone's foreground class, for a status marker rendered as an icon. */
export function toneText(tone: DotTone): string {
  return toneClass[tone].text;
}

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
            toneClass[tone].bg,
            "cm-anim-pulse opacity-60",
          )}
        />
      )}
      <span
        className={cn("relative rounded-full transition-colors duration-300", toneClass[tone].bg)}
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
