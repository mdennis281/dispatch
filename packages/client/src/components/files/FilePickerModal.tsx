/**
 * The picker modal — "which file?" answered in one column.
 *
 * Deliberately NOT a small copy of the full page. A picker is a question with an
 * answer button, so it is optimized for getting to one row and pressing Enter:
 * a single list, a roots strip instead of a sidebar, no columns to sort, no
 * details pane, and the whole thing driven from the keyboard. The full page is
 * the file MANAGER; this is the sentence you interrupt to answer.
 *
 * Both sit on `useFsBrowser`, so navigation, selection and the request-ordering
 * race are solved in one place rather than twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  CornerDownLeft,
  Eye,
  EyeOff,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { FsEntry } from "@dispatch/shared";
import { useFilePicker } from "./filePicker.js";
import { useFsBrowser } from "./useFsBrowser.js";
import { PathBar, isEditPathShortcut } from "./PathBar.js";
import { entryIcon, formatBytes, formatStamp, describeFilter, rootIcon, UNREADABLE_ICON } from "./fsMeta.js";
import { useFsRoots } from "../../stores/fsRoots.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { Kbd } from "../ui/Kbd.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";

/** Mounted once at the app root; renders whatever `pickPath()` last asked for. */
export function FilePickerHost() {
  const request = useFilePicker((s) => s.request);
  if (!request) return null;
  // Keyed by request id so a second `pickPath` starts a genuinely fresh picker
  // (fresh cwd, empty selection) rather than inheriting the previous one's state.
  return <FilePickerModal key={request.id} />;
}

