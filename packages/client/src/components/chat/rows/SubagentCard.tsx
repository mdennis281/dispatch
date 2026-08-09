import { memo } from "react";
import { Clock, Wrench, ArrowUpRight } from "lucide-react";
import { RowShell } from "./RowShell.js";
import type { SubagentRun } from "../../../lib/subagentRuns.js";
import { runDuration } from "../../../lib/subagentRuns.js";
import { openAgentRun, useRunElapsed } from "../../../stores/agentRun.js";
import {
  AgentGlyph,
  RunIdentity,
  RunProgressRail,
  RunStatusChip,
} from "../../agents/runVisuals.js";
import { cn } from "../../../lib/cn.js";

export interface SubagentCardProps {
  run: SubagentRun;
}

/**
 * A subagent's anchor in the transcript: a LIVE STATUS CARD, not an expander.
 *
 * The old card nested the subagent's entire sub-transcript inline, which buried
 * a 40-step run inside the parent's scroll and made the two threads hard to tell
 * apart. Now the run gets its own surface (the inspector) and this card is what
 * the chat shows in its place: who is running, on what, how far along, and what
 * it's doing right now — one click from the full run.
 */
export const SubagentCard = memo(function SubagentCard({ run }: SubagentCardProps) {
  const live = run.status === "running";
  const elapsed = useRunElapsed(run.startedAt, run.durationMs, live);

  return (
    <RowShell gutter={<AgentGlyph status={run.status} />}>
      <button
        onClick={() => openAgentRun(run.chatId, run.id)}
        className={cn(
          "group/run block w-full overflow-hidden rounded-md border text-left transition-colors",
          // Violet is this card's identity colour — a subagent is the app
          // acting on your behalf. Liveness stays amber, but only on the pulse
          // dot below: if the whole card went amber too, the transcript would
          // have no colour left to mean "this one needs YOU".
          live
            ? "border-accent-2-line/70 bg-accent-2-ghost/25 hover:bg-accent-2-ghost/40"
            : run.status === "failed"
              ? "border-danger-ghost bg-danger-ghost/20 hover:bg-danger-ghost/30"
              : "border-line bg-panel-2/60 hover:bg-panel-2",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 px-2.5 pt-2">
          <span className="shrink-0 text-[12px] font-semibold text-accent-2-hi">subagent</span>
          <RunIdentity run={run} />
          {run.description && (
            <span className="min-w-0 truncate text-[11.5px] text-muted">
              {run.description}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <RunStatusChip status={run.status} />
          </span>
        </div>

        {/* live activity — what it is doing right now */}
        {live && run.latest && (
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 px-2.5">
            <span className="size-1 shrink-0 rounded-full bg-accent cm-anim-pulse" />
            <span className="min-w-0 truncate cm-mono !text-[10.5px] text-accent-2-hi/90">
              {run.latest}
            </span>
          </div>
        )}

        <div className="mt-2 flex items-center gap-3 px-2.5 pb-2">
          <span className="inline-flex items-center gap-1 text-[10.5px] text-faint [&_svg]:size-3">
            <Clock />
            <span className={cn("cm-mono !text-[10px] tabular-nums", live && "text-accent-hi")}>
              {runDuration(elapsed)}
            </span>
          </span>
          <span className="inline-flex items-center gap-1 text-[10.5px] text-faint [&_svg]:size-3">
            <Wrench />
            {run.toolCount}
          </span>
          {run.childRunIds.length > 0 && (
            <span className="text-[10.5px] text-faint">
              +{run.childRunIds.length} nested
            </span>
          )}
          <RunProgressRail run={run} className="ml-1 min-w-0 flex-1 justify-start" />
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-faint transition-colors group-hover/run:text-accent-2-hi [&_svg]:size-3">
            Open run
            <ArrowUpRight />
          </span>
        </div>
      </button>
    </RowShell>
  );
});
