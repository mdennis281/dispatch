/**
 * Branch switcher — the popover behind the current-branch button.
 *
 * Searchable list of local branches then remote-tracking ones, plus an inline
 * "create branch" form. Two things git enforces that the UI has to reflect
 * rather than discover by failing:
 *   - a branch already checked out in ANOTHER worktree can't be checked out
 *     here (git refuses a second checkout), so those rows are disabled and say
 *     where it lives;
 *   - checking out a remote-tracking ref would detach HEAD, so picking
 *     `origin/foo` creates a local `foo` from it instead.
 */
import { useMemo, useState } from "react";
import { Check, GitBranch, Plus, Search, Cloud, FolderGit2, ChevronsUpDown } from "lucide-react";
import type { GitBranch as GitBranchInfo, GitStatus } from "@dispatch/shared";
import { Popover } from "../ui/Popover.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { cn } from "../../lib/cn.js";
import { midTruncate } from "../../lib/format.js";
import { relTime } from "./fileMeta.js";

/** A remote-tracking name (`origin/feat/x`) → the local branch it seeds (`feat/x`). */
export function localNameFor(branch: GitBranchInfo): string {
  if (!branch.isRemote) return branch.name;
  const slash = branch.name.indexOf("/");
  return slash > 0 ? branch.name.slice(slash + 1) : branch.name;
}

function BranchRow({
  branch,
  current,
  onPick,
}: {
  branch: GitBranchInfo;
  current: boolean;
  onPick: () => void;
}) {
  // Git refuses to check out a branch that another worktree already holds.
  const heldElsewhere = !!branch.worktreePath && !current;
  const disabled = current || heldElsewhere;
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      title={
        heldElsewhere
          ? `Checked out in another worktree: ${branch.worktreePath}`
          : branch.subject
      }
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        disabled ? "opacity-60" : "hover:bg-active",
        current && "bg-accent-ghost",
      )}
    >
      {branch.isRemote ? (
        <Cloud className="size-3.5 shrink-0 text-muted" />
      ) : (
        <GitBranch className={cn("size-3.5 shrink-0", current ? "text-accent" : "text-muted")} />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate cm-mono !text-xs",
            current ? "font-semibold text-primary" : "text-secondary",
          )}
        >
          {branch.name}
        </span>
        <span className="block truncate text-2xs text-faint">
          {heldElsewhere
            ? `in worktree ${midTruncate(branch.worktreePath ?? "", 28)}`
            : [branch.subject, relTime(branch.lastCommitAt)].filter(Boolean).join(" · ")}
        </span>
      </span>
      {current && <Check className="size-3.5 shrink-0 text-accent" />}
      {!current && !!branch.ahead && (
        <Chip tone="muted" mono>
          ↑{branch.ahead}
        </Chip>
      )}
    </button>
  );
}

function CreateBranchForm({
  onCreate,
  from,
}: {
  onCreate: (name: string) => void;
  from: string;
}) {
  const [name, setName] = useState("");
  const valid = /^[\w./-]{2,}$/.test(name.trim());
  return (
    <div className="flex items-center gap-1.5 border-t border-line-soft p-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) onCreate(name.trim());
        }}
        spellCheck={false}
        placeholder={`New branch from ${from}…`}
        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-inset px-2 cm-mono !text-xs text-primary outline-none placeholder:text-faint focus:border-line-strong"
      />
      <Button
        size="sm"
        variant="primary"
        leftIcon={<Plus />}
        disabled={!valid}
        onClick={() => onCreate(name.trim())}
      >
        Create
      </Button>
    </div>
  );
}

export function BranchMenu({
  status,
  branches,
  busy,
  onCheckout,
  onCreate,
}: {
  status: GitStatus | null;
  branches: GitBranchInfo[];
  busy: boolean;
  onCheckout: (branch: GitBranchInfo) => void;
  onCreate: (name: string) => void;
}) {
  const [query, setQuery] = useState("");

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: GitBranchInfo) => !q || b.name.toLowerCase().includes(q);
    return {
      locals: branches.filter((b) => !b.isRemote && match(b)),
      remotes: branches.filter((b) => b.isRemote && match(b)),
    };
  }, [branches, query]);

  const label = status?.detached
    ? `detached @ ${status.head?.slice(0, 7) ?? "?"}`
    : status?.branch ?? "—";

  return (
    <Popover
      align="start"
      width={320}
      className="p-0"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          disabled={busy}
          className={cn(
            "inline-flex h-6 max-w-[240px] items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 " +
              "text-sm font-medium text-secondary transition-colors hover:border-line-strong hover:text-primary " +
              "disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
            open && "border-line-strong text-primary",
          )}
        >
          {busy ? <Spinner size={12} /> : <GitBranch className="text-accent" />}
          <span className="truncate cm-mono !text-xs">{label}</span>
          <ChevronsUpDown className="ml-auto shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a branch…"
              spellCheck={false}
              className="h-6 w-full bg-transparent text-sm text-primary outline-none placeholder:text-faint"
            />
          </div>

          <ScrollArea className="max-h-[320px] min-h-0">
            <div className="p-1">
              {locals.length === 0 && remotes.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-faint">No matches.</p>
              )}
              {locals.map((b) => (
                <BranchRow
                  key={`l:${b.name}`}
                  branch={b}
                  current={b.isCurrent}
                  onPick={() => {
                    onCheckout(b);
                    close();
                  }}
                />
              ))}
              {remotes.length > 0 && (
                <p className="mt-1 flex items-center gap-1.5 px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
                  <FolderGit2 className="size-3" />
                  Remote
                </p>
              )}
              {remotes.map((b) => (
                <BranchRow
                  key={`r:${b.name}`}
                  branch={b}
                  current={false}
                  onPick={() => {
                    onCheckout(b);
                    close();
                  }}
                />
              ))}
            </div>
          </ScrollArea>

          <CreateBranchForm
            from={label}
            onCreate={(name) => {
              onCreate(name);
              close();
            }}
          />
        </div>
      )}
    </Popover>
  );
}
