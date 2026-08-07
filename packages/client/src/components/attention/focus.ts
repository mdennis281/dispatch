/**
 * Attention → transcript focus: selecting an item in the global Attention Queue
 * jumps to its chat AND scrolls the pending card into view (with a brief flash).
 *
 * The pending permission / question cards tag their root box with
 * `id={attentionCardId(requestId)}`; switching chats lazy-loads that chat's
 * transcript, so we retry the lookup for a short window until the card mounts,
 * then smooth-scroll + flash it. Items without a request id (idle / done /
 * free-form) simply settle the transcript at its latest message.
 */
import type { AttentionItem } from "@dispatch/shared";
import { useChats } from "../../stores/chats.js";

const RETRIES = 12;
const INTERVAL_MS = 150;
const FLASH_MS = 1500;
/** Ring classes toggled on the focused card — kept as literals so Tailwind v4 emits them. */
const FLASH_CLASSES = ["ring-2", "ring-warn/70", "transition-shadow"];

/** Stable DOM id a pending permission/question card puts on its root box. */
export function attentionCardId(requestId: string): string {
  return `attn-card-${requestId}`;
}

function scrollTranscriptToBottom(): void {
  const el = document.querySelector<HTMLElement>("[data-transcript]");
  if (el) el.scrollTop = el.scrollHeight;
}

function flash(el: HTMLElement): void {
  el.classList.add(...FLASH_CLASSES);
  window.setTimeout(() => el.classList.remove(...FLASH_CLASSES), FLASH_MS);
}

function scrollToCard(id: string, triesLeft: number): void {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    flash(el);
    return;
  }
  if (triesLeft <= 0) {
    scrollTranscriptToBottom();
    return;
  }
  window.setTimeout(() => scrollToCard(id, triesLeft - 1), INTERVAL_MS);
}

/**
 * Select a chat and bring its pending card into focus. Safe to call before the
 * transcript has loaded — the scroll retries until the card mounts.
 *
 * Takes the two fields rather than the item because a click on a *desktop
 * notification* arrives from the service worker as plain postMessage data, not
 * as a live `AttentionItem` (the item may even have been resolved by then).
 */
export function focusAttentionTarget(chatId: string, permissionRequestId?: string): void {
  useChats.getState().setActiveChat(chatId);
  if (!permissionRequestId) {
    window.setTimeout(scrollTranscriptToBottom, INTERVAL_MS);
    return;
  }
  window.requestAnimationFrame(() =>
    scrollToCard(attentionCardId(permissionRequestId), RETRIES),
  );
}

/** {@link focusAttentionTarget} for a live queue item. */
export function focusAttentionItem(item: AttentionItem): void {
  focusAttentionTarget(item.chatId, item.permissionRequestId);
}
