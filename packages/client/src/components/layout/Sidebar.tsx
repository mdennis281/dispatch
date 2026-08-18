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
  BarChart3,
  Brain,
  FolderOpen,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import type { Chat, SubApp, RunnerInstance, Project } from "@dispatch/shared";
import { Popover, MenuItem } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { StatusDot, statusMeta, toneText } from "../ui/StatusDot.js";
import { TitleText } from "../ui/TitleText.js";
import { purposeIcon } from "../config/sections.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { useProjects, useActiveProject } from "../../stores/projects.js";
import {
  useChats,
  useProjectChats,
  useProjectAgentCounts,
  type ProjectAgentCounts,
} from "../../stores/chats.js";
import { useView, openOverlay } from "../../stores/view.js";
import { useLayout, dismissLeftDrawer } from "../../stores/layout.js";
import { selectChat, selectProject } from "../../stores/navigation.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useGit, useGitChangeCount } from "../../stores/git.js";
import { useRunners } from "../../stores/runners.js";
import { useAttention } from "../../stores/attention.js";
import { actions } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";
import { midTruncate, relTimeShort } from "../../lib/format.js";
import { useFlipReorder } from "../../lib/useFlip.js";
import { DeleteChatDialog } from "../chat/DeleteChatDialog.js";
import { useChatRename } from "../chat/useChatRename.js";
import { BranchWorktreePicker } from "../panels/BranchWorktreePicker.js";
import {
  useLaunchTargets,
  useLaunchBranch,
  launchSubApp,
  findRunner,
  type LaunchTarget,
} from "../panels/useLauncher.js";

/**
 * The build stamp Vite's `define` inlines (see vite.config.ts). The `typeof`
 * guard is the one form that is safe when the identifier is UNDECLARED — which
 * it is under the client's vitest config, a deliberately plugin-free node
 * runner that never loads vite.config.ts. Reading the bare name there would be
 * a ReferenceError, so a JSX test of this component would fail on the version
 * line rather than on whatever it meant to assert.
 *
 * The `v` prefix belongs to the STAMP, not to the label — the fallback is the
 * word "dev", and `vdev` would be nonsense.
 */
const BUILD_VERSION = typeof __BUILD_VERSION__ === "string" ? `v${__BUILD_VERSION__}` : "dev";

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

/**
 * The right-hand half of a project row: how many agents are live in it.
 *
 * Two tones, never summed into one number — "3 working" and "1 waiting on you"
 * are different calls to action, and a project you have to go answer must not
 * hide inside a busy-looking count. Nothing renders for a quiet project: a row
 * of zeroes would make the menu read as a dashboard rather than a picker.
 */
function ProjectAgentBadge({ counts }: { counts: ProjectAgentCounts | undefined }) {
  const working = counts?.working ?? 0;
  const attention = counts?.attention ?? 0;
  if (!working && !attention) return null;

  // "working" rather than "running": the count also covers `waiting` and
  // `queued`, which are agents with a turn in flight but nothing streaming.
  const label = [
    attention ? `${attention} awaiting input` : null,
    working ? `${working} working` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="flex items-center gap-1.5 tabular-nums" title={label}>
      {/* The dots carry the meaning by colour alone, so the readable form goes
          to assistive tech directly — a `title` is not reliably announced. */}
      <span className="sr-only">{label}</span>
      {attention > 0 && (
        <span aria-hidden className={cn("flex items-center gap-1", toneText("warn"))}>
          <StatusDot tone="warn" pulse size={5} />
          {attention}
        </span>
      )}
      {working > 0 && (
        <span aria-hidden className={cn("flex items-center gap-1", toneText("working"))}>
          <StatusDot tone="working" pulse size={5} />
          {working}
        </span>
      )}
    </span>
  );
}

