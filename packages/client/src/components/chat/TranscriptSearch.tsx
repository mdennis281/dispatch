import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { IconButton } from "../ui/IconButton.js";
import { findTranscriptMatches, type TranscriptMatch } from "./transcriptMatches.js";

const ALL_MATCHES = "dispatch-transcript-search";
const CURRENT_MATCH = "dispatch-transcript-search-current";

type HighlightRegistry = Map<string, Highlight> & {
  delete(name: string): boolean;
  set(name: string, highlight: Highlight): unknown;
};

function highlightRegistry(): HighlightRegistry | null {
  return (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights ?? null;
}

function clearHighlights() {
  const registry = highlightRegistry();
  registry?.delete(ALL_MATCHES);
  registry?.delete(CURRENT_MATCH);
}

export function TranscriptSearch({
  open,
  rootRef,
  revision,
  loadingHistory,
  onClose,
}: {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  revision: unknown;
  loadingHistory: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<TranscriptMatch[]>([]);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      clearHighlights();
    }
  }, [open]);

  useLayoutEffect(() => {
    clearHighlights();
    if (!open || !rootRef.current || !query.trim()) {
      matchesRef.current = [];
      setCount(0);
      setCurrent(0);
      return;
    }

    const matches = findTranscriptMatches(rootRef.current, query);
    matchesRef.current = matches;
    setCount(matches.length);
    setCurrent((index) => (matches.length ? Math.min(index, matches.length - 1) : 0));
    const registry = highlightRegistry();
    if (registry && matches.length) {
      registry.set(ALL_MATCHES, new Highlight(...matches.map((match) => match.range)));
      // A page can add matches without changing the count (one live row may have
      // disappeared at the same time). Restore the current highlight here too;
      // relying only on the count/index effect would leave that case unselected.
      const selected = matches[Math.min(current, matches.length - 1)];
      registry.set(CURRENT_MATCH, new Highlight(selected.range));
    }
    return clearHighlights;
  }, [open, query, revision, rootRef]);

  useLayoutEffect(() => {
    const match = matchesRef.current[current];
    const registry = highlightRegistry();
    registry?.delete(CURRENT_MATCH);
    if (!match) return;
    registry?.set(CURRENT_MATCH, new Highlight(match.range));
    match.row.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [count, current]);

  useEffect(() => clearHighlights, []);

  const move = useCallback((direction: 1 | -1) => {
    setCurrent((index) => {
      const total = matchesRef.current.length;
      return total ? (index + direction + total) % total : 0;
    });
  }, []);

  if (!open) return null;

  return (
    <div
      role="search"
      aria-label="Search chat transcript"
      className="flex h-10 shrink-0 items-center justify-end gap-1.5 border-b border-line bg-panel px-3 cm-anim-rise"
      data-transcript-search-ignore
    >
      <div className="flex h-7 w-[min(420px,100%)] items-center gap-1.5 rounded-md border border-line-strong bg-inset px-2 text-sm shadow-[var(--shadow-xs)] focus-within:border-accent-line">
        <Search className="size-3.5 shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCurrent(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          placeholder="Search transcript"
          aria-label="Search transcript"
          className="min-w-0 flex-1 bg-transparent text-primary outline-none placeholder:text-faint"
        />
        <span className="min-w-[4.5rem] text-right text-xs tabular-nums text-faint" aria-live="polite">
          {loadingHistory ? (
            <span className="inline-flex items-center gap-1">
              <LoaderCircle className="size-3 cm-anim-spin" />
              Loading
            </span>
          ) : query.trim() ? (
            count ? `${current + 1} of ${count}` : "No results"
          ) : (
            ""
          )}
        </span>
      </div>
      <IconButton tip="Previous match" onClick={() => move(-1)} disabled={!count}>
        <ChevronUp />
      </IconButton>
      <IconButton tip="Next match" onClick={() => move(1)} disabled={!count}>
        <ChevronDown />
      </IconButton>
      <IconButton tip="Close transcript search" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}
