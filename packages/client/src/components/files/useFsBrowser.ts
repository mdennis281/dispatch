/**
 * The explorer's state machine, with no opinion about how it looks.
 *
 * The modal picker and the full page are deliberately different UIs — one is a
 * single column with a Select button, the other is a three-pane file manager
 * with a details sidebar and a context menu. What they are NOT different about
 * is what "navigate", "select", "sort" and "delete" MEAN, and every one of those
 * has a way to be subtly wrong: a stale listing after a rename, a selection that
 * survives a directory change, a race where a slow `list` for the folder you
 * just left overwrites the fast one for the folder you're in.
 *
 * Getting those right twice is how the two surfaces drift. So they're solved
 * once, here, and each surface renders the result however it likes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fsCrumbs,
  fsIsSelectable,
  fsIsVisible,
  fsJoin,
  fsNormalize,
  fsParent,
  fsSortEntries,
  type FsEntry,
  type FsFilter,
  type FsListing,
  type FsMutation,
  type FsSort,
} from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { useFsRoots, usePathPlatform } from "../../stores/fsRoots.js";
import { nextCursor, pruneSelection, rangeSelection } from "./fsSelection.js";

export interface UseFsBrowserOptions {
  /** Where to start. Falls back to the server's home directory once known. */
  initialPath?: string;
  /** What the surface will accept — drives greying, and the search's filter. */
  filter: FsFilter;
  /** Fired when a selection is committed (double-click, Enter, Select button). */
  onCommit?: (paths: string[]) => void;
}

export interface FsBrowser {
  /** Current directory, normalized. Empty string before the first navigation. */
  cwd: string;
  /** Raw server response for `cwd`, or null while the first load is in flight. */
  listing: FsListing | null;
  /** `listing.entries` after hidden-filtering and sorting — what to render. */
  entries: FsEntry[];
  crumbs: ReturnType<typeof fsCrumbs>;
  loading: boolean;
  error: string | null;
  /** Absolute paths currently selected, in click order. */
  selected: string[];
  /** Last row clicked, for shift-range and for the details pane. */
  cursor: string | null;
  sort: FsSort;
  showHidden: boolean;
  /** Live search text; empty means "show the directory listing". */
  query: string;
  /** Search hits for `query`, or null when not searching. */
  results: FsEntry[] | null;
  searching: boolean;

  navigate: (path: string) => void;
  up: () => void;
  back: () => void;
  forward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  refresh: () => void;
  /** Open a row: descend into a directory, or commit a selectable file. */
  activate: (entry: FsEntry) => void;
  /** Click a row. `mode` mirrors the modifier keys. */
  select: (entry: FsEntry, mode?: "replace" | "toggle" | "range") => void;
  /** Move the cursor by `delta` rows, wrapping at both ends. */
  moveCursor: (delta: number) => void;
  clearSelection: () => void;
  setSort: (key: FsSort["key"]) => void;
  setShowHidden: (show: boolean) => void;
  setQuery: (q: string) => void;
  /** True when this entry may be handed back as an answer. */
  isSelectable: (entry: FsEntry) => boolean;
  /** Commit the current selection through `onCommit`. */
  commit: () => void;
  /** Run a write and refresh. Resolves to the error string, or null on success. */
  mutate: (m: FsMutation) => Promise<string | null>;
}

/** Debounce for the search box — one request per pause, not per keystroke. */
const SEARCH_DEBOUNCE_MS = 180;

