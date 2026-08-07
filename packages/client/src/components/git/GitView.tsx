/**
 * Source Control — the project's git cockpit.
 *
 * Layout mirrors the Memory view: a toolbar across the top (which repo, which
 * branch, the remote gap and its verbs), a list rail on the left (Changes /
 * History / Stashes) and a Monaco diff filling the rest.
 *
 * The repo picker is what makes this work alongside the rest of the app: a
 * project's agents each work in their OWN worktree, so "the working copy" is
 * ambiguous — you pick the checkout or any worktree, and every panel below
 * re-scopes to it.
 *
 * Nothing here is optimistic. Each mutation posts and the store re-reads status
 * from git, because a checkout or a stash pop changes far more than the call
 * itself touched.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  FolderGit2,
  GitBranch,
  GitCommitVertical,
  GitCompare,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import type { GitBranch as GitBranchInfo, GitCommitFile, WorktreeInfo } from "@dispatch/shared";
import { useActiveProject } from "../../stores/projects.js";
import { useGit, type GitTab } from "../../stores/git.js";
import { useNotices } from "../../stores/notices.js";
import { api } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip } from "../ui/Chip.js";
import { Popover } from "../ui/Popover.js";
import { Select, type SelectOption } from "../ui/Select.js";
import { SegmentedControl, type Segment } from "../ui/SegmentedControl.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { TaskLauncher } from "../tasks/TaskLauncher.js";
import { ChangesTab } from "./ChangesTab.js";
import { HistoryTab } from "./HistoryTab.js";
import { StashesTab } from "./StashesTab.js";
import { BranchMenu, localNameFor } from "./BranchMenu.js";
import { GitDiffPane } from "./GitDiffPane.js";

/** How often the open view re-reads git state (cheap: one `git status`). */
const POLL_MS = 5_000;

const TABS: Segment<GitTab>[] = [
  { value: "changes", label: "Changes" },
  { value: "history", label: "History" },
  { value: "stashes", label: "Stashes" },
];

/* ------------------------------------------------------------ stash form */

