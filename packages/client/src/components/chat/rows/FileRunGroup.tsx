import { memo, useMemo, useState } from "react";
import { Eye, FilePlus2, FileSearch, Files, Pencil, Search, X } from "lucide-react";
import {
  fileEditStat,
  fileResultStat,
  type FileToolAction,
  type FileToolStat,
  type TaskStatusRow,
  type ToolResultRow,
  type ToolUseRow,
} from "@dispatch/shared";
import { RowShell } from "./RowShell.js";
import { ToolDetailModal } from "../ToolDetailModal.js";
import { Button } from "../../ui/Button.js";
import { Spinner } from "../../ui/Spinner.js";
import { OverflowTooltip } from "../../ui/OverflowTooltip.js";
import { cn } from "../../../lib/cn.js";
import { dur, safeJson } from "../../../lib/format.js";
import { toolCallElapsed, toolCallState, type ToolCallState } from "../../../lib/toolState.js";
import { hydrateFullRows } from "../../../stores/index.js";
import { useChats } from "../../../stores/chats.js";
import { usePanels } from "../../../stores/panels.js";
import { openCodeViewer, resolveChatFile, type WorktreeTarget } from "../../monaco/index.js";
import { resultText, toolPresentation, type FileToolPresentation } from "../../../lib/toolPresentations.js";

export interface FileRunEntry {
  use: ToolUseRow;
  result?: ToolResultRow;
  task?: TaskStatusRow;
}

/* ------------------------------------------------------------------- stats */

