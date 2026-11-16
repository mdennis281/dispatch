/**
 * The browser's copy of artifacts — IndexedDB, so opening one is instant
 * because its content and files are already on the device.
 *
 * Three object stores:
 *
 *  - `content` — one version's {@link ArtifactContent}, keyed by
 *    `(chatId, artifactId, version)`. Versions are immutable on the server, so a
 *    copy is never stale; it only stops being WANTED (LRU) or ALLOWED (expiry).
 *  - `blobs` — asset bytes keyed by sha256, shared by every version and chat
 *    that names the hash. Version 7 of a game re-uses version 6's textures
 *    without a second copy, exactly as the server stores them.
 *  - `index` — one small row per content or blob: bytes, project, chat,
 *    lastUsed, expiresAt. Usage, LRU and expiry read ONLY this, so none of
 *    them deserialises megabytes of content to answer "how big is it".
 *
 * Budgets come from `retention` (`artifactCacheMb` / `artifactPreloadMb`, app
 * with a per-project override): the app value is the device TOTAL, and a
 * project's value caps that project's share. Expiry follows the server's
 * `artifactDays` — every row carries the `expiresAt` the server computed, so a
 * copy is never shown after the sweep deleted the original.
 *
 * EVERY call here degrades to "not cached" rather than throwing. IndexedDB is
 * missing or refused in private windows and some embedded contexts, fills up
 * (`QuotaExceededError`), and can be held at an old schema by another window.
 * None of those may cost the human the artifact — the network is always there
 * underneath.
 */
import {
  artifactAssetsBytes,
  resolveRetention,
  type ArtifactAsset,
  type ArtifactContent,
  type ArtifactHead,
} from "@dispatch/shared";
import { api, ApiError } from "./api.js";
import { useSettings } from "../stores/settings.js";
import { useConfig } from "../stores/config.js";

const DB_NAME = "dispatch-artifacts";
const DB_VERSION = 1;
const CONTENT = "content";
const BLOBS = "blobs";
const INDEX = "index";

/**
 * How long an open may take before the cache is treated as unavailable FOR
 * THIS CALL. An open is blocked while another window holds the database at an
 * older version and has not closed it; the pane awaits the cache before
 * falling back to the network, so an unbounded wait here is a pane that never
 * loads.
 */
const OPEN_TIMEOUT_MS = 2_000;

/** One row of the `index` store. */
export interface ArtifactCacheEntry {
  /** `c|<chatId>|<artifactId>|<version>` or `b|<sha256>`. */
  key: string;
  kind: "content" | "blob";
  projectId: string;
  /** For a blob, the chat that first stored it — the server keeps blobs per chat too. */
  chatId: string;
  artifactId?: string;
  version?: number;
  /** A content row's asset hashes, so an expiry bump reaches the bytes it needs. */
  shas?: string[];
  bytes: number;
  lastUsed: number;
  expiresAt: number;
}

interface ContentRecord {
  key: string;
  data: ArtifactContent;
}

interface BlobRecord {
  sha256: string;
  blob: Blob;
}

const contentKey = (chatId: string, artifactId: string, version: number) =>
  `c|${chatId}|${artifactId}|${version}`;
const blobKey = (sha256: string) => `b|${sha256}`;

/* ------------------------------------------------------------------ limits */

/** What is in force for one project, in bytes. Every value `0` = off. */
export interface ArtifactCacheLimits {
  /** The device's whole budget (app setting). */
  totalMaxBytes: number;
  /** This project's share — the project override, else the app value. */
  projectMaxBytes: number;
  /** Largest asset bundle the preloader fetches ahead of time. */
  preloadMaxBytes: number;
  /** The server's artifact retention, which bounds every copy's lifetime. */
  artifactDays: number;
}

/**
 * The effective limits. Read on every call rather than captured, so a
 * Settings save or a `project.yaml` edit applies to the next write.
 *
 * The project layer comes from the config store, which is filled lazily; a
 * project not yet in it is asked for once, and until it answers the app values
 * apply — the app total is always enforced regardless, so that window can only
 * keep slightly more of one project, never more in all.
 */
