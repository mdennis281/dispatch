/**
 * The Changes tab: a commit box on top, then Staged / Changes / Untracked
 * groups of file rows.
 *
 * Clicking a row opens its diff in the right pane; the hover rail carries the
 * verbs that apply to THAT side of the index (stage/unstage, and discard for
 * working-tree rows). Discard is the only irreversible one, so it takes a
 * second click to confirm — the same two-click pattern the chat list uses for
 * delete.
 */
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { GitFileChange, GitStatus } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { statusMeta, splitPath } from "./fileMeta.js";
import type { GitSelection } from "../../stores/git.js";
import { stagedSelection, unstagedSelection } from "../../stores/git.js";

/* -------------------------------------------------------------- file row */

function FileRow({
  file,
  active,
  onSelect,
  actions,
}: {
  file: GitFileChange;
  active: boolean;
  onSelect: () => void;
  actions: React.ReactNode;
}) {
  const meta = statusMeta(file.status);
  const { name, dir } = splitPath(file.path);
  return (
    <div className="group/row relative">
      <button
        onClick={onSelect}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1 pl-2 pr-16 text-left transition-colors",
          active ? "bg-accent-ghost" : "hover:bg-hover",
        )}
      >
        <span
          className={cn(
            "w-3 shrink-0 text-center cm-mono !text-[10.5px] font-bold",
            meta.className,
          )}
          title={meta.label}
        >
          {meta.letter}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span
            className={cn(
              "cm-mono !text-[11.5px]",
              file.status === "deleted"
                ? "text-muted line-through"
                : active
                  ? "text-primary"
                  : "text-secondary",
            )}
          >
            {name}
          </span>
          {dir && (
            <span className="ml-1.5 cm-mono !text-[10px] text-faint">
              {midTruncate(dir, 30)}
            </span>
          )}
        </span>
      </button>
      <div className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        {actions}
      </div>
    </div>
  );
}

/** Two-click confirm for the one action here that can't be undone. */
function DiscardButton({ onDiscard }: { onDiscard: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <IconButton
        size="sm"
        tip="Discard changes"
        className="hover:!text-danger"
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
      </IconButton>
    );
  }
  return (
    <>
      <IconButton
        size="sm"
        tip="Confirm discard — this cannot be undone"
        className="!text-danger hover:!bg-danger/15"
        onClick={onDiscard}
      >
        <Check />
      </IconButton>
      <IconButton size="sm" tip="Cancel" onClick={() => setConfirming(false)}>
        <X />
      </IconButton>
    </>
  );
}

/* ---------------------------------------------------------------- group */

function Group({
  title,
  files,
  defaultOpen = true,
  headerActions,
  children,
}: {
  title: string;
  files: GitFileChange[];
  defaultOpen?: boolean;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (files.length === 0) return null;
  return (
    <div className="pb-1">
      <div className="group/head flex items-center gap-1 px-1.5 py-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-faint" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-faint" />
          )}
          <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
            {title}
          </span>
          <span className="cm-mono !text-[9.5px] text-faint">{files.length}</span>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100">
          {headerActions}
        </div>
      </div>
      {open && <div className="space-y-px px-1.5">{children}</div>}
    </div>
  );
}

/* ----------------------------------------------------------- commit box */

/** Ceiling for the auto-growing message box, so it can't swallow the file list. */
const MAX_MESSAGE_PX = 200;

function CommitBox({
  status,
  message,
  amend,
  busy,
  generating,
  onMessage,
  onAmend,
  onGenerate,
  onCommit,
}: {
  status: GitStatus | null;
  message: string;
  amend: boolean;
  busy: string | null;
  generating: boolean;
  onMessage: (v: string) => void;
  onAmend: (v: boolean) => void;
  onGenerate: () => void;
  onCommit: () => void;
}) {
  const stagedCount = status?.staged.length ?? 0;
  const conflicts = status?.conflicted.length ?? 0;

  // Grow to fit the message, capped so the box can never crowd out the file
  // list. Matters most for an AI draft: it arrives as subject + body all at
  // once, and a fixed 3-row box would hide the half you most need to review
  // before committing.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_MESSAGE_PX)}px`;
  }, [message]);
  // Amending re-uses the existing commit, so an empty index is fine there —
  // it's only a fresh commit that needs something staged.
  const canCommit =
    !!message.trim() && (amend || stagedCount > 0) && conflicts === 0 && !busy;

  return (
    <div className="border-b border-line bg-panel-2/40 p-2">
      <div className="relative">
        <textarea
          ref={boxRef}
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter commits without leaving the box.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
              e.preventDefault();
              onCommit();
            }
          }}
          rows={3}
          spellCheck
          placeholder={
            stagedCount > 0
              ? "Commit message (⌘/Ctrl+Enter to commit)"
              : "Stage some changes to commit…"
          }
          className="w-full resize-y rounded-md border border-line bg-inset px-2 py-1.5 pr-8 text-[12px] leading-[1.45] text-primary outline-none placeholder:text-faint focus:border-line-strong"
        />
        <div className="absolute right-1.5 top-1.5">
          <IconButton
            size="sm"
            tip={
              stagedCount === 0
                ? "Stage changes first"
                : "Draft a message from the staged diff (AI)"
            }
            disabled={stagedCount === 0 || generating}
            onClick={onGenerate}
          >
            {generating ? <Spinner size={12} /> : <Sparkles className="text-accent-hi" />}
          </IconButton>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted hover:text-secondary">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => onAmend(e.target.checked)}
            className="size-3 accent-[var(--p-accent)]"
          />
          Amend
        </label>
        {conflicts > 0 && (
          <span className="text-[11px] text-danger">
            {conflicts} conflict{conflicts > 1 ? "s" : ""} to resolve
          </span>
        )}
        <Button
          size="xs"
          variant="primary"
          className="ml-auto"
          leftIcon={busy === "Commit" ? <Spinner size={12} /> : <Check />}
          disabled={!canCommit}
          onClick={onCommit}
        >
          {amend ? "Amend commit" : `Commit${stagedCount ? ` ${stagedCount}` : ""}`}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tab */

