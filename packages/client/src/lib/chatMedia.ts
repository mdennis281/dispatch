import { useEffect, useMemo, useRef, useState } from "react";
import { collectChatMedia, type ChatMediaItem } from "@dispatch/shared";
import { useChatMessages } from "../stores/messages.js";
import { api } from "./api.js";

/**
 * The chat's gallery — every image in the WHOLE chat, not just the loaded part.
 *
 * WHY THIS FETCHES: the transcript is a 150-row window
 * (`TRANSCRIPT_PAGE_SIZE`), and a real session runs to hundreds of rows. Deriving
 * the gallery from the loaded rows meant a chat with eleven screenshots offered
 * five, said "1/5", and let ← / → walk only the recent tail — the viewer
 * confidently reporting a total that was an artifact of how far you happened to
 * have scrolled. Anything long enough to matter was affected, which is most
 * chats.
 *
 * It is fetched LAZILY — `enabled` is false until something actually opens the
 * viewer. That keeps a whole-transcript scan off the render path, where the
 * previous version ran a full walk of every loaded row inside every media row's
 * `useMemo`, on every render.
 *
 * The loaded window is the fallback while the request is in flight, so a click
 * always opens on something immediately.
 */
export function useChatMedia(chatId: string, enabled: boolean): ChatMediaItem[] {
  const rows = useChatMessages(chatId);
  const [fetched, setFetched] = useState<ChatMediaItem[] | null>(null);

  /**
   * What the cached answer describes: which chat, and how far the transcript
   * had got when we asked.
   *
   * `enabled` goes false→true on EVERY open, so without a watermark this
   * re-requested a whole-transcript walk each time the viewer was opened. But
   * caching on `chatId` alone is wrong in the other direction — a screenshot
   * taken after the first open would never join the gallery. The id of the
   * newest row is a cheap, exact "has anything happened since" signal.
   */
  const cached = useRef<{ chatId: string; lastRowId: string } | null>(null);
  const lastRowId = rows.length ? (rows[rows.length - 1]?.id ?? "") : "";

  useEffect(() => {
    if (!enabled) return;
    const fresh =
      cached.current?.chatId === chatId && cached.current.lastRowId === lastRowId;
    if (fresh) return;

    let live = true;
    void api.chats
      .media(chatId)
      .then((items) => {
        if (!live) return;
        cached.current = { chatId, lastRowId };
        setFetched(items);
      })
      .catch(() => {
        // Fall back to the window. A gallery short by a few images is far
        // better than a viewer that refuses to open. Not cached, so the next
        // open retries rather than inheriting the failure.
        if (live) setFetched(null);
      });
    return () => {
      live = false;
    };
  }, [chatId, enabled, lastRowId]);

  // Recomputed only when the transcript changes, and only while we have no
  // server answer — once fetched, the window is irrelevant.
  const fromWindow = useMemo(
    () => (fetched ? [] : collectChatMedia(rows)),
    [rows, fetched],
  );
  return fetched ?? fromWindow;
}

export { indexOfAsset, labelForAsset, type ChatMediaItem } from "@dispatch/shared";
