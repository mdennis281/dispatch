import { memo, useEffect, useState, type ReactNode } from "react";
import {
  Brain,
  BookOpen,
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
import {
  displayResultText,
  toolPresentation,
  type DispatchToolCategory,
} from "../../../lib/toolPresentations.js";

function toolState(result?: ToolResultRow, task?: TaskStatusRow): ToolDetailState {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  if (!result || (backgrounded && !task)) return "running";
  if (task?.status === "failed" || (!backgrounded && (result.isError || result.ok === false))) {
    return "failed";
  }
  if (task?.status === "stopped") return "stopped";
  return "ok";
}

function categoryIcon(category: DispatchToolCategory): ReactNode {
  if (category === "wait") return <Clock3 />;
  if (category === "pr") return <GitPullRequest />;
  if (category === "terminal") return <SquareTerminal />;
  if (category === "preview") return <MonitorPlay />;
  if (category === "memory") return <Brain />;
  if (category === "config") return <BookOpen />;
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

function promptFor(tool: string, category: DispatchToolCategory): string {
  if (tool === "ask_user") return "ask";
  if (tool === "wait") return "sleep";
  if (tool === "recall") return "recall";
  if (tool === "remember") return "remember";
  if (tool === "forget") return "forget";
  if (category === "memory") return "memory";
  // The prompt names the SUBJECT, not the tool: every one of these edits the
  // guidance a session runs on, and "skill >" is what the reader is looking for.
  if (category === "config") return "skill";
  if (category === "pr") return "pr";
  if (category === "preview") return "app";
  if (category === "terminal") return "terminal";
  if (category === "chat") return "context";
  return "mcp";
}

function promptColor(category: DispatchToolCategory): string {
  if (category === "wait") return "text-warn";
  if (category === "pr") return "text-info-hi";
  if (category === "memory") return "text-accent-2-hi";
  if (category === "config") return "text-accent-2-hi";
  if (category === "preview") return "text-success";
  if (category === "chat") return "text-accent-hi";
  return "text-secondary";
}

function progressColor(category: DispatchToolCategory): string {
  if (category === "wait") return "bg-warn";
  if (category === "pr") return "bg-info";
  if (category === "memory") return "bg-accent-2";
  if (category === "config") return "bg-accent-2";
  if (category === "preview") return "bg-success";
  if (category === "chat") return "bg-accent";
  return "bg-line-strong";
}

function textInput(use: ToolUseRow, key: string): string | undefined {
  const value = use.input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function commandPreview(use: ToolUseRow, tool: string, subject: string | undefined, activity: string): string {
  if (tool === "recall" || tool === "memory_search") {
    return textInput(use, "query") ?? subject ?? "search";
  }
  if (tool === "remember") return textInput(use, "name") ?? subject ?? "save memory";
  if (tool === "forget") return textInput(use, "name") ?? subject ?? "remove memory";
  if (tool === "memory_list") return "list";
  if (tool === "create_pr") return `open ${textInput(use, "title") ?? subject ?? "pull request"}`;
  if (tool === "watch_pr") return `watch ${subject ?? "pull request"}`;
  if (tool === "approve_pr") return `merge ${subject ?? "pull request"}`;
  if (tool === "resolve_thread") return `resolve ${subject ?? "review thread"}`;
  if (tool === "request_review") return `request review${subject ? ` for ${subject}` : ""}`;
  if (tool === "post_review") return `review ${subject ?? "pull request"}`;
  if (tool === "run_subapp") return `${use.input.stop === true ? "stop" : "start"} ${subject ?? "app"}`;
  if (tool === "terminal_output") return `read ${subject ?? "terminal"}`;
  return subject ?? activity;
}

function sleepDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return minutes > 0 ? `${minutes} min ${remainder} sec` : `${remainder} sec`;
}

export const DispatchToolCard = memo(function DispatchToolCard({
  use,
  result,
  task,
  embedded = false,
}: {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
  embedded?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = toolPresentation(use);
  if (!presentation || presentation.kind !== "dispatch") return null;

  const state = toolState(result, task);
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  const elapsed = task?.durationMs ?? (backgrounded ? undefined : result?.durationMs);
  const countdown = useCountdown(use.ts, presentation.countdownSeconds, state === "running");
  const sleep = presentation.tool === "wait" && presentation.countdownSeconds !== undefined;
  const response = sleep && result
    ? `waited for ${sleepDuration(presentation.countdownSeconds!)}`
    : result
      ? displayResultText(result.content) || "No response body"
      : presentation.subject
        ? `${presentation.activity} · ${presentation.subject}`
        : presentation.activity;
  const request = safeJson(use.input);
  const requestPreview = commandPreview(use, presentation.tool, presentation.subject, presentation.activity);
  const clipped = Boolean(use.inputOmitted) || Boolean(result?.contentOmitted);
  const progress = presentation.countdownSeconds && countdown !== null
    ? Math.max(
        0,
        Math.min(
          100,
          ((presentation.countdownSeconds - countdown) / presentation.countdownSeconds) * 100,
        ),
      )
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

  const tone = state === "running"
    ? "accent"
    : state === "failed"
      ? "danger"
      : state === "ok"
        ? "success"
        : "muted";
  const statusLabel = sleep && countdown !== null
    ? "sleeping"
    : countdown !== null
      ? `${countdown}s`
      : state === "running"
        ? "working"
        : state;
  const prompt = promptFor(presentation.tool, presentation.category);
  const promptClass = promptColor(presentation.category);
  const sleepText = countdown !== null
    ? `${countdown}s`
    : sleep
      ? `waited for ${sleepDuration(presentation.countdownSeconds!)}`
      : null;
  const cardTitle = sleep ? "Sleep" : presentation.title;

  return (
    <RowShell
      className={cn(embedded && "!gap-0 !p-0 [&>div:first-child]:hidden")}
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          {categoryIcon(presentation.category)}
        </span>
      }
    >
      <div
        className={cn(
          "overflow-hidden rounded-md border border-line bg-panel-2/60",
          embedded && "!rounded-none !border-0 !bg-transparent",
        )}
      >
        {!embedded && <div className="flex h-8 items-center gap-2 px-2.5">
          <span className="text-sm font-semibold text-primary">{cardTitle}</span>
          {presentation.subject && <Chip tone="info" mono>{presentation.subject}</Chip>}
          <span className="ml-auto">
            <Chip tone={tone} icon={<StateMark state={state} />}>{statusLabel}</Chip>
          </span>
        </div>}
        {progress !== null && (
          <div className="h-0.5 bg-line-soft">
            <div
              className={cn(
                "h-full transition-[width] duration-300 ease-linear",
                progressColor(presentation.category),
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        <div
          className={cn(
            "group/exchange transition-colors hover:bg-hover/20",
            !embedded && "border-t border-line-soft",
          )}
        >
          {sleep ? (
            <Button
              type="button"
              variant="ghost"
              onClick={inspect}
              className="group/sleep !flex !h-6 w-full min-w-0 justify-start !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
            >
              <span className={cn("mr-2 shrink-0 cm-mono !text-xs font-semibold", promptClass)}>
                {prompt} &gt;
              </span>
              <span className="cm-mono !text-xs text-secondary opacity-80 transition-[filter,opacity] group-hover/sleep:brightness-125 group-hover/sleep:opacity-100">
                {sleepText}
              </span>
              <span className="ml-auto"><StateMark state={state} /></span>
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={inspect}
                className="group/send !flex !h-6 w-full min-w-0 justify-start !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
              >
                <span className={cn("mr-2 shrink-0 cm-mono !text-xs font-semibold", promptClass)}>
                  {prompt} &gt;
                </span>
                <OverflowTooltip
                  text={requestPreview}
                  className="min-w-0 flex-1 truncate cm-mono !text-xs text-secondary opacity-80 transition-[filter,opacity] group-hover/send:brightness-125 group-hover/send:opacity-100"
                />
                {state === "running" && <Spinner size={9} className="ml-2 shrink-0" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={inspect}
                className="group/receipt !grid !h-auto min-h-0 w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 !whitespace-normal !rounded-none !border-0 px-2.5 py-0.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
              >
                <OverflowTooltip
                  text={response}
                  lines={2}
                  className={cn(
                    "whitespace-pre-wrap text-xs leading-[1.35] text-muted opacity-75 transition-[color,filter,opacity] group-hover/receipt:brightness-125 group-hover/receipt:text-primary group-hover/receipt:opacity-100",
                    state === "running" && "italic text-faint",
                    state === "failed" && "text-danger",
                  )}
                />
                <span className="flex min-w-12 items-center justify-end gap-1.5 pt-px cm-mono !text-2xs text-faint [&_svg]:size-3">
                  {elapsed !== undefined && <span>{dur(elapsed)}</span>}
                  <StateMark state={state} />
                </span>
              </Button>
            </>
          )}
        </div>
      </div>

      <ToolDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={cardTitle}
        description={presentation.subject ?? "MCP exchange"}
        icon={categoryIcon(presentation.category)}
        state={state}
        duration={dur(elapsed)}
        request={request}
        requestLabel="Arguments"
        response={sleepText ?? response}
        responseLabel="Response"
        responseBody={
          <Markdown className="!text-sm !text-secondary">{sleepText ?? response}</Markdown>
        }
      />
    </RowShell>
  );
});
