/**
 * The AGENT RUN INSPECTOR — a dedicated surface for one subagent run.
 *
 * Subagents used to render as a nested sub-transcript inside the chat, which
 * buried a 40-step run inside the parent's scroll and read as one confusing
 * thread. This gives a run its own room: identity and live status up top, the
 * shape of the run as a timeline on the left, its messages on the right, and the
 * report it handed back at the bottom.
 *
 * Runs are DERIVED from the transcript on every render, so a live run updates
 * here exactly as its rows land — there is no separate copy to go stale.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Clock,
  Wrench,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  ListTree,
} from "lucide-react";
import { useAgentRun, useRunElapsed } from "../../stores/agentRun.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import { findRun, runDuration, type SubagentRun } from "../../lib/subagentRuns.js";
import { AgentGlyph, EffortChip, RunProgressRail, RunStatusChip } from "./runVisuals.js";
import { RunTimeline } from "./RunTimeline.js";
import { RunStream } from "./RunStream.js";
import { Markdown } from "../chat/Markdown.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";

/** A labelled metric in the header strip. */
function Stat({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted [&_svg]:size-3 [&_svg]:text-faint">
      {icon}
      {children}
    </span>
  );
}

/** The report the subagent handed back — or its own closing message, when it was
 *  launched async and the spawner only ever got a launch acknowledgement.
 *  Collapsible: a long report otherwise eats a third of the inspector while
 *  you're trying to read the run itself. */
function RunReport({ run }: { run: SubagentRun }) {
  const [open, setOpen] = useState(true);

  if (run.status === "running") {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-faint">
        <span className="size-1.5 rounded-full bg-accent cm-anim-pulse" />
        {run.async
          ? "Launched in the background — its closing message appears here when it finishes."
          : "The report appears here when the run finishes."}
      </div>
    );
  }
  if (!run.report) {
    return (
      <div className="px-4 py-2.5 text-xs text-faint">
        This run returned no report.
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-hover"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
          {run.async ? "Final message" : "Report to the main agent"}
        </span>
        {run.status === "failed" && <Chip tone="danger">failed</Chip>}
        {!open && (
          <span className="min-w-0 truncate text-xs text-muted">
            {run.report.split("\n").find((l) => l.trim())}
          </span>
        )}
      </button>
      {open && (
        <div className="cm-scroll max-h-[26vh] overflow-y-auto px-4 pb-3">
          <Markdown>{run.report}</Markdown>
        </div>
      )}
    </div>
  );
}

export function AgentRunInspector({ chatId, runId }: { chatId: string; runId: string }) {
  const z = useDialogLayer();
  const close = useAgentRun((s) => s.close);
  const openRun = useAgentRun((s) => s.openRun);
  const focusStepId = useAgentRun((s) => s.focusStepId);
  const focusStep = useAgentRun((s) => s.focusStep);

  const runs = useSubagentRuns(chatId);
  const run = findRun(runs, runId);
  const parent = findRun(runs, run?.parentRunId ?? null);

  const live = run?.status === "running";
  const elapsed = useRunElapsed(run?.startedAt ?? 0, run?.durationMs ?? 0, !!live);

  // Esc closes — matches the code viewer's overlay behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return createPortal(
    <div
      style={{ zIndex: z }}
      className="fixed inset-0 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Subagent run"
    >
      <button
        aria-label="Close run inspector"
        onClick={close}
        className="absolute inset-0 cursor-default bg-scrim backdrop-blur-[2px] cm-anim-rise"
      />

      <div className="relative flex h-[86vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-[var(--shadow-pop)] cm-anim-rise">
        {!run ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <ListTree className="size-5 text-faint" />
            <p className="text-base text-secondary">This run isn&rsquo;t loaded</p>
            <p className="max-w-[380px] text-xs text-muted">
              Its rows are above the part of the transcript that&rsquo;s loaded. Scroll up
              in the chat to page them in, then reopen.
            </p>
            <button
              onClick={close}
              className="mt-1 rounded-[5px] border border-line px-2.5 py-1 text-xs text-secondary hover:text-primary"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* ---------------------------------------------------------- header */}
            <div className="shrink-0 border-b border-line">
              <div className="flex h-12 items-center gap-2.5 px-3">
                {parent && (
                  <IconButton
                    tip={`Back to ${parent.agentType}`}
                    onClick={() => openRun(parent.id)}
                  >
                    <ChevronLeft />
                  </IconButton>
                )}
                <AgentGlyph status={run.status} size={7} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-semibold tracking-tight text-primary">
                      {run.agentType}
                    </h2>
                    {run.model && (
                      <Chip tone="muted" mono className="hidden sm:inline-flex" title="model">
                        {run.model}
                      </Chip>
                    )}
                    {run.effort && <EffortChip effort={run.effort} label="ran at effort" />}
                    {run.async && (
                      <Chip
                        tone="muted"
                        title="Launched in the background — the spawn returned immediately"
                      >
                        async
                      </Chip>
                    )}
                  </div>
                  {run.description && (
                    <p className="truncate text-xs text-muted" title={run.description}>
                      {run.description}
                    </p>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-3">
                  <Stat icon={<Clock />}>
                    <span
                      className={cn("cm-mono !text-xs tabular-nums", live && "text-accent-hi")}
                    >
                      {runDuration(elapsed)}
                    </span>
                  </Stat>
                  <Stat icon={<Wrench />}>
                    {run.toolCount} tool{run.toolCount === 1 ? "" : "s"}
                  </Stat>
                  {run.turnCount > 0 && (
                    <Stat icon={<RotateCw />}>
                      {run.turnCount} turn{run.turnCount === 1 ? "" : "s"}
                    </Stat>
                  )}
                  <RunStatusChip status={run.status} />
                  <IconButton tip="Close" onClick={close}>
                    <X />
                  </IconButton>
                </div>
              </div>
              <RunProgressRail run={run} max={64} className="px-3 pb-2" />
            </div>

            {/* ------------------------------------------------ timeline + stream */}
            <div className="flex min-h-0 flex-1">
              <div className="cm-scroll w-[248px] shrink-0 overflow-y-auto border-r border-line bg-surface/40">
                <RunTimeline
                  run={run}
                  focusStepId={focusStepId}
                  onFocusStep={focusStep}
                />
              </div>
              <div className="min-w-0 flex-1">
                <RunStream
                  run={run}
                  focusStepId={focusStepId}
                  onOpenNested={openRun}
                />
              </div>
            </div>

            {/* ---------------------------------------------------------- report */}
            <div className="shrink-0 border-t border-line bg-surface/40">
              <RunReport run={run} />
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
