/**
 * WorkspaceView — the one place every long-lived resource is listed.
 *
 * Worktrees, terminals and (later) PRs are all created by agents, all outlive
 * the turn that made them, and until now each was only visible from inside the
 * chat that happened to own it. So a worktree nobody claimed, or a shell left
 * running in a chat you closed, was effectively invisible: you found it by
 * noticing the disk filling up or the port being taken.
 *
 * Two axes and one text box: WHAT (worktrees / terminals / PRs) × HOW WIDE (this
 * chat / this project / everything). The scope control is the point — "this
 * chat" is the view you already had, and the other two are the ones that were
 * missing.
 *
 * Additive on purpose: the per-chat right-panel tabs stay as the in-flow view
 * while you work. This is the one you open when you want the whole board.
 *
 * The filter fields are `RegistryQuery`'s, the same shape the REST routes parse
 * and the MCP tools take, so what a human sees here and what an agent gets back
 * from `worktree({ action: "list" })` are the same question.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  FolderGit2,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { RegistryScope, TerminalInfo, WorktreeInfo } from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { Tabs } from "../ui/Tabs.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { api } from "../../lib/api.js";
import { relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { useOverlay } from "../../stores/view.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { selectChat } from "../../stores/navigation.js";
import { useWorkspace, type WorkspaceKind } from "../../stores/workspace.js";

/* --------------------------------------------------------------- utilities */

/**
 * Tone per origin. The two the app did NOT create — a harness worktree and a
 * tree that appeared from outside — read as `warn`, because they are the two
 * whose attribution is inferred rather than recorded.
 */
const ORIGIN_TONE: Record<string, Tone> = {
  ui: "accent",
  tool: "accent",
  agent: "accent",
  harness: "warn",
  external: "warn",
};

/* ------------------------------------------------------------------- rows */

