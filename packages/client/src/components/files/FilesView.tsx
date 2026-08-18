/**
 * The Files page — the file MANAGER, as opposed to the picker's one-question
 * dialog.
 *
 * Same backend, different job, so a genuinely different UI: a persistent roots
 * sidebar (drives, mounts, every project and worktree), sortable columns
 * carrying the numbers a modal has no room for, a details pane that answers the
 * expensive questions — owner, mode, hard links, who last committed it — and the
 * write operations, which a picker has no business offering at all.
 *
 * What it does NOT re-implement is navigation, selection, sorting or the
 * request-ordering race; those live in `useFsBrowser` and are therefore the same
 * here as in the picker.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Copy,
  Eye,
  EyeOff,
  FilePlus2,
  FolderPlus,
  HardDrive,
  Info,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { FsDetails, FsEntry, FsSortKey } from "@dispatch/shared";
import { FS_FILTER_ANY, fsBasename } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { useFsRoots, usePathPlatform } from "../../stores/fsRoots.js";
import { useFsBrowser, useFsJoin } from "./useFsBrowser.js";
import { useFilePicker } from "./filePicker.js";
import {
  entryIcon,
  rootIcon,
  formatBytes,
  formatStamp,
  formatCapacity,
  UNREADABLE_ICON,
} from "./fsMeta.js";
import { PathBar, isEditPathShortcut } from "./PathBar.js";
import { openCodeViewer } from "../monaco/store.js";
import { Modal, Field, TextInput, InlineError } from "../sidebar/Modal.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { SectionLabel } from "../ui/Panel.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";

/** The write dialogs this page can be showing. */
type Prompt =
  | { kind: "mkdir" }
  | { kind: "create-file" }
  | { kind: "rename"; entry: FsEntry }
  | { kind: "delete"; paths: string[] };

