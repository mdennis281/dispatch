import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsUpDown,
  Plus,
  Play,
  Square,
  Gamepad2,
  Database,
  Clapperboard,
  FolderGit2,
  Bot,
  Circle,
  Trash2,
  Pencil,
  Check,
  X,
  Brain,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import type { Chat, SubApp, RunnerInstance, Project } from "@dispatch/shared";
import { Popover, MenuItem } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { StatusDot, statusMeta } from "../ui/StatusDot.js";
import { purposeIcon } from "../config/sections.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { useProjects, useActiveProject } from "../../stores/projects.js";
import { useChats, useProjectChats } from "../../stores/chats.js";
import { useView } from "../../stores/view.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useGit, useGitChangeCount } from "../../stores/git.js";
import { useRunners } from "../../stores/runners.js";
import { useAttention } from "../../stores/attention.js";
import { actions, deleteChat } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";
import { midTruncate, relTimeShort } from "../../lib/format.js";
import { useFlipReorder } from "../../lib/useFlip.js";
import { AddProjectDialog } from "../sidebar/AddProjectDialog.js";
import { ManageConfigDialog } from "../sidebar/ManageConfigDialog.js";
import { RenameChatDialog } from "../chat/RenameChatDialog.js";
import { BranchWorktreePicker } from "../panels/BranchWorktreePicker.js";
import {
  useLaunchTargets,
  defaultBranch,
  launchSubApp,
  findRunner,
  type LaunchTarget,
} from "../panels/useLauncher.js";

const SUBAPP_ICON: Record<string, LucideIcon> = {
  game: Gamepad2,
  "metrics-server": Database,
  "studio-director": Clapperboard,
};

/** Runner states that mean "this subApp is live / in-flight" (vs a dead record). */
function isActive(status: RunnerInstance["status"] | undefined): boolean {
  return status === "running" || status === "starting" || status === "stopping";
}

/* ------------------------------------------------------------ project head */

