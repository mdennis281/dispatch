import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  GitMerge,
  FileDiff,
  CornerDownRight,
  ChevronDown,
  ChevronRight,
  Dot,
  Plus,
  FolderOpen,
  Check,
  Trash2,
  Unlink,
} from "lucide-react";
import type { Chat, WorktreeInfo, PRInfo } from "@cm/shared";
import { usePanels, type WorktreeDiff } from "../../stores/panels.js";
import { loadWorktreeDiff } from "../../stores/index.js";
import { actions } from "../../lib/actions.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { Popover } from "../ui/Popover.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { requestOpenFile, worktreeMatchesChat, samePath, copyToClipboard, suggestBranch } from "./panelBus.js";

/** A GitHub-style +/- block bar. */
function DiffStat({ add, del }: { add: number; del: number }) {
  const total = Math.max(add + del, 1);
  const blocks = 5;
  const green = Math.round((add / total) * blocks);
  const red = Math.min(blocks - green, Math.ceil((del / total) * blocks));
  const grey = blocks - green - red;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold text-success tabular-nums">+{add}</span>
      <span className="font-semibold text-danger tabular-nums">−{del}</span>
      <span className="ml-0.5 inline-flex gap-px">
        {Array.from({ length: green }).map((_, i) => (
          <span key={`g${i}`} className="size-2 rounded-[2px] bg-success" />
        ))}
        {Array.from({ length: red }).map((_, i) => (
          <span key={`r${i}`} className="size-2 rounded-[2px] bg-danger" />
        ))}
        {Array.from({ length: grey }).map((_, i) => (
          <span key={`x${i}`} className="size-2 rounded-[2px] bg-line-strong" />
        ))}
      </span>
    </span>
  );
}

/** Branch-name form used by the demoted "+ New" button. */
function CreateWorktreeForm({ chat, onDone }: { chat: Chat; onDone: () => void }) {
  const [branch, setBranch] = useState(() => suggestBranch(chat.title));
  const valid = /^[\w./-]{2,}$/.test(branch.trim());
  const submit = () => {
    if (!valid) return;
    actions.createWorktree({ chatId: chat.id, projectId: chat.projectId, branch: branch.trim() });
    onDone();
  };
  return (
    <div className="flex flex-col gap-2 p-2.5">
      <label className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Branch</label>
      <input
        autoFocus
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        spellCheck={false}
        placeholder="feat/my-task"
        className="h-7 w-full rounded-md border border-line bg-inset px-2 cm-mono !text-[11.5px] text-primary outline-none placeholder:text-faint focus:border-line-strong"
      />
      <div className="flex items-center gap-1.5 text-[10.5px] text-faint">
        <CornerDownRight className="size-3" />
        cut fresh from the project base
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" leftIcon={<GitBranch />} disabled={!valid} onClick={submit}>
          Create
        </Button>
      </div>
    </div>
  );
}

/** Demoted, secondary "+ New" — worktrees are normally agent-created. */
function NewWorktreeButton({ chat }: { chat: Chat }) {
  return (
    <Popover
      align="end"
      width={240}
      className="p-0"
      trigger={({ toggle, open }) => (
        <Button size="xs" variant="subtle" leftIcon={<Plus />} onClick={toggle} aria-expanded={open}>
          New
        </Button>
      )}
    >
      {(close) => <CreateWorktreeForm chat={chat} onDone={close} />}
    </Popover>
  );
}

const PR_STATE_TONE: Record<PRInfo["state"], Tone> = {
  open: "success",
  merged: "accent",
  closed: "danger",
};

/** Compact link to the PR a worktree's branch owns (if any). */
function WorktreePrRow({ pr }: { pr: PRInfo }) {
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest;
  const href = pr.url && pr.url !== "#" ? pr.url : undefined;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 border-t border-line-soft px-3 py-2 transition-colors hover:bg-white/[0.03]"
    >
      <Icon className={cn("size-3.5 shrink-0", pr.state === "merged" ? "text-accent-hi" : "text-success")} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-secondary">{pr.title}</span>
      <Chip tone={PR_STATE_TONE[pr.state]}>{pr.isDraft ? "draft" : pr.state}</Chip>
      <span className="shrink-0 cm-mono !text-[10px] text-faint">#{pr.number}</span>
    </a>
  );
}

