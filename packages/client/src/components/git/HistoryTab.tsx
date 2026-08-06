/**
 * The History tab: commits newest-first, each expanding in place to the files
 * it touched. Picking a file diffs it against the commit's first parent, so the
 * right pane shows exactly what THAT commit changed.
 */
import { GitCommit as GitCommitIcon, ChevronDown, ChevronRight, Tag } from "lucide-react";
import type { GitCommit, GitCommitFile } from "@dispatch/shared";
import { Spinner } from "../ui/Spinner.js";
import { Chip } from "../ui/Chip.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { relTime, statusMeta, splitPath } from "./fileMeta.js";
import { commitSelection, type GitSelection } from "../../stores/git.js";

function CommitFileRow({
  file,
  commit,
  active,
  onSelect,
}: {
  file: GitCommitFile;
  commit: GitCommit;
  active: boolean;
  onSelect: (s: GitSelection) => void;
}) {
  const meta = statusMeta(file.status);
  const { name, dir } = splitPath(file.path);
  return (
    <button
      onClick={() => onSelect(commitSelection(commit.hash, file.path, commit.shortHash))}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1 pl-5 pr-2 text-left transition-colors",
        active ? "bg-accent-ghost" : "hover:bg-white/[0.04]",
      )}
    >
      <span
        className={cn("w-3 shrink-0 text-center cm-mono !text-[10px] font-bold", meta.className)}
        title={meta.label}
      >
        {meta.letter}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="cm-mono !text-[11px] text-secondary">{name}</span>
        {dir && (
          <span className="ml-1.5 cm-mono !text-[9.5px] text-faint">{midTruncate(dir, 24)}</span>
        )}
      </span>
      {!file.binary && (
        <>
          <span className="shrink-0 cm-mono !text-[10px] tabular-nums text-success">
            +{file.additions}
          </span>
          <span
            className={cn(
              "shrink-0 cm-mono !text-[10px] tabular-nums",
              file.deletions > 0 ? "text-danger" : "text-faint",
            )}
          >
            −{file.deletions}
          </span>
        </>
      )}
    </button>
  );
}

export function HistoryTab({
  commits,
  commitFiles,
  expanded,
  selection,
  loading,
  onToggle,
  onSelect,
}: {
  commits: GitCommit[];
  commitFiles: Record<string, GitCommitFile[]>;
  expanded: string | null;
  selection: GitSelection | null;
  loading: boolean;
  onToggle: (sha: string) => void;
  onSelect: (s: GitSelection) => void;
}) {
  if (loading && commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={16} />
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[11.5px] text-faint">No commits yet.</p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {commits.map((c) => {
        const open = expanded === c.hash;
        const files = commitFiles[c.hash];
        return (
          <div key={c.hash} className="mb-px">
            <button
              onClick={() => onToggle(c.hash)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                open ? "bg-white/[0.045]" : "hover:bg-white/[0.03]",
              )}
            >
              <span className="mt-[3px] shrink-0">
                {open ? (
                  <ChevronDown className="size-3 text-faint" />
                ) : (
                  <ChevronRight className="size-3 text-faint" />
                )}
              </span>
              <GitCommitIcon className="mt-[1px] size-3.5 shrink-0 text-accent-hi" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-secondary">{c.subject}</span>
                <span className="mt-px flex items-center gap-1.5 text-[10px] text-faint">
                  <span className="cm-mono !text-[9.5px]">{c.shortHash}</span>
                  <span>·</span>
                  <span className="truncate">{c.author}</span>
                  <span>·</span>
                  <span>{relTime(c.at)}</span>
                </span>
                {c.refs.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {c.refs.slice(0, 3).map((r) => (
                      <Chip key={r} tone="accent" mono>
                        <Tag className="mr-1 inline size-2.5" />
                        {r.replace(/^HEAD -> /, "")}
                      </Chip>
                    ))}
                  </span>
                )}
              </span>
            </button>

            {open && (
              <div className="pb-1">
                {!files ? (
                  <div className="flex items-center gap-2 py-2 pl-7 text-[11px] text-faint">
                    <Spinner size={11} />
                    Loading files…
                  </div>
                ) : files.length === 0 ? (
                  <p className="py-1.5 pl-7 text-[11px] text-faint">
                    No file changes (merge or empty commit).
                  </p>
                ) : (
                  files.map((f) => (
                    <CommitFileRow
                      key={f.path}
                      file={f}
                      commit={c}
                      active={selection?.relPath === f.path && selection.rightRev === c.hash}
                      onSelect={onSelect}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