function ProjectSelector({
  onAddProject,
  onManageConfig,
}: {
  onAddProject: () => void;
  onManageConfig: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const active = useActiveProject();
  const setActive = useProjects((s) => s.setActiveProject);

  return (
    <Popover
      align="start"
      width={236}
      className="p-1"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-left transition-colors hover:border-line-strong",
            open && "border-line-strong",
          )}
        >
          <span className="flex size-6 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
            <FolderGit2 />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-primary">
              {active?.name ?? "No project"}
            </span>
            <span className="block truncate cm-mono !text-[9.5px] text-faint">
              {active ? midTruncate(active.repoPath, 30) : "—"}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col">
          {projects.length === 0 && (
            <p className="px-2 py-1.5 text-[11.5px] text-faint">No projects yet.</p>
          )}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              icon={<FolderGit2 />}
              active={p.id === active?.id}
              onClick={() => {
                setActive(p.id);
                close();
              }}
            >
              {p.name}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={<Plus />}
            onClick={() => {
              close();
              onAddProject();
            }}
          >
            Add project…
          </MenuItem>
          <MenuItem
            icon={<Bot />}
            onClick={() => {
              close();
              onManageConfig();
            }}
          >
            Agents &amp; modes…
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ subApp */

function SubAppRow({
  app,
  project,
  target,
  runner,
}: {
  app: SubApp;
  project: Project;
  target: LaunchTarget | undefined;
  runner?: RunnerInstance;
}) {
  const Icon = SUBAPP_ICON[app.id] ?? Circle;
  const [busy, setBusy] = useState(false);

  // The server publishes runner-update on start/stop; clear the local pending
  // flag the moment a fresh status lands so the control settles on truth.
  useEffect(() => {
    setBusy(false);
  }, [runner?.status]);

  const running = runner?.status === "running";
  const transitioning = busy || runner?.status === "starting" || runner?.status === "stopping";

  const start = () => {
    if (!target) return;
    setBusy(true);
    launchSubApp(target, app.id, project.id);
  };
  const stop = () => {
    if (!runner) return;
    setBusy(true);
    actions.stopRunner(runner.id);
  };

  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.035]">
      <Icon className={cn("size-3.5 shrink-0", running ? "text-accent-hi" : "text-muted")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-secondary group-hover:text-primary">
          {app.name}
        </span>
      </span>
      {running && runner?.port && (
        <Chip tone="success" mono>
          :{runner.port}
        </Chip>
      )}
      {transitioning ? (
        <span className="flex size-6 items-center justify-center">
          <Spinner size={12} />
        </span>
      ) : running ? (
        <IconButton size="sm" tip="Stop" onClick={stop}>
          <Square />
        </IconButton>
      ) : (
        <IconButton
          size="sm"
          tip="Run"
          onClick={start}
          disabled={!target}
          className="opacity-0 group-hover:opacity-100"
        >
          <Play />
        </IconButton>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- chat */

function ChatRow({
  chat,
  active,
  needsInput,
  now,
  onClick,
}: {
  chat: Chat;
  active: boolean;
  needsInput: boolean;
  /** Shared "current time" tick so every row ages in lockstep. */
  now: number;
  onClick: () => void;
}) {
  const prSettled = useChats((s) => s.prSettled[chat.id] ?? false);
  const meta = statusMeta(chat.status, prSettled);
  // Per-row subscription: re-renders this row (and refreshes its age) the moment
  // its activity clock advances — the recency ordering itself lives in the selector.
  const activityAt = useChats(
    (s) => s.lastActivity[chat.id] ?? chat.updatedAt ?? chat.createdAt,
  );
  const age = relTimeShort(activityAt, now);
  const PurposeIcon = purposeIcon(chat.purpose?.kind);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // Two-click inline confirm (trash → check/✕) so a stray click can't nuke a
  // chat. On confirm: delete server-side, then purge the local stores + reselect
  // (mirrors the header dialog path). A failure just resets so the user retries.
  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteChat(chat.id);
      useAttention.getState().clearChat(chat.id);
      useChats.getState().removeChat(chat.id);
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="group/row relative" data-flip-id={chat.id}>
      <button
        data-testid="chat-row"
        onClick={onClick}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-8 text-left transition-colors",
          active ? "bg-accent-ghost/70" : "hover:bg-white/[0.04]",
        )}
      >
        {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
        {/* A chat the app spawned for a job wears that job's icon instead of the
            status dot — in a sidebar of a dozen rows it's the only way to spot
            the one that's off editing your config. Status still reads from the
            row's subtitle, and an unknown purpose kind falls back to the dot. */}
        {PurposeIcon ? (
          <span
            title={chat.purpose?.label ?? chat.purpose?.kind}
            className={cn(
              "flex size-[15px] shrink-0 items-center justify-center rounded-[4px]",
              "bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-2.5",
              meta.pulse && "animate-pulse",
            )}
          >
            <PurposeIcon />
          </span>
        ) : (
          <StatusDot tone={meta.tone} pulse={meta.pulse} size={7} />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[12.5px]",
              active ? "font-semibold text-primary" : "text-secondary",
            )}
          >
            {chat.title}
          </span>
          <span className="mt-px block truncate text-[10.5px] text-faint">
            {meta.label}
            <span className="text-faint/70"> · {age}</span>
          </span>
        </span>
      </button>

      {/* right rail (sibling of the row button — never a nested button): the
          needs-input dot by default, swapped for a hover-revealed delete that
          expands to a check/✕ confirm. */}
      <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        {confirming ? (
          <>
            <IconButton
              size="sm"
              tip="Confirm delete"
              onClick={doDelete}
              className="!text-danger hover:!bg-danger/15"
            >
              {busy ? <Spinner size={12} /> : <Check />}
            </IconButton>
            <IconButton size="sm" tip="Cancel" onClick={() => setConfirming(false)}>
              <X />
            </IconButton>
          </>
        ) : (
          <>
            {needsInput && (
              <StatusDot tone="warn" pulse size={6} className="group-hover/row:hidden" />
            )}
            <IconButton
              size="sm"
              tip="Rename chat"
              onClick={() => setRenaming(true)}
              className="opacity-0 group-hover/row:opacity-100"
            >
              <Pencil />
            </IconButton>
            <IconButton
              size="sm"
              tip="Delete chat"
              onClick={() => setConfirming(true)}
              className="opacity-0 group-hover/row:opacity-100"
            >
              <Trash2 />
            </IconButton>
          </>
        )}
      </div>

      <RenameChatDialog chatId={chat.id} open={renaming} onClose={() => setRenaming(false)} />
    </div>
  );
}

/* -------------------------------------------------------------- top-level nav */

/** A chat-independent, project-scoped surface toggle (Memory, Source Control). */
function NavButton({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** Right-aligned tally; hidden when undefined (never rendered as "0"). */
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors [&_svg]:size-3.5",
        active
          ? "bg-accent-ghost text-primary"
          : "text-secondary hover:bg-panel-2/60 hover:text-primary",
      )}
    >
      <Icon className={active ? "text-accent" : "text-muted"} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && (
        <span className="cm-mono !text-[9.5px] text-faint">{count}</span>
      )}
    </button>
  );
}

