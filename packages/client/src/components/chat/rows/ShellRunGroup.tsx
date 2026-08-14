import { memo, useMemo, useState } from "react";
import { Check, ChevronRight, Circle, SquareTerminal, X } from "lucide-react";
import type { TaskStatusRow, ToolResultRow, ToolUseRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { CodeBlock, InlineCode } from "../CodeBlock.js";
import { Chip } from "../../ui/Chip.js";
import { Button } from "../../ui/Button.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { dur } from "../../../lib/format.js";
import { ackTaskId } from "../../../lib/subagentRuns.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { resultPreview, resultText, toolPresentation } from "../../../lib/toolPresentations.js";

export interface ShellRunEntry {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}

type EntryState = "running" | "failed" | "stopped" | "ok";

function entryState({ result, task }: ShellRunEntry): EntryState {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  if (!result || (backgrounded && !task)) return "running";
  if (task?.status === "failed" || (!backgrounded && (result.isError || result.ok === false))) {
    return "failed";
  }
  if (task?.status === "stopped") return "stopped";
  return "ok";
}

function StateIcon({ state }: { state: EntryState }) {
  if (state === "running") return <Spinner size={11} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

function ShellCommandRow({ entry, index, grouped }: { entry: ShellRunEntry; index: number; grouped: boolean }) {
  const [open, setOpen] = useState(false);
  const presentation = toolPresentation(entry.use);
  if (!presentation || presentation.kind !== "shell") return null;

  const state = entryState(entry);
  const backgrounded = !!entry.result && (!!entry.task || !!ackTaskId(entry.result));
  const elapsed = entry.task?.durationMs ?? (backgrounded ? undefined : entry.result?.durationMs);
  const output = state === "running" ? "Running…" : resultPreview(entry.result?.content);
  const clipped = Boolean(entry.use.inputOmitted) || Boolean(entry.result?.contentOmitted);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || !clipped) return;
    const ids: string[] = [];
    if (entry.use.inputOmitted) ids.push(entry.use.id);
    if (entry.result?.contentOmitted) ids.push(entry.result.id);
    void hydrateFullRows(entry.use.chatId, ids);
  };

  return (
    <div data-row-id={entry.use.id} className="border-t border-line-soft first:border-t-0">
      <Button
        type="button"
        variant="ghost"
        onClick={toggle}
        aria-expanded={open}
        className="!grid !h-auto w-full grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_auto] items-center gap-2 !rounded-none !border-0 px-2.5 py-1.5 text-left !font-normal hover:bg-hover active:translate-y-0"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight
            className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
          <span className="w-3 shrink-0 text-right cm-mono !text-2xs text-faint">
            {grouped ? index + 1 : "$"}
          </span>
          <span className="min-w-0 flex-1 !text-xs">
            <InlineCode code={presentation.command} language={presentation.language} />
          </span>
        </span>
        <span
          className={cn(
            "min-w-0 truncate border-l border-line-soft pl-2 cm-mono !text-2xs",
            state === "failed" ? "text-danger" : state === "running" ? "text-accent" : "text-muted",
          )}
          title={output}
        >
          <span className="mr-1 select-none text-faint">↳</span>{output}
        </span>
        <span className="flex min-w-12 shrink-0 items-center justify-end gap-1.5 cm-mono !text-2xs text-faint [&_svg]:size-3">
          {elapsed !== undefined && <span>{dur(elapsed)}</span>}
          <StateIcon state={state} />
        </span>
      </Button>

      {open && (
        <div className="cm-anim-rise space-y-2 border-t border-line-soft bg-inset/50 px-3 py-2.5">
          <CodeBlock
            code={presentation.command}
            language={presentation.language}
            filename={presentation.terminal ? `${presentation.terminal} terminal` : undefined}
            className="!my-0"
          />
          <div>
            <div className="mb-1 flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
              Output
              {entry.result?.contentOmitted && <span className="font-normal normal-case tracking-normal">preview</span>}
            </div>
            <pre
              className={cn(
                "cm-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[5px] border px-2.5 py-2 cm-mono !text-xs",
                state === "failed"
                  ? "border-danger-ghost bg-danger-ghost/30 text-secondary"
                  : "border-line-soft bg-panel-2 text-secondary",
              )}
            >
              {entry.result ? (resultText(entry.result.content) || "No output") : "Waiting for output…"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact terminal surface for one or more consecutive handled shell calls. */
export const ShellRunGroup = memo(function ShellRunGroup({ entries }: { entries: ShellRunEntry[] }) {
  const summary = useMemo(() => {
    const states = entries.map(entryState);
    if (states.includes("running")) return { tone: "accent" as const, label: "running", icon: <Spinner size={9} /> };
    if (states.includes("failed")) return { tone: "danger" as const, label: "failed", icon: <X /> };
    if (states.includes("stopped")) return { tone: "muted" as const, label: "stopped", icon: <Circle /> };
    return { tone: "success" as const, label: "ok", icon: <Check /> };
  }, [entries]);
  const terminals = useMemo(
    () => [...new Set(entries.map((entry) => toolPresentation(entry.use)?.terminal).filter(Boolean))],
    [entries],
  );

  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-panel-2 text-secondary ring-1 ring-line [&_svg]:size-3.5">
          <SquareTerminal />
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60 shadow-[inset_0_1px_0_0_var(--p-line-soft)]">
        {entries.length > 1 && (
          <div className="flex h-8 items-center gap-2 px-2.5">
            <span className="text-sm font-semibold text-primary">Shell</span>
            <span className="cm-mono !text-2xs text-faint">{entries.length} commands</span>
            {terminals.length === 1 && <Chip tone="muted" mono>{terminals[0]}</Chip>}
            <span className="ml-auto"><Chip tone={summary.tone} icon={summary.icon}>{summary.label}</Chip></span>
          </div>
        )}
        <div className={cn(entries.length > 1 && "border-t border-line-soft")}>
          {entries.map((entry, index) => (
            <ShellCommandRow
              key={entry.use.id}
              entry={entry}
              index={index}
              grouped={entries.length > 1}
            />
          ))}
        </div>
      </div>
    </RowShell>
  );
});
