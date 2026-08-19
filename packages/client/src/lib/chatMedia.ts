import { useMemo } from "react";
import type { ChatMessage, ImageRef, ToolUseRow } from "@dispatch/shared";
import { useChatMessages } from "../stores/messages.js";
import { mergeImages, recoverResultMedia } from "./resultMedia.js";

/**
 * Every image in a chat, in transcript order — the gallery the viewer walks.
 *
 * WHY CHAT-WIDE AND NOT PER-ROW: opening a screenshot and pressing → should
 * take you to the next screenshot, not stop dead because that particular tool
 * call happened to return exactly one image. A conversation about a room full
 * of renders is ONE sequence of pictures to a human; that it arrived as eleven
 * separate `Read` calls is an implementation detail of how the agent works.
 *
 * Order is the transcript's own order, so "previous" means earlier in the
 * conversation — which is what the arrow keys are expected to mean.
 */

/** One image, plus where it came from and what to call it. */
export interface ChatMediaItem {
  asset: ImageRef;
  /** Row that produced it, so a caller can scroll the transcript to it. */
  rowId: string;
}

/**
 * A human-meaningful name for an image, given the tool call that produced it.
 *
 * Stored assets are content-addressed (`kEE0Q1yjaoffNb8tVDGmR.png`), which is
 * correct on disk and useless to read. The tool's own input still holds the
 * path the agent asked for, so a `Read` of `…/shots/buck-b2-understair.png`
 * gets captioned with that name instead of the nanoid.
 *
 * Derived at RENDER time rather than stored on the ref, because that also
 * repairs every transcript already written — the alternative only ever helps
 * images captured after the change.
 */
export function labelForAsset(asset: ImageRef, use?: ToolUseRow): string | undefined {
  if (asset.alt) return asset.alt;
  const input = (use?.input ?? {}) as Record<string, unknown>;
  const raw = [input.file_path, input.path, input.filename, input.notebook_path].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const name = raw?.split(/[\\/]/).pop();
  return name || undefined;
}

/**
 * Pull every renderable image out of one row, if it carries any.
 *
 * USER rows count. A pasted or dropped screenshot is an image in the chat by
 * any reading, and leaving it out meant clicking your own attachment opened the
 * viewer on some unrelated tool result — `indexOfAsset` could only answer 0 for
 * something it had never been told about.
 */
function imagesOn(row: ChatMessage): ImageRef[] {
  if (row.kind === "user") return row.images ?? [];
  if (row.kind !== "tool_result") return [];
  return mergeImages(row.images, recoverResultMedia(row.content).images);
}

/**
 * Build the chat's gallery.
 *
 * Deduped by `path`: the same screenshot re-read after an edit is one picture,
 * and a gallery that shows it four times makes → feel broken.
 */
export function collectChatMedia(rows: ChatMessage[]): ChatMediaItem[] {
  const uses = new Map<string, ToolUseRow>();
  for (const row of rows) {
    if (row.kind === "tool_use") uses.set(row.toolUseId, row);
  }

  const seen = new Set<string>();
  const out: ChatMediaItem[] = [];
  for (const row of rows) {
    for (const asset of imagesOn(row)) {
      if (seen.has(asset.path)) continue;
      seen.add(asset.path);
      const use = row.kind === "tool_result" ? uses.get(row.toolUseId) : undefined;
      const alt = labelForAsset(asset, use);
      out.push({ asset: alt ? { ...asset, alt } : asset, rowId: row.id });
    }
  }
  return out;
}

/** The chat's gallery, recomputed only when its transcript changes. */
export function useChatMedia(chatId: string): ChatMediaItem[] {
  const rows = useChatMessages(chatId);
  return useMemo(() => collectChatMedia(rows), [rows]);
}

/**
 * Where `path` sits in the gallery, or **-1** when it isn't there.
 *
 * Reporting absence honestly is the point. Coercing a miss to 0 opened the
 * viewer on a completely different picture — the first one in the chat —
 * whenever the clicked image wasn't a gallery member (a markdown embed and a
 * prose chip are neither tool results nor attachments). The caller decides what
 * to do about it; see `MediaGroup`, which falls back to its own row.
 */
export function indexOfAsset(items: ChatMediaItem[], path: string): number {
  return items.findIndex((item) => item.asset.path === path);
}