export function artifactCacheLimits(projectId?: string): ArtifactCacheLimits {
  const app = useSettings.getState().app.retention;
  let project = undefined;
  if (projectId) {
    const cfg = useConfig.getState();
    const entry = cfg.byProject[projectId];
    if (entry) project = entry.config?.retention;
    else if (!cfg.loading[projectId]) void cfg.load(projectId).catch(() => {});
  }
  const total = resolveRetention(app);
  const forProject = resolveRetention(app, project);
  return {
    totalMaxBytes: total.artifactCacheMaxBytes,
    projectMaxBytes: Math.min(forProject.artifactCacheMaxBytes, total.artifactCacheMaxBytes),
    preloadMaxBytes: forProject.artifactPreloadMaxBytes,
    artifactDays: total.artifactDays.effective,
  };
}

/* -------------------------------------------------------------- pure plans */

/**
 * Which index rows to delete, oldest use first: everything expired, then each
 * project down to its own cap, then the device down to the total. Pure so it
 * is testable without a browser.
 */
export function planEviction(
  entries: readonly ArtifactCacheEntry[],
  limits: { totalMaxBytes: number; projectMaxBytes: (projectId: string) => number },
  now: number,
): string[] {
  const doomed = new Set<string>();
  const live: ArtifactCacheEntry[] = [];
  for (const e of entries) {
    if (e.expiresAt <= now) doomed.add(e.key);
    else live.push(e);
  }
  // Oldest use first; the key breaks ties so two windows plan the same.
  live.sort((a, b) => a.lastUsed - b.lastUsed || (a.key < b.key ? -1 : 1));

  const byProject = new Map<string, number>();
  for (const e of live) byProject.set(e.projectId, (byProject.get(e.projectId) ?? 0) + e.bytes);
  for (const [projectId, bytes] of byProject) {
    let over = bytes - limits.projectMaxBytes(projectId);
    for (const e of live) {
      if (over <= 0) break;
      if (e.projectId !== projectId || doomed.has(e.key)) continue;
      doomed.add(e.key);
      over -= e.bytes;
    }
  }

  let total = 0;
  for (const e of live) if (!doomed.has(e.key)) total += e.bytes;
  let over = total - limits.totalMaxBytes;
  for (const e of live) {
    if (over <= 0) break;
    if (doomed.has(e.key)) continue;
    doomed.add(e.key);
    over -= e.bytes;
  }
  return [...doomed];
}

/** Per-chat figures in {@link ArtifactCacheUsage}. */
export interface ArtifactCacheChatUsage {
  chatId: string;
  bytes: number;
  /** Cached versions (content rows) — one artifact at three versions counts three. */
  versions: number;
  /** Distinct artifacts among them. */
  artifacts: number;
  blobs: number;
}

export interface ArtifactCacheProjectUsage {
  projectId: string;
  bytes: number;
  chats: ArtifactCacheChatUsage[];
}

/** What {@link usage} reports — for Settings → Browser storage. */
export interface ArtifactCacheUsage {
  /** False when IndexedDB is unavailable here (private mode, refused): everything else is zero. */
  available: boolean;
  bytes: number;
  entries: number;
  /** Largest first; chats within a project largest first. */
  projects: ArtifactCacheProjectUsage[];
}

