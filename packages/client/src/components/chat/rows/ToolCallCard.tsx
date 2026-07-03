import { useState, type ReactNode } from "react";
import {
  Terminal,
  Plug,
  FileText,
  FilePen,
  Wrench,
  ChevronRight,
  Check,
  X,
  Globe,
  Search,
  FileDiff,
  FileCode2,
} from "lucide-react";
import type { ToolUseRow, ToolResultRow } from "@cm/shared";
import { RowShell } from "./RowShell.js";
import { Chip } from "../../ui/Chip.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { parseMcpName, toolLabel, dur, safeJson } from "../../../lib/format.js";
import { useChats } from "../../../stores/chats.js";
import { usePanels } from "../../../stores/panels.js";
import { toolFileTarget, openCodeViewer } from "../../monaco/index.js";

function iconFor(name: string): ReactNode {
  const mcp = parseMcpName(name);
  if (mcp) {
    if (/navig|open|url|goto/i.test(mcp.tool)) return <Globe />;
    if (/find|search|query/i.test(mcp.tool)) return <Search />;
    return <Plug />;
  }
  if (name === "Bash") return <Terminal />;
  if (name === "Read" || name === "Grep" || name === "Glob") return <FileText />;
  if (name === "Write" || name === "Edit") return <FilePen />;
  return <Wrench />;
}

/** Render a tool result payload (string as mono block, object as JSON). */
function ResultBody({ content }: { content: unknown }) {
  if (content === undefined || content === null) {
    return <span className="text-faint">— no output —</span>;
  }
  const text = typeof content === "string" ? content : safeJson(content);
  return <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">{text}</pre>;
}

export interface ToolCallCardProps {
  use: ToolUseRow;
  result?: ToolResultRow;
  defaultOpen?: boolean;
}

/** A collapsible, pretty tool/MCP invocation card (args + result + timing). */
export function ToolCallCard({ use, result, defaultOpen = false }: ToolCallCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const mcp = parseMcpName(use.name);
  const running = !result;
  const errored = result?.isError || result?.ok === false;

  // A file this tool touched → offer to open it in the Monaco preview/diff.
  // Gated (offered only when a worktree can serve it), never a dead click.
  const chat = useChats((s) => s.byId[use.chatId]);
  const worktrees = usePanels((s) => s.worktrees);
  const fileTarget = toolFileTarget(use, chat, worktrees);

  const status = running ? (
    <Chip tone="accent" icon={<Spinner size={9} />}>running</Chip>
  ) : errored ? (
    <Chip tone="danger" icon={<X />}>failed</Chip>
  ) : (
    <Chip tone="success" icon={<Check />}>ok</Chip>
  );

  const command = typeof use.input.command === "string" ? use.input.command : undefined;

  return (
    <RowShell
      gutter={
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            mcp
              ? "bg-accent-ghost text-accent-hi ring-accent-line"
              : "bg-panel-2 text-secondary ring-line",
          )}
        >
          {iconFor(use.name)}
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex items-center">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.02]"
          >
            <ChevronRight
              className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
            />
            <span className="shrink-0 text-[12px] font-semibold text-primary">
              {toolLabel(use.name)}
            </span>
            {mcp && <Chip tone="accent">MCP · {mcp.server}</Chip>}
            {command && !open && (
              <span className="min-w-0 truncate cm-mono !text-[11px] text-muted">{command}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              {result?.durationMs !== undefined && (
                <span className="cm-mono !text-[10px] text-faint">{dur(result.durationMs)}</span>
              )}
              {status}
            </span>
          </button>
          {fileTarget && (
            <button
              onClick={() => openCodeViewer(fileTarget)}
              title={fileTarget.mode === "diff" ? "Open diff vs main" : "Open file"}
              className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-transparent px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-white/[0.06] hover:text-primary [&_svg]:size-3.5"
            >
              {fileTarget.mode === "diff" ? <FileDiff /> : <FileCode2 />}
              Open
            </button>
          )}
        </div>

        {open && (
          <div className="cm-anim-rise space-y-2 border-t border-line-soft px-3 py-2.5">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                {command ? "Command" : "Arguments"}
              </div>
              <div className="cm-scroll max-h-40 overflow-auto rounded-[5px] border border-line-soft bg-inset px-2.5 py-2">
                {command ? (
                  <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">
                    <span className="select-none text-faint">$ </span>
                    {command}
                  </pre>
                ) : (
                  <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">
                    {safeJson(use.input)}
                  </pre>
                )}
              </div>
            </div>
            {result && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                  Result
                </div>
                <div
                  className={cn(
                    "cm-scroll max-h-48 overflow-auto rounded-[5px] border px-2.5 py-2",
                    errored ? "border-danger-ghost bg-danger-ghost/40" : "border-line-soft bg-inset",
                  )}
                >
                  <ResultBody content={result.content} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </RowShell>
  );
}
