/**
 * Preload artifacts into the browser cache as agents publish them, so the
 * first open is as instant as the second.
 *
 * Driven by `artifact-updated`, for ANY chat in the project on screen — the
 * point is that the agent in the chat you are NOT looking at has already put
 * its page on the device by the time you go there. Other projects are skipped:
 * a busy install with ten projects iterating would otherwise download all of
 * them into a phone.
 *
 * Polite by construction:
 *  - work starts in idle time, one artifact at a time, assets two at a time,
 *    so the transcript's own requests are never queued behind a 30 MB texture;
 *  - only the NEWEST version of each artifact is fetched — an agent cutting ten
 *    versions in a minute costs one download, not ten;
 *  - content (≤ 8 MB) is always fetched; assets only when the bundle is within
 *    `artifactPreloadMb`, and never under `navigator.connection.saveData`.
 */
import { artifactAssetsBytes, type ArtifactAsset, type WsServerEvent } from "@dispatch/shared";
import { api } from "./api.js";
import {
  artifactCacheAvailable,
  artifactCacheLimits,
  bundleFitsCache,
  getContent,
  hasBlob,
  hasContent,
  putBlob,
  putContent,
} from "./artifactCache.js";
import { useProjects } from "../stores/projects.js";

type ArtifactUpdated = Extract<WsServerEvent, { type: "artifact-updated" }>;

/** Assets downloaded at once by the preloader — half the open pane's 4: this is background work. */
const ASSET_CONCURRENCY = 2;

/** `${chatId}:${artifactId}` → the newest event not yet processed. */
const pending = new Map<string, ArtifactUpdated>();
let running = false;

function saveData(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 5_000 });
    else setTimeout(resolve, 200);
  });
}

/** Feed one `artifact-updated`. Cheap and synchronous; the work happens later. */
export function preloadOnArtifactUpdated(evt: ArtifactUpdated): void {
  if (evt.projectId !== useProjects.getState().activeProjectId) return;
  const key = `${evt.chatId}:${evt.artifactId}`;
  const prev = pending.get(key);
  if (prev && prev.version >= evt.version) return;
  pending.set(key, evt);
  if (!running) void drain();
}

async function drain(): Promise<void> {
  running = true;
  try {
    if (!(await artifactCacheAvailable())) {
      pending.clear();
      return;
    }
    while (pending.size) {
      await whenIdle();
      const [key, evt] = pending.entries().next().value as [string, ArtifactUpdated];
      pending.delete(key);
      await preloadOne(evt).catch(() => {
        /* best-effort: the pane fetches on open regardless */
      });
    }
  } finally {
    running = false;
  }
}

async function preloadOne(evt: ArtifactUpdated): Promise<void> {
  const { chatId, artifactId, version, projectId, expiresAt } = evt;
  const limits = artifactCacheLimits(projectId);
  if (limits.projectMaxBytes <= 0) return;

  // The event carries no asset manifest (it would make every edit of a game a
  // megabyte broadcast); the version's content has it.
  let assets: Record<string, ArtifactAsset> | undefined;
  if (await hasContent(chatId, artifactId, version)) {
    assets = (await getContent(chatId, artifactId, version))?.assets;
  } else {
    const data = await api.chats.artifact(chatId, artifactId, version);
    await putContent(projectId, data, expiresAt);
    assets = data.assets;
  }
  if (!assets || !Object.keys(assets).length) return;
  const total = artifactAssetsBytes(assets);
  if (total > limits.preloadMaxBytes || saveData() || !bundleFitsCache(projectId, assets)) return;

  const missing: Array<{ sha256: string; type: string; size: number }> = [];
  const seen = new Set<string>();
  for (const a of Object.values(assets)) {
    if (seen.has(a.sha256)) continue;
    seen.add(a.sha256);
    if (!(await hasBlob(a.sha256))) missing.push(a);
  }
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const a = missing[next++]!;
      const blob = await api.chats.artifactBlob(chatId, a.sha256, a.type);
      await putBlob({ projectId, chatId, expiresAt }, a.sha256, blob);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, missing.length) }, worker));
}