/** Fold index rows into the per-project, per-chat breakdown. Pure. */
export function summarizeUsage(entries: readonly ArtifactCacheEntry[]): Omit<ArtifactCacheUsage, "available"> {
  const projects = new Map<string, Map<string, ArtifactCacheChatUsage & { ids: Set<string> }>>();
  let bytes = 0;
  for (const e of entries) {
    bytes += e.bytes;
    let chats = projects.get(e.projectId);
    if (!chats) projects.set(e.projectId, (chats = new Map()));
    let chat = chats.get(e.chatId);
    if (!chat) {
      chat = { chatId: e.chatId, bytes: 0, versions: 0, artifacts: 0, blobs: 0, ids: new Set() };
      chats.set(e.chatId, chat);
    }
    chat.bytes += e.bytes;
    if (e.kind === "blob") chat.blobs++;
    else {
      chat.versions++;
      if (e.artifactId) chat.ids.add(e.artifactId);
    }
  }
  const out: ArtifactCacheProjectUsage[] = [];
  for (const [projectId, chats] of projects) {
    const list = [...chats.values()]
      .map(({ ids, ...c }) => ({ ...c, artifacts: ids.size }))
      .sort((a, b) => b.bytes - a.bytes);
    out.push({ projectId, bytes: list.reduce((n, c) => n + c.bytes, 0), chats: list });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return { bytes, entries: entries.length, projects: out };
}

/* ------------------------------------------------------------- IndexedDB */

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** Set once IndexedDB has refused outright — no point asking again this session. */
let refused = false;

function openDb(): Promise<IDBDatabase | null> {
  if (refused) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") {
        refused = true;
        return resolve(null);
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Firefox private windows (before 115) and some sandboxed contexts throw
      // SecurityError / InvalidStateError synchronously from open().
      refused = true;
      return resolve(null);
    }
    const timer = setTimeout(() => {
      // Blocked behind another window: don't remember this as "no cache" — the
      // other window closes on versionchange and the next call may succeed.
      dbPromise = null;
      resolve(null);
    }, OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONTENT)) db.createObjectStore(CONTENT, { keyPath: "key" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "sha256" });
      if (!db.objectStoreNames.contains(INDEX)) {
        const index = db.createObjectStore(INDEX, { keyPath: "key" });
        index.createIndex("chatId", "chatId");
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // Another window (a newer build after an upgrade, or deleteDatabase)
      // wants a new version. Holding this connection open would block it
      // forever — the classic two-tabs IDB deadlock — so let go and reopen
      // lazily on the next call.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      // The browser can close it under us (storage cleared from DevTools,
      // eviction under disk pressure).
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
      void sweepOnce();
    };
    request.onerror = () => {
      clearTimeout(timer);
      // Private mode in some browsers fails here instead of throwing above.
      refused = true;
      resolve(null);
    };
    request.onblocked = () => {
      /* the timer above decides; the blocking window gets a versionchange */
    };
  });
  dbPromise = opening;
  return opening;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "QuotaExceededError" || err.code === 22);
}

/** Run `fn` against the db, or return `fallback` on ANY failure. */
async function withDb<T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    const db = await openDb();
    if (!db) return fallback;
    return await fn(db);
  } catch {
    return fallback;
  }
}

/** True when the cache can store anything here. */
export function artifactCacheAvailable(): Promise<boolean> {
  return openDb().then(
    (db) => !!db,
    () => false,
  );
}

/* ------------------------------------------------------------------- reads */

async function readEntry(db: IDBDatabase, key: string): Promise<ArtifactCacheEntry | undefined> {
  return req(db.transaction(INDEX).objectStore(INDEX).get(key)) as Promise<ArtifactCacheEntry | undefined>;
}

/** Bump lastUsed — fire-and-forget, a missed bump only makes LRU slightly wrong. */
function touch(db: IDBDatabase, entry: ArtifactCacheEntry): void {
  try {
    const tx = db.transaction(INDEX, "readwrite");
    tx.objectStore(INDEX).put({ ...entry, lastUsed: Date.now() });
  } catch {
    /* closed under us */
  }
}

/** A cached version, or null. An expired one is a miss, and is deleted. */
export function getContent(chatId: string, artifactId: string, version: number): Promise<ArtifactContent | null> {
  return withDb(null, async (db) => {
    const key = contentKey(chatId, artifactId, version);
    const entry = await readEntry(db, key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      await removeKeys(db, [key]);
      return null;
    }
    const rec = (await req(db.transaction(CONTENT).objectStore(CONTENT).get(key))) as ContentRecord | undefined;
    if (!rec) return null;
    touch(db, entry);
    return rec.data;
  });
}

/** A cached asset blob, or null. */
export function getBlob(sha256: string): Promise<Blob | null> {
  return withDb(null, async (db) => {
    const entry = await readEntry(db, blobKey(sha256));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      await removeKeys(db, [entry.key]);
      return null;
    }
    const rec = (await req(db.transaction(BLOBS).objectStore(BLOBS).get(sha256))) as BlobRecord | undefined;
    if (!rec) return null;
    touch(db, entry);
    return rec.blob;
  });
}

/** Whether a version / blob is held — index only, no payload read. */
export function hasContent(chatId: string, artifactId: string, version: number): Promise<boolean> {
  return withDb(false, async (db) => {
    const e = await readEntry(db, contentKey(chatId, artifactId, version));
    return !!e && e.expiresAt > Date.now();
  });
}
export function hasBlob(sha256: string): Promise<boolean> {
  return withDb(false, async (db) => {
    const e = await readEntry(db, blobKey(sha256));
    return !!e && e.expiresAt > Date.now();
  });
}

