import { useEffect, useRef } from "react";
import {
  Gamepad2,
  Database,
  Clapperboard,
  Square,
  Play,
  ExternalLink,
  Circle,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import type { Chat, RunnerInstance, SubApp } from "@cm/shared";
import { useRunners } from "../../stores/runners.js";
import { useProjects } from "../../stores/projects.js";
import { actions } from "../../lib/actions.js";
import { StatusDot } from "../ui/StatusDot.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { SectionLabel } from "../ui/Panel.js";
import { cn } from "../../lib/cn.js";
import { clock } from "../../lib/format.js";
import { samePath } from "./panelBus.js";

const SUBAPP_ICON: Record<string, LucideIcon> = {
  game: Gamepad2,
  "metrics-server": Database,
  "studio-director": Clapperboard,
};

const EMPTY_LOGS: import("../../stores/runners.js").RunnerLogLine[] = [];
const ACTIVE = new Set<RunnerInstance["status"]>(["starting", "running"]);

function RunnerCard({ runner }: { runner: RunnerInstance }) {
  const Icon = SUBAPP_ICON[runner.subAppId] ?? Circle;
  const logs = useRunners((s) => s.logs[runner.id] ?? EMPTY_LOGS);
  const running = runner.status === "running";
  const active = ACTIVE.has(runner.status);

  // Follow the tail: pin the log view to the bottom as lines stream in.
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const open = () => {
    if (runner.url) window.open(runner.url, "_blank", "noopener,noreferrer");
  };

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
          <span className="block truncate text-[12px] font-medium text-primary">{runner.subAppId}</span>
          <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
            <StatusDot tone={running ? "working" : runner.status === "crashed" ? "danger" : "muted"} pulse={active} size={5} />
            {runner.status === "starting" ? "starting…" : running ? "running" : runner.status}
            {runner.pid && <span className="cm-mono">· pid {runner.pid}</span>}
          </span>
        </span>
        {runner.usedDocker && <Chip tone="accent">docker</Chip>}
        {runner.port && (
          <Chip tone="success" mono>
            :{runner.port}
          </Chip>
        )}
      </div>

      {runner.url && (
        <button
          onClick={open}
          className="flex w-full items-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-left text-[11px] text-accent-hi transition-colors hover:bg-white/[0.02] [&_svg]:size-3"
        >
          <ExternalLink />
          <span className="cm-mono !text-[10.5px] truncate">{runner.url}</span>
        </button>
      )}

      {logs.length > 0 && (
        <div ref={logRef} className="cm-scroll max-h-48 overflow-y-auto border-t border-line-soft bg-inset px-3 py-2">
          {logs.map((l, i) => (
            <div key={i} className="flex gap-2 py-px cm-mono !text-[10.5px] leading-relaxed">
              <span className="shrink-0 text-faint">{clock(l.ts)}</span>
              <span className={cn("min-w-0 flex-1 break-all", l.stream === "stderr" ? "text-warn" : "text-secondary")}>
                {l.line}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
        {active ? (
          <Button size="xs" variant="danger" leftIcon={<Square />} onClick={() => actions.stopRunner(runner.id)}>
            Stop
          </Button>
        ) : (
          <Button
            size="xs"
            variant="default"
            leftIcon={<Play />}
            onClick={() =>
              actions.startRunner({
                worktreePath: runner.worktreePath,
                subAppId: runner.subAppId,
                projectId: runner.projectId,
                chatId: runner.chatId,
              })
            }
          >
            Restart
          </Button>
        )}
        <IconButton size="sm" tip="Open URL" className="ml-auto" disabled={!runner.url} onClick={open}>
          <ExternalLink />
        </IconButton>
      </div>
    </div>
  );
}

/** Row in the launcher: start a subApp in this chat's worktree. */
function LaunchRow({
  subApp,
  worktreePath,
  projectId,
  chatId,
  runningRunner,
}: {
  subApp: SubApp;
  worktreePath: string | undefined;
  projectId: string;
  chatId: string;
  runningRunner: RunnerInstance | undefined;
}) {
  const Icon = SUBAPP_ICON[subApp.id] ?? Circle;
  const isActive = !!runningRunner && ACTIVE.has(runningRunner.status);
  const canStart = !!worktreePath && !isActive;

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <Icon className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-secondary">{subApp.name}</span>
        {subApp.ports && subApp.ports.length > 0 && (
          <span className="cm-mono !text-[10px] text-faint">:{subApp.ports.join(" :")}</span>
        )}
      </span>
      {subApp.dockerCompose && <Chip tone="muted">docker</Chip>}
      {isActive ? (
        <Chip tone="success" icon={<StatusDot tone="working" pulse size={5} />}>
          running
        </Chip>
      ) : (
        <Button
          size="xs"
          variant="subtle"
          leftIcon={<Play />}
          disabled={!canStart}
          onClick={() =>
            worktreePath && actions.startRunner({ worktreePath, subAppId: subApp.id, projectId, chatId })
          }
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
  const mine = order.map((id) => byId[id]!).filter((r) => r && r.chatId === chat.id);

  const subApps = project?.subApps ?? [];
  const worktreePath = chat.worktrees[0];

  // Which subApp already has a live runner in this chat's worktree.
  const activeFor = (subAppId: string) =>
    mine.find((r) => r.subAppId === subAppId && worktreePath && samePath(r.worktreePath, worktreePath) && ACTIVE.has(r.status));

  if (mine.length === 0 && subApps.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <Gamepad2 className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-[12px] text-muted">No subApps configured.</p>
        <p className="mt-0.5 text-[11px] text-faint">Add subApps to this project to run them here.</p>
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
          </div>
          <div className="p-1">
            {!worktreePath && (
              <p className="px-2 py-1.5 text-[10.5px] text-faint">Create a worktree to run subApps in isolation.</p>
            )}
            {subApps.map((s) => (
              <LaunchRow
                key={s.id}
                subApp={s}
                worktreePath={worktreePath}
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
    </div>
  );
}
