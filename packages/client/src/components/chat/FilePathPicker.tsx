/**
 * File-path picker — pick a file from the chat's checkout, insert its path.
 *
 * Deliberately NOT the OS file dialog: a browser page is never told a file's
 * real path (both `<input type=file>` and drag-and-drop yield a bare basename),
 * so the only way to hand the agent a path it can actually open is to list the
 * files server-side and pick from that. `/api/files` does the listing; this is
 * the surface over it.
 *
 * Built as its own overlay rather than a `Popover` because it has to open
 * PROGRAMMATICALLY as well as by click — dropping a file whose basename matches
 * several paths opens it pre-filled to disambiguate — and Popover owns its own
 * open state.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File as FileIcon, Search, CornerDownLeft } from "lucide-react";
import { api, type IndexedFile } from "../../lib/api.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";

export interface FilePathPickerProps {
  chatId: string;
  /** Seed query — a dropped file's basename, or "" for a cold open. */
  initialQuery?: string;
  onPick: (file: IndexedFile) => void;
  onClose: () => void;
}

/** Keystroke-to-query delay: enough to not fire git per character. */
const DEBOUNCE_MS = 120;

/** Split a repo-relative path into its directory and filename halves. */
function splitPath(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { dir: "", name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}

export function FilePathPicker({
  chatId,
  initialQuery = "",
  onPick,
  onClose,
}: FilePathPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [root, setRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced search. The generation guard is what keeps a slow early response
  // from overwriting a fast later one — the user types faster than git lists.
  const genRef = useRef(0);
  useEffect(() => {
    const gen = ++genRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      api.files
        .search(chatId, query, 50)
        .then((res) => {
          if (gen !== genRef.current) return;
          setFiles(res.files);
          setRoot(res.root);
          setActive(0);
          setError(null);
        })
        .catch((e: unknown) => {
          if (gen !== genRef.current) return;
          setFiles([]);
          setError(e instanceof Error ? e.message : "Could not list files");
        })
        .finally(() => {
          if (gen === genRef.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [chatId, query]);

  // Escape closes from anywhere, including while focus sits in the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (i: number) => {
    const file = files[i];
    if (file) onPick(file);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, files.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
    }
  };

  return createPortal(
    <div
      style={{ zIndex: LAYER.palette }}
      className={
        // 12vh clears the status bar on a tall phone and not on a short one, so
        // the offset is the larger of the two rather than the guess.
        "fixed inset-0 flex items-start justify-center bg-scrim backdrop-blur-[2px] " +
        "pt-[max(12vh,var(--cm-safe-top))] pb-[var(--cm-safe-bottom)]"
      }
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[60vh] w-[min(92vw,620px)] flex-col overflow-hidden rounded-lg border border-line-strong bg-overlay shadow-[var(--shadow-pop)] cm-anim-rise"
        role="dialog"
        aria-label="Insert file path"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <span className="text-muted [&_svg]:size-4">
            <Search />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a file — its full path is inserted into your message"
            aria-label="Search files"
            className="min-w-0 flex-1 bg-transparent text-base text-primary outline-none placeholder:text-faint"
          />
          {loading && <Spinner size={13} />}
        </div>

        <div ref={listRef} className="cm-scroll min-h-0 flex-1 overflow-y-auto py-1">
          {error && (
            <div className="px-3 py-6 text-center text-sm text-danger" role="alert">
              {error}
            </div>
          )}
          {!error && files.length === 0 && !loading && (
            <div className="px-3 py-6 text-center text-sm text-muted">
              {query ? `No files match “${query}”` : "No files found in this checkout"}
            </div>
          )}
          {files.map((f, i) => {
            const { dir, name } = splitPath(f.rel);
            return (
              <button
                key={f.rel}
                data-idx={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                title={f.abs}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                  i === active ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span className="shrink-0 text-faint [&_svg]:size-3.5">
                  <FileIcon />
                </span>
                <span className="min-w-0 flex-1 truncate text-base">
                  {/* The directory is context, the filename is the answer — so the
                      filename carries the weight and the dir recedes. Truncation
                      is left-biased (`dir` shrinks first) for the same reason. */}
                  <span className="text-faint">{dir}</span>
                  <span className={i === active ? "text-primary" : "text-secondary"}>{name}</span>
                </span>
                {i === active && (
                  <span className="shrink-0 text-faint [&_svg]:size-3">
                    <CornerDownLeft />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {root && (
          <div className="cm-mono shrink-0 truncate border-t border-line-soft px-3 py-1.5 !text-2xs text-faint">
            {root}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
