import { memo, useMemo, useState } from "react";
import { Check, Circle, SlidersHorizontal, SquareTerminal, X } from "lucide-react";
import type { TaskStatusRow, ToolResultRow, ToolUseRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ResultMediaStrip } from "./ResultMediaStrip.js";
import { InlineCode } from "../CodeBlock.js";
import { ToolDetailModal, type ToolDetailState } from "../ToolDetailModal.js";
import { DispatchToolCard } from "./DispatchToolCard.js";
import { Chip } from "../../ui/Chip.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Spinner } from "../../ui/Spinner.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { cn } from "../../../lib/cn.js";
import { dur } from "../../../lib/format.js";
import { ackTaskId } from "../../../lib/subagentRuns.js";
import { toolCallState } from "../../../lib/toolState.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { displayResultText, shellGroupPresentation } from "../../../lib/toolPresentations.js";
import {
  SHELL_FILTER_OPTIONS,
  presentationFilterCategory,
  useShellFilter,
} from "../../../lib/shellFilter.js";
import { ShellFilterModal } from "../ShellFilterModal.js";

export interface ShellRunEntry {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}

function entryState({ result, task }: ShellRunEntry): ToolDetailState {
  return toolCallState(result, task);
}

function StateIcon({ state }: { state: ToolDetailState }) {
  if (state === "running") return <Spinner size={10} />;
  if (state === "failed") return <X className="text-danger" />;
  if (state === "stopped") return <Circle className="text-muted" />;
  return <Check className="text-success" />;
}

function shellLabel(language: "bash" | "powershell", short = false): string {
  if (language === "powershell") return short ? "ps" : "PowerShell";
  return short ? "bash" : "Bash";
}

function ShellCommandPair({ entry }: { entry: ShellRunEntry }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = shellGroupPresentation(entry.use);
  if (!presentation || presentation.kind !== "shell") return null;

  const state = entryState(entry);
  const backgrounded = !!entry.result && (!!entry.task || !!ackTaskId(entry.result));
  const elapsed = entry.task?.durationMs ?? (backgrounded ? undefined : entry.result?.durationMs);
  const output = entry.result
    ? displayResultText(entry.result.content) || "No output"
    : state === "running"
      ? "Waiting for output…"
      : "No output";
  const clipped = Boolean(entry.use.inputOmitted) || Boolean(entry.result?.contentOmitted);

  const inspect = () => {
    if (clipped) {
      const ids: string[] = [];
      if (entry.use.inputOmitted) ids.push(entry.use.id);
      if (entry.result?.contentOmitted) ids.push(entry.result.id);
      void hydrateFullRows(entry.use.chatId, ids);
    }
    setDetailOpen(true);
  };

  return (
    <div
      data-row-id={entry.use.id}
      className="group/pair transition-colors duration-150 hover:bg-hover/20"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={inspect}
        className="group/send !flex !h-6 w-full min-w-0 justify-start gap-0 !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-transparent active:translate-y-0"
      >
        <span className="mr-2 shrink-0 cm-mono !text-xs font-semibold text-accent-hi">
          {shellLabel(presentation.language, true)} &gt;
        </span>
        <OverflowTooltip text={presentation.command} className="min-w-0 flex-1 !text-xs">
          <span className="block min-w-0 opacity-80 transition-[filter,opacity] duration-150 group-hover/send:brightness-125 group-hover/send:opacity-100 group-focus/send:brightness-125 group-focus/send:opacity-100">
            <InlineCode code={presentation.command} language={presentation.language} />
          </span>
        </OverflowTooltip>
      </Button>

      <Button
        type="button"
        variant="ghost"
        onClick={inspect}
        className="group/receipt !grid !h-auto min-h-0 w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 !whitespace-normal !rounded-none !border-0 px-2.5 py-0.5 text-left !font-normal text-muted hover:!bg-transparent hover:text-secondary active:translate-y-0"
      >
        <span className="flex min-w-0 items-start gap-1.5">
          <OverflowTooltip
            text={output}
            lines={2}
            className={cn(
              "min-w-0 flex-1 whitespace-pre-wrap cm-mono !text-2xs leading-[1.35] opacity-75 transition-[color,opacity] duration-150 group-hover/receipt:text-primary group-hover/receipt:opacity-100 group-focus/receipt:text-primary group-focus/receipt:opacity-100",
              state === "running" && "italic text-faint",
              state === "failed" && "text-danger",
            )}
          />
          {state === "running" && <Spinner size={9} className="mt-0.5 shrink-0" />}
        </span>
        {state !== "running" && (
          <span className="flex min-w-12 items-center justify-end gap-1.5 pt-px cm-mono !text-2xs text-faint [&_svg]:size-3">
            {elapsed !== undefined && <span>{dur(elapsed)}</span>}
            <StateIcon state={state} />
          </span>
        )}
      </Button>

      <ToolDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title="Shell exchange"
        description={presentation.terminal ? `${presentation.terminal} terminal` : `${shellLabel(presentation.language)} session`}
        state={state}
        duration={dur(elapsed)}
        request={presentation.command}
        requestLabel="Input"
        response={output}
        responseLabel="Output"
        language={presentation.language}
      />
    </div>
  );
}

