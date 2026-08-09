/**
 * Shared visual vocabulary for subagent runs, so a run reads identically in the
 * transcript card, the Agents rail and the inspector: one status colour, one
 * glyph, one progress rail.
 */
import { Bot, Check, X, Square } from "lucide-react";
import type { Effort } from "@dispatch/shared";
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

/* ------------------------------------------------------------------ effort */

/** The effort ladder, low → max. Index = how many bars the meter fills. */
export const EFFORT_LADDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * A five-tick meter for a reasoning-effort level.
 *
 * Effort is ordinal, so it reads far faster as a filled ladder than as a word —
 * and next to a run's agent + model it answers "how hard is this thing thinking"
 * without the eye having to parse text. Accent from `high` up, quiet below, so a
 * rail of runs shows the expensive ones at a glance.
 */
export function EffortMeter({ effort, className }: { effort: Effort; className?: string }) {
  const filled = EFFORT_LADDER.indexOf(effort) + 1;
  const loud = filled >= 3;
  return (
    <span className={cn("inline-flex items-end gap-px", className)} aria-hidden>
      {EFFORT_LADDER.map((level, i) => (
        <span
          key={level}
          className={cn(
            "w-[2px] rounded-[1px]",
            i < filled ? (loud ? "bg-accent" : "bg-muted") : "bg-line-strong",
          )}
          // A ladder, not a bar chart: each tick is taller than the last.
          style={{ height: `${3 + i * 1.5}px` }}
        />
      ))}
    </span>
  );
}

/**
 * The effort a thread ran at. `source` distinguishes a level the runtime
 * reported from the chat's own pick, because a subagent CAN differ from its
 * parent — an agent definition may pin its own, and a model that doesn't support
 * the requested level is silently downgraded.
 */
export function EffortChip({
  effort,
  label = "effort",
  className,
}: {
  effort: Effort;
  label?: string;
  className?: string;
}) {
  return (
    <Chip
      tone="muted"
      icon={<EffortMeter effort={effort} />}
      className={cn("shrink-0", className)}
      title={`${label}: ${effort}`}
    >
      {effort}
    </Chip>
  );
}

/**
 * WHO ran and HOW: agent type, model, effort — the three facts that differ
 * between a run and the chat that spawned it. Shared so the transcript card, the
 * rail and the inspector never drift apart on what a run "is".
 */
export function RunIdentity({
  run,
  className,
  showAgent = true,
}: {
  run: SubagentRun;
  className?: string;
  showAgent?: boolean;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {showAgent && (
        <Chip tone="agent" className="shrink-0">
          {run.agentType}
        </Chip>
      )}
      {run.model && (
        <Chip tone="muted" mono className="hidden shrink-0 sm:inline-flex" title="model">
          {run.model}
        </Chip>
      )}
      {run.effort && <EffortChip effort={run.effort} label="ran at effort" />}
    </span>
  );
}

/** Live dot + label pair used in list rows. */
export function RunStatusDot({ status }: { status: RunStatus }) {
  return <StatusDot tone={runTone(status)} pulse={status === "running"} size={7} />;
}
