/**
 * One independently-loading section of the CI/CD page.
 *
 * The page is four or five of these side by side (workflows, runs, a run, its
 * jobs, its artifacts), each its own request. That is the whole partial-load
 * story: a section that is slow shows its own skeleton, one that fails shows
 * its own error with a retry, and neither holds up or blanks its neighbours.
 *
 * Two rules that are easy to get wrong:
 *
 *  - A REFRESH that fails keeps the last good data and reports the error
 *    beside it. A poll hiccup must not empty a list someone is reading.
 *  - A response for a key that is no longer current is dropped. Clicking
 *    through three runs fires three detail requests; only the last one may
 *    land, or the pane shows run B's jobs under run C's header.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api.js";

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  /** HTTP status of the failure, when there was one — 409 means "no CI here". */
  errorStatus: number | null;
  /** First load for this key — nothing to show yet. */
  loading: boolean;
  /** A reload over data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Replace the data locally (optimistic updates, merged pages). */
  set: (fn: (prev: T | undefined) => T | undefined) => void;
}

export function useResource<T>(
  /** `null` = nothing to load (e.g. no run selected). Changing it resets. */
  key: string | null,
  fetcher: () => Promise<T>,
  opts: {
    /** Re-fetch on this interval while the tab is visible. Falsy = never. */
    pollMs?: number | false;
    /** Shown while the first load runs, e.g. the run the list already has. */
    placeholder?: T;
  } = {},
): Resource<T> {
  const [data, setData] = useState<T | undefined>(opts.placeholder);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(key);
  const hasData = useRef(false);
  const placeholderRef = useRef(opts.placeholder);
  placeholderRef.current = opts.placeholder;

  const load = useCallback(async (forKey: string | null) => {
    if (forKey === null) return;
    if (hasData.current) setRefreshing(true);
    try {
      const next = await fetcherRef.current();
      if (keyRef.current !== forKey) return;
      hasData.current = true;
      setData(next);
      setError(null);
      setErrorStatus(null);
    } catch (err) {
      if (keyRef.current !== forKey) return;
      setError(err instanceof Error ? err.message : String(err));
      setErrorStatus(err instanceof ApiError ? err.status : null);
    } finally {
      if (keyRef.current === forKey) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    keyRef.current = key;
    hasData.current = false;
    setData(placeholderRef.current);
    setError(null);
    setErrorStatus(null);
    setRefreshing(false);
    setLoading(key !== null);
    void load(key);
  }, [key, load]);

  const pollMs = opts.pollMs;
  useEffect(() => {
    if (!pollMs || key === null) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(key);
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, key, load]);

  const reload = useCallback(() => load(keyRef.current), [load]);
  const set = useCallback((fn: (prev: T | undefined) => T | undefined) => setData(fn), []);

  return { data, error, errorStatus, loading, refreshing, reload, set };
}
