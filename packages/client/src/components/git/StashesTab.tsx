/**
 * The Stashes tab: the stash stack with Apply / Pop / Drop, and per-entry file
 * lists that diff against the stash's base commit (`stash@{n}^1`), so you can
 * read what's inside one before deciding to restore it.
 *
 * Drop is destructive and unrecoverable once the reflog entry goes, so it takes
 * a second click to confirm.
 */
import { useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Trash2,
  X,
} from "lucide-react";
import type { GitCommitFile, GitStash } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { relTime, statusMeta, splitPath } from "./fileMeta.js";
import { stashSelection, type GitSelection } from "../../stores/git.js";

function DropButton({ onDrop }: { onDrop: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <IconButton size="sm" tip="Drop stash" className="hover:!text-danger" onClick={() => setConfirming(true)}>
        <Trash2 />
      </IconButton>
    );
  }
  return (
    <>
      <IconButton
        size="sm"
        tip="Confirm drop — this cannot be undone"
        className="!text-danger hover:!bg-danger/15"
        onClick={onDrop}
      >
        <Check />
      </IconButton>
      <IconButton size="sm" tip="Cancel" onClick={() => setConfirming(false)}>
        <X />
      </IconButton>
    </>
  );
}

export function StashesTab({
  stashes,
  stashFiles,
  expanded,
  selection,
  busy,
  onToggle,
  onSelect,
  onApply,
  onPop,
  onDrop,
}: {
  stashes: GitStash[];
  stashFiles: Record<string, GitCommitFile[]>;
  expanded: string | null;
  selection: GitSelection | null;
  busy: string | null;
  onToggle: (ref: string) => void;
  onSelect: (s: GitSelection) => void;
  onApply: (index: number) => void;
  onPop: (index: number) => void;
  onDrop: (index: number) => void;
}) {
  if (stashes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <Archive className="mb-2 size-5 text-faint" />
        <p className="text-[12px] text-muted">No stashes.</p>
        <p className="mt-0.5 text-[11px] text-faint">
          Stash from the toolbar to park your working-tree changes.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {stashes.map((s) => {
        const open = expanded === s.ref;
        const files = stashFiles[s.ref];
        return (
          <div key={s.ref} className="mb-1 rounded-md border border-line bg-panel-2/40">
            <button
              onClick={() => onToggle(s.ref)}
              className="flex w-full items-start gap-2 px-2 py-1.5 text-left"
            >
              <span className="mt-[3px] shrink-0">
                {open ? (
                  <ChevronDown className="size-3 text-faint" />
                ) : (
                  <ChevronRight className="size-3 text-faint" />
                )}
              </span>
              <Archive className="mt-[1px] size-3.5 shrink-0 text-accent-hi" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-secondary">{s.message}</span>
                <span className="mt-px flex items-center gap-1.5 text-[10px] text-faint">
                  <span className="cm-mono !text-[9.5px]">{s.ref}</span>
                  {s.branch && (
                    <>
                      <span>·</span>
                      <span className="truncate">on {s.branch}</span>
                    </>
                  )}
                  {s.at && (
                    <>
                      <span>·</span>
                      <span>{relTime(s.at)}</span>
                    </>
                  )}
                </span>
              </span>
            </button>

            {open && (
              <div className="border-t border-line-soft">
                {!files ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-faint">
                    <Spinner size={11} />
                    Loading files…
                  </div>
                ) : files.length === 0 ? (
                  <p className="px-3 py-2 text-[11px] text-faint">No file changes.</p>
                ) : (
                  <div className="p-1">
                    {files.map((f) => {
                      const meta = statusMeta(f.status);
                      const { name, dir } = splitPath(f.path);
                      return (
                        <button
                          key={f.path}
                          onClick={() => onSelect(stashSelection(s.ref, f.path))}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
                            selection?.relPath === f.path && selection.rightRev === s.ref
                              ? "bg-accent-ghost"
                              : "hover:bg-white/[0.04]",
                          )}
                        >
                          <span
                            className={cn(
                              "w-3 shrink-0 text-center cm-mono !text-[10px] font-bold",
                              meta.className,
                            )}
                          >
                            {meta.letter}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            <span className="cm-mono !text-[11px] text-secondary">{name}</span>
                            {dir && (
                              <span className="ml-1.5 cm-mono !text-[9.5px] text-faint">
                                {midTruncate(dir, 24)}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex items-center gap-1.5 border-t border-line-soft px-2 py-1.5">
                  <Button
                    size="xs"
                    variant="subtle"
                    leftIcon={<CornerDownLeft />}
                    disabled={!!busy}
                    onClick={() => onApply(s.index)}
                  >
                    Apply
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    leftIcon={<Check />}
                    disabled={!!busy}
                    onClick={() => onPop(s.index)}
                  >
                    Pop
                  </Button>
                  <div className="ml-auto">
                    <DropButton onDrop={() => onDrop(s.index)} />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
