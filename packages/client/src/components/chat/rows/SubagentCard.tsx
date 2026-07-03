import { useMemo, useState, type ReactNode } from "react";
import { Bot, ChevronRight, Check, X } from "lucide-react";
import type { ChatMessage, ToolUseRow, ToolResultRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";

/** Best-effort subagent type: the Task input, else a child row's tag, else generic. */
function subagentTypeOf(use: ToolUseRow, children: ChatMessage[]): string {
  const fromInput = use.input.subagent_type;
  if (typeof fromInput === "string" && fromInput.trim()) return fromInput.trim();
  for (const c of children) {
    if ("subagentType" in c && c.subagentType) return c.subagentType;
  }
  return "subagent";
}

/** Short one-line task description from the Task tool input, if present. */
function descriptionOf(use: ToolUseRow): string | undefined {
  const d = use.input.description ?? use.input.prompt;
  if (typeof d !== "string" || !d.trim()) return undefined;
  const s = d.trim();
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export interface SubagentCardProps {
  /** The `Task` (or other spawner) tool_use row that started the subagent. */
  use: ToolUseRow;
  /** The spawner's own result (present once the subagent finished). */
  result?: ToolResultRow;
  /** The subagent's own transcript rows (share `parentToolUseId === use.toolUseId`). */
  childRows: ChatMessage[];
  /** Recursively render nested rows (reuses MessageList's grouping + pairing). */
  renderRows: (rows: ChatMessage[]) => ReactNode;
  defaultOpen?: boolean;
}

/**
 * A NESTED, collapsible sub-transcript for a subagent/workflow the in-chat agent
 * spawned via the `Task` tool. Collapsed, it still summarizes the subagent (type,
 * running/done, turn + tool counts); expanded, it renders the subagent's own
 * messages/tools indented under a left rail so parallel subagents read as distinct
 * stacked groups rather than a flat interleave in the main transcript.
 */
export function SubagentCard({
  use,
  result,
  childRows,
  renderRows,
  defaultOpen = false,
}: SubagentCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const { type, description, turns, tools, running, errored } = useMemo(() => {
    let turns = 0;
    let tools = 0;
    for (const c of childRows) {
      if (c.kind === "result") turns += 1;
      else if (c.kind === "tool_use") tools += 1;
    }
    return {
      type: subagentTypeOf(use, childRows),
      description: descriptionOf(use),
      turns,
      tools,
      running: !result,
      errored: result?.isError || result?.ok === false,
    };
  }, [use, result, childRows]);

  const status = running ? (
    <Chip tone="accent" icon={<Spinner size={9} />}>running</Chip>
  ) : errored ? (
    <Chip tone="danger" icon={<X />}>failed</Chip>
  ) : (
    <Chip tone="success" icon={<Check />}>done</Chip>
  );

  const counts: string[] = [];
  if (tools > 0) counts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (turns > 0) counts.push(`${turns} turn${turns === 1 ? "" : "s"}`);

  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent-hi ring-1 ring-accent-line [&_svg]:size-3.5">
          <Bot />
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-accent-line/60 bg-accent-ghost/20">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
          <span className="shrink-0 text-[12px] font-semibold text-accent-hi">subagent</span>
          <Chip tone="accent" className="shrink-0">{type}</Chip>
          {description && !open && (
            <span className="min-w-0 truncate text-[11px] text-muted">{description}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            {counts.length > 0 && (
              <span className="cm-mono !text-[10px] text-faint">{counts.join(" · ")}</span>
            )}
            {status}
          </span>
        </button>

        {open && (
          <div className="cm-anim-rise border-t border-accent-line/40">
            {description && (
              <div className="border-b border-line-soft/60 px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                {description}
              </div>
            )}
            {childRows.length > 0 ? (
              <div className="ml-3 border-l border-accent-line/40">
                <div className="flex flex-col divide-y divide-line-soft/70">
                  {renderRows(childRows)}
                </div>
              </div>
            ) : (
              <div className="px-3 py-2 text-[11.5px] text-faint">
                {running ? "Subagent is starting…" : "No activity recorded."}
              </div>
            )}
          </div>
        )}
      </div>
    </RowShell>
  );
}
