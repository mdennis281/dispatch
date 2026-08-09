/**
 * The AGENTS rail — every subagent run in the chat, live ones first.
 *
 * The chat transcript shows a run where it was spawned; this shows them all at
 * once, which is what you want when three subagents are running in parallel and
 * their cards are scattered across hundreds of rows. Clicking a run opens the
 * inspector.
 */
import { useMemo } from "react";
import { Bot, Clock, Wrench, CornerDownRight, FolderGit2, FilePen, TriangleAlert } from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { openAgentRun, useAgentRun, useRunElapsed } from "../../stores/agentRun.js";
import { useSubagentRuns } from "../../lib/useSubagentRuns.js";
import { runDuration, sortRunsForRoster, type SubagentRun } from "../../lib/subagentRuns.js";
import { rootLabel } from "../../lib/runLocation.js";
import {
  AgentGlyph,
  EffortMeter,
  RunProgressRail,
  RunStatusChip,
} from "../agents/runVisuals.js";
import { cn } from "../../lib/cn.js";

/**
 * WHERE this run is working — the line the rail was missing on 2026-08-07, when
 * five concurrent subagents shared one session cwd, a parent `EnterWorktree`
 * moved them all, and two edits landed on another agent's branch with nothing on
 * screen to say so (see `lib/runLocation.ts`).
 *
 * Renders nothing when the run's rows named no path: a blank is honest, and a
 * guessed directory here would be worse than the silence it replaced. The stray
 * case is loud and always shown, because that is the whole reason for the row.
 */
function RunWhere({ run }: { run: SubagentRun }) {
  const { home, current, strayRoots, strayFiles, files } = run.location;
  const where = current ?? home;
  if (!where) return null;
  const stray = strayRoots.length > 0;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-0.5">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-2xs [&_svg]:size-3",
          stray ? "text-danger" : "text-faint",
        )}
        title={stray ? `working in ${current}\nexpected ${home}` : where}
      >
        <FolderGit2 className="shrink-0" />
        <span className="min-w-0 truncate cm-mono !text-2xs">{rootLabel(where)}</span>
        {files.length > 0 && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1"
            title={files.join("\n")}
          >
            <FilePen />
            {files.length}
          </span>
        )}
      </div>
      {stray && (
        <div
          className="flex min-w-0 items-start gap-1.5 rounded border border-danger-ghost bg-danger-ghost/20 px-1.5 py-1 text-2xs leading-snug text-danger [&_svg]:size-3"
          title={strayFiles.join("\n")}
        >
          <TriangleAlert className="mt-px shrink-0" />
          <span className="min-w-0">
            Wrote {strayFiles.length} {strayFiles.length === 1 ? "file" : "files"} outside{" "}
            <span className="cm-mono !text-2xs">{rootLabel(home ?? "")}</span> — in{" "}
            {strayRoots.map((r) => rootLabel(r)).join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}

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
          : // A run that wrote outside its own worktree is flagged ahead of its
            // status: a "done" run that landed files on someone else's branch is
            // the case the rail exists to catch.
            run.location.strayRoots.length > 0
            ? "border-danger bg-danger-ghost/15 hover:bg-danger-ghost/25"
            : live
              ? "border-accent-line/60 bg-accent-ghost/20 hover:bg-accent-ghost/35"
              : run.status === "failed"
                ? "border-danger-ghost bg-danger-ghost/15 hover:bg-danger-ghost/25"
                : "border-line bg-panel-2/50 hover:bg-panel-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AgentGlyph status={run.status} size={5} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
          {run.agentType}
        </span>
        <span className={cn("cm-mono !text-2xs tabular-nums", live ? "text-accent-hi" : "text-faint")}>
          {runDuration(elapsed)}
        </span>
      </div>

      {/* how this run was configured — differs from the chat's own model/effort
          whenever an agent definition pins its own or the model downgraded it */}
      {(run.model || run.effort) && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-faint">
          {run.model && (
            <span className="min-w-0 truncate cm-mono !text-2xs" title={run.model}>
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

      <RunWhere run={run} />

      {run.description && (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted">
          {run.description}
        </p>
      )}

      {live && run.latest && (
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className="size-1 shrink-0 rounded-full bg-accent cm-anim-pulse" />
          <span className="min-w-0 truncate cm-mono !text-2xs text-accent-hi/90">
            {run.latest}
          </span>
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2">
        <RunProgressRail run={run} className="min-w-0 flex-1" />
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-faint [&_svg]:size-3">
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
  const strayCount = runs.filter((r) => r.location.strayRoots.length > 0).length;

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted [&_svg]:size-5">
          <Bot />
        </span>
        <p className="text-base text-secondary">No subagents yet</p>
        <p className="text-xs text-muted">
          Runs appear here when the agent spawns one with the Task tool.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">
          {liveCount > 0 ? `${liveCount} running` : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
        </span>
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1 text-2xs text-faint [&_svg]:size-3">
            <Clock />
            live
          </span>
        )}
        {strayCount > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-2xs font-semibold text-danger [&_svg]:size-3"
            title="A run wrote files outside the worktree it started in — check its branch before committing."
          >
            <TriangleAlert />
            {strayCount} off-worktree
          </span>
        )}
      </div>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} active={openId === run.id} />
      ))}
    </div>
  );
}
