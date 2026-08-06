/**
 * Per-chat composer drafts — the unsent text AND its image attachments.
 *
 * Backed by localStorage rather than a module-level Map, so a draft survives a
 * reload / crashed tab and not just a chat switch. Attachments persist as
 * `ImageRef`s only: the bytes already live under the chat's `assets/` dir the
 * moment they're uploaded, so a rehydrated draft points at the same files the
 * send would have used — nothing is re-uploaded.
 *
 * Writes are coalesced (`WRITE_DELAY_MS`) because `onUpdate` fires per keystroke,
 * and flushed on `pagehide` so the last few characters before a reload aren't the
 * ones that get lost. Every storage access is guarded: localStorage throws when
 * cookies are blocked, and doesn't exist at all in the node test environment.
 */
import type { ImageRef } from "@dispatch/shared";

export interface ComposerDraft {
  /** The editor's HTML — TipTap round-trips it verbatim via `setContent`. */
  html: string;
  /** Already-uploaded attachments, by reference. */
  images: ImageRef[];
}

const PREFIX = "cm:draft:";
/** Drafts untouched for this long are swept — a deleted chat leaves its key behind. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Coalesce a burst of keystrokes into a single write. */
const WRITE_DELAY_MS = 250;

const EMPTY: ComposerDraft = { html: "", images: [] };

/** Drafts written but not yet flushed — reads must see them, or a fast chat
    switch would rehydrate the previous (already-stale) stored value. */
const pending = new Map<string, ComposerDraft>();
let timer: ReturnType<typeof setTimeout> | undefined;

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

const keyOf = (chatId: string) => `${PREFIX}${chatId}`;

/** TipTap serializes an empty document as `<p></p>` — that's "no draft", not text. */
const BLANK_HTML = /^(<p>(\s|<br\s*\/?>|&nbsp;)*<\/p>\s*)*$/i;

const isEmpty = (d: ComposerDraft) => BLANK_HTML.test(d.html.trim()) && d.images.length === 0;

/** Tolerant parse — a hand-edited or older-shaped entry reads as "no draft". */
function parse(raw: string | null): ComposerDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { html?: unknown; images?: unknown; at?: unknown };
    const html = typeof v.html === "string" ? v.html : "";
    const images = Array.isArray(v.images)
      ? (v.images.filter(
          (i) =>
            !!i &&
            typeof i === "object" &&
            typeof (i as ImageRef).id === "string" &&
            typeof (i as ImageRef).path === "string",
        ) as ImageRef[])
      : [];
    if (typeof v.at === "number" && Date.now() - v.at > MAX_AGE_MS) return null;
    return html || images.length ? { html, images } : null;
  } catch {
    return null;
  }
}

function write(chatId: string, draft: ComposerDraft): void {
  const store = backing();
  if (!store) return;
  try {
    if (isEmpty(draft)) store.removeItem(keyOf(chatId));
    else store.setItem(keyOf(chatId), JSON.stringify({ ...draft, at: Date.now() }));
  } catch {
    /* quota / private mode — a lost draft beats a thrown save */
  }
}

/** Write every queued draft now. Called on `pagehide` and before any read path
    that would otherwise race a pending write. */
export function flushDrafts(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  for (const [chatId, draft] of pending) write(chatId, draft);
  pending.clear();
}

/** The saved draft for a chat, or an empty one. */
export function loadDraft(chatId: string): ComposerDraft {
  const queued = pending.get(chatId);
  if (queued) return queued;
  return parse(backing()?.getItem(keyOf(chatId)) ?? null) ?? EMPTY;
}

/** Queue a draft save. An empty draft (no text, no images) removes the entry. */
export function saveDraft(chatId: string, draft: ComposerDraft): void {
  if (isEmpty(draft)) {
    clearDraft(chatId);
    return;
  }
  pending.set(chatId, draft);
  if (!timer) timer = setTimeout(flushDrafts, WRITE_DELAY_MS);
}

/** Drop a draft outright — on send, and when its chat is deleted. */
export function clearDraft(chatId: string): void {
  pending.delete(chatId);
  const store = backing();
  try {
    store?.removeItem(keyOf(chatId));
  } catch {
    /* ignore */
  }
}

/**
 * Append an attachment to a chat's stored draft without touching live state —
 * for an upload that lands after the user has already switched away, so the
 * image is waiting in the composer when they switch back.
 */
export function appendDraftImage(chatId: string, image: ImageRef): void {
  const cur = loadDraft(chatId);
  saveDraft(chatId, { ...cur, images: [...cur.images, image] });
}

/** Sweep expired entries. Cheap (a handful of keys) and runs once, at import. */
export function pruneDrafts(): void {
  const store = backing();
  if (!store) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      if (!parse(store.getItem(key))) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    /* ignore */
  }
}

pruneDrafts();

if (typeof globalThis.addEventListener === "function") {
  // `pagehide` (not `beforeunload`) so bfcache navigations and mobile tab
  // eviction flush too.
  globalThis.addEventListener("pagehide", flushDrafts);
}