/** A compact terminal transcript: prompt/input followed by its unprefixed receipt. */
export const ShellRunGroup = memo(function ShellRunGroup({
  entries,
  active = false,
}: {
  entries: ShellRunEntry[];
  active?: boolean;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const chatId = entries[0]?.use.chatId ?? "";
  const filter = useShellFilter(chatId);
  const enabled = useMemo(() => new Set(filter.enabled), [filter.enabled]);
  const summary = useMemo(() => {
    const states = entries.map(entryState);
    if (states.includes("running")) return { tone: "accent" as const, label: "running", icon: <Spinner size={9} /> };
    if (states.includes("failed")) return { tone: "danger" as const, label: "failed", icon: <X /> };
    if (states.includes("stopped")) return { tone: "muted" as const, label: "stopped", icon: <Circle /> };
    return { tone: "success" as const, label: "ok", icon: <Check /> };
  }, [entries]);
  const terminals = useMemo(
    () => [...new Set(entries.map((entry) => {
      const presentation = shellGroupPresentation(entry.use);
      return presentation?.kind === "shell" ? presentation.terminal : undefined;
    }).filter(Boolean))],
    [entries],
  );
  const languages = useMemo(
    () => [...new Set(entries.map((entry) => {
      const presentation = shellGroupPresentation(entry.use);
      return presentation?.kind === "shell" ? presentation.language : undefined;
    }).filter((language): language is "bash" | "powershell" => Boolean(language)))],
    [entries],
  );
  const activeLanguage = languages[languages.length - 1] ?? "bash";
  const headerLabel = languages.length === 1 ? shellLabel(activeLanguage) : "Shell";
  const visibleEntries = entries.filter((entry) => {
    const presentation = shellGroupPresentation(entry.use);
    return presentation ? enabled.has(presentationFilterCategory(presentation)) : true;
  });
  const collapseGroup = !active && visibleEntries.length === 0;

  return (
    <>
      <div className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out)]",
        collapseGroup ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}>
        <div className="min-h-0 overflow-hidden">
          <RowShell
            gutter={
              <span className="flex size-6 items-center justify-center rounded-md bg-inset text-secondary ring-1 ring-line [&_svg]:size-3.5">
                <SquareTerminal />
              </span>
            }
          >
            <div className="overflow-hidden rounded-md border border-line bg-inset shadow-[inset_0_1px_0_0_var(--p-line-soft)]">
        <div className="flex h-8 items-center gap-2 border-b border-line-soft px-2.5">
          <span className="flex items-center gap-1.5 cm-mono !text-xs font-semibold text-primary">
            <span className="size-1.5 rounded-full bg-danger/65" />
            <span className="size-1.5 rounded-full bg-warn/65" />
            <span className="size-1.5 rounded-full bg-success/65" />
            <span className="ml-1">{headerLabel}</span>
          </span>
          <span className="cm-mono !text-2xs text-faint">{entries.length} exchange{entries.length === 1 ? "" : "s"}</span>
          {terminals.length === 1 && <Chip tone="muted" mono>{terminals[0]}</Chip>}
          <span className="ml-auto">
            <IconButton
              // Counted, never hardcoded: the list has already lost a category
              // (`pr`, now its own card) and a stale "of 7" is a lie the UI
              // tells with total confidence.
              tip={`Shell visibility · ${filter.enabled.length} of ${SHELL_FILTER_OPTIONS.length} shown`}
              active={filter.enabled.length < SHELL_FILTER_OPTIONS.length}
              onClick={() => setFilterOpen(true)}
            >
              <SlidersHorizontal />
            </IconButton>
          </span>
        </div>
        <div>
          {entries.map((entry, index) => {
            const presentation = shellGroupPresentation(entry.use);
            const admitted = presentation ? enabled.has(presentationFilterCategory(presentation)) : true;
            const settledBehindActiveCommand = !admitted && active && index < entries.length - 1 && entryState(entry) !== "running";
            const collapsed = !admitted && !active;
            return (
              <div
                key={entry.use.id}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out)]",
                  collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
                  settledBehindActiveCommand && "opacity-50",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  {presentation?.kind === "dispatch" ? (
                    <DispatchToolCard embedded use={entry.use} result={entry.result} task={entry.task} />
                  ) : (
                    <ShellCommandPair entry={entry} />
                  )}
                </div>
              </div>
            );
          })}
          {active && languages.length > 0 && summary.label !== "running" && (
            <div className="flex h-7 items-center px-2.5 cm-mono !text-xs" aria-label="Active shell prompt">
              <span className="mr-2 font-semibold text-accent-hi">{shellLabel(activeLanguage, true)} &gt;</span>
              {summary.label === "running" ? (
                <Spinner size={9} />
              ) : (
                <span className="h-3 w-1.5 bg-secondary cm-anim-pulse" />
              )}
            </div>
          )}
        </div>
        {/* A command that produced an image — a screenshot tool driven from the
            shell, a chart script that prints a data URL. */}
        <ResultMediaStrip
          chatId={chatId}
          results={entries.map((e) => e.result)}
          uses={entries.map((e) => e.use)}
        />
      </div>
          </RowShell>
        </div>
      </div>
      <ShellFilterModal open={filterOpen} onClose={() => setFilterOpen(false)} chatId={chatId} resolved={filter} />
    </>
  );
});