function numberArg(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The `+n −m` for a write/edit. `fileStat` is the server's answer, taken before
 * the lean projection dropped the edit bodies; without it the row still has the
 * verbatim input to count from.
 */
function editStatOf(use: ToolUseRow): FileToolStat | null {
  return use.fileStat ?? (use.inputOmitted ? null : fileEditStat(use.name, use.input));
}

/** The line range a read returned / hit count a search found. */
function readStatOf(use: ToolUseRow, result?: ToolResultRow): FileToolStat | null {
  if (result?.fileStat) return result.fileStat;
  if (result && !result.contentOmitted) return fileResultStat(use.name, resultText(result.content));
  // A clipped result with no carried stat (its tool_use paged in separately)
  // would COUNT THE PREVIEW and report a range shorter than what was read. The
  // range the call asked for is less precise but never wrong.
  const offset = numberArg(use.input, "offset");
  const limit = numberArg(use.input, "limit");
  if (offset === undefined && limit === undefined) return null;
  const startLine = offset ?? 1;
  return { startLine, endLine: limit ? startLine + limit - 1 : undefined, lines: limit };
}

/* -------------------------------------------------------------------- path */

interface SplitPath {
  dir: string;
  file: string;
}

function splitPath(path: string): SplitPath {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  return cut < 0
    ? { dir: "", file: normalized }
    : { dir: normalized.slice(0, cut), file: normalized.slice(cut + 1) };
}

/* -------------------------------------------------------------------- row */

const ACTION_ICON: Record<FileToolAction, typeof Pencil> = {
  edit: Pencil,
  write: FilePlus2,
  read: Eye,
  search: Search,
};

/** `+12 −3`, a read's line range, or a search's hit count. */
function StatCell({
  action,
  stat,
  state,
}: {
  action: FileToolAction;
  stat: FileToolStat | null;
  state: ToolCallState;
}) {
  if (state === "running") return <Spinner size={9} />;
  if (state === "failed") return <X className="size-3 text-danger" />;
  // A stopped call was interrupted mid-flight: whatever stat we could compute
  // describes what it INTENDED to do, so showing it would read as completed.
  if (state === "stopped") return <span className="text-muted">stopped</span>;
  if (!stat) return <span className="text-faint">·</span>;

  if (action === "edit" || action === "write") {
    const added = stat.added ?? 0;
    const removed = stat.removed ?? 0;
    if (!added && !removed) return <span className="text-faint">no change</span>;
    return (
      <>
        {added > 0 && <span className="text-success">+{added}</span>}
        {removed > 0 && <span className="text-danger">-{removed}</span>}
      </>
    );
  }

  if (action === "search") {
    const count = stat.count ?? 0;
    return (
      <span className={cn(count ? "text-secondary" : "text-faint")}>
        {count} {count === 1 ? "hit" : "hits"}
      </span>
    );
  }

  if (stat.startLine !== undefined && stat.endLine !== undefined && stat.endLine > stat.startLine) {
    return (
      <span className="text-muted">
        L{stat.startLine}–{stat.endLine}
      </span>
    );
  }
  if (stat.lines !== undefined) {
    return <span className="text-muted">{stat.lines} lines</span>;
  }
  if (stat.startLine !== undefined) return <span className="text-muted">L{stat.startLine}</span>;
  return <span className="text-faint">·</span>;
}

function FileRow({
  entry,
  presentation,
  target,
  /** A search's directory, already made relative to the worktree it ran in. */
  scope,
  /** True when the row above touched the same file — its path is dimmed as a repeat. */
  repeat,
}: {
  entry: FileRunEntry;
  presentation: FileToolPresentation;
  target: WorktreeTarget | null;
  scope: string;
  repeat: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const { action } = presentation;
  const state = toolCallState(entry.result, entry.task);
  const elapsed = toolCallElapsed(entry.result, entry.task);
  const stat = action === "read" || action === "search"
    ? readStatOf(entry.use, entry.result)
    : editStatOf(entry.use);
  // A Glob matches file NAMES and a Grep matches file CONTENTS — different
  // enough that the pattern on the row reads differently, so the icon says which.
  const Icon = presentation.tool === "Glob" ? FileSearch : ACTION_ICON[action];

  const openDetail = () => {
    const ids: string[] = [];
    if (entry.use.inputOmitted) ids.push(entry.use.id);
    if (entry.result?.contentOmitted) ids.push(entry.result.id);
    if (ids.length) void hydrateFullRows(entry.use.chatId, ids);
    setDetailOpen(true);
  };

  // Drilling in lands where the work happened: a diff for an edit, the file
  // scrolled to the lines that were read for a read. A row we cannot resolve to
  // a worktree file (or a search, which has no single file) opens the raw
  // request/response instead, so the click is never dead.
  const activate = () => {
    if (!target || action === "search") {
      openDetail();
      return;
    }
    openCodeViewer({
      worktreePath: target.worktreePath,
      relPath: target.relPath,
      branch: target.branch,
      base: target.base,
      mode: action === "read" ? "file" : "diff",
      selection:
        action === "read" && stat?.startLine !== undefined
          ? { startLine: stat.startLine, endLine: stat.endLine ?? stat.startLine }
          : undefined,
    });
  };

  const shown = target?.relPath ?? presentation.path ?? "";
  const { dir, file } = splitPath(shown);
  const label = action === "search"
    ? [presentation.pattern, scope && `in ${scope}`, presentation.filter].filter(Boolean).join(" ")
    : shown;

  return (
    <div data-row-id={entry.use.id}>
      <Button
        type="button"
        variant="ghost"
        onClick={activate}
        title={
          action === "search"
            ? "Show what this search returned"
            : !target
              ? "Show this call's arguments and result"
              : action === "read"
                ? "Open the file at the lines that were read"
                : "Open the diff for this file"
        }
        className="group/file !grid !h-[26px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 !rounded-none !border-0 px-2.5 text-left !font-normal hover:!bg-hover/40 active:translate-y-0"
      >
        <Icon
          className={cn(
            "size-3 shrink-0 transition-colors",
            state === "failed" ? "text-danger/70" : "text-faint group-hover/file:text-accent-hi",
          )}
        />

        <OverflowTooltip text={label} className="min-w-0 !text-xs">
          {action === "search" ? (
            // The query is the row. Everything else is where it ran, so the
            // shrink weights let the directory collapse to nothing before the
            // pattern gives up a character — an absolute worktree path used to
            // take the whole line and leave the search string invisible.
            <span className="flex min-w-0 items-baseline gap-1.5 cm-mono !text-xs">
              <span className="min-w-0 shrink truncate font-medium text-primary">
                {presentation.pattern}
              </span>
              {scope && (
                // RTL for the same reason a file path uses it: the tail is the
                // part that says which directory this actually was. The "in"
                // rides along so it ellipsizes away with the rest of the phrase
                // rather than being left dangling over an empty span.
                <span dir="rtl" className="min-w-0 shrink-[100] truncate text-faint">
                  in {scope}
                </span>
              )}
              {presentation.filter && (
                <span className="min-w-0 shrink-[100] truncate text-muted">
                  {presentation.filter}
                </span>
              )}
            </span>
          ) : (
            <span
              className={cn(
                "flex min-w-0 items-baseline cm-mono !text-xs transition-opacity",
                // A run of edits to ONE file is the common shape, and repeating
                // its path five times makes the column of numbers — the part
                // that actually differs — harder to find, not easier.
                repeat && "opacity-55 group-hover/file:opacity-100",
              )}
            >
              {dir && (
                <>
                  {/* RTL so the ellipsis eats the LEFT of a deep path: the tail
                      (the directory the file is actually in) is the useful part. */}
                  <span dir="rtl" className="min-w-0 truncate text-faint">
                    {dir}
                  </span>
                  <span className="shrink-0 text-faint">/</span>
                </>
              )}
              <span className="shrink-0 font-medium text-primary">{file}</span>
            </span>
          )}
        </OverflowTooltip>

        <span className="flex shrink-0 items-center justify-end gap-1.5 cm-mono !text-2xs tabular-nums">
          {elapsed !== undefined && elapsed >= 1_000 && (
            <span className="text-faint/70">{dur(elapsed)}</span>
          )}
          <StatCell action={action} stat={stat} state={state} />
        </span>
      </Button>

      <ToolDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={label || entry.use.name}
        description={`${entry.use.name} · ${action}`}
        icon={<Icon />}
        state={state}
        duration={dur(elapsed)}
        request={safeJson(entry.use.input)}
        requestLabel="Arguments"
        response={entry.result ? resultText(entry.result.content) : ""}
        responseLabel="Result"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ group */

/**
 * A run of adjacent file calls, rendered as a changelog rather than as a stack
 * of collapsible cards.
 *
 * The shape is deliberately NOT the terminal frame: a shell run is a
 * conversation (you sent this, it said that), while file work is a ledger — one
 * fixed-height line per touch, path on the left, `+n −m` right-aligned so a long
 * run reads as a column of numbers. That column is the entire point: fifteen
 * edits in a row should be scannable at a glance, which is exactly what fifteen
 * identical "Edit ✓" cards were not.
 */
export const FileRunGroup = memo(function FileRunGroup({ entries }: { entries: FileRunEntry[] }) {
  const chatId = entries[0]?.use.chatId ?? "";
  const chat = useChats((s) => s.byId[chatId]);
  const worktrees = usePanels((s) => s.worktrees);

  const rows = useMemo(
    () =>
      entries.flatMap((entry) => {
        const presentation = toolPresentation(entry.use);
        if (presentation?.kind !== "file") return [];
        const target = presentation.path
          ? resolveChatFile(chat, worktrees, presentation.path)
          : null;
        // A search's `path` arrives absolute more often than not, and the
        // worktree prefix is the one part of it the reader already knows.
        // Resolving to "" means it searched the worktree root — say nothing.
        const scopeTarget = presentation.scope
          ? resolveChatFile(chat, worktrees, presentation.scope)
          : null;
        const scope = scopeTarget?.relPath ?? presentation.scope ?? "";
        return [{ entry, presentation, target, scope }];
      }),
    [entries, chat, worktrees],
  );

  const summary = useMemo(() => {
    let added = 0;
    let removed = 0;
    let touched = 0;
    let read = 0;
    let searched = 0;
    let failed = false;
    let running = false;
    for (const { entry, presentation } of rows) {
      const state = toolCallState(entry.result, entry.task);
      if (state === "failed") failed = true;
      if (state === "running") running = true;
      if (presentation.action === "read") {
        read++;
        continue;
      }
      if (presentation.action === "search") {
        searched++;
        continue;
      }
      touched++;
      const stat = editStatOf(entry.use);
      added += stat?.added ?? 0;
      removed += stat?.removed ?? 0;
    }
    return { added, removed, touched, read, searched, failed, running };
  }, [rows]);

  if (!rows.length) return null;

  // Counted separately because they are named separately: a Grep is not a read,
  // and folding both into "4 reads" describes a run that did not happen.
  const counts = [
    summary.touched ? `${summary.touched} change${summary.touched === 1 ? "" : "s"}` : "",
    summary.read ? `${summary.read} read${summary.read === 1 ? "" : "s"}` : "",
    summary.searched ? `${summary.searched} search${summary.searched === 1 ? "" : "es"}` : "",
  ].filter(Boolean);

  return (
    <RowShell
      gutter={
        <span className="flex size-6 items-center justify-center rounded-md bg-inset text-secondary ring-1 ring-line [&_svg]:size-3.5">
          <Files />
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-line bg-inset shadow-[inset_0_1px_0_0_var(--p-line-soft)]">
        {/* A single touch needs no header — the row already says everything the
            header would, and a two-line frame around one line reads as clutter. */}
        {rows.length > 1 && (
          <div className="flex h-7 items-center gap-2 border-b border-line-soft px-2.5">
            <span className="cm-mono !text-xs font-semibold text-primary">Files</span>
            <span className="cm-mono !text-2xs text-faint">{counts.join(" · ")}</span>
            <span className="ml-auto flex items-center gap-1.5 cm-mono !text-2xs tabular-nums">
              {summary.running && <Spinner size={9} />}
              {summary.failed && <X className="size-3 text-danger" />}
              {summary.added > 0 && <span className="text-success">+{summary.added}</span>}
              {summary.removed > 0 && <span className="text-danger">-{summary.removed}</span>}
            </span>
          </div>
        )}
        <div className="py-0.5">
          {rows.map(({ entry, presentation, target, scope }, index) => {
            const previous = rows[index - 1];
            return (
              <FileRow
                key={entry.use.id}
                entry={entry}
                presentation={presentation}
                target={target}
                scope={scope}
                repeat={
                  !!previous &&
                  !!presentation.path &&
                  previous.presentation.path === presentation.path
                }
              />
            );
          })}
        </div>
      </div>
    </RowShell>
  );
});
