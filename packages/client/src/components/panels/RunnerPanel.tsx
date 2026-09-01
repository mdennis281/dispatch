import { useState } from "react";
import {
  Gamepad2,
  Database,
  Clapperboard,
  Square,
  Play,
  ExternalLink,
  Circle,
  Rocket,
  Terminal,
  GitBranch,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import type { Chat, RunnerInstance, SubApp } from "@dispatch/shared";
import { useRunners, belongsToChat } from "../../stores/runners.js";
import { useProjects } from "../../stores/projects.js";
import { actions } from "../../lib/actions.js";
import { openCodeViewer } from "../monaco/store.js";
import { StatusDot } from "../ui/StatusDot.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { SectionLabel } from "../ui/Panel.js";
import { cn } from "../../lib/cn.js";
import { openRunnerLogWindow } from "./RunnerLogWindow.js";
import { RunnerTranscript } from "./RunnerTranscript.js";
import { ProcessesPanel } from "./ProcessesPanel.js";
import { BranchWorktreePicker } from "./BranchWorktreePicker.js";
import {
  useLaunchTargets,
  useLaunchBranch,
  launchSubApp,
  findRunner,
  type LaunchTarget,
} from "./useLauncher.js";

const SUBAPP_ICON: Record<string, LucideIcon> = {
  game: Gamepad2,
  "metrics-server": Database,
  "studio-director": Clapperboard,
};

const ACTIVE = new Set<RunnerInstance["status"]>(["starting", "running"]);

function RunnerCard({ runner }: { runner: RunnerInstance }) {
  const Icon = SUBAPP_ICON[runner.subAppId] ?? Circle;
  const running = runner.status === "running";
  const active = ACTIVE.has(runner.status);

  const open = () => {
    if (runner.url) window.open(runner.url, "_blank", "noopener,noreferrer");
  };
  const popOut = () => openRunnerLogWindow(runner.id, runner.subAppId);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
            active ? "bg-accent-ghost text-accent-hi ring-accent-line" : "bg-panel-2 text-muted ring-line",
          )}
        >
          <Icon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-primary">{runner.subAppId}</span>
          <span className="flex items-center gap-1.5 text-2xs text-faint">
            <StatusDot tone={running ? "working" : runner.status === "crashed" ? "danger" : "muted"} pulse={active} size={5} />
            {runner.status === "starting" ? "starting…" : running ? "running" : runner.status}
            {runner.pid && <span className="cm-mono">· pid {runner.pid}</span>}
          </span>
        </span>
        {/* Started from the Sidebar, which launches per PROJECT rather than per
            chat. Say so, or the card looks like something this chat started and
            Stop reads as "stop my app" when it's shared with every other chat. */}
        {!runner.chatId && (
          <Chip tone="muted" title="Launched from the sidebar — belongs to the project, not this chat">
            project
          </Chip>
        )}
        {runner.usedDocker && <Chip tone="info">docker</Chip>}
        {runner.port &&
          (runner.url ? (
            <button
              onClick={open}
              title={`Open ${runner.url}`}
              className="rounded-full outline-none transition-transform hover:-translate-y-px focus-visible:ring-1 focus-visible:ring-accent-line"
            >
              <Chip tone="success" mono>
                :{runner.port}
              </Chip>
            </button>
          ) : (
            <Chip tone="success" mono>
              :{runner.port}
            </Chip>
          ))}
      </div>

      {/* branch this runner is on */}
      {runner.branch && (
        <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-1 text-2xs text-faint [&_svg]:size-3">
          <GitBranch className="text-accent-hi/70" />
          <span className="truncate cm-mono !text-2xs text-muted">{runner.branch}</span>
        </div>
      )}

      {runner.url && (
        <button
          onClick={open}
          className="flex w-full items-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-left text-xs text-accent-hi transition-colors hover:bg-hover [&_svg]:size-3"
        >
          <ExternalLink />
          <span className="cm-mono !text-2xs truncate">{runner.url}</span>
        </button>
      )}

      <div className="border-t border-line-soft">
        <div className="flex items-center gap-1.5 px-3 pt-1.5">
          <span className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">Output</span>
          <button
            onClick={popOut}
            title="Pop out logs into a separate window"
            className="ml-auto flex items-center gap-1 text-2xs text-muted transition-colors hover:text-accent-hi [&_svg]:size-3"
          >
            <Terminal />
            pop out
          </button>
        </div>
        <RunnerTranscript runnerId={runner.id} active={active} className="max-h-48" />
      </div>

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
        {active ? (
          <Button size="sm" variant="danger" leftIcon={<Square />} onClick={() => actions.stopRunner(runner.id)}>
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="default"
            leftIcon={<Play />}
            onClick={() =>
              actions.startRunner({
                worktreePath: runner.worktreePath,
                branch: runner.branch,
                subAppId: runner.subAppId,
                projectId: runner.projectId,
                chatId: runner.chatId,
              })
            }
          >
            Restart
          </Button>
        )}
        <IconButton size="sm" tip="Pop out logs" className="ml-auto" onClick={popOut}>
          <Terminal />
        </IconButton>
        <IconButton size="sm" tip="Open URL" disabled={!runner.url} onClick={open}>
          <ExternalLink />
        </IconButton>
      </div>
    </div>
  );
}

