/**
 * WorkspaceView — the one place every long-lived resource is listed.
 *
 * Worktrees, terminals and PRs are all created by agents, all outlive the turn
 * that made them, and until now each was only visible from inside the chat that
 * happened to own it. So a worktree nobody claimed, or a shell left running in a
 * chat you closed, was effectively invisible: you found it by noticing the disk
 * filling up or the port being taken.
 *
 * The PRs tab is the odd one out in one respect: its rows come from a STANDING
 * store fed by `pr-record-update`, not from a fetch when this opens. A PR's
 * state changes while nobody is watching — CI finishes, a reviewer starts, a
 * thread lands — so the answer has to be here already and has to keep moving.
 * The project-wide PR overlay this replaced re-ran `gh pr list` on every open
 * and could do neither.
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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  Check,
  ExternalLink,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type {
  CheckRun,
  PrRecord,
  PrReviewer,
  RegistryScope,
  RegistrySort,
  TerminalInfo,
  WorktreeInfo,
} from "@dispatch/shared";
import { matchesScope } from "@dispatch/shared";
import { Modal, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { Tabs } from "../ui/Tabs.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { api } from "../../lib/api.js";
import { actions } from "../../lib/actions.js";
import { relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { useOverlay } from "../../stores/view.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { usePrs, selectPrs } from "../../stores/prs.js";
import { selectChat } from "../../stores/navigation.js";
import {
  useWorkspace,
  type WorkspaceFilters,
  type WorkspaceKind,
} from "../../stores/workspace.js";

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

/**
 * The sort keys are `RegistryQuery`'s three, but the FIELD each one reads is
 * per-catalog — so the labels are too. "Recent" is a worktree's last sighting
 * and a shell's last output, and calling both "Recent" in the menu would hide
 * that the two tabs are answering with different clocks.
 */
const SORT_LABELS: Record<WorkspaceKind, Record<RegistrySort, string>> = {
  worktrees: { recent: "Last seen", created: "Created", name: "Branch" },
  terminals: { recent: "Last activity", created: "Created", name: "Name" },
  prs: { recent: "Recent", created: "Created", name: "Title" },
};

/**
 * Which toggles belong to which tab, and what each one says it does.
 *
 * A facet is a SERVER-side narrowing — it goes into the `RegistryQuery` the
 * fetch sends, because `unmerged` isn't answerable in a browser at all. PRs have
 * none for exactly that reason: their rows arrive over the socket rather than
 * from a query, so a toggle here would have to mean something different on that
 * tab than on the other two. The scope control and the text box narrow them, and
 * "unattributed" is a chip on every row that needs it.
 */
