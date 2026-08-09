/**
 * Shared, controlled branch/worktree picker used by BOTH the right-panel
 * RunnerPanel and the left Sidebar. Searchable, recency-sorted (edited date),
 * with a distinct icon per kind: primary checkout (House), worktree (FolderGit2),
 * bare branch (GitBranch). Purely presentational — the parent owns the selected
 * branch (two-way binding via `value` + `onChange`).
 */
import { useMemo, useRef, useState } from "react";
import { House, FolderGit2, GitBranch, ChevronDown, Check, Search, Dot } from "lucide-react";
import { Popover } from "../ui/Popover.js";
import { cn } from "../../lib/cn.js";
import { relTimeShort } from "../../lib/format.js";
import type { LaunchKind, LaunchTarget } from "./useLauncher.js";

const KIND_ICON: Record<LaunchKind, typeof GitBranch> = {
  repo: House,
  worktree: FolderGit2,
  branch: GitBranch,
};
const KIND_TIP: Record<LaunchKind, string> = {
  repo: "primary checkout",
  worktree: "worktree",
  branch: "branch (no worktree — created on launch)",
};

export function BranchWorktreePicker({
  targets,
  value,
  onChange,
  align = "end",
  width = 300,
  disabled = false,
}: {
  targets: LaunchTarget[];
  value: string | undefined;
  onChange: (branch: string) => void;
  align?: "start" | "end";
  width?: number;
  disabled?: boolean;
}) {
  const current = targets.find((t) => t.branch === value) ?? targets[0];
  const CurIcon = current ? KIND_ICON[current.kind] : GitBranch;

  return (
    <Popover
      align={align}
      width={width}
      className="p-0"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled || targets.length === 0}
          aria-expanded={open}
          title={current ? `${current.branch} — ${KIND_TIP[current.kind]}` : "No branches"}
          className={cn(
            "flex items-center gap-1 rounded-sm border border-line bg-inset px-1.5 py-0.5 cm-mono !text-2xs text-secondary transition-colors hover:border-line-strong disabled:opacity-45",
            open && "border-line-strong",
          )}
        >
          <CurIcon className="size-3 shrink-0 text-accent-hi" />
          <span className="max-w-[130px] truncate">{current?.branch ?? "—"}</span>
          <ChevronDown className="size-3 shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <PickerList
          targets={targets}
          value={value}
          onPick={(b) => {
            onChange(b);
            close();
          }}
        />
      )}
    </Popover>
  );
}

function PickerList({
  targets,
  value,
  onPick,
}: {
  targets: LaunchTarget[];
  value: string | undefined;
  onPick: (branch: string) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const now = Date.now();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return targets;
    return targets.filter((t) => t.branch.toLowerCase().includes(needle));
  }, [q, targets]);

  return (
    <div className="flex max-h-[min(60vh,380px)] flex-col">
      {/* search */}
      <div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
        <Search className="size-3 shrink-0 text-faint" />
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search branches…"
          spellCheck={false}
          className="w-full bg-transparent text-xs text-primary outline-none placeholder:text-faint"
        />
      </div>

      {/* list */}
      <div className="cm-scroll min-h-0 flex-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-2 text-2xs text-faint">No branches match.</p>
        ) : (
          filtered.map((t) => {
            const Icon = KIND_ICON[t.kind];
            const selected = t.branch === value;
            return (
              <button
                key={t.branch}
                type="button"
                onClick={() => onPick(t.branch)}
                title={KIND_TIP[t.kind]}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-active",
                  selected && "bg-hover",
                )}
              >
                <Icon
                  className={cn(
                    "size-3 shrink-0",
                    t.kind === "branch" ? "text-muted" : "text-accent-hi",
                  )}
                />
                <span className="min-w-0 flex-1 truncate cm-mono !text-2xs text-secondary">
                  {t.branch}
                </span>
                {t.isDirty && <Dot className="size-3 shrink-0 text-warn" />}
                {t.editedAt && (
                  <span className="shrink-0 text-2xs tabular-nums text-faint">
                    {relTimeShort(t.editedAt, now)}
                  </span>
                )}
                {selected && <Check className="size-3 shrink-0 text-success" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
