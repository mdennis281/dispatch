/**
 * Resolve an `ImageRef` to something an `<img>` can actually render.
 *
 * WHY THIS EXISTS: chat assets are served from `/api/chats/:id/assets/:name`,
 * and the auth gate (server/app.ts) rejects every `/api/` request that arrives
 * without a `Bearer` token. A browser sends NO such header for `<img src=…>`,
 * so once authentication was enabled every stored image in every transcript
 * turned into the broken-thumbnail fallback.
 *
 * The service worker can't rescue it either: a same-origin subresource fetch is
 * `mode: "no-cors"`, and the `Request` constructor silently STRIPS
 * `authorization` from a no-cors request — so the token never reaches the wire
 * (and in dev there is no worker at all, it's registered in PROD only).
 *
 * So the bytes are fetched through the one authenticated path the app already
 * has (`sessionFetch`, which also handles a 401 → refresh → retry) and handed
 * to the DOM as an object URL. Object URLs cost a fetch instead of an HTTP
 * cache hit, so results are memoized per URL for the life of the page; a
 * transcript re-renders its thumbnails constantly and must not re-download on
 * every scroll.
 */
import { useEffect, useState } from "react";
import { assetUrl } from "./api.js";
import { sessionFetch } from "../stores/auth.js";

/** Already renderable as-is — nothing to fetch, nothing to revoke. */
const DIRECT = /^(https?:|data:|blob:)/i;

/**
 * Bound the object URLs held alive. Each entry pins its blob in memory, and an
 * install that never reloads would otherwise grow without limit. Entries with
 * a live `<img>` on them are never evicted, so eviction can't break a rendered
 * image.
 */
const MAX_ENTRIES = 120;

interface Entry {
  promise: Promise<string>;
  /** Resolved object URL, once known — needed to revoke on eviction. */
  objectUrl?: string;
  /** Mounted consumers. An entry above zero is exempt from eviction. */
  refs: number;
  usedAt: number;
}

const cache = new Map<string, Entry>();
let clock = 0;

function evict(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const cold = [...cache.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, entry] of cold) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(key);
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
}

/**
 * The `src` to hand the DOM for `path`, or null when the bytes must be fetched.
 * Exported for the hook and its tests.
 */
export function directSrc(path: string): string | null {
  return DIRECT.test(path) ? path : null;
}

/** The endpoint that serves `image` for `chatId` — only for non-direct paths. */
export function assetSrcTarget(chatId: string, path: string): string {
  return directSrc(path) ?? assetUrl(chatId, { path });
}

function entryFor(url: string): Entry {
  const existing = cache.get(url);
  if (existing) {
    existing.usedAt = ++clock;
    return existing;
  }
  const entry: Entry = { refs: 0, usedAt: ++clock, promise: undefined as never };
  entry.promise = (async () => {
    const response = await sessionFetch(url);
    if (!response.ok) {
      // Name the asset: several are usually in flight at once, and a bare
      // status says nothing about which one failed.
      throw new Error(`asset ${url} failed: ${response.status} ${response.statusText}`.trimEnd());
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    entry.objectUrl = objectUrl;
    return objectUrl;
  })().catch((error: unknown) => {
    // A failure must not be memoized, or a blip would poison the image for the
    // rest of the session.
    cache.delete(url);
    throw error;
  });
  cache.set(url, entry);
  evict();
  return entry;
}

/**
 * Fetch `url` with the session's bearer token and expose the bytes as an object
 * URL, memoized per URL. Concurrent and repeat callers share one request.
 *
 * INTERNAL — for `useAssetSrc` and its tests, not for feature code. It does not
 * take a reference on the cache entry, so the object URL it returns may be
 * revoked by a later eviction; anything holding one in the DOM must go through
 * `useAssetSrc` / `AssetImage`, which keep the entry pinned while it is mounted.
 */
export function loadAsset(url: string): Promise<string> {
  return entryFor(url).promise;
}

export interface ResolvedAsset {
  /** Undefined while the bytes are still in flight. */
  src?: string;
  failed: boolean;
}

/**
 * Renderable `src` for a chat asset. `data:` / `blob:` / remote URLs pass
 * straight through; a stored `assets/<name>` path is fetched with the session's
 * bearer token and exposed as an object URL.
 */
export function useAssetSrc(
  chatId: string,
  image: { path: string } | null | undefined,
): ResolvedAsset {
  const path = image?.path;
  const url = path === undefined ? undefined : assetSrcTarget(chatId, path);
  const [state, setState] = useState<ResolvedAsset>(() =>
    path !== undefined && directSrc(path) ? { src: url, failed: false } : { failed: false },
  );

  useEffect(() => {
    if (url === undefined) {
      setState({ failed: false });
      return;
    }
    if (directSrc(url)) {
      setState({ src: url, failed: false });
      return;
    }
    let live = true;
    const entry = entryFor(url);
    entry.refs += 1;
    setState((prev) => (prev.src === undefined && !prev.failed ? prev : { failed: false }));
    void entry.promise.then(
      (src) => { if (live) setState({ src, failed: false }); },
      () => { if (live) setState({ failed: true }); },
    );
    return () => {
      live = false;
      entry.refs = Math.max(0, entry.refs - 1);
    };
  }, [url]);

  return state;
}

/** Drop every memoized object URL. Exported for tests. */
export function __resetAssetCache(): void {
  for (const entry of cache.values()) if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  cache.clear();
}
