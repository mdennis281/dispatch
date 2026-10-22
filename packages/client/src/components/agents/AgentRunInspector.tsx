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
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";
import { useLayoutMode } from "../../stores/layout.js";

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
        <div className="cm-scroll max-h-[26vh] overflow-y-auto px-4 pb-3 max-sm:max-h-[20vh]">
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

  // On a phone the 248px timeline column next to the stream left the messages
  // ~140px wide, so the two panes become tabs instead. Picking a step jumps to
  // the stream — that's where the step you tapped actually is.
  const compact = useLayoutMode() === "sm";
  const [pane, setPane] = useState<"timeline" | "stream">("stream");
  const onFocusStep = (id: string) => {
    focusStep(id);
    if (compact) setPane("stream");
  };

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
      className={cn(
        "fixed inset-0 flex items-center justify-center",
        // Full-bleed on a phone: the safe-area padding moves onto the panel so
        // its own background, not the scrim, fills the notch and home-bar bands.
        !compact && "dp-safe-pad [--dp-gutter:1rem] sm:[--dp-gutter:1.5rem]",
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Subagent run"
    >
      <button
        aria-label="Close run inspector"
        onClick={close}
        className="absolute inset-0 cursor-default bg-scrim backdrop-blur-[2px] cm-anim-rise"
      />

      {/* Height as `full` capped at 86vh, not a flat 86vh: `full` is 100% of the
          overlay's CONTENT box, so whatever the safe-area gutters take comes off
          the panel automatically. A flat `86vh` is measured against the large
          viewport instead and can't see the insets at all. The cap is what keeps
          the desktop card off the window edges, as before. */}
      <div
        className={cn(
          "relative flex h-full flex-col overflow-hidden bg-panel cm-anim-rise",
          compact
            ? "w-full dp-safe-pad"
            : "max-h-[86vh] w-[min(1180px,94vw)] rounded-lg border border-line-strong shadow-[var(--shadow-pop)]",
        )}
      >
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
              <div
                className={cn(
                  "flex items-center gap-2.5 px-3",
                  compact ? "flex-wrap gap-y-1.5 py-2" : "h-12",
                )}
              >
                {parent && (
                  <IconButton
                    tip={`Back to ${parent.agentType}`}
                    onClick={() => openRun(parent.id)}
                  >
                    <ChevronLeft />
                  </IconButton>
                )}
                <AgentGlyph status={run.status} size={7} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
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

                {compact && (
                  <IconButton tip="Close" onClick={close} className="shrink-0">
                    <X />
                  </IconButton>
                )}

                <div
                  className={cn(
                    "flex items-center gap-3",
                    // Its own full-width row under the title on a phone; the
                    // stats crowded the agent name down to a few characters.
                    compact ? "order-last w-full" : "ml-auto",
                  )}
                >
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
                  {!compact && (
                    <IconButton tip="Close" onClick={close}>
                      <X />
                    </IconButton>
                  )}
                </div>
              </div>
              <RunProgressRail run={run} max={64} className="px-3 pb-2" />
            </div>

            {/* ------------------------------------------------ timeline + stream */}
            {compact && (
              <div className="shrink-0 border-b border-line px-3 py-1.5">
                <SegmentedControl
                  className="flex w-full [&>button]:flex-1 [&>button]:justify-center"
                  value={pane}
                  onChange={setPane}
                  segments={[
                    { value: "stream", label: "Messages" },
                    { value: "timeline", label: `Steps · ${run.steps.length}` },
                  ]}
                />
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              {/* Both panes stay MOUNTED on a phone, the inactive one only
                  hidden: unmounting RunStream on a tab flip threw away the
                  reader's scroll position and replayed a stale focusStepId on
                  remount. A step tap flips the pane in the same render as the
                  focus, so the stream is visible by the time its scroll effect
                  runs — scrollIntoView on a display:none subtree is a no-op. */}
              <div
                className={cn(
                  "cm-scroll overflow-y-auto bg-surface/40",
                  compact ? "flex-1" : "w-[248px] shrink-0 border-r border-line",
                  compact && pane !== "timeline" && "hidden",
                )}
              >
                <RunTimeline
                  run={run}
                  focusStepId={focusStepId}
                  onFocusStep={onFocusStep}
                />
              </div>
              <div className={cn("min-w-0 flex-1", compact && pane !== "stream" && "hidden")}>
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