function ProjectSelector({
  onAddProject,
  onManageConfig,
}: {
  onAddProject: () => void;
  onManageConfig: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const active = useActiveProject();
  const agentCounts = useProjectAgentCounts();

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
            <span className="block truncate text-base font-semibold text-primary">
              {active?.name ?? "No project"}
            </span>
            <span className="block truncate cm-mono !text-2xs text-faint">
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
            <p className="px-2 py-1.5 text-xs text-faint">No projects yet.</p>
          )}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              icon={<FolderGit2 />}
              active={p.id === active?.id}
              hint={<ProjectAgentBadge counts={agentCounts[p.id]} />}
              onClick={() => {
                selectProject(p.id);
                close();
                // Deliberately NOT dismissLeftDrawer(): unlike the nav items below,
                // switching project navigates you INTO the sidebar, not out of it.
                // `selectProject` clears the open chat, so closing the drawer here
                // left a phone staring at the empty state with the chat list it
                // needs to pick from hidden behind a second tap.
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
            New project…
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
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover">
      <Icon className={cn("size-3.5 shrink-0", running ? "text-accent-hi" : "text-muted")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary group-hover:text-primary">
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
          // `cm-touch-reveal` (index.css): always visible on a coarse pointer,
          // where there is no hover to reveal it with.
          className="cm-touch-reveal opacity-0 group-hover:opacity-100"
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useChatRename(chat);

  return (
    <div className="group/row relative" data-flip-id={chat.id}>
      <button
        data-testid="chat-row"
        onClick={onClick}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-8 text-left transition-colors",
          active ? "bg-accent-ghost/70" : "hover:bg-hover",
        )}
      >
        {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
        {/* A chat the app spawned for a job wears that job's icon instead of the
            status dot — in a sidebar of a dozen rows it's the only way to spot
            the one that's off editing your config. It's a bare glyph in the
            dot's slot, tinted with the SAME tone the dot would have used: the
            icon says what the chat is, its colour says how the chat is doing,
            so one marker carries both and the row keeps one colour language.
            An unknown purpose kind falls back to the dot. */}
        {PurposeIcon ? (
          <span
            title={chat.purpose?.label ?? chat.purpose?.kind}
            className={cn(
              "flex size-[15px] shrink-0 items-center justify-center [&_svg]:size-3.5",
              toneText(meta.tone),
              "transition-colors duration-300",
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
              "block truncate text-base",
              active ? "font-semibold text-primary" : "text-secondary",
            )}
          >
            {/* `**category**:` in a title takes the accent — the category is
                what the eye scans a long sidebar FOR. See ui/TitleText. */}
            <TitleText title={chat.title} />
          </span>
          <span className="mt-px block truncate text-2xs text-faint">
            {meta.label}
            <span className="text-faint/70"> · {age}</span>
          </span>
        </span>
      </button>

      {/* Rename edits the row IN PLACE — same interaction as the transcript
          header, overlaid on the row so the list doesn't reflow mid-edit. It's
          a sibling of the row button because an input nested inside a button is
          invalid and swallows its own clicks. */}
      {rename.editing && (
        <div className="absolute inset-x-1 inset-y-0 flex items-center pl-[26px] pr-1">
          <input
            {...rename.inputProps}
            aria-label="Rename chat"
            className="w-full rounded-sm border border-accent-line bg-inset px-1.5 py-0.5 text-base font-semibold text-primary outline-none"
          />
        </div>
      )}

      {/* right rail (sibling of the row button — never a nested button): the
          needs-input dot by default, swapped for hover-revealed actions.
          The actions stay MOUNTED at opacity-0 so they keep their tab stop and
          their fade — but an opacity-0 button is invisible and still occupies
          its 24px, so a dot sharing their flex row got pushed two icon-widths
          off the right edge and read as a stray dot floating mid-row. Hence the
          dot is taken out of flow and pinned to the rail's right edge instead.
          It stands down for EITHER way the actions can appear: pointer hover of
          the row, or keyboard focus landing in the rail. */}
      {!rename.editing && (
        <div className="group/rail absolute inset-y-0 right-1.5 flex items-center gap-0.5">
          {needsInput && (
            <span
              className={cn(
                "pointer-events-none absolute inset-y-0 right-0 flex w-6 items-center justify-center",
                "group-hover/row:hidden group-focus-within/rail:hidden",
              )}
            >
              <StatusDot tone="warn" pulse size={6} />
            </span>
          )}
          <IconButton
            size="sm"
            tip="Rename chat"
            onClick={rename.start}
            className="cm-touch-reveal opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <Pencil />
          </IconButton>
          <IconButton
            size="sm"
            tip="Delete chat"
            onClick={() => setConfirmDelete(true)}
            className="cm-touch-reveal opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <Trash2 />
          </IconButton>
        </div>
      )}

      <DeleteChatDialog
        chatId={chat.id}
        title={chat.title}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
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
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors [&_svg]:size-3.5",
        active
          ? "bg-accent-ghost text-primary"
          : "text-secondary hover:bg-panel-2/60 hover:text-primary",
      )}
    >
      <Icon className={active ? "text-accent" : "text-muted"} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && (
        <span className="cm-mono !text-2xs text-faint">{count}</span>
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
    selectChat(id);
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
  // Below `md` this whole column lives inside an off-canvas `Drawer`, so it
  // fills the drawer instead of carrying its own 260px. At `md` and `lg` the
  // classes are byte-for-byte what they always were.
  const mode = useLayout((s) => s.mode);
  const leftOpen = useLayout((s) => s.leftOpen);
  const inDrawer = mode === "sm";

  const project = useActiveProject();
  const chats = useProjectChats(project?.id ?? null);
  const activeChatId = useChats((s) => s.activeChatId);
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

  // Opening a chat always returns to the chat workspace (out of the Memory view);
  // selectChat does that, and keeps the project selection in step. On a phone it
  // also closes the drawer, which is otherwise sitting on top of the transcript
  // you just asked for.
  const setActiveChat = (id: string) => {
    selectChat(id);
    dismissLeftDrawer();
  };

  // Launch target for the Apps section. The SAME selection the right panel's
  // Runner picker drives (see useLaunchBranch) — one project, one answer to
  // "which branch does Run use?".
  const { targets } = useLaunchTargets(project?.id);
  const {
    branch: selectedBranch,
    setBranch: setSelectedBranch,
    target: selectedTarget,
  } = useLaunchBranch(project?.id, targets, project?.repoPath);

  // Shared clock so every chat row's "age" label ages together. 30s is plenty
  // for m/h/d/w granularity and keeps the sidebar idle-cheap.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // FLIP: animate chat rows sliding to their new slot when activity reorders them.
  // Skipped while the drawer is closed — see the `active` note in lib/useFlip:
  // every reorder that happened off-canvas would otherwise replay at once on the
  // first frame after opening.
  const chatListRef = useRef<HTMLDivElement>(null);
  useFlipReorder(chatListRef, !inDrawer || leftOpen);

  // New chat = instant create with defaults + auto-select (no dialog). Gated on a
  // selected project, so the trigger is disabled until there's somewhere to create.
  const startNewChat = () => {
    if (!project) return;
    setView("chat");
    dismissLeftDrawer();
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
    <aside
      className={cn(
        "flex flex-col border-r border-line bg-surface",
        inDrawer ? "h-full w-full" : "w-[260px] shrink-0",
      )}
    >
      <div className="flex h-12 shrink-0 items-center px-2.5 cm-hairline-b">
        {/* Adding a project is a full page, not a dialog: it ends by handing
            the repo to an agent, and that hand-off needs the config it's
            handing over visible beside it. See NewProjectView. */}
        <ProjectSelector
          onAddProject={() => setView("new-project")}
          onManageConfig={() => openOverlay("agents")}
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
            onClick={() => {
              setView(view === "memory" ? "chat" : "memory");
              dismissLeftDrawer();
            }}
          />
          <NavButton
            icon={GitBranch}
            label="Source Control"
            // Only a non-zero tally is worth the pixels — a clean tree says so
            // by showing nothing at all.
            count={changeCount || undefined}
            active={view === "git"}
            onClick={() => {
              setView(view === "git" ? "chat" : "git");
              dismissLeftDrawer();
            }}
          />
          {/* Below Source Control because it's the wider lens on the same
              thing: git shows what CHANGED in the checkout, this shows what's
              on the disk — including the drives and mounts no repo covers. */}
          <NavButton
            icon={FolderOpen}
            label="Files"
            active={view === "files"}
            onClick={() => {
              setView(view === "files" ? "chat" : "files");
              dismissLeftDrawer();
            }}
          />
          {/* Last in the group: it is the only one that is not about the CURRENT
              state of the project — it is the record of what has already
              happened, across every project. */}
          <NavButton
            icon={BarChart3}
            label="Metrics"
            active={view === "metrics"}
            onClick={() => {
              setView(view === "metrics" ? "chat" : "metrics");
              dismissLeftDrawer();
            }}
          />
        </div>

        <div className="my-2 h-px bg-line-soft" />

        {/* subApps */}
        <div className="mb-1 flex items-center gap-1.5 px-2.5 pb-1">
          <SectionLabel className="px-0">Apps</SectionLabel>
          <span className="cm-mono !text-2xs text-faint">{project?.subApps.length ?? 0}</span>
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
            <p className="px-2 py-1.5 text-xs text-faint">No project selected.</p>
          ) : project.subApps.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-faint">No apps configured.</p>
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

        {/* chats — no "+" here. It fired the exact same startNewChat as the
            pinned footer button 400px below it, and two controls for one action
            in one column is how a sidebar starts feeling like a toolbar. The
            footer one wins: it's pinned, so it's reachable from any scroll
            position, and it's labelled. */}
        <div className="mb-1 flex items-center justify-between px-2.5 pb-1">
          <SectionLabel className="px-0">Chats</SectionLabel>
          <span className="cm-mono !text-2xs text-faint">{chats.length || ""}</span>
        </div>
        <div ref={chatListRef} className="space-y-0.5 px-1.5">
          {chats.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-faint">
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
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-panel-2 py-1.5 text-sm font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5"
        >
          <Plus />
          New chat
        </button>
        {/* Build stamp, not a page-load clock: it says which bundle you're
            looking at, which is the first question when dev (4319) and the
            installed app (4318) disagree. */}
        <p
          className="cm-mono mt-2 text-center !text-2xs text-faint"
          title="Build version (UTC) — vyyyy.mm.dd.sssss, where sssss is the seconds elapsed since UTC midnight"
        >
          {BUILD_VERSION}
        </p>
      </div>

    </aside>
  );
}
