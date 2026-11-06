import { useEffect, useRef, useState } from "react";
import { artifactAssetsBytes, isRewritableAssetType, type ArtifactAsset } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import type { ArtifactBootAsset } from "../../lib/artifactDoc.js";

/** Downloads at once. Enough to fill the pipe; few enough not to starve the transcript's own requests. */
const CONCURRENCY = 4;

export type ArtifactAssetsState =
  | { state: "none" }
  | { state: "loading"; loaded: number; total: number }
  | { state: "ready"; assets: ArtifactBootAsset[] }
  | { state: "error"; message: string };

/**
 * A version's asset bundle, downloaded and ready to post into the frame.
 *
 * Blobs are kept per hash for the life of the pane, so stepping between two
 * versions that share most of their textures fetches only what changed, and
 * Reload fetches nothing. (The route is `immutable` too, so a re-open after
 * closing the pane is served from the HTTP cache.)
 */
export function useArtifactAssets(
  chatId: string,
  manifest: Record<string, ArtifactAsset> | undefined,
): ArtifactAssetsState {
  const cache = useRef(new Map<string, Blob>());
  const [result, setResult] = useState<ArtifactAssetsState>({ state: "none" });
  // The manifest object is a fresh one on every refetch of the same version;
  // key the download on what it names, not on its identity.
  const key = manifest
    ? Object.entries(manifest)
        .map(([p, a]) => `${p}=${a.sha256}`)
        .sort()
        .join("|")
    : "";

  useEffect(() => {
    if (!manifest || !key) {
      setResult({ state: "none" });
      return;
    }
    const ctrl = new AbortController();
    const entries = Object.entries(manifest);
    const total = artifactAssetsBytes(manifest);
    let loaded = 0;
    let last = 0;
    const tick = () => {
      // A progress render per network chunk is thousands of renders for a big
      // bundle; ten a second reads the same.
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      setResult({ state: "loading", loaded, total });
    };
    setResult({ state: "loading", loaded: 0, total });

    const fetchOne = async (a: ArtifactAsset): Promise<Blob> => {
      const hit = cache.current.get(a.sha256);
      if (hit) {
        loaded += a.size;
        return hit;
      }
      const blob = await api.chats.artifactBlob(chatId, a.sha256, a.type, (n) => {
        loaded += n;
        tick();
      }, ctrl.signal);
      cache.current.set(a.sha256, blob);
      return blob;
    };

    (async () => {
      const out: ArtifactBootAsset[] = new Array(entries.length);
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const i = next++;
          const [path, a] = entries[i]!;
          const blob = await fetchOne(a);
          // The blob's type is the manifest's, whatever it was cached under:
          // one file can back a `.bin` here and a `.glb` there.
          out[i] = {
            path,
            type: a.type,
            blob: blob.type === a.type ? blob : blob.slice(0, blob.size, a.type),
            rewrite: isRewritableAssetType(a.type),
          };
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
      return out;
    })()
      .then((assets) => {
        if (!ctrl.signal.aborted) setResult({ state: "ready", assets });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setResult({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `manifest`
  }, [chatId, key]);

  return result;
}