/** The newest version of an artifact held here — "latest" when the server can't be asked. */
function newestCachedVersion(chatId: string, artifactId: string): Promise<number | null> {
  return withDb(null, async (db) => {
    const rows = (await req(
      db.transaction(INDEX).objectStore(INDEX).index("chatId").getAll(chatId),
    )) as ArtifactCacheEntry[];
    let best: number | null = null;
    for (const r of rows) {
      if (r.kind !== "content" || r.artifactId !== artifactId || r.expiresAt <= Date.now()) continue;
      if (r.version !== undefined && (best === null || r.version > best)) best = r.version;
    }
    return best;
  });
}

/* ------------------------------------------------------------------ writes */

/**
 * Write one record plus its index row in a single transaction, so a crash or
 * a quota failure can never leave bytes the index doesn't count (invisible to
 * eviction, so never freed) or an index row with nothing behind it.
 */
async function putRecord(
  storeName: typeof CONTENT | typeof BLOBS,
  record: ContentRecord | BlobRecord,
  entry: ArtifactCacheEntry,
): Promise<void> {
  const limits = artifactCacheLimits(entry.projectId);
  // One item bigger than the budget would evict everything else and then
  // itself; don't start.
  if (entry.bytes > limits.projectMaxBytes) return;
  await withDb(undefined, async (db) => {
    const write = async () => {
      const tx = db.transaction([storeName, INDEX], "readwrite");
      tx.objectStore(storeName).put(record);
      tx.objectStore(INDEX).put(entry);
      await done(tx);
    };
    try {
      await write();
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      // The ORIGIN is out of quota — which our own budget can't see: the
      // browser's quota is shared with everything else on the origin and can
      // be far below 500 MB on a phone. Free this write's size (plus slack)
      // from the least recently used, then try exactly once more.
      await freeBytes(db, entry.bytes * 2);
      await write();
    }
    scheduleEnforce();
  });
}

/**
 * Cache one version. `expiresAt` is the server's (see `ArtifactHead`); it is
 * applied to every cached version of the artifact, since retention expires an
 * artifact whole, measured from its LAST edit.
 */
export async function putContent(projectId: string, data: ArtifactContent, expiresAt: number): Promise<void> {
  const { meta, version } = data;
  const size = meta.versions.find((v) => v.n === version)?.size ?? data.content.length;
  const shas = Object.values(data.assets ?? {}).map((a) => a.sha256);
  await putRecord(
    CONTENT,
    { key: contentKey(meta.chatId, meta.id, version), data },
    {
      key: contentKey(meta.chatId, meta.id, version),
      kind: "content",
      projectId,
      chatId: meta.chatId,
      artifactId: meta.id,
      version,
      ...(shas.length ? { shas } : {}),
      // The meta rides along with every version; count it roughly.
      bytes: size + 512 + meta.versions.length * 96,
      lastUsed: Date.now(),
      expiresAt,
    },
  );
  await noteExpiry(meta.chatId, meta.id, expiresAt);
}

/** Cache one asset blob. Shared by hash: a second owner extends its expiry, never re-attributes it. */
export async function putBlob(
  owner: { projectId: string; chatId: string; expiresAt: number },
  sha256: string,
  blob: Blob,
): Promise<void> {
  const existing = await withDb(undefined, (db) => readEntry(db, blobKey(sha256)));
  if (existing) {
    if (existing.expiresAt < owner.expiresAt) {
      await withDb(undefined, async (db) => {
        const tx = db.transaction(INDEX, "readwrite");
        tx.objectStore(INDEX).put({ ...existing, expiresAt: owner.expiresAt, lastUsed: Date.now() });
        await done(tx);
      });
    }
    return;
  }
  await putRecord(
    BLOBS,
    { sha256, blob },
    {
      key: blobKey(sha256),
      kind: "blob",
      projectId: owner.projectId,
      chatId: owner.chatId,
      bytes: blob.size,
      lastUsed: Date.now(),
      expiresAt: owner.expiresAt,
    },
  );
}

/**
 * The server's current expiry for an artifact. Every cached version takes it
 * (an edit extends them all; a shortened `artifactDays` shortens them), and
 * the blobs they name take it if it is later than what they already have —
 * a blob may also back another artifact that lives longer.
 */
