import { useCallback, useEffect, useRef, useState } from "react";
import {
  latestArtifactVersion,
  type ArtifactContent,
  type ArtifactHead,
  type ArtifactType,
} from "@dispatch/shared";
import { api, ApiError } from "../../lib/api.js";
import { bundleFitsCache, loadArtifact } from "../../lib/artifactCache.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { artifactKey, useArtifactView } from "../../stores/artifacts.js";
import { useArtifactAssets } from "./useArtifactAssets.js";
import { useArtifactStorage } from "./useArtifactStorage.js";

export type Loaded =
  | { state: "loading" }
  | { state: "ok"; data: ArtifactContent; head: ArtifactHead | null }
  | { state: "expired"; expiredAt?: number }
  | { state: "error"; message: string };

export type View = "preview" | "source";

/** Types whose preview is something other than the source itself. */
const PREVIEWABLE: ReadonlySet<ArtifactType> = new Set(["html", "svg", "markdown"]);

/** How long to gather a burst of frame errors before sending them in one POST. */
const ERROR_FLUSH_MS = 600;

/**
 * Everything about ONE live view of an artifact that isn't layout: the fetch,
 * the version it follows, its persisted storage, its asset bundle, the runtime
 * errors it reports, and the Copy/Download actions.
 *
 * Shared by the two shells that show an artifact — the pane beside the chat
 * and the pop-out window — so they cannot drift apart in what "Reload" or
 * "latest" means. Mounting this IS being a live view: it reads and writes the
 * artifact's server-side localStorage, which is why the pane must not mount it
 * while the same artifact is popped out (see ArtifactPane).
 */
export function useArtifactDoc(chatId: string, id: string, pinned: number | null) {
  const latestSeen = useArtifactView((s) => s.latest[artifactKey(chatId, id)] ?? 0);

  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [view, setView] = useState<View>("preview");
  const [reloadKey, setReloadKey] = useState(0);
  const [frameErrors, setFrameErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // Following "latest" means re-resolving whenever a newer version is seen
  // (transcript card, `artifact-updated`, or — in a pop-out — the app's relay);
  // a pinned version never changes. Either way the content comes through the
  // browser cache, so re-opening — or flipping back to a version already seen,
  // or popping out what the pane just showed — downloads nothing.
  const fetchKey = pinned ?? `latest@${latestSeen}`;
  useEffect(() => {
    let live = true;
    setLoaded((prev) => (prev.state === "ok" && prev.data.meta.id === id ? prev : { state: "loading" }));
    loadArtifact(chatId, id, pinned ?? null)
      .then(({ data, head }) => live && setLoaded({ state: "ok", data, head }))
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 410) {
          const at = (err.detail as { expiredAt?: number } | undefined)?.expiredAt;
          setLoaded({ state: "expired", ...(typeof at === "number" ? { expiredAt: at } : {}) });
        } else {
          setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      live = false;
    };
  }, [chatId, id, pinned, fetchKey]);

  const data = loaded.state === "ok" ? loaded.data : null;
  const shownVersion = data?.version;
  const storage = useArtifactStorage(chatId, id);
  const type = data?.meta.type;
  const head = loaded.state === "ok" ? loaded.head : null;
  const htmlAssets = type === "html" ? data?.assets : undefined;
  // Write the bundle back to the cache only when the server told us whose it is
  // and until when — and only when it fits: caching the tail of a bundle bigger
  // than the budget would evict its own head.
  const cacheOwner =
    head && bundleFitsCache(head.projectId, htmlAssets)
      ? { projectId: head.projectId, expiresAt: head.expiresAt }
      : null;
  const bundle = useArtifactAssets(chatId, htmlAssets, cacheOwner);

  // The errors on screen are the ones the server already knew for this
  // version plus what the frame reports now — reset whenever the version or
  // the render changes, since a reload is a new chance to throw.
  useEffect(() => {
    setFrameErrors(data?.errors ?? []);
  }, [data, reloadKey]);

  // Batch the frame's reports to the server, so `artifact_read` can tell the
  // agent its page threw. Deduped per version: an error in an animation loop
  // fires sixty times a second and is one fact.
  //
  // Two dedupes, with different lifetimes. What the BANNER shows resets with
  // every render (the effect above), so an error that comes back after Reload
  // is shown again. What has been POSTED lives for the version: the server
  // already has it, and resending it on every reload says nothing new.
  const pending = useRef<string[]>([]);
  const posted = useRef<{ key: string; seen: Set<string> }>({ key: "", seen: new Set() });
  const flushTimer = useRef<number | undefined>(undefined);
  const onFrameError = useCallback(
    (message: string) => {
      if (shownVersion === undefined) return;
      setFrameErrors((prev) => (prev.includes(message) ? prev : [...prev, message]));
      const key = `${chatId}:${id}:${shownVersion}`;
      if (posted.current.key !== key) posted.current = { key, seen: new Set() };
      if (posted.current.seen.has(message)) return;
      posted.current.seen.add(message);
      pending.current.push(message);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(() => {
        const batch = pending.current.splice(0);
        if (batch.length) void api.chats.artifactErrors(chatId, id, shownVersion, batch).catch(() => {});
      }, ERROR_FLUSH_MS);
    },
    [chatId, id, shownVersion],
  );
  useEffect(() => () => window.clearTimeout(flushTimer.current), []);

  const previewable = type ? PREVIEWABLE.has(type) : false;
  const effectiveView: View = previewable ? view : "source";
  const newest = data ? latestArtifactVersion(data.meta) : 0;

  const copy = async () => {
    if (!data) return;
    if (await copyToClipboard(data.content)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const download = () => {
    if (!data) return;
    // `application/octet-stream`, not text/html: the blob URL belongs to THIS
    // origin, and a browser that decided to navigate to an html blob instead of
    // saving it would run the artifact unsandboxed, same-origin.
    const blob = new Blob([data.content], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(data.meta.title)}-v${data.version}.${extensionOf(data.meta.type, data.meta.language)}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return {
    chatId,
    id,
    loaded,
    data,
    type,
    storage,
    bundle,
    frameErrors,
    onFrameError,
    previewable,
    view: effectiveView,
    setView,
    reloadKey,
    reload: () => setReloadKey((k) => k + 1),
    newest,
    copied,
    copy,
    download,
  };
}

export type ArtifactDoc = ReturnType<typeof useArtifactDoc>;

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artifact";
}

function extensionOf(type: ArtifactType, language?: string): string {
  if (type === "markdown") return "md";
  if (type === "code") return (language ?? "txt").toLowerCase().replace(/[^a-z0-9]/g, "") || "txt";
  return type;
}
