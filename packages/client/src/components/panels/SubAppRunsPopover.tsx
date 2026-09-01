import { useEffect, useMemo, useState } from "react";
import { ExternalLink, GitBranch, SquareTerminal } from "lucide-react";
import type { RunnerInstance, SubApp } from "@dispatch/shared";
import { useRunners } from "../../stores/runners.js";
import { cn } from "../../lib/cn.js";
import { relTimeShort } from "../../lib/format.js";
import { Popover } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { StatusDot } from "../ui/StatusDot.js";
import { RunnerTranscript } from "./RunnerTranscript.js";
import { openRunnerLogWindow } from "./RunnerLogWindow.js";

const ACTIVE = new Set<RunnerInstance["status"]>(["starting", "running", "stopping"]);

export function sortSubAppRuns(
  runs: RunnerInstance[],
  projectId: string,
  subAppId: string,
): RunnerInstance[] {
  return runs
    .filter((run) => run.projectId === projectId && run.subAppId === subAppId)
    .sort((a, b) => {
      const active = Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status));
      return active || (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });
}

function outcome(run: RunnerInstance): { label: string; tone: Tone } {
  if (run.status === "starting") return { label: "starting", tone: "accent" };
  if (run.status === "running") return { label: "running", tone: "accent" };
  if (run.status === "stopping") return { label: "stopping", tone: "warn" };
  if (run.status === "crashed") {
    if (run.exitCode !== undefined && run.exitCode !== null) {
      return { label: `exit ${run.exitCode}`, tone: "danger" };
    }
    if (run.exitSignal) return { label: run.exitSignal, tone: "danger" };
    return { label: "failed", tone: "danger" };
  }
  if (run.status === "exited") return { label: "exit 0", tone: "success" };
  return { label: "stopped", tone: "muted" };
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: RunnerInstance;
  selected: boolean;
  onSelect: () => void;
}) {
  const active = ACTIVE.has(run.status);
  const result = outcome(run);
  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      className={cn(
        "!h-auto w-full !items-start !justify-start !rounded-none !px-2.5 !py-2 text-left",
        selected && "!bg-active",
      )}
    >
      <StatusDot
        tone={active ? "working" : run.status === "crashed" ? "danger" : "muted"}
        pulse={active}
        size={5}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-secondary">
            {run.branch ?? "untracked branch"}
          </span>
          <span className="ml-auto shrink-0 text-2xs text-faint">
            {run.startedAt ? relTimeShort(run.startedAt) : "—"}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <Chip tone={result.tone} mono={result.label.startsWith("exit")}>
            {result.label}
          </Chip>
          {run.port && <span className="cm-mono !text-2xs text-faint">:{run.port}</span>}
        </span>
      </span>
    </Button>
  );
}

function RunsMenu({ app, projectId }: { app: SubApp; projectId: string }) {
  const byId = useRunners((s) => s.byId);
  const runs = useMemo(
    () => sortSubAppRuns(Object.values(byId), projectId, app.id).slice(0, 12),
    [byId, projectId, app.id],
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(runs[0]?.id);
  useEffect(() => {
    if (!selectedId || !runs.some((run) => run.id === selectedId)) {
      setSelectedId(runs[0]?.id);
    }
  }, [runs, selectedId]);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];

  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <SquareTerminal className="size-3.5 text-accent-hi" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
          {app.name} runs
        </span>
        <Chip tone="muted">{runs.length ? `${runs.length} recent` : "no runs"}</Chip>
      </div>

      {selected ? (
        <div className="flex h-[340px] min-h-0">
          <div className="cm-scroll w-44 shrink-0 overflow-y-auto border-r border-line-soft bg-panel-2/40">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                selected={run.id === selected.id}
                onSelect={() => setSelectedId(run.id)}
              />
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-10 items-center gap-1.5 border-b border-line-soft px-2.5 py-1.5">
              <GitBranch className="size-3 shrink-0 text-muted" />
              <span className="min-w-0 truncate cm-mono !text-2xs text-secondary">
                {selected.branch ?? selected.worktreePath}
              </span>
              {selected.url && (
                <IconButton
                  size="sm"
                  tip="Open app"
                  className="ml-auto"
                  onClick={() => window.open(selected.url, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink />
                </IconButton>
              )}
              <IconButton
                size="sm"
                tip="Pop out run output"
                onClick={() => openRunnerLogWindow(selected.id, app.name)}
              >
                <SquareTerminal />
              </IconButton>
            </div>
            <RunnerTranscript
              runnerId={selected.id}
              active={ACTIVE.has(selected.status)}
              className="min-h-0 flex-1"
            />
          </div>
        </div>
      ) : (
        <div className="px-5 py-10 text-center">
          <SquareTerminal className="mx-auto mb-2 size-5 text-faint" />
          <p className="text-sm text-muted">No runs yet.</p>
          <p className="mt-0.5 text-xs text-faint">
            Start this app and its live output will appear here.
          </p>
        </div>
      )}
    </div>
  );
}

export function SubAppRunsPopover({
  app,
  projectId,
  latest,
}: {
  app: SubApp;
  projectId: string;
  latest?: RunnerInstance;
}) {
  return (
    <Popover
      side="right"
      align="start"
      width={520}
      className="p-0"
      trigger={({ open, toggle }) => (
        <IconButton
          size="sm"
          tip="Current and recent runs"
          active={open}
          onClick={toggle}
          className={cn(
            "cm-touch-reveal opacity-0 group-hover:opacity-100",
            latest?.status === "crashed" && "opacity-100 text-danger",
          )}
        >
          <SquareTerminal />
        </IconButton>
      )}
    >
      <RunsMenu app={app} projectId={projectId} />
    </Popover>
  );
}