export function noteExpiry(chatId: string, artifactId: string, expiresAt: number): Promise<void> {
  return withDb(undefined, async (db) => {
    const tx = db.transaction(INDEX, "readwrite");
    const store = tx.objectStore(INDEX);
    const rows = (await req(store.index("chatId").getAll(chatId))) as ArtifactCacheEntry[];
    const shas = new Set<string>();
    for (const r of rows) {
      if (r.kind !== "content" || r.artifactId !== artifactId) continue;
      for (const s of r.shas ?? []) shas.add(s);
      if (r.expiresAt !== expiresAt) store.put({ ...r, expiresAt });
    }
    for (const sha of shas) {
      const b = (await req(store.get(blobKey(sha)))) as ArtifactCacheEntry | undefined;
      if (b && b.expiresAt < expiresAt) store.put({ ...b, expiresAt });
    }
    await done(tx);
  });
}

/* --------------------------------------------------------------- eviction */

/** Delete index rows and what they name, in one transaction. */
async function removeKeys(db: IDBDatabase, keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  const tx = db.transaction([CONTENT, BLOBS, INDEX], "readwrite");
  for (const key of keys) {
    tx.objectStore(INDEX).delete(key);
    if (key.startsWith("b|")) tx.objectStore(BLOBS).delete(key.slice(2));
    else tx.objectStore(CONTENT).delete(key);
  }
  await done(tx);
}

async function allEntries(db: IDBDatabase): Promise<ArtifactCacheEntry[]> {
  return (await req(db.transaction(INDEX).objectStore(INDEX).getAll())) as ArtifactCacheEntry[];
}

/** Free at least `bytes`, least recently used first — the quota-error path. */
async function freeBytes(db: IDBDatabase, bytes: number): Promise<void> {
  const rows = (await allEntries(db)).sort((a, b) => a.lastUsed - b.lastUsed);
  const keys: string[] = [];
  let freed = 0;
  for (const r of rows) {
    if (freed >= bytes) break;
    keys.push(r.key);
    freed += r.bytes;
  }
  await removeKeys(db, keys);
}

/** Bring the cache within its budgets and drop what has expired. */
export function enforceArtifactCacheLimits(): Promise<void> {
  return withDb(undefined, async (db) => {
    const entries = await allEntries(db);
    const total = artifactCacheLimits().totalMaxBytes;
    const keys = planEviction(
      entries,
      { totalMaxBytes: total, projectMaxBytes: (pid) => artifactCacheLimits(pid).projectMaxBytes },
      Date.now(),
    );
    await removeKeys(db, keys);
  });
}

let enforceTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Coalesced: a 300-file bundle writes 300 blobs, and planning after each one
 * would read the whole index 300 times.
 */
function scheduleEnforce(): void {
  if (enforceTimer) return;
  enforceTimer = setTimeout(() => {
    enforceTimer = undefined;
    void enforceArtifactCacheLimits();
  }, 1_000);
}

let swept = false;
/** Once per page load: expired copies from last week go before anything reads them. */
async function sweepOnce(): Promise<void> {
  if (swept) return;
  swept = true;
  await enforceArtifactCacheLimits();
}

/**
 * Forget every cached version of an artifact — the server answered 410 (or
 * 404): retention deleted it, and a copy must not outlive the original.
 * Blobs are left to LRU/expiry; another artifact may still name them.
 */
export function evictArtifact(chatId: string, artifactId: string): Promise<void> {
  return withDb(undefined, async (db) => {
    const rows = (await req(
      db.transaction(INDEX).objectStore(INDEX).index("chatId").getAll(chatId),
    )) as ArtifactCacheEntry[];
    await removeKeys(
      db,
      rows.filter((r) => r.kind === "content" && r.artifactId === artifactId).map((r) => r.key),
    );
  });
}

/* --------------------------------------------------------- Settings API */

/** The per-project, per-chat breakdown for Settings → Browser storage. */
export async function usage(): Promise<ArtifactCacheUsage> {
  const db = await openDb().catch(() => null);
  if (!db) return { available: false, bytes: 0, entries: 0, projects: [] };
  try {
    return { available: true, ...summarizeUsage(await allEntries(db)) };
  } catch {
    return { available: false, bytes: 0, entries: 0, projects: [] };
  }
}