function WorktreeCard({
  wt,
  diff,
  pr,
  chatId,
}: {
  wt: WorktreeInfo;
  diff?: WorktreeDiff;
  pr?: PRInfo;
  chatId: string;
}) {
  const [copied, setCopied] = useState(false);
  const base = wt.base ?? "main";
  const merged = pr?.state === "merged";
  const fileCount = diff?.files.length ?? 0;
  // Diff file list is collapsible; it auto-collapses once the branch is merged
  // (the changes are landed — no need to keep the list open), but the user can
  // still re-expand. `userToggled` stops the merge effect from fighting a manual open.
  const [open, setOpen] = useState(!merged);
  const userToggled = useRef(false);
  useEffect(() => {
    if (merged && !userToggled.current) setOpen(false);
  }, [merged]);

  const reveal = async () => {
    if (await copyToClipboard(wt.path)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div className="rounded-md border border-line bg-panel-2/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch className="size-3.5 shrink-0 text-accent-hi" />
        <span className="min-w-0 flex-1">
          <span className="block truncate cm-mono !text-[11.5px] font-medium text-primary">{wt.branch}</span>
          <span className="flex items-center gap-1 text-[10.5px] text-faint">
            <CornerDownRight className="size-3" />
            from {base}
            {wt.isDirty && (
              <>
                <Dot className="size-3 text-warn" />
                <span className="text-warn">dirty</span>
              </>
            )}
          </span>
        </span>
        {wt.ahead !== undefined && wt.ahead > 0 && (
          <Chip tone="muted" mono>
            ↑{wt.ahead}
          </Chip>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((o) => !o);
        }}
        disabled={fileCount === 0}
        className={cn(
          "flex w-full items-center justify-between border-t border-line-soft px-3 py-2 text-[11px] text-left",
          fileCount > 0 && "transition-colors hover:bg-white/[0.03]",
        )}
      >
        <span className="flex items-center gap-1.5 text-faint">
          {fileCount > 0 ? (
            open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />
          ) : (
            <span className="inline-block size-3" />
          )}
          vs {base}
          {fileCount > 0 && (
            <span className="text-muted">
              · {fileCount} file{fileCount > 1 ? "s" : ""}
            </span>
          )}
        </span>
        {diff ? <DiffStat add={diff.additions} del={diff.deletions} /> : <span className="text-muted">—</span>}
      </button>

      {open && diff && diff.files.length > 0 && (
        <div className="border-t border-line-soft px-1.5 py-1.5">
          {diff.files.map((f) => (
            <button
              key={f.path}
              onClick={() => requestOpenFile({ worktreePath: wt.path, relPath: f.path, base })}
              title={`Open ${f.path} in Monaco`}
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-white/[0.05]"
            >
              <FileDiff className="size-3 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate cm-mono !text-[10.5px] text-secondary">
                {midTruncate(f.path, 32)}
              </span>
              <span className="shrink-0 tabular-nums text-success">+{f.add}</span>
              <span className={cn("shrink-0 tabular-nums", f.del > 0 ? "text-danger" : "text-faint")}>−{f.del}</span>
            </button>
          ))}
        </div>
      )}

      {pr && <WorktreePrRow pr={pr} />}

      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
        <Button
          size="xs"
          variant="subtle"
          leftIcon={<FileDiff />}
          disabled={!diff || diff.files.length === 0}
          onClick={() => {
            const first = diff?.files[0];
            if (first) requestOpenFile({ worktreePath: wt.path, relPath: first.path, base });
          }}
        >
          Open diff
        </Button>
        <Button size="xs" variant="ghost" leftIcon={copied ? <Check /> : <FolderOpen />} onClick={reveal}>
          {copied ? "Copied" : "Reveal"}
        </Button>
        <IconButton
          size="sm"
          tip="Unlink from this chat (keeps the worktree on disk)"
          className="ml-auto hover:text-warn"
          onClick={() => actions.detachWorktree({ chatId, worktreePath: wt.path })}
        >
          <Unlink />
        </IconButton>
        <IconButton
          size="sm"
          tip={wt.isDirty ? "Commit or discard changes first" : "Remove worktree"}
          disabled={wt.isDirty}
          className="hover:text-danger"
          onClick={() => actions.removeWorktree({ worktreePath: wt.path, chatId })}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}

/** A chat-owned worktree path we know about but whose runtime info hasn't landed yet. */
function PendingWorktreeCard({ path, chatId }: { path: string; chatId: string }) {
  const [copied, setCopied] = useState(false);
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  const reveal = async () => {
    if (await copyToClipboard(path)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <div className="rounded-md border border-dashed border-line bg-panel-2/30">
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1">
          <span className="block truncate cm-mono !text-[11.5px] font-medium text-secondary">{name}</span>
          <span className="flex items-center gap-1 text-[10.5px] text-faint">
            <Spinner size={10} />
            syncing worktree…
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 border-t border-line-soft px-3 py-2">
        <Button size="xs" variant="ghost" leftIcon={copied ? <Check /> : <FolderOpen />} onClick={reveal}>
          {copied ? "Copied" : "Reveal"}
        </Button>
        <IconButton
          size="sm"
          tip="Unlink from this chat (keeps the worktree on disk)"
          className="ml-auto hover:text-warn"
          onClick={() => actions.detachWorktree({ chatId, worktreePath: path })}
        >
          <Unlink />
        </IconButton>
        <IconButton
          size="sm"
          tip="Remove worktree"
          className="hover:text-danger"
          onClick={() => actions.removeWorktree({ worktreePath: path, chatId })}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}

export function WorktreesPanel({ chat }: { chat: Chat }) {
  const worktrees = usePanels((s) => s.worktrees);
  const diffs = usePanels((s) => s.diffs);
  const prs = usePanels((s) => s.prs);

  // Runtime worktrees the server knows about that belong to this chat.
  const mine = worktrees.filter((w) => worktreeMatchesChat(w, chat));
  // Chat-owned paths with no runtime info yet (freshly created, still syncing) so
  // EVERY entry in chat.worktrees renders — 0, 1, or many.
  const pending = chat.worktrees.filter((p) => !mine.some((w) => samePath(w.path, p)));
  const total = mine.length + pending.length;

  // Match a worktree to its PR by branch (prefer an open PR over a closed/merged one).
  const prFor = (branch: string): PRInfo | undefined =>
    prs.find((p) => p.branch === branch && p.state === "open") ?? prs.find((p) => p.branch === branch);

  // Fetch each worktree's diff-vs-base summary, re-fetching when the worktree
  // actually changes. The guard is keyed by the worktree's identity (head + dirty
  // + ahead), so a turn-end refresh that brings new commits/edits re-pulls the
  // diff, while a steady-state re-render doesn't loop.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    for (const wt of mine) {
      const key = `${wt.path}@${wt.head ?? ""}@${wt.isDirty ? "d" : ""}@${wt.ahead ?? 0}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      void loadWorktreeDiff(wt.path, wt.base ?? "main");
    }
  }, [mine]);

  if (total === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <GitBranch className="mx-auto mb-2 size-5 text-faint" />
        <p className="text-[12px] text-muted">No worktrees yet.</p>
        <p className="mt-0.5 text-[11px] text-faint">
          Worktrees appear here when the agent creates one for this chat.
        </p>
        <div className="mt-3 flex justify-center">
          <NewWorktreeButton chat={chat} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] text-faint">
          {total} worktree{total > 1 ? "s" : ""}
        </span>
        <NewWorktreeButton chat={chat} />
      </div>
      {mine.map((wt) => (
        <WorktreeCard key={wt.path} wt={wt} diff={diffs[wt.path]} pr={prFor(wt.branch)} chatId={chat.id} />
      ))}
      {pending.map((p) => (
        <PendingWorktreeCard key={p} path={p} chatId={chat.id} />
      ))}
    </div>
  );
}
