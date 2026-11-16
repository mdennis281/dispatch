/**
 * What THIS browser holds for THIS origin — for Settings → Browser storage.
 *
 * Everything here is a survey of the device the page is running on. The stable
 * install (4318), a dev server (4319) and a phone are three origins with three
 * separate stores; nothing in this file can see the others, and the section
 * that renders it has to say so or a "0 B" on a phone reads as a bug on the
 * desktop.
 *
 * Every probe degrades to "unknown" rather than throwing: Safari has no
 * `indexedDB.databases()` before 14 and no `usageDetails` at all, Firefox
 * private windows refuse IndexedDB, and an embedded webview may not expose
 * `navigator.storage`. A settings page that crashes because a browser API is
 * missing is worse than one that shows a dash.
 */

/** `navigator.storage.estimate()`, with Chromium's non-standard breakdown when present. */
export interface OriginEstimate {
  usage: number;
  quota: number;
  /** Chromium only: `indexedDB`, `caches`, `serviceWorkerRegistrations`, … in bytes. */
  details: Record<string, number> | null;
}

export async function originEstimate(): Promise<OriginEstimate | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = (await navigator.storage.estimate()) as StorageEstimate & {
      usageDetails?: Record<string, number>;
    };
    return {
      usage: e.usage ?? 0,
      quota: e.quota ?? 0,
      details: e.usageDetails && Object.keys(e.usageDetails).length ? { ...e.usageDetails } : null,
    };
  } catch {
    return null;
  }
}

/** `true`/`false` from `persisted()`, or `null` where the API is missing. */
export async function storagePersisted(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/**
 * Ask for persistent storage. Chromium decides silently from engagement (an
 * installed PWA, a bookmarked site, granted notifications) and never prompts;
 * Firefox prompts. A `false` is therefore not an error to show as one — it
 * means "best-effort", which the section explains.
 */
export async function requestPersist(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- Web Storage */

export interface WebStorageKey {
  key: string;
  bytes: number;
}

export interface WebStorageSurvey {
  available: boolean;
  bytes: number;
  /** Largest first. */
  keys: WebStorageKey[];
}

/**
 * Bytes a key/value pair costs. Web Storage strings are UTF-16 and the
 * browser's ~5 MB cap is counted in those code units, so `length * 2` is the
 * honest figure — a UTF-8 byte count would understate how close to the cap
 * an origin is by up to half.
 */
export const webStorageBytes = (key: string, value: string): number => (key.length + value.length) * 2;

/** Pure over any `Storage`-shaped object, so it is testable without a DOM. */
export function surveyWebStorage(storage: Pick<Storage, "length" | "key" | "getItem"> | null): WebStorageSurvey {
  if (!storage) return { available: false, bytes: 0, keys: [] };
  try {
    const keys: WebStorageKey[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key == null) continue;
      keys.push({ key, bytes: webStorageBytes(key, storage.getItem(key) ?? "") });
    }
    keys.sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
    return { available: true, bytes: keys.reduce((n, k) => n + k.bytes, 0), keys };
  } catch {
    // Reading `window.localStorage` itself throws (SecurityError) when storage
    // is blocked for the site — the getter, not just a write.
    return { available: false, bytes: 0, keys: [] };
  }
}

function storageOrNull(which: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[which];
  } catch {
    return null;
  }
}

export const surveyLocalStorage = () => surveyWebStorage(storageOrNull("localStorage"));
export const surveySessionStorage = () => surveyWebStorage(storageOrNull("sessionStorage"));

/* ------------------------------------------------------- Cache Storage */

/**
 * The service worker's app-shell cache (`public/sw.js` → `CACHE`). Matched by
 * prefix because the worker bumps the suffix to evict old shells, and this
 * page must not need a release in lockstep to recognise the new one.
 */
const SHELL_CACHE_PREFIX = "dispatch-shell-";
/** Must match PUSH_DEVICE_CACHE in public/sw.js and lib/webPush.ts. */
const PUSH_DEVICE_CACHE = "dispatch-push-device";

export interface CacheSurvey {
  name: string;
  entries: number;
  /** Sum of response body sizes, or null when a body could not be read. */
  bytes: number | null;
  /**
   * Whether the section may offer to delete it. Only the shell cache is: the
   * worker re-fills it on the next navigation, so clearing it costs one
   * slower load. The push-device cache is the ONLY place the worker's
   * `pushsubscriptionchange` handler can find this device's id — deleting it
   * would make the next subscription rotation register a duplicate device.
   */
  clearable: boolean;
  role: "shell" | "push" | "other";
}

export function cacheRole(name: string): CacheSurvey["role"] {
  if (name.startsWith(SHELL_CACHE_PREFIX)) return "shell";
  if (name === PUSH_DEVICE_CACHE) return "push";
  return "other";
}

export async function surveyCaches(): Promise<CacheSurvey[] | null> {
  try {
    if (typeof caches === "undefined") return null;
    const names = await caches.keys();
    const out: CacheSurvey[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      let bytes: number | null = 0;
      // Reading bodies is the only portable size measure (Content-Length is
      // absent on opaque and chunked responses). The shell is a handful of
      // files, so this is cheap; it is not done for anything unbounded.
      for (const req of requests) {
        try {
          const res = await cache.match(req);
          bytes += res ? (await res.blob()).size : 0;
        } catch {
          bytes = null;
          break;
        }
      }
      const role = cacheRole(name);
      out.push({ name, entries: requests.length, bytes, role, clearable: role === "shell" });
    }
    return out.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  } catch {
    return null;
  }
}

export async function deleteCache(name: string): Promise<boolean> {
  try {
    return await caches.delete(name);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------- IndexedDB */

export interface IdbDatabase {
  name: string;
  version: number;
}

/**
 * The origin's IndexedDB databases by name. There is no per-database size
 * API — `usageDetails.indexedDB` is the only figure, and it is the total — so
 * the section lists names and attributes bytes only where it can (the
 * artifact cache counts its own).
 */
export async function listIdbDatabases(): Promise<IdbDatabase[] | null> {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return null;
    const dbs = await indexedDB.databases();
    return dbs
      .filter((d): d is { name: string; version: number } => typeof d.name === "string")
      .map((d) => ({ name: d.name, version: d.version ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
}

/**
 * A readable label for a `usageDetails` key. Chromium's keys are camelCase
 * API names; showing `serviceWorkerRegistrations` raw is fine for a developer
 * and noise for everyone else.
 */
export function usageDetailLabel(key: string): string {
  switch (key) {
    case "indexedDB":
      return "IndexedDB";
    case "caches":
      return "Cache Storage";
    case "serviceWorkerRegistrations":
      return "Service worker";
    case "fileSystem":
      return "File system";
    default:
      return key;
  }
}