/* ----------------------------------------------------------------- sidebar */

/**
 * Fire-and-focus chat creation: dispatch create-chat with DEFAULTS (current
 * project, default mode/effort, no custom agent) and select the chat the moment
 * its id streams back into the store — no dialog. create-chat is fire-and-forget,
 * so we watch the chats store for the newly-appeared id (with an 8s safety net).
 */
function createChatAndFocus(input: { projectId: string; modeId?: string }): void {
  const before = new Set(useChats.getState().order);
  actions.createChat({
    projectId: input.projectId,
    modeId: input.modeId,
    effort: "medium",
  });

  let done = false;
  const finish = (id: string) => {
    if (done) return;
    done = true;
    unsub();
    clearTimeout(timer);
    useChats.getState().setActiveChat(id);
  };
  const unsub = useChats.subscribe((s) => {
    const fresh = s.order.find((id) => !before.has(id));
    if (fresh) finish(fresh);
  });
  const timer = setTimeout(() => {
    done = true;
    unsub();
  }, 8000);
}

export function Sidebar() {
  const project = useActiveProject();
  const chats = useProjectChats(project?.id ?? null);
  const activeChatId = useChats((s) => s.activeChatId);
  const setActiveChatRaw = useChats((s) => s.setActiveChat);
  const runners = useRunners((s) => s.byId);
  const attentionItems = useAttention((s) => s.items);
  const view = useView((s) => s.view);
  const setView = useView((s) => s.setView);
  const memCount = useProjectMemories(project?.id ?? null).length;
  const changeCount = useGitChangeCount();

  // Keep the Source Control tally live without opening the view. One `git
  // status` a minute is nothing, and it means the badge is already right when
  // you go looking — the open view polls far faster on its own.
  const setGitRepo = useGit((s) => s.setRepoPath);
  const refreshGit = useGit((s) => s.refresh);
  useEffect(() => {
    setGitRepo(project?.repoPath ?? null);
  }, [project?.repoPath, setGitRepo]);
  useEffect(() => {
    if (!project?.repoPath) return;
    const t = setInterval(() => void refreshGit(), 60_000);
    return () => clearInterval(t);
  }, [project?.repoPath, refreshGit]);

  // Opening a chat always returns to the chat workspace (out of the Memory view).
  const setActiveChat = (id: string) => {
    setView("chat");
    setActiveChatRaw(id);
  };

  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  // Project-level launch target for the Apps section — same picker as the right
  // panel, defaulting to the project's default (current) branch.
  const { targets } = useLaunchTargets(project?.id);
  const [selectedBranch, setSelectedBranch] = useState<string | undefined>();
  useEffect(() => {
    if (!targets.some((t) => t.branch === selectedBranch)) {
      setSelectedBranch(defaultBranch(targets, project?.repoPath));
    }
  }, [targets, selectedBranch, project?.repoPath]);
  const selectedTarget = targets.find((t) => t.branch === selectedBranch);

  // Shared clock so every chat row's "age" label ages together. 30s is plenty
  // for m/h/d/w granularity and keeps the sidebar idle-cheap.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // FLIP: animate chat rows sliding to their new slot when activity reorders them.
  const chatListRef = useRef<HTMLDivElement>(null);
  useFlipReorder(chatListRef);

  // New chat = instant create with defaults + auto-select (no dialog). Gated on a
  // selected project, so the trigger is disabled until there's somewhere to create.
  const startNewChat = () => {
    if (!project) return;
    setView("chat");
    // Deterministic default: "auto" is always a valid primary segment (both the
    // broker's mode-fallback map and the composer understand it without a stored
    // ModeConfig), so a fresh chat opens on Auto — never on whichever mode file
    // happened to enumerate first on disk (readdir order is arbitrary).
    createChatAndFocus({ projectId: project.id, modeId: "auto" });
  };

  const attentionByChat = useMemo(() => {
    const set = new Set<string>();
    for (const i of attentionItems) {
      if (i.kind === "permission" || i.kind === "question") set.add(i.chatId);
    }
    return set;
  }, [attentionItems]);

  // Match a live runner to the SELECTED branch/worktree target (so the row's
  // Run/Stop reflects the branch the picker is pointed at).
  const runnerFor = (subAppId: string): RunnerInstance | undefined =>
    findRunner(runners, {
      subAppId,
      branch: selectedTarget?.branch,
      worktreePath: selectedTarget?.worktreePath,
    });

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 shrink-0 items-center px-2.5 cm-hairline-b">
        <ProjectSelector
          onAddProject={() => setAddProjectOpen(true)}
          onManageConfig={() => setManageOpen(true)}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 py-2">
        {/* top-level nav: chat-independent, project-scoped surfaces */}
        <div className="space-y-0.5 px-1.5 pb-1">
          <NavButton
            icon={Brain}
            label="Memory"
            count={memCount}
            active={view === "memory"}
            onClick={() => setView(view === "memory" ? "chat" : "memory")}
          />
          <NavButton
            icon={GitBranch}
            label="Source Control"
            // Only a non-zero tally is worth the pixels — a clean tree says so
            // by showing nothing at all.
            count={changeCount || undefined}
            active={view === "git"}
            onClick={() => setView(view === "git" ? "chat" : "git")}
          />
        </div>

        <div className="my-2 h-px bg-line-soft" />

        {/* subApps */}
        <div className="mb-1 flex items-center gap-1.5 px-2.5 pb-1">
          <SectionLabel className="px-0">Apps</SectionLabel>
          <span className="cm-mono !text-[9.5px] text-faint">{project?.subApps.length ?? 0}</span>
          {project && project.subApps.length > 0 && (
            <div className="ml-auto">
              <BranchWorktreePicker
                targets={targets}
                value={selectedBranch}
                onChange={setSelectedBranch}
                align="end"
              />
            </div>
          )}
        </div>
        <div className="px-1.5">
          {!project ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">No project selected.</p>
          ) : project.subApps.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">No apps configured.</p>
          ) : (
            project.subApps.map((app) => (
              <SubAppRow
                key={app.id}
                app={app}
                project={project}
                target={selectedTarget}
                runner={runnerFor(app.id)}
              />
            ))
          )}
        </div>

        <div className="my-2.5 h-px bg-line-soft" />

        {/* chats */}
        <div className="mb-1 flex items-center justify-between px-2.5 pb-1">
          <SectionLabel className="px-0">Chats</SectionLabel>
          <IconButton size="sm" tip="New chat" onClick={startNewChat} disabled={!project}>
            <Plus />
          </IconButton>
        </div>
        <div ref={chatListRef} className="space-y-0.5 px-1.5">
          {chats.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">
              {project ? "No chats yet." : "Select a project to see its chats."}
            </p>
          ) : (
            chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                active={chat.id === activeChatId}
                needsInput={attentionByChat.has(chat.id)}
                now={now}
                onClick={() => setActiveChat(chat.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* new chat */}
      <div className="cm-hairline-t p-2.5">
        <button
          onClick={startNewChat}
          disabled={!project}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-panel-2 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5"
        >
          <Plus />
          New chat
        </button>
      </div>

      <AddProjectDialog open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />
      <ManageConfigDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </aside>
  );
}
