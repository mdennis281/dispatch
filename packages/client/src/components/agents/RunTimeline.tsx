/**
 * The inspector's left rail: every step of a run as a vertical timeline.
 *
 * One row per tool call / assistant turn / nested spawn, with a connector line
 * so a long run reads as a single thread. Clicking a step focuses it in the
 * stream on the right. The live step pulses and stays scrolled into view.
 */
import { useEffect, useRef } from "react";
import { Bot, MessageSquare } from "lucide-react";
import type { RunStep, SubagentRun } from "../../lib/subagentRuns.js";
import { runDuration, toolDetail } from "../../lib/subagentRuns.js";
import { toolIcon } from "../chat/toolIcon.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { toolLabel } from "../../lib/format.js";

/** Title + detail line for one step. */
function stepLabels(step: RunStep): { title: string; detail?: string } {
  if (step.kind === "message") {
    return { title: "Message", detail: step.row.text.split("\n").find((l) => l.trim()) };
  }
  if (step.kind === "subagent") {
    const type =
      typeof step.use.input.subagent_type === "string"
        ? step.use.input.subagent_type
        : "subagent";
    const desc = step.use.input.description;
    return { title: type, detail: typeof desc === "string" ? desc : undefined };
  }
  return { title: toolLabel(step.use.name), detail: toolDetail(step.use) };
}

function StepRow({
  step,
  active,
  last,
  onClick,
}: {
  step: RunStep;
  active: boolean;
  last: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pending = step.kind !== "message" && step.pending;
  const failed =
    step.kind !== "message" && (step.result?.isError || step.result?.ok === false);
  const { title, detail } = stepLabels(step);

  // Follow the live step so a long run doesn't leave the reader behind.
  useEffect(() => {
    if (pending) ref.current?.scrollIntoView({ block: "nearest" });
  }, [pending]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      className={cn(
        "group/step relative flex w-full items-start gap-2.5 rounded-[5px] py-1 pl-1 pr-2 text-left transition-colors",
        active ? "bg-accent-ghost/60" : "hover:bg-white/[0.04]",
      )}
    >
      {/* connector + node */}
      <span className="relative flex w-4 shrink-0 justify-center pt-[3px]">
        {!last && (
          <span className="absolute left-1/2 top-[15px] h-[calc(100%+4px)] w-px -translate-x-1/2 bg-line" />
        )}
        <span
          className={cn(
            "relative z-10 flex size-3.5 items-center justify-center rounded-full ring-2 ring-panel [&_svg]:size-2.5",
            failed
              ? "bg-danger/20 text-danger"
              : pending
                ? "bg-accent/20 text-accent-hi"
                : step.kind === "message"
                  ? "bg-panel-2 text-muted"
                  : "bg-panel-2 text-secondary",
          )}
        >
          {pending ? (
            <Spinner size={9} />
          ) : step.kind === "message" ? (
            <MessageSquare />
          ) : step.kind === "subagent" ? (
            <Bot />
          ) : (
            toolIcon(step.use.name)
          )}
        </span>
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "truncate text-[11.5px] font-medium",
              failed ? "text-danger" : active ? "text-primary" : "text-secondary",
            )}
          >
            {title}
          </span>
          {step.kind === "tool" && step.durationMs !== undefined && (
            <span className="ml-auto shrink-0 cm-mono !text-[9.5px] text-faint">
              {runDuration(step.durationMs)}
            </span>
          )}
        </span>
        {detail && (
          <span className="mt-px block truncate cm-mono !text-[10px] text-faint">
            {detail}
          </span>
        )}
      </span>
    </button>
  );
}

export function RunTimeline({
  run,
  focusStepId,
  onFocusStep,
}: {
  run: SubagentRun;
  focusStepId: string | null;
  onFocusStep: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-px p-2">
      <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
        Timeline
      </div>
      {run.steps.length === 0 ? (
        <p className="px-1 py-2 text-[11.5px] text-faint">
          {run.status === "running" ? "Starting up…" : "No recorded steps."}
        </p>
      ) : (
        run.steps.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            active={focusStepId === step.id}
            last={i === run.steps.length - 1}
            onClick={() => onFocusStep(step.id)}
          />
        ))
      )}
    </div>
  );
}
