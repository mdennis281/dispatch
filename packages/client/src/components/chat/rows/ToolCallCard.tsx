import { memo, useMemo, useState } from "react";
import { ChevronRight, Check, X, FileDiff, FileCode2, Square, Moon } from "lucide-react";
import type { ToolUseRow, ToolResultRow, TaskStatusRow } from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { toolIcon } from "../toolIcon.js";
import { ImageThumb } from "./ImageThumb.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { PlanBody, parsePlan } from "./PlanCard.js";
import { ackTaskId } from "../../../lib/subagentRuns.js";
import { Chip } from "../../ui/Chip.js";
import { Button } from "../../ui/Button.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../../lib/cn.js";
import { parseMcpName, toolLabel, dur, safeJson, kb } from "../../../lib/format.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { useChats } from "../../../stores/chats.js";
import { usePanels } from "../../../stores/panels.js";
import { toolFileTarget, openCodeViewer } from "../../monaco/index.js";
import { parseInlineResultImages } from "../../../lib/resultImages.js";

/** Render a tool result payload (string as mono block, object as JSON). */
function ResultBody({ content }: { content: unknown }) {
  const parsed = useMemo(() => parseInlineResultImages(content), [content]);
  const [zoomed, setZoomed] = useState<number | null>(null);
  if (content === undefined || content === null) {
    return <span className="text-faint">— no output —</span>;
  }
  const text = typeof parsed.content === "string" ? parsed.content : safeJson(parsed.content);
  return (
    <>
      {parsed.images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {parsed.images.map((image, index) => {
            const src = `data:${image.mimeType};base64,${image.data}`;
            return (
              <Button
                key={index}
                type="button"
                variant="ghost"
                onClick={() => setZoomed(index)}
                className="!h-auto !p-0 overflow-hidden rounded-md border border-line bg-inset outline-none focus-visible:ring-1 focus-visible:ring-accent-line"
                title="Click to enlarge"
              >
                <img
                  src={src}
                  alt={`Tool result image ${index + 1}`}
                  className="block max-h-52 max-w-[240px] object-contain"
                />
              </Button>
            );
          })}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">{text}</pre>
      {zoomed !== null && parsed.images[zoomed] && (
        <ImageLightbox
          src={`data:${parsed.images[zoomed].mimeType};base64,${parsed.images[zoomed].data}`}
          name={`Tool result image ${zoomed + 1}`}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  );
}

/** Trailing "…still loading the rest" hint under a clipped payload. */
function ClippedNote({ bytes }: { bytes?: number }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-faint">
      <Spinner size={9} />
      <span>Loading the full payload{bytes ? ` (${kb(bytes)})` : ""}…</span>
    </div>
  );
}

export interface ToolCallCardProps {
  use: ToolUseRow;
  result?: ToolResultRow;
  /**
   * The SDK's settle verdict, when this call was sent to the BACKGROUND. Such a
   * call answers in milliseconds with a launch ack and keeps running, so its own
   * `result` says nothing about whether the work finished — this does.
   */
  task?: TaskStatusRow;
  defaultOpen?: boolean;
}

/**
 * A collapsible, pretty tool/MCP invocation card (args + result + timing).
 *
 * Memoized: a transcript is mostly these, and re-rendering them all on every
 * store change was a large part of the long-chat lag.
 *
 * The transcript ships LEAN (see server/services/transcript-lean.ts) — a big
 * `input`/`content` arrives clipped to a preview and flagged, because a collapsed
 * card never shows it. The first expand fetches the verbatim rows and the store
 * swaps them in place, so the payload is paid for only when it's actually read.
 */
export const ToolCallCard = memo(function ToolCallCard({
  use,
  result,
  task,
  defaultOpen = false,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const mcp = parseMcpName(use.name);
  // Clipped payloads still on the wire — fetched on first expand.
  const clipped = Boolean(use.inputOmitted) || Boolean(result?.contentOmitted);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && clipped) {
      const ids: string[] = [];
      if (use.inputOmitted) ids.push(use.id);
      if (result?.contentOmitted) ids.push(result.id);
      void hydrateFullRows(use.chatId, ids);
    }
  };
  // Backgrounded: the ack printed a task id, so this call's own result is a
  // receipt, not an outcome. It stays live until a settle verdict lands.
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  const running = !result || (backgrounded && !task);
  const errored =
    task?.status === "failed" || (!backgrounded && (result?.isError || result?.ok === false));

  // A file this tool touched → offer to open it in the Monaco preview/diff.
  // Gated (offered only when a worktree can serve it), never a dead click.
  const chat = useChats((s) => s.byId[use.chatId]);
  const worktrees = usePanels((s) => s.worktrees);
  const fileTarget = toolFileTarget(use, chat, worktrees);

  const status = running ? (
    <Chip tone="accent" icon={backgrounded ? <Moon /> : <Spinner size={9} />}>
      {backgrounded ? "in background" : "running"}
    </Chip>
  ) : errored ? (
    <Chip tone="danger" icon={<X />}>failed</Chip>
  ) : task?.status === "stopped" ? (
    <Chip tone="muted" icon={<Square />}>stopped</Chip>
  ) : (
    <Chip tone="success" icon={<Check />}>ok</Chip>
  );

  const command = typeof use.input.command === "string" ? use.input.command : undefined;
  // ExitPlanMode's argument IS a markdown document — render it as one.
  // (skipped while the input is still clipped — a half-plan would render as
  // broken markdown; the first expand hydrates it and this lights up.)
  const plan = use.name === "ExitPlanMode" && !use.inputOmitted ? parsePlan(use.input) : null;

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
          {toolIcon(use.name)}
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-panel-2/60">
        <div className="flex items-center">
          <button
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
          >
            <ChevronRight
              className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
            />
            <span className="shrink-0 text-sm font-semibold text-primary">
              {toolLabel(use.name)}
            </span>
            {mcp && <Chip tone="agent">MCP · {mcp.server}</Chip>}
            {command && !open && (
              <span className="min-w-0 truncate cm-mono !text-xs text-muted">{command}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              {/* A backgrounded call's own durationMs times the ACK, not the work. */}
              {(task?.durationMs ?? (backgrounded ? undefined : result?.durationMs)) !==
                undefined && (
                <span className="cm-mono !text-2xs text-faint">
                  {dur((task?.durationMs ?? result?.durationMs)!)}
                </span>
              )}
              {status}
            </span>
          </button>
          {fileTarget && (
            <button
              onClick={() => openCodeViewer(fileTarget)}
              title={fileTarget.mode === "diff" ? "Open diff vs main" : "Open file"}
              className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-transparent px-1.5 py-1 text-xs text-muted transition-colors hover:bg-active hover:text-primary [&_svg]:size-3.5"
            >
              {fileTarget.mode === "diff" ? <FileDiff /> : <FileCode2 />}
              Open
            </button>
          )}
        </div>

        {result?.images && result.images.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-line-soft px-3 py-2.5">
            {result.images.map((img) => (
              <ImageThumb key={img.id} chatId={use.chatId} img={img} />
            ))}
          </div>
        )}

        {open && (
          <div className="cm-anim-rise space-y-2 border-t border-line-soft px-3 py-2.5">
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
                {plan ? "Plan" : command ? "Command" : "Arguments"}
              </div>
              {plan ? (
                <PlanBody plan={plan.plan} allowedPrompts={plan.allowedPrompts} />
              ) : (
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
                  {use.inputOmitted && <ClippedNote />}
                </div>
              )}
            </div>
            {task?.summary && (
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
                  Background outcome
                  {task.toolUses !== undefined && (
                    <span className="ml-1.5 font-normal normal-case tracking-normal text-faint">
                      {task.toolUses} tool call{task.toolUses === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <p className="rounded-[5px] border border-line-soft bg-inset px-2.5 py-2 text-xs text-secondary">
                  {task.summary}
                </p>
              </div>
            )}
            {result && (
              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
                  Result
                  {result.contentOmitted && result.contentBytes !== undefined && (
                    <span className="ml-1.5 font-normal normal-case tracking-normal text-faint">
                      {kb(result.contentBytes)}
                    </span>
                  )}
                </div>
                <div
                  className={cn(
                    "cm-scroll max-h-48 overflow-auto rounded-[5px] border px-2.5 py-2",
                    errored ? "border-danger-ghost bg-danger-ghost/40" : "border-line-soft bg-inset",
                  )}
                >
                  <ResultBody content={result.content} />
                  {result.contentOmitted && <ClippedNote bytes={result.contentBytes} />}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </RowShell>
  );
});