/** Row in the launcher: start a subApp on the selected target. */
function LaunchRow({
  subApp,
  target,
  projectId,
  chatId,
  runningRunner,
}: {
  subApp: SubApp;
  target: LaunchTarget | undefined;
  projectId: string;
  chatId: string;
  runningRunner: RunnerInstance | undefined;
}) {
  const Icon = SUBAPP_ICON[subApp.id] ?? Circle;
  const isActive = !!runningRunner && ACTIVE.has(runningRunner.status);
  const canStart = !!target && !isActive;

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-secondary">{subApp.name}</span>
        {subApp.ports && subApp.ports.length > 0 && (
          <span className="cm-mono !text-2xs text-faint">:{subApp.ports.join(" :")}</span>
        )}
      </span>
      {subApp.dockerCompose && <Chip tone="muted">docker</Chip>}
      {isActive ? (
        <Chip tone="success" icon={<StatusDot tone="working" pulse size={5} />}>
          running
        </Chip>
      ) : (
        <Button
          size="sm"
          variant="subtle"
          leftIcon={<Play />}
          disabled={!canStart}
          onClick={() => launchSubApp(target, subApp.id, projectId, chatId)}
        >
          Start
        </Button>
      )}
    </div>
  );
}

export function RunnerPanel({ chat }: { chat: Chat }) {
  const project = useProjects((s) => s.projects.find((p) => p.id === chat.projectId));
  const byId = useRunners((s) => s.byId);
  const order = useRunners((s) => s.order);
  const mine = order
    .map((id) => byId[id]!)
    .filter((r) => r && belongsToChat(r, chat.id, chat.projectId));

  const subApps = project?.subApps ?? [];
  const { targets } = useLaunchTargets(project?.id);

  // Selected launch branch — shared with the sidebar's Apps picker, seeded from
  // this chat's own worktree when nothing has been chosen yet.
  const {
    branch: selectedBranch,
    setBranch: setSelectedBranch,
    target: selectedTarget,
  } = useLaunchBranch(project?.id, targets, chat.worktrees[0]);

  // No chatId in the match — deliberately, and matching what the Sidebar has
  // always done. "Is this subApp already up?" is a question about the BRANCH and
  // its ports, not about who pressed Start: a sidebar-launched app used to leave
  // this row showing an enabled Start, and pressing it launched a second copy of
  // something already holding the port.
  const activeFor = (subAppId: string) =>
    findRunner(byId, {
      subAppId,
      branch: selectedTarget?.branch,
      worktreePath: selectedTarget?.worktreePath,
    });

  const editDefinitions = () => {
    if (!project?.repoPath) return;
    openCodeViewer({
      worktreePath: project.repoPath,
      relPath: ".dispatch/project.yaml",
      mode: "file",
      base: project.defaultBranch || "main",
      editable: true,
    });
  };

  if (mine.length === 0 && subApps.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <Gamepad2 className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-sm text-muted">No subApps configured.</p>
        <p className="mt-0.5 text-xs text-faint">Add subApps to this project to run them here.</p>
        {project?.repoPath && (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="subtle" leftIcon={<SquarePen />} onClick={editDefinitions}>
              Edit definitions
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {subApps.length > 0 && (
        <div className="rounded-md border border-line bg-panel-2/40">
          <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-2">
            <Rocket className="size-3.5 text-muted" />
            <SectionLabel className="px-0">Launch</SectionLabel>
            <div className="ml-auto">
              <BranchWorktreePicker targets={targets} value={selectedBranch} onChange={setSelectedBranch} />
            </div>
            <IconButton
              size="sm"
              tip="Edit subApp definitions (.dispatch/project.yaml)"
              disabled={!project?.repoPath}
              onClick={editDefinitions}
            >
              <SquarePen />
            </IconButton>
          </div>
          <div className="p-1">
            {subApps.map((s) => (
              <LaunchRow
                key={s.id}
                subApp={s}
                target={selectedTarget}
                projectId={chat.projectId}
                chatId={chat.id}
                runningRunner={activeFor(s.id)}
              />
            ))}
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <div className="space-y-2.5">
          {mine.map((r) => (
            <RunnerCard key={r.id} runner={r} />
          ))}
        </div>
      )}

      {project && <ProcessesPanel projectId={project.id} />}
    </div>
  );
}