export function useFsBrowser(opts: UseFsBrowserOptions): FsBrowser {
  const platform = usePathPlatform();
  // `usePathPlatform` returns a DEFAULT before the fetch lands, so it can't tell
  // "the server is POSIX" from "we haven't asked yet". This can.
  const platformKnown = useFsRoots((s) => s.platform) !== null;
  const home = useFsRoots((s) => s.home);
  const loadRoots = useFsRoots((s) => s.load);

  /**
   * Empty until the server's platform is known — deliberately NOT seeded from
   * `initialPath` here.
   *
   * At first render `platform` is still the `posix` default, and normalizing a
   * Windows path under POSIX rules leaves it non-canonical (`C:` never becomes
   * `C:/`). That value then sticks: nothing re-normalizes it when the real
   * platform arrives, so it fails equality against the roots list and produces
   * breadcrumbs for a path the server never returns. Landing once, after the
   * rules are known, means there is no wrong intermediate state to repair.
   */
  const [cwd, setCwd] = useState("");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSortState] = useState<FsSort>({ key: "name", desc: false });
  const [showHidden, setShowHidden] = useState(opts.filter.showHidden);
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<FsEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  /** Visited directories and where we are in them — the back/forward stack. */
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState(-1);
  /** Bumped to force a re-fetch of the same path (after a write, or Refresh). */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  /**
   * Land once, on `initialPath` or the server's home directory.
   *
   * Gated on `platformKnown` rather than on `home` so the path is normalized
   * with the SERVER's rules the first and only time it is computed.
   *
   * It seeds `history` in the same breath, which is the other half of the fix:
   * `cwd` used to be set here for the home case and in `useState` for the
   * `initialPath` case, and only this branch pushed onto the stack — so a picker
   * opened at a given directory started with an empty history, and Back could
   * never return to where it opened.
   */
  useEffect(() => {
    if (cwd || !platformKnown) return;
    const start = fsNormalize(opts.initialPath || home || "", platform);
    if (!start) return;
    setCwd(start);
    setHistory([start]);
    setHistoryAt(0);
    // `opts.initialPath` deliberately absent: it is a STARTING point, and
    // re-running this when a caller re-renders with a new object identity would
    // yank the user back out of the folder they navigated to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, home, platform, platformKnown]);

  /**
   * Fetch the listing for `cwd`.
   *
   * The generation counter is the fix for the ordering race: click into a slow
   * network directory, click Back before it lands, and without this the slow
   * response arrives second and replaces the listing for the directory you are
   * actually in. Only the newest request may write state.
   */
  const gen = useRef(0);
  useEffect(() => {
    if (!cwd) return;
    const mine = ++gen.current;
    setLoading(true);
    setError(null);
    api.fs
      .list(cwd)
      .then((res) => {
        if (gen.current !== mine) return;
        setListing(res);
        setLoading(false);
        // A refresh after a delete (or an external change) can drop rows that
        // are still selected, and a selection holding paths that aren't on
        // screen is how Delete acts on something you can't see.
        setSelected((s) => (s.length ? pruneSelection(res.entries, s) : s));
      })
      .catch((err: unknown) => {
        if (gen.current !== mine) return;
        setListing(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [cwd, nonce]);

  /* Search: debounced, and cancelled by the same generation trick. */
  const searchGen = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q || !cwd) {
      setResults(null);
      setSearching(false);
      return;
    }
    const mine = ++searchGen.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api.fs
        .search(cwd, q, {
          select: opts.filter.select,
          ext: opts.filter.extensions,
          showHidden,
          limit: 200,
        })
        .then((res) => {
          if (searchGen.current !== mine) return;
          setResults(res.results);
          setSearching(false);
        })
        .catch(() => {
          if (searchGen.current !== mine) return;
          setResults([]);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, cwd, showHidden, opts.filter.select, opts.filter.extensions?.join(",")]);

  const navigate = useCallback(
    (path: string) => {
      const next = fsNormalize(path, platform);
      if (!next) return;
      setCwd((prev) => {
        if (prev === next) return prev;
        // Truncate the forward stack: navigating somewhere new from the middle
        // of history is a new branch, and keeping the old forward entries would
        // let Forward jump somewhere you never went from here.
        setHistory((h) => [...h.slice(0, historyAt + 1), next]);
        setHistoryAt((i) => i + 1);
        return next;
      });
      // A selection is a set of paths in the directory you were in. Carrying it
      // across a navigation means Delete acts on rows that aren't on screen.
      setSelected([]);
      setCursor(null);
      setQueryState("");
    },
    [platform, historyAt],
  );

  const goTo = useCallback(
    (index: number) => {
      const path = history[index];
      if (!path) return;
      setHistoryAt(index);
      setCwd(path);
      setSelected([]);
      setCursor(null);
      setQueryState("");
    },
    [history],
  );

  const entries = useMemo(() => {
    const source = results ?? listing?.entries ?? [];
    // Search results are already ranked by the server, and re-sorting them
    // alphabetically would throw that ranking away — the whole point of a
    // search is that the best match is first.
    if (results) return source.filter((e) => fsIsVisible(e, { showHidden }));
    return fsSortEntries(
      source.filter((e) => fsIsVisible(e, { showHidden })),
      sort,
    );
  }, [results, listing, showHidden, sort]);

  const isSelectable = useCallback(
    (entry: FsEntry) => fsIsSelectable(entry, opts.filter),
    [opts.filter],
  );

  const select = useCallback(
    (entry: FsEntry, mode: "replace" | "toggle" | "range" = "replace") => {
      setCursor(entry.path);
      if (!isSelectable(entry)) {
        // A directory in a files-only picker is still worth focusing (the
        // details pane follows the cursor) — it just can't be an answer.
        setSelected([]);
        return;
      }
      if (!opts.filter.multiple || mode === "replace") {
        setSelected([entry.path]);
        return;
      }
      if (mode === "toggle") {
        setSelected((s) =>
          s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path],
        );
        return;
      }
      // Range: anchor on the last thing selected, take everything between in
      // the order the LIST is showing. See `rangeSelection` for why that isn't
      // the same as the order the paths sort in.
      setSelected((s) => {
        const anchor = s[s.length - 1] ?? null;
        const span = rangeSelection(entries, anchor, entry.path, isSelectable);
        return Array.from(new Set([...s, ...span]));
      });
    },
    [entries, isSelectable, opts.filter],
  );

  const commit = useCallback(() => {
    if (selected.length) opts.onCommit?.(selected);
  }, [selected, opts]);

  const activate = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === "directory") {
        navigate(entry.path);
        return;
      }
      // Double-clicking a file in a directory picker shouldn't do nothing AND
      // shouldn't answer with a file — so it just selects, and the Select button
      // stays disabled with the reason visible.
      if (isSelectable(entry)) opts.onCommit?.([entry.path]);
    },
    [navigate, isSelectable, opts],
  );

  const mutate = useCallback(async (m: FsMutation): Promise<string | null> => {
    try {
      const res = await api.fs.mutate(m);
      // Refresh either way: a partial failure still changed some paths, and a
      // listing that doesn't reflect them is a listing that lies.
      setNonce((n) => n + 1);
      setSelected([]);
      if (res.ok) return null;
      const first = res.errors[0];
      return res.errors.length > 1
        ? `${first?.message ?? "failed"} (and ${res.errors.length - 1} more)`
        : (first?.message ?? "failed");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  const parent = cwd ? fsParent(cwd, platform) : null;

  return {
    cwd,
    listing,
    entries,
    crumbs: useMemo(() => (cwd ? fsCrumbs(cwd, platform) : []), [cwd, platform]),
    loading,
    error,
    selected,
    cursor,
    sort,
    showHidden,
    query,
    results,
    searching,
    navigate,
    up: () => parent && navigate(parent),
    back: () => goTo(historyAt - 1),
    forward: () => goTo(historyAt + 1),
    canGoBack: historyAt > 0,
    canGoForward: historyAt >= 0 && historyAt < history.length - 1,
    refresh: () => setNonce((n) => n + 1),
    activate,
    select,
    moveCursor: (delta) => {
      const next = nextCursor(entries, cursor, delta);
      if (next) select(next, "replace");
    },
    clearSelection: () => {
      setSelected([]);
      setCursor(null);
    },
    // Clicking the column you're already sorted by flips direction; clicking a
    // different one starts ascending, which is what every file manager does.
    setSort: (key) =>
      setSortState((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false })),
    setShowHidden,
    setQuery: setQueryState,
    isSelectable,
    commit,
    mutate,
  };
}

/** `fsJoin` bound to the live platform — for "create a file called X here". */
export function useFsJoin(): (dir: string, name: string) => string {
  const platform = usePathPlatform();
  return useCallback((dir, name) => fsJoin(dir, name, platform), [platform]);
}