export function FilesView() {
  const platform = usePathPlatform();
  const roots = useFsRoots((s) => s.roots);
  const rootsLoading = useFsRoots((s) => s.loading);
  const refreshRoots = useFsRoots((s) => s.refresh);
  const join = useFsJoin();

  const [showDetails, setShowDetails] = useState(true);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  // A picker modal can be opened OVER this page. It is a dialog, so it owns the
  // keyboard while it's up — without this, one Ctrl+L opens two path fields and
  // one arrow key moves two lists, the second of them behind a scrim.
  const pickerOpen = useFilePicker((s) => s.request !== null);

  const browser = useFsBrowser({
    // The page browses; it never answers a question, so nothing is ever
    // un-selectable and hidden files are the user's toggle rather than a rule.
    filter: useMemo(() => ({ ...FS_FILTER_ANY }), []),
  });

  /** Open a file in the Monaco viewer — the page's "activate" for non-folders. */
  const openFile = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === "directory") {
        browser.navigate(entry.path);
        return;
      }
      // The viewer reads relative to a root, so hand it the containing folder.
      // Outside a checkout there's no diff to show, which the viewer handles by
      // falling back to plain file mode.
      openCodeViewer({
        worktreePath: browser.listing?.repoRoot ?? browser.cwd,
        relPath: relativeTo(browser.listing?.repoRoot ?? browser.cwd, entry.path),
        mode: "file",
        base: "main",
      });
    },
    [browser],
  );

  const run = useCallback(
    async (m: Parameters<typeof browser.mutate>[0]) => {
      const err = await browser.mutate(m);
      setBanner(err);
      if (!err) setPrompt(null);
      return err;
    },
    [browser],
  );

  /* Keyboard. A file manager that needs the mouse for navigation and for its
     most-used destructive action is a file manager people go back to a terminal
     for — so ↑/↓/Enter/Backspace/Delete/F2 all work without one. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Never while typing: Delete in the rename field means "delete a letter",
      // and Backspace in the search box means "delete a letter", not "go up".
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // A dialog is open — its own buttons own the keyboard.
      if (prompt || pickerOpen) return;

      // Before the navigation keys: Ctrl+L is the one shortcut that is about
      // getting somewhere rather than moving within what's already listed.
      if (isEditPathShortcut(e)) {
        e.preventDefault();
        setEditingPath(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        browser.moveCursor(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        browser.moveCursor(-1);
      } else if (e.key === "Enter") {
        const at = browser.entries.find((x) => x.path === browser.cursor);
        if (at) {
          e.preventDefault();
          openFile(at);
        }
      } else if (
        // ⌘⌫ is the macOS delete gesture, so it has to be tested BEFORE plain
        // Backspace — otherwise "go up a folder" swallows it and the Mac
        // shortcut silently navigates instead of deleting.
        (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) &&
        browser.selected.length
      ) {
        e.preventDefault();
        setPrompt({ kind: "delete", paths: browser.selected });
      } else if (e.key === "Backspace") {
        e.preventDefault();
        browser.up();
      } else if (e.key === "F2" && browser.selected.length === 1) {
        const entry = browser.entries.find((x) => x.path === browser.selected[0]);
        if (entry) setPrompt({ kind: "rename", entry });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browser, openFile, prompt, pickerOpen]);

  return (
    <div className="flex h-full min-w-0 flex-1 bg-app">
      {/* ---------------------------------------------------------- roots */}
      <aside className="hidden w-[220px] shrink-0 flex-col cm-hairline-r md:flex">
        <div className="flex items-center gap-1.5 px-3 py-2.5 cm-hairline-b">
          <SectionLabel className="px-0">Places</SectionLabel>
          <IconButton
            tip="Rescan drives and projects"
            className="ml-auto"
            onClick={() => void refreshRoots()}
          >
            <RefreshCw />
          </IconButton>
        </div>
        <ScrollArea className="min-h-0 flex-1 p-1.5">
          {rootsLoading && !roots.length && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {(["home", "project", "worktree", "drive", "mount"] as const).map((kind) => {
            const group = roots.filter((r) => r.kind === kind);
            if (!group.length) return null;
            return (
              <div key={kind} className="mb-2">
                {kind !== "home" && (
                  <SectionLabel className="px-2 pb-1">{GROUP_LABEL[kind]}</SectionLabel>
                )}
                {group.map((root) => {
                  const Icon = rootIcon(root);
                  const capacity = formatCapacity(root.freeBytes, root.totalBytes);
                  const active = browser.cwd === root.path;
                  return (
                    // A whole row that happens to be clickable, with a second
                    // line of capacity under the label — `Button` is one fixed
                    // height with a centred, nowrap label, and overriding both
                    // would be fighting the primitive rather than using it.
                    <div
                      key={root.path}
                      role="button"
                      tabIndex={0}
                      aria-current={active ? "true" : undefined}
                      onClick={() => browser.navigate(root.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          browser.navigate(root.path);
                        }
                      }}
                      title={root.detail ?? root.path}
                      className={cn(
                        "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        active ? "bg-selected text-primary" : "text-secondary hover:bg-hover",
                      )}
                    >
                      <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-muted")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{root.label}</span>
                        {capacity && (
                          <span className="block truncate text-2xs text-faint">{capacity}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </ScrollArea>
      </aside>

      {/* ----------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          browser={browser}
          showDetails={showDetails}
          onToggleDetails={() => setShowDetails((v) => !v)}
          onPrompt={setPrompt}
        />

        <PathBar
          crumbs={browser.crumbs}
          cwd={browser.cwd}
          editing={editingPath}
          onEditingChange={setEditingPath}
          onNavigate={browser.navigate}
        />

        {banner && (
          <div className="flex items-start gap-2 border-b border-danger/30 bg-danger-ghost px-3 py-2 text-xs text-danger">
            <span className="min-w-0 flex-1">{banner}</span>
            <IconButton tip="Dismiss" onClick={() => setBanner(null)}>
              <X />
            </IconButton>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ColumnHeader browser={browser} />
            <ScrollArea className="min-h-0 flex-1">
              <FileTable browser={browser} onOpen={openFile} />
            </ScrollArea>
            <StatusBar browser={browser} />
          </div>
          {showDetails && (
            <DetailsPane
              path={browser.cursor}
              onClose={() => setShowDetails(false)}
              platform={platform}
            />
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- dialogs */}
      <NamePrompt
        prompt={prompt}
        cwd={browser.cwd}
        onCancel={() => {
          setPrompt(null);
          setBanner(null);
        }}
        onSubmit={async (name) => {
          if (!prompt) return;
          if (prompt.kind === "mkdir") await run({ op: "mkdir", path: join(browser.cwd, name) });
          else if (prompt.kind === "create-file")
            await run({ op: "create-file", path: join(browser.cwd, name) });
          else if (prompt.kind === "rename")
            await run({ op: "rename", path: prompt.entry.path, to: name });
        }}
        error={banner}
      />
      <DeletePrompt
        prompt={prompt}
        onCancel={() => {
          setPrompt(null);
          setBanner(null);
        }}
        onConfirm={(permanent) =>
          prompt?.kind === "delete"
            ? run({ op: "delete", paths: prompt.paths, permanent })
            : Promise.resolve(null)
        }
        error={banner}
      />
    </div>
  );
}

const GROUP_LABEL: Record<string, string> = {
  project: "Projects",
  worktree: "Worktrees",
  drive: "Volumes",
  mount: "Volumes",
};

/** `C:/a/b/c.txt` relative to `C:/a` → `b/c.txt`. */
function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/* ------------------------------------------------------------------ toolbar */

function Toolbar({
  browser,
  showDetails,
  onToggleDetails,
  onPrompt,
}: {
  browser: ReturnType<typeof useFsBrowser>;
  showDetails: boolean;
  onToggleDetails: () => void;
  onPrompt: (p: Prompt) => void;
}) {
  const one = browser.selected.length === 1;
  const any = browser.selected.length > 0;
  const selectedEntry = browser.entries.find((e) => e.path === browser.selected[0]);

  return (
    <div className="flex items-center gap-1 px-3 py-2 cm-hairline-b [&_svg]:size-4">
      <IconButton tip="Back" onClick={browser.back} disabled={!browser.canGoBack}>
        <ArrowLeft />
      </IconButton>
      <IconButton tip="Forward" onClick={browser.forward} disabled={!browser.canGoForward}>
        <ArrowRight />
      </IconButton>
      <IconButton tip="Up one level" onClick={browser.up}>
        <ArrowUp />
      </IconButton>
      <IconButton tip="Refresh" onClick={browser.refresh}>
        <RefreshCw />
      </IconButton>

      <span className="mx-1 h-4 w-px bg-line-soft" />

      <IconButton tip="New folder" onClick={() => onPrompt({ kind: "mkdir" })}>
        <FolderPlus />
      </IconButton>
      <IconButton tip="New file" onClick={() => onPrompt({ kind: "create-file" })}>
        <FilePlus2 />
      </IconButton>
      <IconButton
        tip="Rename (F2)"
        disabled={!one || !selectedEntry}
        onClick={() => selectedEntry && onPrompt({ kind: "rename", entry: selectedEntry })}
      >
        <Pencil />
      </IconButton>
      <IconButton
        tip="Duplicate here"
        disabled={!any}
        onClick={() =>
          void browser.mutate({ op: "copy", paths: browser.selected, toDir: browser.cwd })
        }
      >
        <Copy />
      </IconButton>
      <IconButton
        tip="Delete (Del)"
        disabled={!any}
        onClick={() => onPrompt({ kind: "delete", paths: browser.selected })}
      >
        <Trash2 />
      </IconButton>

      <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-inset px-2 py-1">
        <Search className="!size-3.5 shrink-0 text-muted" />
        <input
          value={browser.query}
          onChange={(e) => browser.setQuery(e.target.value)}
          placeholder="Search this folder and everything under it…"
          className="min-w-0 flex-1 bg-transparent text-sm text-primary placeholder:text-faint outline-none"
          spellCheck={false}
        />
        {browser.searching && <Spinner size={13} />}
        {browser.query && (
          <IconButton tip="Clear search" onClick={() => browser.setQuery("")}>
            <X />
          </IconButton>
        )}
      </div>

      <IconButton
        tip={browser.showHidden ? "Hide hidden files" : "Show hidden files"}
        active={browser.showHidden}
        onClick={() => browser.setShowHidden(!browser.showHidden)}
      >
        {browser.showHidden ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton tip="Details" active={showDetails} onClick={onToggleDetails}>
        <Info />
      </IconButton>
    </div>
  );
}

/* -------------------------------------------------------------------- table */

/**
 * One width and one alignment per column, shared by the header and the cells —
 * they are declared together because a header that doesn't sit over its own
 * column is worse than no header at all, and two separate class strings drift
 * the moment either is touched.
 *
 * `lg:flex`, not `lg:block`: the header cell is a `Button`, which is
 * `inline-flex`. Un-hiding it as `block` overrides that and collapses the
 * label-plus-sort-arrow layout — which is exactly how these ended up sitting
 * beside their columns instead of above them.
 */
const COLUMNS: Array<{ key: FsSortKey; label: string; cell: string; head: string }> = [
  { key: "name", label: "Name", cell: "min-w-0 flex-1", head: "min-w-0 flex-1 justify-start" },
  { key: "size", label: "Size", cell: "w-[9ch] text-right", head: "w-[9ch] justify-end" },
  {
    key: "modified",
    label: "Modified",
    cell: "hidden w-[14ch] lg:block",
    head: "hidden w-[14ch] justify-start lg:flex",
  },
  {
    key: "created",
    label: "Created",
    cell: "hidden w-[14ch] xl:block",
    head: "hidden w-[14ch] justify-start xl:flex",
  },
];

/** The width/alignment a cell must use to sit under its own header. */
const cellClass = (key: FsSortKey): string =>
  COLUMNS.find((c) => c.key === key)?.cell ?? "";

function ColumnHeader({ browser }: { browser: ReturnType<typeof useFsBrowser> }) {
  // Search results carry the server's ranking, and re-sorting would throw away
  // the one thing that makes a result list useful — so the columns go inert.
  const searching = browser.results !== null;
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 cm-hairline-b text-2xs font-medium uppercase tracking-wide text-faint">
      <span className="w-4 shrink-0" />
      {COLUMNS.map((col) => (
        <Button
          key={col.key}
          variant="ghost"
          disabled={searching}
          onClick={() => browser.setSort(col.key)}
          rightIcon={
            browser.sort.key === col.key && !searching ? (
              <ArrowUpDown className="!size-2.5" />
            ) : undefined
          }
          className={cn(
            "!h-5 !px-0 !text-2xs !font-medium uppercase tracking-wide",
            col.head,
            browser.sort.key === col.key && !searching ? "text-secondary" : "text-faint",
          )}
        >
          {col.label}
        </Button>
      ))}
    </div>
  );
}

function FileTable({
  browser,
  onOpen,
}: {
  browser: ReturnType<typeof useFsBrowser>;
  onOpen: (entry: FsEntry) => void;
}) {
  if (browser.error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <HardDrive className="mb-2 size-6 text-faint" />
        <p className="text-sm text-danger">{browser.error}</p>
        <p className="mt-1 text-xs text-muted">
          It may have been moved, unmounted, or belong to another user.
        </p>
      </div>
    );
  }
  if (browser.loading && !browser.listing) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!browser.entries.length) {
    return (
      <p className="py-16 text-center text-sm text-muted">
        {browser.query ? `Nothing matches “${browser.query}”.` : "This folder is empty."}
      </p>
    );
  }

  return (
    <div className="p-1">
      {browser.entries.map((entry) => {
        const selected = browser.selected.includes(entry.path);
        const cursor = browser.cursor === entry.path;
        const Icon = entry.unreadable ? UNREADABLE_ICON : entryIcon(entry);
        const isDir = entry.kind === "directory";
        return (
          <div
            key={entry.path}
            role="button"
            tabIndex={0}
            onClick={(e) =>
              browser.select(
                entry,
                e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "replace",
              )
            }
            onDoubleClick={() => onOpen(entry)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen(entry);
            }}
            className={cn(
              "flex cursor-default items-center gap-3 rounded-md px-2 py-1 text-sm transition-colors",
              selected ? "bg-selected" : cursor ? "bg-hover" : "hover:bg-hover",
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                isDir ? "text-accent" : entry.unreadable ? "text-faint" : "text-muted",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-primary">
              {entry.name}
              {entry.link && (
                <span className={cn("ml-1.5 text-2xs", entry.link.broken ? "text-danger" : "text-faint")}>
                  {entry.link.broken ? "broken link" : `→ ${entry.link.target}`}
                </span>
              )}
              {/* In search mode the name alone doesn't say WHERE it is, which is
                  most of what you wanted to know. */}
              {browser.results && (
                <span className="ml-1.5 text-2xs text-faint">
                  {relativeTo(browser.cwd, entry.path).slice(0, -entry.name.length) || "./"}
                </span>
              )}
            </span>
            {/* Widths come from COLUMNS so a cell cannot drift out from under
                its own header. */}
            <span className={cn(cellClass("size"), "shrink-0 cm-mono text-2xs text-faint")}>
              {isDir ? "—" : formatBytes(entry.size)}
            </span>
            <span className={cn(cellClass("modified"), "shrink-0 cm-mono text-2xs text-faint")}>
              {formatStamp(entry.modifiedAt)}
            </span>
            <span className={cn(cellClass("created"), "shrink-0 cm-mono text-2xs text-faint")}>
              {formatStamp(entry.createdAt)}
            </span>
          </div>
        );
      })}
      {browser.listing?.truncated && !browser.results && (
        <p className="px-3 py-3 text-center text-2xs text-faint">
          Showing {browser.entries.length} of {browser.listing.total} entries. Search to narrow it.
        </p>
      )}
    </div>
  );
}

function StatusBar({ browser }: { browser: ReturnType<typeof useFsBrowser> }) {
  const shown = browser.entries.length;
  const selected = browser.selected.length;
  const bytes = browser.entries
    .filter((e) => browser.selected.includes(e.path))
    .reduce((sum, e) => sum + (e.size ?? 0), 0);
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 cm-hairline-t text-2xs text-faint">
      <span>
        {shown} item{shown === 1 ? "" : "s"}
        {browser.results && " found"}
      </span>
      {selected > 0 && (
        <span>
          {selected} selected{bytes > 0 && ` · ${formatBytes(bytes)}`}
        </span>
      )}
      {browser.listing?.repoRoot && (
        <span className="ml-auto truncate cm-mono">git: {browser.listing.repoRoot}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ details */

function DetailsPane({
  path,
  onClose,
  platform,
}: {
  path: string | null;
  onClose: () => void;
  platform: ReturnType<typeof usePathPlatform>;
}) {
  const [details, setDetails] = useState<FsDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setDetails(null);
      return;
    }
    let live = true;
    setLoading(true);
    api.fs
      .details(path)
      .then((d) => live && setDetails(d))
      .catch(() => live && setDetails(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <aside className="hidden w-[260px] shrink-0 flex-col cm-hairline-l lg:flex">
      <div className="flex items-center gap-1.5 px-3 py-2.5 cm-hairline-b">
        <SectionLabel className="px-0">Details</SectionLabel>
        <IconButton tip="Hide details" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        {!path ? (
          <p className="text-xs text-muted">Select something to see its details.</p>
        ) : loading && !details ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !details ? (
          <p className="text-xs text-muted">Couldn't read this path.</p>
        ) : (
          <dl className="space-y-2.5">
            <div>
              <p className="break-words text-sm font-medium text-primary">
                {fsBasename(details.entry.path, platform)}
              </p>
              <p className="mt-0.5 break-all text-2xs text-faint cm-mono">{details.entry.path}</p>
            </div>
            <Row label="Kind" value={details.entry.kind} />
            <Row
              label={details.entry.kind === "directory" ? "Contains" : "Size"}
              value={
                details.entry.kind === "directory"
                  ? details.childCount === null
                    ? "—"
                    : `${details.childCount} item${details.childCount === 1 ? "" : "s"}`
                  : formatBytes(details.entry.size)
              }
            />
            <Row label="Modified" value={formatStamp(details.entry.modifiedAt)} />
            {/* Absent, not "unknown": most Linux filesystems don't record a
                birth time, and a blank row is quieter than a row of dashes. */}
            {details.entry.createdAt !== null && (
              <Row label="Created" value={formatStamp(details.entry.createdAt)} />
            )}
            <Row label="Owner" value={details.owner ?? "—"} />
            {details.group && <Row label="Group" value={details.group} />}
            {details.mode && <Row label="Mode" value={details.mode} mono />}
            <Row label="Writable" value={details.writable ? "yes" : "no"} />
            {details.links !== null && details.links > 1 && (
              // Worth surfacing only when it's surprising: >1 means deleting
              // this path won't free the bytes.
              <Row label="Hard links" value={String(details.links)} />
            )}
            <div className="pt-1">
              <SectionLabel className="px-0 pb-1">Last edited by</SectionLabel>
              {details.lastEditedBy ? (
                <p className="text-xs text-secondary">
                  {details.lastEditedBy}
                  {details.lastEditedAt && (
                    <span className="text-faint"> · {formatStamp(details.lastEditedAt)}</span>
                  )}
                </p>
              ) : (
                // Being explicit about WHY beats a dash: this is the one field
                // that isn't a filesystem fact, and the reason is the answer.
                <p className="text-xs text-faint">
                  Not tracked by git — a filesystem records when a file changed,
                  never who changed it.
                </p>
              )}
            </div>
          </dl>
        )}
      </ScrollArea>
    </aside>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[7ch] shrink-0 text-2xs text-faint">{label}</dt>
      <dd className={cn("min-w-0 flex-1 break-words text-xs text-secondary", mono && "cm-mono")}>
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

function NamePrompt({
  prompt,
  cwd,
  onCancel,
  onSubmit,
  error,
}: {
  prompt: Prompt | null;
  cwd: string;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
  error: string | null;
}) {
  const open =
    prompt?.kind === "mkdir" || prompt?.kind === "create-file" || prompt?.kind === "rename";
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(prompt?.kind === "rename" ? prompt.entry.name : "");
    setBusy(false);
  }, [open, prompt]);

  if (!open || !prompt) return null;
  const title =
    prompt.kind === "mkdir" ? "New folder" : prompt.kind === "create-file" ? "New file" : "Rename";

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await onSubmit(name.trim());
    setBusy(false);
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      description={prompt.kind === "rename" ? prompt.entry.path : cwd}
      width={420}
      footer={
        <>
          <InlineError message={error} />
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim() || busy} onClick={submit}>
              {prompt.kind === "rename" ? "Rename" : "Create"}
            </Button>
          </div>
        </>
      }
    >
      <Field label="Name">
        <TextInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder={prompt.kind === "create-file" ? "notes.md" : "new-folder"}
          spellCheck={false}
        />
      </Field>
    </Modal>
  );
}

function DeletePrompt({
  prompt,
  onCancel,
  onConfirm,
  error,
}: {
  prompt: Prompt | null;
  onCancel: () => void;
  onConfirm: (permanent: boolean) => Promise<string | null>;
  error: string | null;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [prompt]);
  if (prompt?.kind !== "delete") return null;

  const n = prompt.paths.length;
  const run = async (permanent: boolean) => {
    setBusy(true);
    await onConfirm(permanent);
    setBusy(false);
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={n === 1 ? "Delete this item?" : `Delete ${n} items?`}
      icon={<Trash2 />}
      width={460}
      footer={
        <>
          <InlineError message={error} />
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            {/* Permanent is present but secondary, and never the default —
                the whole reason the trash exists is that this button is one
                misclick away at all times. */}
            <Button variant="ghost" disabled={busy} onClick={() => void run(true)}>
              Delete permanently
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void run(false)}>
              Move to Trash
            </Button>
          </div>
        </>
      }
    >
      <ul className="mb-3 space-y-0.5">
        {prompt.paths.slice(0, 8).map((p) => (
          <li key={p} className="truncate text-xs text-secondary cm-mono">
            {p}
          </li>
        ))}
        {n > 8 && <li className="text-xs text-faint">…and {n - 8} more</li>}
      </ul>
      <p className="text-xs text-muted">
        “Move to Trash” uses your system's Recycle Bin or trash folder, so this is
        recoverable. “Delete permanently” is not.
      </p>
    </Modal>
  );
}
