/**
 * The AGENTS rail — every subagent run in the chat, live ones first.
 *
 * The chat transcript shows a run where it was spawned; this shows them all at
 * once, which is what you want when three subagents are running in parallel and
 * their cards are scattered across hundreds of rows. Clicking a run opens the
 * inspector.
 */
import { useMemo } from "react";
import { Bot, Clock, Wrench, CornerDownRight } from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { openAgentRun, useAgentRun, useRunElapsed } from "../../stores/agentRun.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import { runDuration, sortRunsForRoster, type SubagentRun } from "../../lib/subagentRuns.js";
import {
  AgentGlyph,
  EffortMeter,
  RunProgressRail,
  RunStatusChip,
} from "../agents/runVisuals.js";
import { cn } from "../../lib/cn.js";

function RunRow({ run, active }: { run: SubagentRun; active: boolean }) {
  const live = run.status === "running";
  const elapsed = useRunElapsed(run.startedAt, run.durationMs, live);

  return (
    <button
      onClick={() => openAgentRun(run.chatId, run.id)}
      className={cn(
        "group w-full rounded-md border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-accent-line bg-accent-ghost/40"
          : live
            ? "border-accent-line/60 bg-accent-ghost/20 hover:bg-accent-ghost/35"
            : run.status === "failed"
              ? "border-danger-ghost bg-danger-ghost/15 hover:bg-danger-ghost/25"
              : "border-line bg-panel-2/50 hover:bg-panel-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentGlyph status={run.status} size={5} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-primary">
          {run.agentType}
        </span>
        <span className={cn("cm-mono !text-[10px] tabular-nums", live ? "text-accent-hi" : "text-faint")}>
          {runDuration(elapsed)}
        </span>
      </div>

      {/* how this run was configured — differs from the chat's own model/effort
          whenever an agent definition pins its own or the model downgraded it */}
      {(run.model || run.effort) && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-faint">
          {run.model && (
            <span className="min-w-0 truncate cm-mono !text-[10px]" title={run.model}>
              {run.model}
            </span>
          )}
          {run.effort && (
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-1"
              title={`ran at effort: ${run.effort}`}
            >
              <EffortMeter effort={run.effort} />
              {run.effort}
            </span>
          )}
        </div>
      )}

      {run.description && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted">
          {run.description}
        </p>
      )}

      {live && run.latest && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className="size-1 shrink-0 rounded-full bg-accent cm-anim-pulse" />
          <span className="min-w-0 truncate cm-mono !text-[10px] text-accent-hi/90">
            {run.latest}
          </span>
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <RunProgressRail run={run} className="min-w-0 flex-1" />
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-faint [&_svg]:size-3">
          <Wrench />
          {run.toolCount}
        </span>
        {run.parentRunId && (
          <span title="Spawned by another subagent" className="shrink-0 text-faint [&_svg]:size-3">
            <CornerDownRight />
          </span>
        )}
        <RunStatusChip status={run.status} />
      </div>
    </button>
  );
}

export function AgentsPanel({ chat }: { chat: Chat }) {
  const openId = useAgentRun((s) => (s.target?.chatId === chat.id ? s.target.runId : null));
  const derived = useSubagentRuns(chat.id);
  const runs = useMemo(() => sortRunsForRoster(derived), [derived]);

  const liveCount = runs.filter((r) => r.status === "running").length;

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-5">
          <Bot />
        </span>
        <p className="text-[12.5px] text-secondary">No subagents yet</p>
        <p className="text-[11.5px] text-muted">
          Runs appear here when the agent spawns one with the Task tool.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
          {liveCount > 0 ? `${liveCount} running` : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
        </span>
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] text-faint [&_svg]:size-3">
            <Clock />
            live
          </span>
        )}
      </div>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} active={openId === run.id} />
      ))}
    </div>
  );
}
