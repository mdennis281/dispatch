import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaKind, type ArtifactMeta, type ChatMediaItem } from "@dispatch/shared";
import { api } from "./api.js";
import { useChatMessages } from "../stores/messages.js";
import { useArtifactView } from "../stores/artifacts.js";

/**
 * The chat's attachments — everything it has PRODUCED or been GIVEN that a
 * human would go back looking for, sorted into a few kinds.
 *
 * The kinds are a closed list on purpose. Each one is a section in the menu and
 * a segment in its filter, so adding one (links, diffs, recordings) is a new
 * key here plus a renderer there — not a new menu.
 */
export const ATTACHMENT_KINDS = ["artifacts", "images", "files"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface ChatAttachments {
  artifacts: ArtifactMeta[];
  /** Images AND video: the things you look at, so the things a grid suits. */
  images: ChatMediaItem[];
  /** Audio and plain files: the things you open by name, so a list suits. */
  files: ChatMediaItem[];
}

/**
 * Sort a chat's media and artifacts into the menu's kinds, NEWEST first.
 *
 * Newest first because the question this menu answers is almost always "the
 * thing it just made" — whereas the gallery (`collectChatMedia`) is transcript
 * order because ← / → have to mean earlier / later. The viewer is still handed
 * the gallery order; only the list is reversed.
 */
export function groupAttachments(
  artifacts: readonly ArtifactMeta[],
  media: readonly ChatMediaItem[],
): ChatAttachments {
  const images: ChatMediaItem[] = [];
  const files: ChatMediaItem[] = [];
  for (let i = media.length - 1; i >= 0; i--) {
    const item = media[i]!;
    const kind = mediaKind(item.asset.mimeType);
    (kind === "image" || kind === "video" ? images : files).push(item);
  }
  // The route already answers most-recently-edited first; sorted again here so
  // the menu doesn't silently depend on that, and so a list merged from two
  // fetches can't come back interleaved.
  const sorted = [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
  return { artifacts: sorted, images, files };
}

export function attachmentCount(a: ChatAttachments): number {
  return a.artifacts.length + a.images.length + a.files.length;
}

const EMPTY: ChatMediaItem[] = [];

interface Loaded {
  chatId: string;
  /** Undefined until that half has answered — `ready` waits for both. */
  media?: ChatMediaItem[];
  artifacts?: ArtifactMeta[];
}

/**
 * Fetches a chat's attachments for the header menu.
 *
 * Both lists are WHOLE-chat server answers, not derived from the loaded rows:
 * the transcript is a 150-row window, and a menu that only listed what you had
 * scrolled past would undercount every long chat — the same trap `useChatMedia`
 * documents for the viewer.
 *
 * When it fetches is the whole design:
 *
 * - **Once per chat**, on arrival, so the trigger's count is true before anyone
 *   clicks it. One transcript scan per chat opened.
 * - **Media again on `refresh()`** (the menu opening), but only if a row has
 *   landed since the last scan.
 *   Not on every row while the menu is shut: during a turn that would be a
 *   whole-transcript scan per streamed message, for a count nobody is reading.
 * - **Artifacts whenever one is created or bumped** — `useArtifactView.latest`
 *   already moves on every `artifact-updated` event, so a new page shows in the
 *   count the moment the agent publishes it. That list is a small JSON read.
 */
export function useChatAttachments(chatId: string) {
  const rows = useChatMessages(chatId);
  const lastRowId = rows.length ? (rows[rows.length - 1]?.id ?? "") : "";
  // A string, so the selector is equality-stable: zustand re-renders on a new
  // reference, and an object built here would be new every time.
  const artifactSig = useArtifactView((s) => {
    let sig = "";
    for (const key in s.latest) if (key.startsWith(`${chatId}:`)) sig += `${key}=${s.latest[key]};`;
    return sig;
  });

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const mediaMark = useRef<{ chatId: string; lastRowId: string } | null>(null);

  // Media: on arrival, then again only when asked AND a row has landed since.
  const lastRowRef = useRef(lastRowId);
  lastRowRef.current = lastRowId;
  const fetchMedia = useCallback(() => {
    const mark = { chatId, lastRowId: lastRowRef.current };
    mediaMark.current = mark;
    void api.chats
      .media(chatId)
      .then((media) => {
        // A newer request, or a chat switch, replaced the mark and retires
        // this answer.
        if (mediaMark.current !== mark) return;
        setLoaded((prev) => ({
          chatId,
          media,
          artifacts: prev?.chatId === chatId ? prev.artifacts : undefined,
        }));
      })
      .catch(() => {
        // Unmark so the next open retries. Keeping it made a failed first
        // scan permanent on an idle chat: `refresh()` saw a matching mark and
        // skipped, and the menu sat on "Loading…" until a new row landed.
        if (mediaMark.current === mark) mediaMark.current = null;
      });
  }, [chatId]);

  useEffect(() => {
    fetchMedia();
  }, [fetchMedia]);

  /** Call when the menu opens. Free when nothing has happened since the last scan. */
  const refresh = useCallback(() => {
    const mark = mediaMark.current;
    if (mark?.chatId === chatId && mark.lastRowId === lastRowRef.current) return;
    fetchMedia();
  }, [chatId, fetchMedia]);

  // Artifacts: on arrival, and whenever one is published or bumped.
  useEffect(() => {
    let live = true;
    void api.chats
      .artifacts(chatId)
      .then((artifacts) => {
        if (!live) return;
        setLoaded((prev) => ({
          chatId,
          artifacts,
          media: prev?.chatId === chatId ? prev.media : undefined,
        }));
      })
      // Settle to empty rather than leave `ready` waiting on an answer that
      // isn't coming; the next `artifact-updated` refetches anyway.
      .catch(() => {
        if (!live) return;
        setLoaded((prev) => ({
          chatId,
          artifacts: prev?.chatId === chatId ? (prev.artifacts ?? []) : [],
          media: prev?.chatId === chatId ? prev.media : undefined,
        }));
      });
    return () => {
      live = false;
    };
  }, [chatId, artifactSig]);

  const current = loaded?.chatId === chatId ? loaded : null;
  const groups = useMemo(
    () => groupAttachments(current?.artifacts ?? [], current?.media ?? []),
    [current],
  );
  return {
    /** False until the first answer for THIS chat — never another chat's list. */
    ready: !!current?.media && !!current.artifacts,
    /** The viewer's gallery: every image and file, in transcript order. */
    gallery: current?.media ?? EMPTY,
    groups,
    refresh,
  };
}
