/**
 * Shared visual vocabulary for subagent runs, so a run reads identically in the
 * transcript card, the Agents rail and the inspector: one status colour, one
 * glyph, one progress rail.
 */
import { Bot, Check, X, Square } from "lucide-react";
import type { RunStatus, SubagentRun } from "../../lib/subagentRuns.js";
import type { DotTone } from "../ui/StatusDot.js";
import { StatusDot } from "../ui/StatusDot.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";

/** Dot tone per run status (accent = live, matching the chat's own convention). */
export function runTone(status: RunStatus): DotTone {
  if (status === "running") return "accent";
  if (status === "failed") return "danger";
  // Stopped isn't a failure — it just never got to finish.
  if (status === "stopped") return "muted";
  return "success";
}

export function runStatusLabel(status: RunStatus): string {
  return status;
}

/** The status pill used in every run header. */
export function RunStatusChip({ status }: { status: RunStatus }) {
  if (status === "running") {
    return (
      <Chip tone="accent" icon={<Spinner size={9} />}>
        running
      </Chip>
    );
  }
  if (status === "failed") {
    return (
      <Chip tone="danger" icon={<X />}>
        failed
      </Chip>
    );
  }
  if (status === "stopped") {
    return (
      <Chip tone="muted" icon={<Square />}>
        stopped
      </Chip>
    );
  }
  return (
    <Chip tone="success" icon={<Check />}>
      done
    </Chip>
  );
}

/** The subagent avatar — accent-tinted while live, quiet once finished. */
export function AgentGlyph({
  status,
  size = 6,
  className,
}: {
  status: RunStatus;
  size?: 5 | 6 | 7;
  className?: string;
}) {
  const box = size === 5 ? "size-5" : size === 7 ? "size-7" : "size-6";
  const svg = size === 5 ? "[&_svg]:size-3" : "[&_svg]:size-3.5";
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-md ring-1",
        box,
        svg,
        status === "failed"
          ? "bg-danger-ghost/50 text-danger ring-danger-ghost"
          : status === "stopped"
            ? "bg-panel-2 text-muted ring-line"
            : "bg-accent-ghost text-accent-hi ring-accent-line",
        className,
      )}
    >
      <Bot />
    </span>
  );
}

/**
 * A compact bar of the run's steps — one tick per step, coloured by outcome.
 * Reads as "shape of the run" at a glance: how long, how much failed, where it
 * is now. Ticks are capped so a 200-step run stays one line.
 */
export function RunProgressRail({
  run,
  max = 28,
  className,
}: {
  run: SubagentRun;
  max?: number;
  className?: string;
}) {
  if (run.steps.length === 0) {
    return (
      <div className={cn("flex h-1 gap-px", className)}>
        <span className="h-full w-6 rounded-full bg-line" />
      </div>
    );
  }
  // Keep the TAIL: on a live run the recent steps are the interesting ones.
  const shown = run.steps.slice(-max);
  return (
    // Ticks are CAPPED and left-aligned, never stretched to fill: a 3-step run
    // must read as "three steps", not as a progress bar sitting at 33%.
    <div className={cn("flex h-1 items-stretch gap-px", className)} aria-hidden>
      {shown.map((step) => {
        const failed =
          step.kind !== "message" &&
          (step.result?.isError || step.result?.ok === false);
        const pending = step.kind !== "message" && step.pending;
        return (
          <span
            key={step.id}
            className={cn(
              "h-full min-w-[2px] max-w-[7px] flex-1 rounded-full",
              failed
                ? "bg-danger"
                : pending
                  ? "bg-accent cm-anim-pulse"
                  : step.kind === "message"
                    ? "bg-line-strong"
                    : "bg-accent/60",
            )}
          />
        );
      })}
    </div>
  );
}

/** Live dot + label pair used in list rows. */
export function RunStatusDot({ status }: { status: RunStatus }) {
  return <StatusDot tone={runTone(status)} pulse={status === "running"} size={7} />;
}
