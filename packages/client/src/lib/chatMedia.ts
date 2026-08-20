import { useEffect, useMemo, useState } from "react";
import { collectChatMedia, type ChatMediaItem } from "@dispatch/shared";
import { useChatMessages } from "../stores/messages.js";
import { api } from "./api.js";

/**
 * The chat's gallery — every image in the WHOLE chat, not just the loaded part.
 *
 * WHY THIS FETCHES: the transcript is a 150-row window
 * (`TRANSCRIPT_PAGE_SIZE`), and a real session runs to hundreds of rows. Deriving
 * the gallery from the loaded rows meant a chat with eleven screenshots offered
 * five of them, said "1/5", and let ← / → walk only the recent tail — the
 * viewer confidently reporting a total that was an artifact of how far you
 * happened to have scrolled. Anything long enough to matter was affected, which
 * is most chats.
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

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.chats
      .media(chatId)
      .then((items) => {
        if (live) setFetched(items);
      })
      .catch(() => {
        // Fall back to the window. A gallery short by a few images is far
        // better than a viewer that refuses to open.
        if (live) setFetched(null);
      });
    return () => {
      live = false;
    };
  }, [chatId, enabled]);

  // Recomputed only when the transcript changes, and only while we have no
  // server answer — once fetched, the window is irrelevant.
  const fromWindow = useMemo(
    () => (fetched ? [] : collectChatMedia(rows)),
    [rows, fetched],
  );
  return fetched ?? fromWindow;
}

export { indexOfAsset, labelForAsset, type ChatMediaItem } from "@dispatch/shared";