/** Shared row chrome: a title line, a subtitle, chips, and trailing actions. */
function Row({
  title,
  subtitle,
  chips,
  actions,
  muted,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  chips?: React.ReactNode;
  actions?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border border-line bg-panel px-3 py-2",
        muted && "opacity-70",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm text-primary">{title}</span>
          {chips}
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate cm-mono text-xs text-muted">{subtitle}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/**
 * The chat a resource belongs to, as a button that navigates there — or a plain
 * "unattributed" marker.
 *
 * That marker is the whole reason the registry exists. A worktree with no owner
 * used to be indistinguishable from one whose owner the app simply hadn't
 * worked out yet; now it is a visible, fixable state.
 */
function ChatChip({ chatId }: { chatId?: string }) {
  const chat = useChats((s) => (chatId ? s.byId[chatId] : undefined));
  const close = useOverlay("workspace").close;
  if (!chatId) return <Chip tone="warn">unattributed</Chip>;
  if (!chat) return <Chip tone="neutral">chat gone</Chip>;
  return (
    <Button
      variant="subtle"
      size="sm"
      className="max-w-[18rem] gap-1 px-1.5 text-xs"
      onClick={() => {
        selectChat(chatId);
        close();
      }}
      title={`Go to “${chat.title}”`}
    >
      <MessageSquare size={11} className="shrink-0" />
      <span className="truncate">{chat.title}</span>
    </Button>
  );
}

/** The project a resource belongs to. Only shown when the scope spans projects. */
function ProjectChip({ projectId, show }: { projectId?: string; show: boolean }) {
  const project = useProjects((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined,
  );
  if (!show || !project) return null;
  return <Chip tone="neutral">{project.name}</Chip>;
}

function WorktreeRow({ wt, showProject }: { wt: WorktreeInfo; showProject: boolean }) {
  return (
    <Row
      muted={wt.isPrimary}
      title={<span className="cm-mono">{wt.branch}</span>}
      subtitle={wt.path}
      chips={
        <>
          <ProjectChip projectId={wt.projectId} show={showProject} />
          {wt.isPrimary ? (
            <Chip tone="neutral">primary checkout</Chip>
          ) : (
            <>
              <ChatChip chatId={wt.chatId} />
              {wt.origin && (
                <Chip tone={ORIGIN_TONE[wt.origin] ?? "neutral"}>{wt.origin}</Chip>
              )}
            </>
          )}
          {wt.label && <Chip tone="neutral">{wt.label}</Chip>}
        </>
      }
      actions={
        wt.createdAt ? (
          <span className="text-xs text-faint">{relTime(wt.createdAt)}</span>
        ) : null
      }
    />
  );
}

function TerminalRow({
  term,
  showProject,
  onPurge,
}: {
  term: TerminalInfo;
  showProject: boolean;
  onPurge: (id: string) => void;
}) {
  const tone: Tone = term.background ? "warn" : term.status === "live" ? "success" : "neutral";
  const state = term.background
    ? "background"
    : term.busy
      ? "running"
      : term.archived
        ? "archived"
        : term.status;
  return (
    <Row
      muted={term.status !== "live"}
      title={<span className="cm-mono">{term.name}</span>}
      subtitle={term.lastCommand ? `${term.cwd} — ${term.lastCommand}` : term.cwd}
      chips={
        <>
          <ProjectChip projectId={term.projectId} show={showProject} />
          <ChatChip chatId={term.chatId} />
          <Chip tone={tone}>{state}</Chip>
          {term.origin && <Chip tone="neutral">{term.origin}</Chip>}
          {!!term.lines && <Chip tone="neutral">{term.lines} lines</Chip>}
        </>
      }
      actions={
        <>
          <span className="text-xs text-faint">
            {relTime(term.lastActivityAt ?? term.updatedAt ?? term.createdAt)}
          </span>
          {/* Only offered for a shell with no process behind it: closing a LIVE
              one belongs in the chat that is using it, not in a global roster. */}
          {term.archived && (
            <Button
              variant="ghost"
              size="sm"
              title="Delete this shell's record and transcript"
              onClick={() => onPurge(term.id)}
            >
              <Trash2 size={13} />
            </Button>
          )}
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------- view */

export function WorkspaceView() {
  const { open, close } = useOverlay("workspace");
  const { kind, scope, q, worktrees, terminals, loading, error, setKind, setScope, setQ, load } =
    useWorkspace();
  const projectId = useProjects((s) => s.activeProjectId) ?? undefined;
  const chatId = useChats((s) => s.activeChatId) ?? undefined;

  const refresh = useCallback(() => {
    void load({ projectId, chatId });
  }, [load, projectId, chatId]);

  // Fetch on open and whenever the question changes. Not on `q`: that filter is
  // applied to the rows we already have, so typing costs nothing.
  useEffect(() => {
    if (open) refresh();
  }, [open, kind, scope, refresh]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (fields: Array<string | undefined>) =>
      !needle || fields.some((f) => f && f.toLowerCase().includes(needle));
    return {
      worktrees: worktrees.filter((w) => match([w.path, w.branch, w.label, w.origin])),
      terminals: terminals.filter((t) => match([t.name, t.cwd, t.lastCommand])),
    };
  }, [q, worktrees, terminals]);

  const list = kind === "worktrees" ? rows.worktrees : kind === "terminals" ? rows.terminals : [];
  const showProject = scope === "all";

  const onPurge = useCallback(
    async (id: string) => {
      await api.terminals.purge(id).catch(() => null);
      refresh();
    },
    [refresh],
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title="Workspace"
      icon={<FolderGit2 size={15} />}
      description="Every worktree, shell and PR — scoped to this chat, this project, or everything."
      width={860}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-faint">
            {loading ? "Loading…" : `${list.length} ${kind === "prs" ? "PRs" : kind}`}
          </span>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={kind}
            onChange={(id) => setKind(id as WorkspaceKind)}
            tabs={[
              {
                id: "worktrees",
                label: "Worktrees",
                icon: <FolderGit2 size={13} />,
                count: rows.worktrees.length,
              },
              {
                id: "terminals",
                label: "Terminals",
                icon: <SquareTerminal size={13} />,
                count: rows.terminals.length,
              },
              { id: "prs", label: "PRs", icon: <GitPullRequest size={13} /> },
            ]}
          />
          <SegmentedControl<RegistryScope>
            value={scope}
            onChange={setScope}
            segments={[
              { value: "chat", label: "This chat" },
              { value: "project", label: "Project" },
              { value: "all", label: "Everything" },
            ]}
          />
        </div>

        <label className="flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1.5">
          <Search size={13} className="shrink-0 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              kind === "terminals" ? "Filter by name, cwd or command…" : "Filter by path, branch or label…"
            }
            className="w-full bg-transparent text-sm text-primary outline-none placeholder:text-faint"
          />
        </label>

        {error && <InlineError message={error} />}

        <div className="cm-scroll flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
          {kind === "prs" ? (
            <EmptyState>
              PRs land here next, with their live review state, comments and CI runs.
              For now the project-wide roster is under ⌘K → “Pull requests”.
            </EmptyState>
          ) : loading && list.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> Loading…
            </div>
          ) : list.length === 0 ? (
            <EmptyState>
              {q
                ? `Nothing matches “${q}”.`
                : scope === "chat"
                  ? `This chat has no ${kind}. Try a wider scope.`
                  : `No ${kind} here yet.`}
            </EmptyState>
          ) : kind === "worktrees" ? (
            rows.worktrees.map((w) => (
              <WorktreeRow key={w.path} wt={w} showProject={showProject} />
            ))
          ) : (
            rows.terminals.map((t) => (
              <TerminalRow key={t.id} term={t} showProject={showProject} onPurge={onPurge} />
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}