/**
 * Delete cached copies. No filter = everything; `projectId` and/or `chatId`
 * narrow it (both = that chat, if it is in that project).
 */
export function clear(filter: { projectId?: string; chatId?: string } = {}): Promise<void> {
  return withDb(undefined, async (db) => {
    if (!filter.projectId && !filter.chatId) {
      const tx = db.transaction([CONTENT, BLOBS, INDEX], "readwrite");
      tx.objectStore(CONTENT).clear();
      tx.objectStore(BLOBS).clear();
      tx.objectStore(INDEX).clear();
      await done(tx);
      return;
    }
    const keys = (await allEntries(db))
      .filter(
        (e) =>
          (!filter.projectId || e.projectId === filter.projectId) && (!filter.chatId || e.chatId === filter.chatId),
      )
      .map((e) => e.key);
    await removeKeys(db, keys);
  });
}

/** Sign-out: the next person on this device must not open the last one's artifacts from disk. */
export const clearArtifactCacheOnLogout = (): Promise<void> => clear();

/* ------------------------------------------------------------ read-through */

export interface LoadedArtifact {
  data: ArtifactContent;
  /** What the server said about "latest" — null when it couldn't be asked and the cache answered. */
  head: ArtifactHead | null;
  fromCache: boolean;
}

/** A failure that means "the server isn't answering", as opposed to a real answer like 404/410. */
function isUnreachable(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500 || err.status === 0;
}

/**
 * One version of an artifact, from the cache when it is there.
 *
 * "Latest" (`pinned` null) is resolved with the head route first — a few
 * hundred bytes — because the cache is keyed by version and "latest" is the
 * one thing that changes. Then the content comes from IndexedDB if held, else
 * the network, and is written back. The returned meta is the HEAD's, so the
 * version picker is current even when the content is a week-old copy.
 *
 * When the server can't be reached at all, the newest cached version is shown
 * rather than an error — reading what the agent made yesterday on a train.
 */
export async function loadArtifact(
  chatId: string,
  artifactId: string,
  pinned: number | null,
): Promise<LoadedArtifact> {
  let head: ArtifactHead | null = null;
  let headError: unknown = null;
  try {
    head = await api.chats.artifactHead(chatId, artifactId);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 410 || err.status === 404)) {
      void evictArtifact(chatId, artifactId);
      throw err;
    }
    if (!isUnreachable(err)) throw err;
    headError = err;
  }
  if (head) void noteExpiry(chatId, artifactId, head.expiresAt);

  const version = pinned ?? head?.version ?? (await newestCachedVersion(chatId, artifactId));
  if (version) {
    const hit = await getContent(chatId, artifactId, version);
    if (hit) return { data: head ? { ...hit, meta: head.meta } : hit, head, fromCache: true };
  }
  if (!head && headError) throw headError;

  try {
    const data = await api.chats.artifact(chatId, artifactId, version ?? undefined);
    if (head) void putContent(head.projectId, data, head.expiresAt);
    return { data, head, fromCache: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 410) void evictArtifact(chatId, artifactId);
    throw err;
  }
}

/**
 * One asset's bytes from the cache, else the network (written back when
 * `owner` is given — the caller passes null for a bundle too big to keep, so
 * caching its tail doesn't evict its own head).
 */
export async function loadArtifactBlob(
  chatId: string,
  asset: ArtifactAsset,
  owner: { projectId: string; expiresAt: number } | null,
  onBytes?: (n: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const hit = await getBlob(asset.sha256);
  if (hit) {
    onBytes?.(asset.size);
    return hit;
  }
  const blob = await api.chats.artifactBlob(chatId, asset.sha256, asset.type, onBytes, signal);
  if (owner) void putBlob({ ...owner, chatId }, asset.sha256, blob);
  return blob;
}

/** Whether a bundle of this size should be written to the cache for `projectId`. */
export function bundleFitsCache(projectId: string, assets: Record<string, ArtifactAsset> | undefined): boolean {
  const { projectMaxBytes } = artifactCacheLimits(projectId);
  // Half the budget: a bundle that fills the cache evicts every other artifact
  // in the project to make room for one.
  return projectMaxBytes > 0 && artifactAssetsBytes(assets) <= projectMaxBytes / 2;
}
