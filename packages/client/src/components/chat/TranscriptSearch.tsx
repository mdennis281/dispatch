import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { IconButton } from "../ui/IconButton.js";
import { findTranscriptMatches, indexOfMatch, type TranscriptMatch } from "./transcriptMatches.js";
import { scrollMatchIntoView } from "./scrollMatchIntoView.js";

const ALL_MATCHES = "dispatch-transcript-search";
const CURRENT_MATCH = "dispatch-transcript-search-current";

type HighlightRegistry = Map<string, Highlight> & {
  delete(name: string): boolean;
  set(name: string, highlight: Highlight): unknown;
};

function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === "undefined") return null;
  return (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights ?? null;
}

function makeHighlight(ranges: Range[]): Highlight | null {
  if (typeof Highlight === "undefined") return null;
  const highlight = new Highlight();
  for (const range of ranges) highlight.add(range);
  return highlight;
}

function clearHighlights() {
  const registry = highlightRegistry();
  registry?.delete(ALL_MATCHES);
  registry?.delete(CURRENT_MATCH);
}

export function TranscriptSearch({
  open,
  rootRef,
  scrollRef,
  revision,
  loadingHistory,
  onClose,
}: {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  /** The transcript's scrollport — what a match has to be brought into. */
  scrollRef: React.RefObject<HTMLDivElement>;
  revision: unknown;
  loadingHistory: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<TranscriptMatch[]>([]);
  // Which OCCURRENCE is current, by stable identity rather than by index. Two
  // things renumber the list under the reader while they are looking at it:
  // older history paging in above (every index shifts), and a running agent
  // streaming into the newest row. Holding an identity means neither one
  // silently changes which hit "3 of 76" refers to.
  const anchorRef = useRef<{ rowId: string; start: number } | null>(null);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const [matchRevision, setMatchRevision] = useState(0);

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

  // DOM walking can be substantial after full-history paging. Run it after
  // paint so typing into the search field never waits on a synchronous layout
  // effect before the browser can update the input.
  useEffect(() => {
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
    const kept = indexOfMatch(matches, anchorRef.current);
    setCurrent((index) =>
      kept >= 0 ? kept : matches.length ? Math.min(index, matches.length - 1) : 0,
    );
    setMatchRevision((value) => value + 1);
    const registry = highlightRegistry();
    if (registry && matches.length) {
      const highlight = makeHighlight(matches.map((match) => match.range));
      if (highlight) registry.set(ALL_MATCHES, highlight);
    }
    return clearHighlights;
  }, [open, query, revision, rootRef]);

  useLayoutEffect(() => {
    const match = matchesRef.current[current];
    const registry = highlightRegistry();
    registry?.delete(CURRENT_MATCH);
    if (!match) {
      anchorRef.current = null;
      return;
    }
    const highlight = makeHighlight([match.range]);
    if (registry && highlight) registry.set(CURRENT_MATCH, highlight);

    // Re-running because the TRANSCRIPT changed — a page of history landing, a
    // token streaming in — must not move the page. Only an actual change of
    // which occurrence is current earns a scroll; without this guard the view
    // is yanked back to the current hit on every render while paging the full
    // history in, which is most of the time right after the bar opens.
    const previous = anchorRef.current;
    anchorRef.current = { rowId: match.rowId, start: match.start };
    if (previous && previous.rowId === match.rowId && previous.start === match.start) return;
    if (scrollRef.current) scrollMatchIntoView(scrollRef.current, match);
  }, [current, matchRevision, scrollRef]);

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
            // Drop the anchor: the hits for a new query are different
            // occurrences, so there is nothing to hold the reader's place on,
            // and keeping it would suppress the scroll to the first hit.
            anchorRef.current = null;
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
          {/* The count is shown WHILE history pages in, not replaced by the
              spinner: the hits found so far are real and navigable, and hiding
              the total behind "Loading" makes a search that already works look
              broken for as long as the paging takes. */}
          <span className="inline-flex items-center gap-1">
            {loadingHistory && <LoaderCircle className="size-3 shrink-0 cm-anim-spin" />}
            {query.trim()
              ? count
                ? `${current + 1} of ${count}`
                : loadingHistory
                  ? "Searching"
                  : "No results"
              : loadingHistory
                ? "Loading"
                : ""}
          </span>
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