const FACETS: Record<WorkspaceKind, Array<{
  key: keyof WorkspaceFilters;
  label: string;
  tip: string;
}>> = {
  prs: [],
  worktrees: [
    {
      key: "unmerged",
      label: "Unmerged",
      tip: "Branches whose work isn't on the trunk yet — plus any the app couldn't determine",
    },
    {
      key: "unattributed",
      label: "Unattributed",
      tip: "Worktrees no chat owns — the state this catalog exists to surface",
    },
  ],
  terminals: [
    { key: "active", label: "Active", tip: "Running a command, or holding a background one" },
    { key: "hideArchived", label: "Hide archived", tip: "Hide shells whose process is gone" },
  ],
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
          {/* Only the LANDED state is chipped. "Unmerged" is the resting state
              of nearly every tree here, so a chip for it would sit on every row
              and say nothing; "merged" is the one that means you can delete
              this. Its absence is what the Unmerged filter selects on. */}
          {wt.merged === true && <Chip tone="muted">merged</Chip>}
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

/**
 * Kill every live shell the current question selects.
 *
 * Two clicks, like `StashesTab`'s stash drop: this stops real processes — a dev
 * server mid-build, a watcher — and at "Everything" scope it reaches into other
 * people's chats, so it must not be one stray click away. The label names the
 * count so the second click is a decision about a number rather than a leap.
 *
 * It does NOT delete transcripts. Killing a shell archives its row and keeps its
 * output readable, which is the difference between reclaiming a port and losing
 * the log that says why it was held.
 */
function KillAllButton({
  count,
  scopeLabel,
  busy,
  onKill,
}: {
  count: number;
  scopeLabel: string;
  busy: boolean;
  onKill: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Disarm whenever the TARGET changes, not just when it empties. Arming for
  // "3 in this chat", flipping the scope to Everything, and confirming would
  // otherwise stop a different — and much larger — set of processes than the
  // one the first click agreed to. A two-click guard that survives a change of
  // subject is not a guard.
  useEffect(() => {
    setConfirming(false);
  }, [count, scopeLabel]);

  if (count === 0) return null;
  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="hover:!text-danger"
        title={`Stop ${count} running shell${count === 1 ? "" : "s"} ${scopeLabel}. Transcripts are kept.`}
        onClick={() => setConfirming(true)}
      >
        <Zap size={13} /> Kill {count} running
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted">Kill {count} {scopeLabel}?</span>
      <Button
        variant="danger"
        size="sm"
        disabled={busy}
        title="Confirm — the processes stop; their transcripts stay readable"
        onClick={() => {
          setConfirming(false);
          onKill();
        }}
      >
        <Check size={13} /> Kill
      </Button>
      <Button variant="ghost" size="sm" title="Cancel" onClick={() => setConfirming(false)}>
        <X size={13} />
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------- PR rows */

/** Fold a PR's checks into one chip. Failing wins, then running, then green. */
function ChecksChip({ checks }: { checks: CheckRun[] }) {
  if (checks.length === 0) return <Chip tone="neutral">no checks</Chip>;
  const running = checks.filter((c) => c.status !== "completed").length;
  const failed = checks.filter(
    (c) =>
      c.status === "completed" &&
      (c.conclusion === "failure" ||
        c.conclusion === "timed_out" ||
        c.conclusion === "cancelled" ||
        c.conclusion === "action_required"),
  ).length;
  if (failed > 0) return <Chip tone="danger">{failed} failed</Chip>;
  if (running > 0) return <Chip tone="accent">{running} running</Chip>;
  return <Chip tone="success">{checks.length} passed</Chip>;
}

/** How a reviewer's state reads and colours. */
const REVIEWER_META: Record<PrReviewer["state"], { label: string; tone: Tone }> = {
  requested: { label: "requested", tone: "warn" },
  // The state this whole registry exists to surface: GitHub's spinner, made
  // legible. "Waiting on Copilot" and "Copilot is writing it now" are different
  // situations, and only one of them means the wait is nearly over.
  in_progress: { label: "reviewing…", tone: "accent" },
  approved: { label: "approved", tone: "success" },
  changes_requested: { label: "changes requested", tone: "danger" },
  commented: { label: "commented", tone: "neutral" },
  dismissed: { label: "dismissed", tone: "neutral" },
};

function ReviewerChip({ reviewer }: { reviewer: PrReviewer }) {
  const meta = REVIEWER_META[reviewer.state];
  return (
    <Chip
      tone={meta.tone}
      icon={reviewer.state === "in_progress" ? <Loader2 className="animate-spin" /> : undefined}
      // `stale` is why this is a title and not just a colour: a reviewer who
      // approved a commit you've since replaced has NOT approved what's there.
      title={
        reviewer.stale
          ? `${reviewer.login} ${meta.label} — but on an older commit than the current head`
          : `${reviewer.login} ${meta.label}`
      }
    >
      {reviewer.login.replace(/\[bot\]$/, "")} {meta.label}
      {reviewer.stale ? " (stale)" : ""}
    </Chip>
  );
}

function PrRow({ pr, showProject }: { pr: PrRecord; showProject: boolean }) {
  const link = pr.url && pr.url !== "#" ? pr.url : undefined;
  const open = pr.state === "open";
  const unresolved = pr.threads.filter((t) => !t.isResolved && !t.isOutdated).length;
  // Only offered for a PR this app could act on. A discovered PR belongs to
  // somebody else, and a Merge button on it is an invitation to a mistake.
  const canAct = open && !!pr.projectId;

  return (
    <Row
      muted={!open}
      title={
        <>
          <span className="cm-mono text-muted">#{pr.number}</span>{" "}
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent-hi"
            >
              {pr.title || pr.branch}
            </a>
          ) : (
            (pr.title || pr.branch)
          )}
        </>
      }
      subtitle={
        <>
          {pr.branch} → {pr.baseBranch || "?"}
          {pr.author ? ` · by ${pr.author}` : ""}
          {/* A stale row says so rather than presenting old state as current. */}
          {pr.pollError ? ` · ⚠ ${pr.pollError}` : ""}
        </>
      }
      chips={
        <>
          <ProjectChip projectId={pr.projectId} show={showProject} />
          <ChatChip chatId={pr.chatId} />
          {pr.state === "merged" && <Chip tone="accent">merged</Chip>}
          {pr.state === "closed" && <Chip tone="neutral">closed</Chip>}
          {pr.isDraft && <Chip tone="neutral">draft</Chip>}
          {pr.hold && <Chip tone="warn">hold</Chip>}
          {/* null is "GitHub hasn't computed it yet", not "fine" — so only an
              explicit false raises the conflict flag. */}
          {open && pr.mergeable === false && (
            <Chip tone="danger" icon={<AlertTriangle />}>
              conflicts
            </Chip>
          )}
          {open && <ChecksChip checks={pr.checks} />}
          {pr.reviewDecision === "approved" && (
            <Chip tone="success" icon={<Check />}>
              approved
            </Chip>
          )}
          {pr.reviewDecision === "changes_requested" && (
            <Chip tone="danger">changes requested</Chip>
          )}
          {unresolved > 0 && (
            <Chip tone="warn" icon={<MessageSquare />}>
              {unresolved} unresolved
            </Chip>
          )}
          {open && pr.reviewers.map((r) => <ReviewerChip key={r.login} reviewer={r} />)}
        </>
      }
      actions={
        <>
          <span className="text-xs text-faint">{relTime(pr.lastChangedAt)}</span>
          {open && (
            <Button
              variant="ghost"
              size="sm"
              // The escape hatch from the adaptive cadence: a parked PR is only
              // polled every ten minutes, and a roster you can't force to look
              // again is a roster you stop believing.
              title="Poll GitHub for this PR now"
              onClick={() => void api.prs.refresh(pr.key).catch(() => null)}
            >
              <RefreshCw size={13} />
            </Button>
          )}
          {canAct &&
            (pr.hold ? (
              <Button
                variant="ghost"
                size="sm"
                title="Remove the hold label"
                onClick={() =>
                  actions.ghAction({ op: "unhold", projectId: pr.projectId, prNumber: pr.number })
                }
              >
                <Play size={13} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                title="Park this PR with the hold label"
                onClick={() =>
                  actions.ghAction({ op: "hold", projectId: pr.projectId, prNumber: pr.number })
                }
              >
                <Pause size={13} />
              </Button>
            ))}
          {canAct && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pr.isDraft || pr.hold}
              title={
                pr.isDraft
                  ? "Draft — mark ready first"
                  : pr.hold
                    ? "Held — unhold to merge"
                    : "Merge this PR"
              }
              onClick={() =>
                actions.ghAction({ op: "merge", projectId: pr.projectId, prNumber: pr.number })
              }
            >
              <GitMerge size={13} />
            </Button>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title="Open on GitHub"
              className="px-1 text-faint transition-colors hover:text-secondary"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </>
      }
    />
  );
}

/* ------------------------------------------------------------------- view */

export function WorkspaceView() {
  const { open, close } = useOverlay("workspace");
  const {
    kind,
    scope,
    sort,
    filters,
    q,
    worktrees,
    terminals,
    loading,
    killing,
    error,
    setKind,
    setScope,
    setSort,
    toggleFilter,
    setQ,
    load,
    killAll,
  } = useWorkspace();
  const projectId = useProjects((s) => s.activeProjectId) ?? undefined;
  const chatId = useChats((s) => s.activeChatId) ?? undefined;
  // PRs come from the STANDING catalog, not from a fetch when this opens — the
  // one thing the overlay this replaces could never do. Scope is applied here
  // for the same reason `q` is: the rows are already local.
  const allPrs = usePrs(selectPrs);

  const refresh = useCallback(() => {
    void load({ projectId, chatId });
  }, [load, projectId, chatId]);

  // Fetch on open and whenever the QUESTION changes — the sort and the facets
  // included, because the server is what answers them (`unmerged` needs git and
  // the PR records; nothing in the browser can compute it). Not on `q`: that
  // filter is applied to the rows we already have, so typing costs nothing.
  useEffect(() => {
    if (open) refresh();
  }, [open, kind, scope, sort, filters, refresh]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (fields: Array<string | undefined>) =>
      !needle || fields.some((f) => f && f.toLowerCase().includes(needle));
    // The PR rows never went through the server's predicate — they arrived over
    // the socket — so the scope filter is applied here, with the SHARED
    // predicate rather than a second copy of it. That's what keeps "this chat's
    // PRs" meaning the same thing here as it does on `/api/prs`, including the
    // invariant that a narrow scope with a missing id shows nothing.
    const query = { scope, projectId, chatId };
    return {
      worktrees: worktrees.filter((w) => match([w.path, w.branch, w.label, w.origin])),
      terminals: terminals.filter((t) => match([t.name, t.cwd, t.lastCommand])),
      prs: allPrs.filter(
        (p) => matchesScope(p, query) && match([p.title, p.branch, p.repo, p.author, `#${p.number}`]),
      ),
    };
  }, [q, worktrees, terminals, allPrs, scope, projectId, chatId]);

  const list =
    kind === "worktrees" ? rows.worktrees : kind === "terminals" ? rows.terminals : rows.prs;
  const kindLabel = kind === "prs" ? "PRs" : kind;
  const showProject = scope === "all";
  // What "Kill all" would actually stop: a shell with a process behind it. The
  // count comes off the VISIBLE rows so the button and the list can't disagree.
  const runningCount = rows.terminals.filter((t) => t.status === "live" && !t.archived).length;
  const scopeLabel =
    scope === "chat" ? "in this chat" : scope === "project" ? "in this project" : "everywhere";

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
            {loading ? "Loading…" : `${list.length} ${kindLabel}`}
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
              {
                id: "prs",
                label: "PRs",
                icon: <GitPullRequest size={13} />,
                count: rows.prs.length,
              },
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

        {kind !== "prs" && (
          <div className="flex flex-wrap items-center gap-2">
            <Select<RegistrySort>
              label="Sort"
              leftIcon={<ArrowDownWideNarrow size={13} />}
              value={sort}
              onChange={setSort}
              width={190}
              options={[
                {
                  value: "recent",
                  label: SORT_LABELS[kind].recent,
                  hint: "Newest first",
                },
                {
                  value: "created",
                  label: SORT_LABELS[kind].created,
                  hint: "Newest first",
                },
                { value: "name", label: SORT_LABELS[kind].name, hint: "A→Z" },
              ]}
            />
            {FACETS[kind].map((f) => (
              <Button
                key={f.key}
                variant="toggle"
                size="sm"
                // `aria-pressed` drives the pressed LOOK as well as the
                // accessible state (see the `toggle` variant), so the two can
                // never drift apart.
                aria-pressed={filters[f.key]}
                title={f.tip}
                onClick={() => toggleFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
            {kind === "terminals" && (
              <div className="ml-auto">
                <KillAllButton
                  count={runningCount}
                  scopeLabel={scopeLabel}
                  busy={killing}
                  onKill={() => void killAll({ projectId, chatId })}
                />
              </div>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 rounded-md border border-line bg-inset px-2 py-1.5">
          <Search size={13} className="shrink-0 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              kind === "terminals"
                ? "Filter by name, cwd or command…"
                : kind === "prs"
                  ? "Filter by title, branch, repo or #number…"
                  : "Filter by path, branch or label…"
            }
            className="w-full bg-transparent text-sm text-primary outline-none placeholder:text-faint"
          />
        </label>

        {error && <InlineError message={error} />}

        <div className="cm-scroll flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
          {loading && list.length === 0 && kind !== "prs" ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Spinner /> Loading…
            </div>
          ) : list.length === 0 ? (
            <EmptyState>
              {q
                ? `Nothing matches “${q}”.`
                : FACETS[kind].some((f) => filters[f.key])
                  ? // Named separately from the scope hint because the fix is
                    // different: an empty filtered list means turn a toggle off,
                    // not widen the scope.
                    `No ${kindLabel} match these filters.`
                  : scope === "chat"
                    ? `This chat has no ${kindLabel}. Try a wider scope.`
                    : `No ${kindLabel} here yet.`}
            </EmptyState>
          ) : kind === "worktrees" ? (
            rows.worktrees.map((w) => (
              <WorktreeRow key={w.path} wt={w} showProject={showProject} />
            ))
          ) : kind === "prs" ? (
            rows.prs.map((p) => <PrRow key={p.key} pr={p} showProject={showProject} />)
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
