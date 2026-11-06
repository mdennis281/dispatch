import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import type { ArtifactStorageWrite } from "./ArtifactFrame.js";

/** How long to gather a page's writes before sending them as one PATCH. */
const STORAGE_FLUSH_MS = 400;

interface Pending {
  clear?: true;
  set: Record<string, string | null>;
}

/**
 * One artifact's persisted `localStorage`, as the pane sees it.
 *
 * Three copies with three jobs:
 *  - the SERVER copy is the durable one;
 *  - `mirror` is what the next frame mount is seeded with — every write the
 *    page makes lands here at once, so Reload (or the agent cutting a new
 *    version) hands the page exactly what it last wrote, even if the PATCH
 *    carrying it is still in its debounce window;
 *  - `pending` is the not-yet-sent difference between the two.
 *
 * Writes are coalesced rather than sent one by one: a game that saves on every
 * frame would otherwise be sixty requests a second. A `clear` folds everything
 * before it away, which is also what the server does with it.
 *
 * `ready` is false until the first snapshot arrives. The pane holds the frame
 * until then — a page that boots against empty storage and only then learns
 * it had a save would start a new game over the old one.
 */
export function useArtifactStorage(chatId: string, id: string) {
  const [ready, setReady] = useState(false);
  const mirror = useRef<Record<string, string>>({});
  const pending = useRef<Pending | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** Which artifact `pending` belongs to — a flush after switching must still go to the old one. */
  const target = useRef({ chatId, id });

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const batch = pending.current;
    pending.current = null;
    if (!batch) return;
    const { chatId: c, id: a } = target.current;
    void api.chats.artifactStoragePatch(c, a, batch).catch((err: unknown) => {
      // The page's own shim enforces the quota, so a refusal here means the
      // artifact expired or the server is gone. Nothing for the page to do —
      // say so where a developer looking at a misbehaving save would look.
      console.warn(`[artifact ${a}] storage write not saved:`, err);
    });
  }, []);

  useEffect(() => {
    flush();
    target.current = { chatId, id };
    mirror.current = {};
    setReady(false);
    let live = true;
    api.chats
      .artifactStorage(chatId, id)
      .then((s) => {
        if (live) mirror.current = s.entries;
      })
      // An expired artifact, a server that can't answer: render with empty
      // storage rather than not at all. The page still runs; it just starts
      // from nothing, which is what a fresh browser profile would give it.
      .catch(() => {})
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [chatId, id, flush]);

  // Unmount and tab-close both send what is waiting; a debounce window must
  // never be the difference between a save and no save.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const onWrite = useCallback(
    (write: ArtifactStorageWrite) => {
      if (write.clear) mirror.current = {};
      for (const [k, v] of Object.entries(write.set)) {
        if (v === null) delete mirror.current[k];
        else mirror.current[k] = v;
      }
      pending.current =
        write.clear || !pending.current
          ? { ...(write.clear ? { clear: true as const } : {}), set: { ...write.set } }
          : { ...pending.current, set: { ...pending.current.set, ...write.set } };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, STORAGE_FLUSH_MS);
    },
    [flush],
  );

  return { ready, mirror, onWrite };
}