function StashButton({ disabled }: { disabled: boolean }) {
  const run = useGit((s) => s.run);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);

  return (
    <Popover
      align="end"
      width={280}
      className="p-0"
      trigger={({ toggle, open }) => (
        <Button
          size="xs"
          variant="subtle"
          leftIcon={<Archive />}
          disabled={disabled}
          onClick={toggle}
          aria-expanded={open}
        >
          Stash
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2 p-2.5">
          <label className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            Stash message
          </label>
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="optional"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-line bg-inset px-2 text-[11.5px] text-primary outline-none placeholder:text-faint focus:border-line-strong"
          />
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted hover:text-secondary">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
              className="size-3 accent-[var(--accent)]"
            />
            Include untracked files
          </label>
          <div className="flex justify-end gap-1.5 pt-0.5">
            <Button size="xs" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="primary"
              leftIcon={<Archive />}
              onClick={() => {
                void run("Stash", (repo) =>
                  api.git.stash(repo, { message: message.trim() || undefined, includeUntracked }),
                );
                setMessage("");
                close();
              }}
            >
              Stash changes
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------- commit sweep form */

/**
 * "Sweep into commits" — hand the whole dirty tree to an agent and get one
 * commit per coherent change back.
 *
 * It lives in the toolbar rather than in the Changes tab's commit box because it
 * is the alternative to that box, not an accessory to it: you either stage and
 * write a message yourself, or you let the sweep do the grouping. Putting it
 * inside the commit box would read as "generate a message for what I staged",
 * which is the button that's already there.
 *
 * The form itself is the shared TaskLauncher, so this is a popover and a repo
 * path — the instructions box, effort selector and toggles come with it.
 */
function SweepButton({
  projectId,
  repoPath,
  dirty,
  disabled,
}: {
  projectId: string | null;
  repoPath: string | null;
  dirty: boolean;
  disabled: boolean;
}) {
  return (
    <Popover
      align="end"
      width={520}
      className="p-0"
      trigger={({ toggle, open }) => (
        <Button
          size="xs"
          variant="subtle"
          leftIcon={<GitCommitVertical />}
          disabled={disabled}
          onClick={toggle}
          aria-expanded={open}
          title="Group the working tree into per-feature commits (AI)"
        >
          Sweep
        </Button>
      )}
    >
      {(close) => (
        <TaskLauncher
          taskId="git:commit-sweep"
          projectId={projectId}
          dense
          // The sweep must target the repo the VIEW is pointed at — usually a
          // worktree, not the project checkout. Sending the wrong one commits
          // someone else's work.
          params={repoPath ? { repoPath } : undefined}
          blockedReason={
            !dirty ? "Nothing to sweep — the working tree is clean." : undefined
          }
          onLaunched={close}
        />
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ view */

export function GitView() {
  const project = useActiveProject();
  const {
    repoPath,
    status,
    branches,
    commits,
    stashes,
    commitFiles,
    tab,
    selection,
    message,
    amend,
    loading,
    error,
    busy,
    setRepoPath,
    setTab,
    select,
    setMessage,
    setAmend,
    refresh,
    loadCommitFiles,
    run,
  } = useGit();

  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [expandedStash, setExpandedStash] = useState<string | null>(null);
  const [stashFiles, setStashFiles] = useState<Record<string, GitCommitFile[]>>({});
  const [generating, setGenerating] = useState(false);

  // Point the store at the project checkout whenever the project changes; the
  // picker below can then move it to any worktree.
  useEffect(() => {
    setRepoPath(project?.repoPath ?? null);
  }, [project?.repoPath, setRepoPath]);

  // The repo picker needs the project's worktrees. Best-effort: a repo with
  // none simply offers the checkout.
  useEffect(() => {
    if (!project?.id) {
      setWorktrees([]);
      return;
    }
    let live = true;
    void api.worktrees
      .list(project.id)
      .then((w) => live && setWorktrees(w))
      .catch(() => live && setWorktrees([]));
    return () => {
      live = false;
    };
  }, [project?.id]);

  // Keep the open view live. A mutation already refreshes; this catches changes
  // made OUTSIDE the UI — which is the common case here, since the agents in
  // the other panes are editing these very files.
  useEffect(() => {
    if (!repoPath) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh({ full: true });
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [repoPath, refresh]);

  // Reset per-repo expansion state when the repo changes.
  useEffect(() => {
    setExpandedCommit(null);
    setExpandedStash(null);
    setStashFiles({});
  }, [repoPath]);

  const repoOptions = useMemo<SelectOption<string>[]>(() => {
    const opts: SelectOption<string>[] = [];
    if (project?.repoPath) {
      opts.push({
        value: project.repoPath,
        label: project.name,
        icon: <FolderGit2 />,
        hint: "checkout",
      });
    }
    for (const w of worktrees) {
      if (w.path === project?.repoPath) continue;
      opts.push({
        value: w.path,
        label: w.branch,
        icon: <GitBranch />,
        hint: "worktree",
      });
    }
    return opts;
  }, [project?.repoPath, project?.name, worktrees]);

  /* ------------------------------------------------------------ actions */

  const checkout = (branch: GitBranchInfo) => {
    // Checking out a remote-tracking ref would detach HEAD, so create/switch to
    // the local branch it seeds instead — which is what the click means.
    const name = localNameFor(branch);
    void run("Checkout", (repo) =>
      branch.isRemote
        ? api.git.checkout(repo, name, { create: true, from: branch.name })
        : api.git.checkout(repo, name),
    );
  };

  const generateMessage = async () => {
    if (!repoPath || generating) return;
    setGenerating(true);
    try {
      const { message: draft } = await api.git.commitMessage(repoPath);
      setMessage(draft);
    } catch (err) {
      useNotices.getState().push({
        level: "error",
        text: "Couldn't draft a commit message",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGenerating(false);
    }
  };

  const commit = async () => {
    const result = await run("Commit", (repo) =>
      api.git.commit(repo, message, { amend }),
    );
    if (!result) return;
    setMessage("");
    setAmend(false);
    select(null);
    useNotices.getState().push({
      level: "info",
      text: `Committed ${result.commit.shortHash}`,
      detail: result.commit.subject,
    });
  };

  const toggleCommit = (sha: string) => {
    const next = expandedCommit === sha ? null : sha;
    setExpandedCommit(next);
    if (next) void loadCommitFiles(next);
  };

  const toggleStash = (ref: string) => {
    const next = expandedStash === ref ? null : ref;
    setExpandedStash(next);
    if (!next || stashFiles[ref] || !repoPath) return;
    // A stash IS a commit, so its contents come back through the same endpoint.
    void api.git
      .commitFiles(repoPath, ref)
      .then((files) => setStashFiles((prev) => ({ ...prev, [ref]: files })))
      .catch(() => setStashFiles((prev) => ({ ...prev, [ref]: [] })));
  };

  const sync = (op: "fetch" | "pull" | "push") => {
    const label = op[0]!.toUpperCase() + op.slice(1);
    void run(label, async (repo) => {
      const result = await api.git.sync(repo, op, {
        // A branch with no upstream can't be pushed without publishing it.
        setUpstream: op === "push" && !status?.upstream,
        branch: status?.branch,
      });
      useNotices.getState().push({
        level: "info",
        text: `${label} complete`,
        detail: result.message ? midTruncate(result.message, 140) : undefined,
      });
      return result;
    });
  };

  /* -------------------------------------------------------------- render */

  if (!project) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center bg-app text-center">
        <GitBranch className="mb-2 size-6 text-faint" />
        <p className="text-[13px] font-medium text-secondary">No project selected</p>
        <p className="mt-0.5 text-[11.5px] text-muted">
          Pick a project to see its working copy.
        </p>
      </div>
    );
  }

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const dirty =
    (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0) > 0;
  // A sweep can commit what's already staged too, so it has a wider notion of
  // "there is work here" than Stash does.
  const anyChanges = dirty || (status?.staged.length ?? 0) > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        {repoOptions.length > 1 ? (
          <Select
            options={repoOptions}
            value={repoPath ?? project.repoPath}
            onChange={setRepoPath}
            leftIcon={<FolderGit2 />}
            width={300}
            className="max-w-[220px]"
          />
        ) : (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[12px] text-secondary [&_svg]:size-3.5">
            <FolderGit2 className="text-muted" />
            <span className="truncate">{project.name}</span>
          </span>
        )}

        <BranchMenu
          status={status}
          branches={branches}
          busy={busy === "Checkout"}
          onCheckout={checkout}
          onCreate={(name) =>
            void run("Create branch", (repo) =>
              api.git.checkout(repo, name, { create: true }),
            )
          }
        />

        {status?.upstream && (behind > 0 || ahead > 0) && (
          <span className="flex items-center gap-1">
            {behind > 0 && (
              <Chip tone="warn" mono>
                ↓{behind}
              </Chip>
            )}
            {ahead > 0 && (
              <Chip tone="accent" mono>
                ↑{ahead}
              </Chip>
            )}
          </span>
        )}
        {status && !status.upstream && !status.detached && (
          <Chip tone="muted">no upstream</Chip>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <SweepButton
            projectId={project.id}
            repoPath={repoPath}
            dirty={anyChanges}
            disabled={!!busy}
          />
          <StashButton disabled={!dirty || !!busy} />
          <Button
            size="xs"
            variant="subtle"
            leftIcon={busy === "Fetch" ? <Spinner size={12} /> : <RefreshCw />}
            disabled={!!busy}
            onClick={() => sync("fetch")}
          >
            Fetch
          </Button>
          <Button
            size="xs"
            variant="subtle"
            leftIcon={busy === "Pull" ? <Spinner size={12} /> : <ArrowDownToLine />}
            disabled={!!busy || behind === 0}
            onClick={() => sync("pull")}
          >
            Pull{behind > 0 ? ` ${behind}` : ""}
          </Button>
          <Button
            size="xs"
            variant={ahead > 0 ? "primary" : "subtle"}
            leftIcon={busy === "Push" ? <Spinner size={12} /> : <ArrowUpFromLine />}
            disabled={!!busy || (ahead === 0 && !!status?.upstream)}
            onClick={() => sync("push")}
          >
            Push{ahead > 0 ? ` ${ahead}` : ""}
          </Button>
          <span className="mx-0.5 h-4 w-px bg-line" />
          <IconButton
            size="sm"
            tip="Refresh"
            disabled={loading}
            onClick={() => void refresh({ full: true })}
          >
            <RotateCw className={cn(loading && "animate-spin")} />
          </IconButton>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-line bg-danger-ghost px-3 py-1.5 text-[11.5px] text-danger">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <div className="flex w-[340px] shrink-0 flex-col border-r border-line bg-surface">
          <div className="shrink-0 px-2 py-2">
            <SegmentedControl segments={TABS} value={tab} onChange={setTab} />
          </div>

          {tab === "changes" && (
            <ChangesTab
              status={status}
              selection={selection}
              message={message}
              amend={amend}
              busy={busy}
              generating={generating}
              onSelect={select}
              onMessage={setMessage}
              onAmend={setAmend}
              onGenerate={() => void generateMessage()}
              onCommit={() => void commit()}
              onStage={(paths) => void run("Stage", (repo) => api.git.stage(repo, paths))}
              onUnstage={(paths) => void run("Unstage", (repo) => api.git.unstage(repo, paths))}
              onDiscard={(paths) => void run("Discard", (repo) => api.git.discard(repo, paths))}
              onStageAll={() => void run("Stage all", (repo) => api.git.stageAll(repo))}
              onUnstageAll={() => void run("Unstage all", (repo) => api.git.unstageAll(repo))}
            />
          )}

          {tab === "history" && (
            <HistoryTab
              commits={commits}
              commitFiles={commitFiles}
              expanded={expandedCommit}
              selection={selection}
              loading={loading}
              onToggle={toggleCommit}
              onSelect={select}
            />
          )}

          {tab === "stashes" && (
            <StashesTab
              stashes={stashes}
              stashFiles={stashFiles}
              expanded={expandedStash}
              selection={selection}
              busy={busy}
              onToggle={toggleStash}
              onSelect={select}
              onApply={(i) => void run("Apply stash", (repo) => api.git.stashApply(repo, i))}
              onPop={(i) => void run("Pop stash", (repo) => api.git.stashApply(repo, i, true))}
              onDrop={(i) => void run("Drop stash", (repo) => api.git.stashDrop(repo, i))}
            />
          )}
        </div>

        {/* diff */}
        {selection && repoPath ? (
          <GitDiffPane
            key={`${repoPath}:${selection.relPath}:${selection.leftRev}:${selection.rightRev}`}
            repoPath={repoPath}
            selection={selection}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center bg-inset text-center">
            <GitCompare className="mb-2 size-6 text-faint" />
            <p className="text-[12.5px] text-muted">Select a file to see its diff</p>
            <p className="mt-0.5 max-w-sm text-[11px] text-faint">
              Changes, commits and stashes all open here side by side.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
