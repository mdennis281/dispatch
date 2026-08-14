import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  Circle,
  Clock3,
  GitPullRequest,
  MessageSquare,
  MonitorPlay,
  PlugZap,
  SquareTerminal,
  X,
} from "lucide-react";
import type { TaskStatusRow, ToolResultRow, ToolUseRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ToolDetailModal, type ToolDetailState } from "../ToolDetailModal.js";
import { Markdown } from "../Markdown.js";
import { Button } from "../../ui/Button.js";
import { Chip } from "../../ui/Chip.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur, safeJson } from "../../../lib/format.js";
import { ackTaskId } from "../../../lib/subagentRuns.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { displayResultText, toolPresentation, type DispatchToolCategory } from "../../../lib/toolPresentations.js";

function toolState(result?: ToolResultRow, task?: TaskStatusRow): ToolDetailState {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  if (!result || (backgrounded && !task)) return "running";
  if (task?.status === "failed" || (!backgrounded && (result.isError || result.ok === false))) return "failed";
  if (task?.status === "stopped") return "stopped";
  return "ok";
}

function categoryIcon(category: DispatchToolCategory): ReactNode {
  if (category === "wait") return <Clock3 />;
  if (category === "pr") return <GitPullRequest />;
  if (category === "terminal") return <SquareTerminal />;
  if (category === "preview") return <MonitorPlay />;
  if (category === "memory") return <Brain />;
  if (category === "chat") return <MessageSquare />;
  return <PlugZap />;
}

function useCountdown(startedAt: number, seconds: number | undefined, running: boolean): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!running || seconds === undefined) {
      setRemaining(null);
      return;
    }
    const deadline = startedAt + seconds * 1_000;
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [running, seconds, startedAt]);
  return remaining;
}

function StateMark({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

export const DispatchToolCard = memo(function DispatchToolCard({
  use,
  result,
  task,
}: {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = toolPresentation(use);
  if (!presentation || presentation.kind !== "dispatch") return null;

  const state = toolState(result, task);
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  const elapsed = task?.durationMs ?? (backgrounded ? undefined : result?.durationMs);
  const countdown = useCountdown(use.ts, presentation.countdownSeconds, state === "running");
  const response = result
    ? displayResultText(result.content) || "No response body"
    : countdown !== null
      ? `${presentation.activity} · ${countdown}s remaining`
      : presentation.subject
        ? `${presentation.activity} · ${presentation.subject}`
        : presentation.activity;
  const request = safeJson(use.input);
  const requestPreview = presentation.countdownSeconds !== undefined
    ? `Pause this run for ${presentation.countdownSeconds}s`
    : presentation.subject
      ? `${presentation.activity} · ${presentation.subject}`
      : presentation.activity;
  const clipped = Boolean(use.inputOmitted) || Boolean(result?.contentOmitted);
  const progress = presentation.countdownSeconds && countdown !== null
    ? Math.max(0, Math.min(100, ((presentation.countdownSeconds - countdown) / presentation.countdownSeconds) * 100))
    : null;

  const inspect = () => {
    if (clipped) {
      const ids: string[] = [];
      if (use.inputOmitted) ids.push(use.id);
      if (result?.contentOmitted) ids.push(result.id);
      void hydrateFullRows(use.chatId, ids);
    }
    setDetailOpen(true);
  };

  const tone = state === "running" ? "accent" : state === "failed" ? "danger" : state === "ok" ? "success" : "muted";
  const statusLabel = countdown !== null ? `${countdown}s` : state === "running" ? "working" : state;

  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          {categoryIcon(presentation.category)}
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex h-8 items-center gap-2 px-2.5">
          <span className="text-sm font-semibold text-primary">{presentation.title}</span>
          {presentation.subject && <Chip tone="info" mono>{presentation.subject}</Chip>}
          <span className="ml-auto"><Chip tone={tone} icon={<StateMark state={state} />}>{statusLabel}</Chip></span>
        </div>
        {progress !== null && (
          <div className="h-0.5 bg-line-soft">
            <div className="h-full bg-accent transition-[width] duration-300 ease-linear" style={{ width: `${progress}%` }} />
          </div>
        )}
        <div className="group/exchange border-t border-line-soft transition-colors hover:bg-hover/35">
          <Button
            type="button"
            variant="ghost"
            onClick={inspect}
            className="group/send !flex !h-8 w-full min-w-0 justify-start !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-active/55 active:translate-y-0"
          >
            <span className="mr-2 shrink-0 text-2xs font-semibold uppercase tracking-[0.07em] text-faint">send</span>
            <OverflowTooltip text={requestPreview} className="min-w-0 flex-1 truncate text-xs text-secondary" />
            {state === "running" && <Spinner size={9} className="ml-2 shrink-0" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={inspect}
            className="group/receipt !grid !h-auto min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 !rounded-none !border-0 px-2.5 py-1.5 text-left !font-normal hover:!bg-active/45 active:translate-y-0"
          >
            <OverflowTooltip
              text={response}
              lines={2}
              className={cn(
                "text-xs leading-[1.45] text-muted transition-colors group-hover/receipt:text-primary",
                state === "running" && "italic text-faint",
                state === "failed" && "text-danger",
              )}
            />
            <span className="flex min-w-12 items-center justify-end gap-1.5 pt-px cm-mono !text-2xs text-faint [&_svg]:size-3">
              {elapsed !== undefined && <span>{dur(elapsed)}</span>}
              <StateMark state={state} />
            </span>
          </Button>
        </div>
      </div>

      <ToolDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={presentation.title}
        description={presentation.subject ?? "MCP exchange"}
        icon={categoryIcon(presentation.category)}
        state={state}
        duration={dur(elapsed)}
        request={request}
        requestLabel="Arguments"
        response={response}
        responseLabel="Response"
        responseBody={<Markdown className="!text-sm !text-secondary">{response}</Markdown>}
      />
    </RowShell>
  );
});
