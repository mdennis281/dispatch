/**
 * The inspector's right pane: the subagent's own messages, read as a narrative.
 *
 * Deliberately NOT the chat's MessageList — a subagent stream wants a tighter,
 * flatter presentation (no rollback affordances, no avatars per row, nested
 * spawns as drill-in rows rather than recursive transcripts). Clicking a step in
 * the timeline scrolls the matching block here into view.
 */
import { memo, useEffect, useRef } from "react";
import { ChevronRight, CornerDownRight } from "lucide-react";
import type { RunStep, SubagentRun } from "../../lib/subagentRuns.js";
import { runDuration, toolDetail } from "../../lib/subagentRuns.js";
import { toolIcon } from "../chat/toolIcon.js";
import { Markdown } from "../chat/Markdown.js";
import { AgentGlyph } from "./runVisuals.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { TypingPulse } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { clock, safeJson, toolLabel } from "../../lib/format.js";
import { useState } from "react";

/** A collapsed tool call; expands to args + result in place. */
const ToolBlock = memo(function ToolBlock({
  step,
}: {
  step: Extract<RunStep, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const failed = step.result?.isError || step.result?.ok === false;
  const detail = toolDetail(step.use);
  const content = step.result?.content;
  const resultText =
    content === undefined || content === null
      ? ""
      : typeof content === "string"
        ? content
        : safeJson(content);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-panel-2/50",
        failed ? "border-danger-ghost" : "border-line",
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-muted [&_svg]:size-3.5">{toolIcon(step.use.name)}</span>
        <span className="shrink-0 text-[12px] font-medium text-primary">
          {toolLabel(step.use.name)}
        </span>
        {detail && (
          <span className="min-w-0 truncate cm-mono !text-[11px] text-muted">{detail}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {step.durationMs !== undefined && (
            <span className="cm-mono !text-[10px] text-faint">
              {runDuration(step.durationMs)}
            </span>
          )}
          {step.pending ? (
            <Chip tone="accent" icon={<Spinner size={9} />}>
              running
            </Chip>
          ) : failed ? (
            <Chip tone="danger">failed</Chip>
          ) : (
            <Chip tone="success">ok</Chip>
          )}
        </span>
      </button>
      {open && (
        <div className="cm-anim-rise space-y-2 border-t border-line-soft px-3 py-2.5">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
              Arguments
            </div>
            <div className="cm-scroll max-h-40 overflow-auto rounded-[5px] border border-line-soft bg-inset px-2.5 py-2">
              <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">
                {safeJson(step.use.input)}
              </pre>
            </div>
          </div>
          {step.result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
                Result
              </div>
              <div
                className={cn(
                  "cm-scroll max-h-56 overflow-auto rounded-[5px] border px-2.5 py-2",
                  failed ? "border-danger-ghost bg-danger-ghost/40" : "border-line-soft bg-inset",
                )}
              >
                <pre className="whitespace-pre-wrap break-words cm-mono text-secondary">
                  {resultText || "— no output —"}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** A nested subagent — a drill-in row, never an inline sub-transcript. */
function NestedRunBlock({
  step,
  onOpen,
}: {
  step: Extract<RunStep, { kind: "subagent" }>;
  onOpen: () => void;
}) {
  const type =
    typeof step.use.input.subagent_type === "string"
      ? step.use.input.subagent_type
      : "subagent";
  const desc =
    typeof step.use.input.description === "string" ? step.use.input.description : undefined;
  const status = step.pending
    ? "running"
    : step.result?.isError || step.result?.ok === false
      ? "failed"
      : "done";
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-2.5 rounded-md border border-accent-line/60 bg-accent-ghost/20 px-2.5 py-2 text-left transition-colors hover:bg-accent-ghost/40"
    >
      <CornerDownRight className="size-3.5 shrink-0 text-faint" />
      <AgentGlyph status={status} size={5} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-accent-hi">{type}</span>
        {desc && <span className="block truncate text-[11px] text-muted">{desc}</span>}
      </span>
      <span className="shrink-0 text-[11px] text-faint transition-colors group-hover:text-accent-hi">
        Open →
      </span>
    </button>
  );
}

export function RunStream({
  run,
  focusStepId,
  onOpenNested,
}: {
  run: SubagentRun;
  focusStepId: string | null;
  onOpenNested: (runId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Follow a live run only while the reader is pinned to the bottom.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.steps.length, run.status]);

  // Timeline click → bring that block into view (and stop auto-following).
  useEffect(() => {
    if (!focusStepId) return;
    const el = scrollRef.current?.querySelector(`[data-step-id="${CSS.escape(focusStepId)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusStepId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="cm-scroll h-full overflow-y-auto px-4 py-3"
    >
      <div className="flex flex-col gap-2.5">
        {run.steps.length === 0 && (
          <p className="py-6 text-center text-[12px] text-faint">
            {run.status === "running"
              ? "The subagent is starting up…"
              : "This run recorded no messages."}
          </p>
        )}

        {run.steps.map((step) => (
          <div
            key={step.id}
            data-step-id={step.id}
            className={cn(
              "scroll-mt-4 rounded-md transition-shadow",
              focusStepId === step.id && "ring-1 ring-accent-line",
            )}
          >
            {step.kind === "message" ? (
              <div className="px-0.5">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11.5px] font-semibold tracking-tight text-accent-hi">
                    {run.agentType}
                  </span>
                  <span className="cm-mono !text-[10px] text-faint">{clock(step.ts)}</span>
                </div>
                <Markdown>{step.row.text}</Markdown>
              </div>
            ) : step.kind === "subagent" ? (
              <NestedRunBlock step={step} onOpen={() => onOpenNested(step.runId)} />
            ) : (
              <ToolBlock step={step} />
            )}
          </div>
        ))}

        {run.status === "running" && (
          <div className="flex items-center gap-2 px-0.5 py-1">
            <TypingPulse />
            <span className="text-[11.5px] text-muted">{run.latest ?? "Working…"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
