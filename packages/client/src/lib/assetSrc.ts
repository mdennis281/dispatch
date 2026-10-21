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
import type { ImageRef } from "@dispatch/shared";
import { assetUrl, fsAssetUrl } from "./api.js";
import { sessionFetch } from "../stores/auth.js";

/** Already renderable as-is — nothing to fetch, nothing to revoke. */
const DIRECT = /^(https?:|data:|blob:)/i;

/**
 * Marks a path that lives in the PROJECT working tree rather than in the chat's
 * assets dir — an image the agent wrote and then merely mentioned.
 *
 * An explicit prefix rather than a heuristic on the path shape, because there
 * isn't a reliable one: `assetUrl` reduces a chat asset to its basename, so
 * `out/chart.png` and `assets/chart.png` would both be requested as
 * `chart.png` and the working-tree file would 404. The two are genuinely
 * different resources and the ref has to say which it is.
 */
const FS_PREFIX = "fs:";

/** An `ImageRef` for a file in the chat's working tree. */
export function fsImageRef(path: string, extra?: Partial<ImageRef>): ImageRef {
  return { id: `fs-${path}`, ...extra, path: `${FS_PREFIX}${path}` };
}

/** The working-tree path a ref points at, or null if it isn't one. */
export function fsRefPath(path: string): string | null {
  return path.startsWith(FS_PREFIX) ? path.slice(FS_PREFIX.length) : null;
}

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
  /** Bytes received so far, and the total if the server said (content-length). */
  loaded: number;
  total?: number;
  /** Mounted consumers to tell when `loaded` moves. */
  listeners: Set<() => void>;
}

const cache = new Map<string, Entry>();
let clock = 0;

/**
 * A chat asset the server's retention sweep deleted — answered 410, never 404.
 *
 * Its own error type because it is the one failure that is NOT a failure to
 * load: the transcript still names the file and always will, and the honest
 * thing to draw is "this image expired", not a broken picture inviting a retry.
 */
export class AssetExpiredError extends Error {
  constructor(url: string) {
    super(`asset ${url} expired`);
    this.name = "AssetExpiredError";
  }
}

/**
 * URLs known to be expired. Remembered, unlike every other failure, because an
 * expiry is permanent: a long transcript remounts its thumbnails as it scrolls,
 * and re-asking the server about each dead screenshot every time buys nothing.
 */
const expiredUrls = new Set<string>();

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
  const direct = directSrc(path);
  if (direct) return direct;
  const fsPath = fsRefPath(path);
  return fsPath === null ? assetUrl(chatId, { path }) : fsAssetUrl(chatId, fsPath);
}

/**
 * The response body as a Blob, publishing progress on `entry` as it arrives.
 *
 * WHY NOT `response.blob()`: that is one opaque await, and the whole file has
 * to land before anything renders (see `AssetMedia`'s KNOWN LIMIT). For a
 * screenshot that is instant; for a WebM a review card is waiting on, it was a
 * grey pulsing box for long enough to wonder whether it was ever coming. With
 * the bytes counted, the placeholder can say how far along it is.
 *
 * Listeners hear about whole-percent steps only: a 200MB video arrives in
 * thousands of chunks, and a re-render per chunk would be pure churn.
 */
async function readBody(response: Response, entry: Entry): Promise<Blob> {
  const total = Number(response.headers?.get("content-length"));
  // Decide BEFORE taking a reader: `getReader()` locks the body, and a locked
  // body makes the `blob()` fallback throw — which drew every length-less
  // response as a broken image.
  if (!response.body || !(total > 0)) return response.blob();
  const reader = response.body.getReader();
  entry.total = total;
  const chunks: Uint8Array[] = [];
  let step = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    entry.loaded += value.byteLength;
    const next = Math.floor((entry.loaded / total) * 100);
    if (next !== step) {
      step = next;
      for (const listener of entry.listeners) listener();
    }
  }
  // The type is what lets a <video> play the object URL; `response.blob()`
  // carried it implicitly, a hand-built Blob has to be told.
  return new Blob(chunks as BlobPart[], { type: response.headers.get("content-type") ?? "" });
}

function entryFor(url: string): Entry {
  if (expiredUrls.has(url)) {
    // Not cached: there are no bytes to pin, and nothing to evict.
    return {
      refs: 0,
      usedAt: ++clock,
      loaded: 0,
      listeners: new Set(),
      promise: Promise.reject(new AssetExpiredError(url)),
    };
  }
  const existing = cache.get(url);
  if (existing) {
    existing.usedAt = ++clock;
    return existing;
  }
  const entry: Entry = {
    refs: 0,
    usedAt: ++clock,
    loaded: 0,
    listeners: new Set(),
    promise: undefined as never,
  };
  entry.promise = (async () => {
    const response = await sessionFetch(url);
    if (response.status === 410) {
      expiredUrls.add(url);
      throw new AssetExpiredError(url);
    }
    if (!response.ok) {
      // Name the asset: several are usually in flight at once, and a bare
      // status says nothing about which one failed.
      throw new Error(`asset ${url} failed: ${response.status} ${response.statusText}`.trimEnd());
    }
    const objectUrl = URL.createObjectURL(await readBody(response, entry));
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
  /** The failure was an expiry (see {@link AssetExpiredError}). Implies `failed`. */
  expired?: boolean;
  /**
   * 0–1 while the bytes are in flight, when the server said how many to expect.
   * Undefined when it didn't (draw an indeterminate spinner) or once loaded.
   */
  progress?: number;
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
    // A carried-over `progress` is the PREVIOUS asset's: paging the viewer from
    // a clip at 60% to one with no length would otherwise sit on a fake 60%.
    setState((prev) =>
      prev.src === undefined && !prev.failed && prev.progress === undefined ? prev : { failed: false },
    );
    const onProgress = () => {
      if (!live || !entry.total) return;
      const progress = entry.loaded / entry.total;
      setState((prev) => (prev.src !== undefined || prev.failed ? prev : { failed: false, progress }));
    };
    entry.listeners.add(onProgress);
    // A remount mid-download (a transcript scrolling) picks up where it is
    // rather than restarting the ring from zero.
    onProgress();
    void entry.promise.then(
      (src) => { if (live) setState({ src, failed: false }); },
      (error: unknown) => {
        if (live) setState({ failed: true, expired: error instanceof AssetExpiredError });
      },
    );
    return () => {
      live = false;
      entry.listeners.delete(onProgress);
      entry.refs = Math.max(0, entry.refs - 1);
    };
  }, [url]);

  return state;
}

/** Drop every memoized object URL. Exported for tests. */
export function __resetAssetCache(): void {
  for (const entry of cache.values()) if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  cache.clear();
  expiredUrls.clear();
}