export interface ChangesTabProps {
  status: GitStatus | null;
  selection: GitSelection | null;
  message: string;
  amend: boolean;
  busy: string | null;
  generating: boolean;
  onSelect: (s: GitSelection) => void;
  onMessage: (v: string) => void;
  onAmend: (v: boolean) => void;
  onGenerate: () => void;
  onCommit: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
}

export function ChangesTab(props: ChangesTabProps) {
  const {
    status,
    selection,
    busy,
    onSelect,
    onStage,
    onUnstage,
    onDiscard,
    onStageAll,
    onUnstageAll,
  } = props;

  const isActive = (path: string, staged: boolean) =>
    selection?.relPath === path &&
    (staged ? selection.label === "staged" : selection.label !== "staged");

  const unstagedAll = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])];
  const nothing =
    (status?.staged.length ?? 0) === 0 &&
    unstagedAll.length === 0 &&
    (status?.conflicted.length ?? 0) === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CommitBox
        status={status}
        message={props.message}
        amend={props.amend}
        busy={busy}
        generating={props.generating}
        onMessage={props.onMessage}
        onAmend={props.onAmend}
        onGenerate={props.onGenerate}
        onCommit={props.onCommit}
      />

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {nothing && (
          <p className="px-3 py-8 text-center text-[11.5px] text-faint">
            Working tree clean — nothing to commit.
          </p>
        )}

        {(status?.conflicted.length ?? 0) > 0 && (
          <Group title="Conflicts" files={status?.conflicted ?? []}>
            {status?.conflicted.map((f) => (
              <FileRow
                key={`c:${f.path}`}
                file={f}
                active={isActive(f.path, false)}
                onSelect={() => onSelect(unstagedSelection(f.path))}
                actions={
                  <IconButton
                    size="sm"
                    tip="Mark resolved (stage)"
                    onClick={() => onStage([f.path])}
                  >
                    <Check />
                  </IconButton>
                }
              />
            ))}
          </Group>
        )}

        <Group
          title="Staged"
          files={status?.staged ?? []}
          headerActions={
            <IconButton size="sm" tip="Unstage all" onClick={onUnstageAll}>
              <Minus />
            </IconButton>
          }
        >
          {status?.staged.map((f) => (
            <FileRow
              key={`s:${f.path}`}
              file={f}
              active={isActive(f.path, true)}
              onSelect={() => onSelect(stagedSelection(f.path))}
              actions={
                <IconButton size="sm" tip="Unstage" onClick={() => onUnstage([f.path])}>
                  <Undo2 />
                </IconButton>
              }
            />
          ))}
        </Group>

        <Group
          title="Changes"
          files={unstagedAll}
          headerActions={
            <IconButton size="sm" tip="Stage all" onClick={onStageAll}>
              <Plus />
            </IconButton>
          }
        >
          {unstagedAll.map((f) => (
            <FileRow
              key={`u:${f.path}`}
              file={f}
              active={isActive(f.path, false)}
              onSelect={() =>
                onSelect(unstagedSelection(f.path, f.status === "untracked"))
              }
              actions={
                <>
                  <DiscardButton onDiscard={() => onDiscard([f.path])} />
                  <IconButton size="sm" tip="Stage" onClick={() => onStage([f.path])}>
                    <Plus />
                  </IconButton>
                </>
              }
            />
          ))}
        </Group>
      </div>
    </div>
  );
}