function FilePickerModal() {
  const request = useFilePicker((s) => s.request);
  const z = useDialogLayer(true);
  const roots = useFsRoots((s) => s.roots);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingPath, setEditingPath] = useState(false);

  const settle = request?.settle;
  const cancel = useCallback(() => settle?.(null), [settle]);

  const filter = request?.filter;
  const browser = useFsBrowser({
    initialPath: request?.initialPath,
    initialQuery: request?.initialQuery,
    // `useMemo` so the filter object is stable — `useFsBrowser` keys its search
    // effect off it, and a fresh object each render would re-search forever.
    filter: useMemo(
      () =>
        filter ?? { select: "file" as const, multiple: false, showHidden: false },
      [filter],
    ),
    onCommit: (paths) => settle?.(paths),
  });

  /* Focus the search box on open: typing is the fastest way to a known file. */
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      // A SEEDED query is a guess the caller made on your behalf (the basename
      // of a dropped file), so it starts selected — one keystroke replaces it,
      // rather than appending to a word you didn't type.
      if (request?.initialQuery) inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [request?.initialQuery]);

  /** Keep the cursor row on screen as ↑/↓ move it. */
  useEffect(() => {
    if (!browser.cursor) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(browser.cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [browser.cursor]);

  // Past every hook, so the early return below is safe.
  if (!request || !filter) return null;

  const heading = request.title ?? describeFilter(filter);
  /**
   * With nothing picked, a folder picker answers with the folder you're IN.
   *
   * This is what every OS folder dialog does, and without it choosing
   * `C:/Users/me/projects` means navigating to its PARENT and clicking it —
   * i.e. leaving the place you already are to point at it from outside. Files
   * get no equivalent: there is no "current file" to fall back to.
   */
  const canPickCwd = filter.select !== "file" && !browser.selected.length && !!browser.cwd;
  const canSelect = browser.selected.length > 0 || canPickCwd;
  const commit = () => (canPickCwd ? settle?.([browser.cwd]) : browser.commit());

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Bound to the DIALOG, not to the window: a modal that grabbed Ctrl+L
    // globally would also fire for the Files page underneath it. Focus is
    // always inside here (the search box takes it on open), so a React handler
    // on the container sees every keystroke that matters.
    if (isEditPathShortcut(e)) {
      e.preventDefault();
      setEditingPath(true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Stop it here so one Escape closes the picker and not also whatever
      // dialog opened it — a document-level listener below would see both.
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      browser.moveCursor(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      browser.moveCursor(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const at = browser.entries.find((x) => x.path === browser.cursor);
      // Enter on a folder goes IN; Enter on a valid answer returns it. That's
      // one key doing the two things the mouse does with a double-click and the
      // Select button, which is what makes the whole flow keyboard-only.
      if (at) browser.activate(at);
      else if (canSelect) commit();
    } else if (e.key === "Backspace" && !browser.query) {
      // Only when the search box is empty — otherwise this eats the character
      // the user was trying to delete.
      e.preventDefault();
      browser.up();
    }
  };

  return createPortal(
    <div
      style={{ zIndex: z }}
      className={
        "fixed inset-0 flex items-start justify-center " +
        "cm-safe-pad [--cm-gutter:1.5rem] sm:pt-[max(9vh,var(--cm-safe-top),var(--cm-titlebar-h))]"
      }
      onKeyDown={onKeyDown}
    >
      <div className="fixed inset-0 bg-scrim backdrop-blur-[2px]" onClick={cancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className={
          "relative z-10 flex max-h-[76vh] w-full max-w-[620px] flex-col overflow-hidden rounded-lg " +
          "border border-line-strong bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise"
        }
      >
        {/* Every row outside the list is `shrink-0`. A flex child's default is
            `shrink: 1`, so a tall listing squeezed the header, the roots strip
            and the nav row — the chips lost half their height and the footer
            crept up. Only the list may give ground. */}
        <header className="flex shrink-0 items-center gap-2.5 px-4 py-3 cm-hairline-b">
          {/* The path used to live here as dead text. It's a `PathBar` below
              now — same control as the full page, so it can be clicked through
              and typed into rather than only read. */}
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-primary">
            {heading}
          </h2>
          <IconButton tip="Close" onClick={cancel}>
            <X />
          </IconButton>
        </header>

        {/* Roots strip. A sidebar's worth of destinations in one scrollable row —
            the picker is 620px wide and a column of drives would cost a third of
            it to show something you click once. */}
        {roots.length > 0 && (
          <div className="cm-scroll cm-scroll-x flex shrink-0 gap-1 overflow-x-auto px-3 py-2 cm-hairline-b">
            {roots.map((root) => {
              const Icon = rootIcon(root);
              return (
                <Button
                  key={root.path}
                  // `toggle` reads its pressed look off `aria-pressed`, so "this
                  // is where you are" cannot drift apart from what a screen
                  // reader is told.
                  variant="toggle"
                  aria-pressed={browser.cwd === root.path}
                  onClick={() => browser.navigate(root.path)}
                  title={root.detail ?? root.path}
                  leftIcon={<Icon />}
                  className="shrink-0 border-line bg-panel-2 [&_svg]:!size-3"
                >
                  <span className="max-w-[12ch] truncate">{root.label}</span>
                </Button>
              );
            })}
          </div>
        )}

        {/* Nav + search */}
        <div className="flex shrink-0 items-center gap-1.5 px-3 py-2 cm-hairline-b [&_svg]:size-4">
          <IconButton tip="Back" onClick={browser.back} disabled={!browser.canGoBack}>
            <ArrowLeft />
          </IconButton>
          <IconButton tip="Forward" onClick={browser.forward} disabled={!browser.canGoForward}>
            <ArrowRight />
          </IconButton>
          <IconButton tip="Up one level" onClick={browser.up}>
            <ArrowUp />
          </IconButton>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-inset px-2 py-1">
            <Search className="!size-3.5 shrink-0 text-muted" />
            <input
              ref={inputRef}
              value={browser.query}
              onChange={(e) => browser.setQuery(e.target.value)}
              placeholder="Search this folder…"
              className="min-w-0 flex-1 bg-transparent text-sm text-primary placeholder:text-faint outline-none"
              spellCheck={false}
              autoComplete="off"
            />
            {browser.searching && <Spinner size={13} />}
          </div>
          <IconButton
            tip={browser.showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => browser.setShowHidden(!browser.showHidden)}
          >
            {browser.showHidden ? <Eye /> : <EyeOff />}
          </IconButton>
          <IconButton tip="Refresh" onClick={browser.refresh}>
            <RefreshCw />
          </IconButton>
        </div>

        {/* Directly above the list, exactly where the full page puts it, so the
            same gesture works on both surfaces without relearning. */}
        <PathBar
          className="shrink-0"
          crumbs={browser.crumbs}
          cwd={browser.cwd}
          editing={editingPath}
          onEditingChange={(next) => {
            setEditingPath(next);
            // Hand focus back when the field closes. It is removed from the DOM
            // on the way out, so focus would fall to `<body>` and take the
            // dialog's container-scoped keyboard handling with it — Ctrl+L
            // would work exactly once.
            if (!next) requestAnimationFrame(() => inputRef.current?.focus());
          }}
          onNavigate={browser.navigate}
        />

        <div ref={listRef} className="cm-scroll min-h-[200px] flex-1 overflow-y-auto p-1.5">
          <EntryList browser={browser} />
        </div>

        <footer className="flex shrink-0 items-center gap-2 px-3.5 py-2.5 cm-hairline-t">
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {browser.selected.length > 1
              ? `${browser.selected.length} selected`
              : (browser.selected[0] ?? "")}
          </span>
          <span className="hidden items-center gap-1 text-2xs text-faint sm:flex">
            <Kbd>
              <CornerDownLeft className="size-2.5" />
            </Kbd>
            open / choose
          </span>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSelect} onClick={commit}>
            {/* The label says WHICH thing is about to be returned, because
                "Select" beside an empty selection reads as a broken button. */}
            {canPickCwd
              ? "Select this folder"
              : browser.selected.length > 1
                ? `Select (${browser.selected.length})`
                : "Select"}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** The rows. Shared shape between search results and a plain listing. */
function EntryList({ browser }: { browser: ReturnType<typeof useFsBrowser> }) {
  if (browser.error) {
    return (
      <div className="px-3 py-10 text-center text-sm text-danger">
        {browser.error}
      </div>
    );
  }
  if (browser.loading && !browser.listing) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (!browser.entries.length) {
    return (
      <div className="px-3 py-10 text-center text-sm text-muted">
        {browser.query
          ? `Nothing here matches “${browser.query}”.`
          : browser.showHidden
            ? "This folder is empty."
            : "This folder is empty — or everything in it is hidden."}
      </div>
    );
  }

  return (
    // A listbox, not a stack of buttons. The dialog owns ↑/↓/Enter, so each row
    // being its own tab stop would fight the keyboard model it already has —
    // and `option`/`aria-selected` is what actually tells a screen reader which
    // row is chosen, which a pile of buttons never did.
    <div role="listbox" aria-label="Files and folders">
      {browser.entries.map((entry) => (
        <Row key={entry.path} entry={entry} browser={browser} />
      ))}
      {browser.listing?.truncated && !browser.results && (
        // Silence here would read as "that's all of them", which is the one
        // thing a truncated listing must never imply.
        <p className="px-3 py-2 text-center text-2xs text-faint">
          Showing {browser.entries.length} of {browser.listing.total} — narrow it with search.
        </p>
      )}
    </div>
  );
}

function Row({
  entry,
  browser,
}: {
  entry: FsEntry;
  browser: ReturnType<typeof useFsBrowser>;
}) {
  const selectable = browser.isSelectable(entry);
  const selected = browser.selected.includes(entry.path);
  const cursor = browser.cursor === entry.path;
  const Icon = entry.unreadable ? UNREADABLE_ICON : entryIcon(entry);
  const isDir = entry.kind === "directory";

  return (
    <div
      role="option"
      aria-selected={selected}
      data-path={entry.path}
      // KEEP FOCUS IN THE SEARCH BOX. A `role="option"` div isn't focusable, so
      // mousing down on one hands focus to `<body>` — and this dialog's entire
      // keyboard model is a React `onKeyDown` on its container, which only sees
      // events raised INSIDE itself. So one click on a row used to silently kill
      // ↑/↓, Enter, Escape and Backspace for the rest of the session.
      //
      // Suppressing the default is the standard listbox answer: focus never
      // leaves the input, and `aria-selected` is what conveys the choice.
      // Double-click is unaffected — it doesn't depend on focus moving.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) =>
        browser.select(entry, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "replace")
      }
      onDoubleClick={() => browser.activate(entry)}
      className={cn(
        "flex w-full cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        selected
          ? "bg-selected"
          : cursor
            ? "bg-hover"
            : "hover:bg-hover",
        // Greyed, not removed: a picker that erases every non-matching file
        // leaves you unable to tell a wrong folder from a working filter.
        !selectable && !isDir && "opacity-40",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          isDir ? "text-accent" : entry.unreadable ? "text-faint" : "text-muted",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-primary">
        {entry.name}
        {entry.link && !entry.link.broken && (
          <span className="ml-1.5 text-2xs text-faint">→ {entry.link.target}</span>
        )}
      </span>
      {!isDir && (
        <span className="shrink-0 cm-mono text-2xs text-faint">{formatBytes(entry.size)}</span>
      )}
      {/* `nowrap` + enough width for "Jun 17, 2023": an older file's date wrapped
          onto two lines and made its row taller than every other one. */}
      <span className="hidden w-[10ch] shrink-0 whitespace-nowrap text-right cm-mono text-2xs text-faint sm:block">
        {formatStamp(entry.modifiedAt)}
      </span>
      {isDir ? (
        <ChevronRight className="size-3.5 shrink-0 text-faint" />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
    </div>
  );
}
