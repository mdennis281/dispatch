import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { ChatMessage, PermissionRequest, PermissionRow } from "@dispatch/shared";

/** Per-chat backward-paging state for the windowed transcript. */
export interface ChatPage {
  /**
   * There may be older rows above what we hold. Set when a page came back FULL
   * (exactly `limit` rows), cleared once a short/empty page proves we hit the top.
   */
  hasMore: boolean;
  /** An older page is in flight (drives the top spinner + dedupes concurrent loads). */
  loadingOlder: boolean;
}

const DEFAULT_PAGE: ChatPage = { hasMore: false, loadingOlder: false };

/**
 * Ceiling on how many rows a chat's window keeps once live rows start arriving.
 *
 * Opening a chat pulls a bounded page and paging up is capped, but `append` had
 * no ceiling at all: a chat left open while an agent works streams rows in all
 * session, so the window grew without bound and the "lazy" transcript ended up
 * holding the whole history anyway — hundreds of rows in the DOM and a scrollbar
 * to match. Trimming from the head puts the dropped rows back where every other
 * old row lives: on the server, one "load earlier" away.
 */
export const MAX_WINDOW_ROWS = 400;

/**
 * How far above the ceiling the window may drift before a trim runs. Without
 * the slack every single append would re-slice the array (and re-render the
 * whole list); with it a trim happens once per `TRIM_SLACK` rows.
 */
export const TRIM_SLACK = 100;

interface MessagesStore {
  /** chatId → ordered transcript rows (a WINDOW: the newest N, paged upward) */
  byChat: Record<string, ChatMessage[]>;
  /** chatId → backward-paging state for that window */
  pages: Record<string, ChatPage>;
  /** in-flight streaming buffers: `${chatId}:${messageId}` → partial text */
  streaming: Record<string, { text: string; thinking: string }>;

  hydrate: (byChat: Record<string, ChatMessage[]>) => void;
  /**
   * Drop every in-flight streaming buffer, for every chat, leaving transcripts
   * alone. A reconnect can't reconcile buffers it stopped receiving deltas for,
   * but the windows themselves are still good (see {@link setForChat}).
   */
  resetStreaming: () => void;
  /** Fold a REST snapshot (newest page) into one chat's window, in place. */
  setForChat: (chatId: string, messages: ChatMessage[], page?: Partial<ChatPage>) => void;
  /** Prepend an older page above the current window (backward paging). */
  prependForChat: (chatId: string, older: ChatMessage[], page?: Partial<ChatPage>) => void;
  /** Patch a chat's paging state (loading flags, top-reached). */
  setPage: (chatId: string, page: Partial<ChatPage>) => void;
  /**
   * Swap lean rows for their verbatim selves (hydrate-on-expand). Replaces by id,
   * in place, so an expanded card keeps its position and scroll offset.
   */
  replaceRows: (chatId: string, rows: ChatMessage[]) => void;
  /**
   * Drop cached transcripts for every chat except `keep`. Called on chat switch:
   * without it, a session that visits many chats accumulates every window it ever
   * loaded (79 chats × a page each) and never gives the memory back.
   */
  evictExcept: (keep: string[]) => void;
  /**
   * Drop the oldest rows of a chat's window back to {@link MAX_WINDOW_ROWS} and
   * flag `hasMore` (the dropped rows are still on the server). No-op until the
   * window has drifted a full `TRIM_SLACK` past the ceiling.
   *
   * The CALLER owns the "is this safe right now" question: trimming the head
   * moves everything below it, so it must only run when the reader is pinned to
   * the bottom (or isn't looking at this chat at all).
   */
  trimWindow: (chatId: string) => void;
  append: (chatId: string, message: ChatMessage) => void;
  /**
   * Synthesize (idempotently) a pending permission card from a live
   * `permission-request` event so the inline "needs approval" card shows the
   * instant a tool blocks — before the server persists the resolved row. The
   * server's resolved `permission` row later replaces it (deduped by requestId
   * in `append`).
   */
  upsertPermissionRequest: (chatId: string, request: PermissionRequest) => void;
  /** apply a token-level delta to an in-flight assistant/thinking row */
  chunk: (
    chatId: string,
    messageId: string,
    delta: string,
    channel: "text" | "thinking",
  ) => void;
  /** mark a pending permission row resolved (for the transcript) */
  resolvePermission: (chatId: string, requestId: string, decision: "allow" | "deny") => void;
  /**
   * Drop EVERY in-flight streaming buffer for a chat. Called when a turn ends /
   * is interrupted / errors (a `chat-status` leaving `running`), so a streamed
   * assistant message whose finalized `chat-message` never arrived can't strand a
   * perpetual typing pulse (a stuck `StreamingRow`) that resurfaces next turn.
   */
  clearStreaming: (chatId: string) => void;
}

type StreamMap = Record<string, { text: string; thinking: string }>;

/** Drop one `${chatId}:${messageId}` streaming buffer (no-op if absent). */
function dropStreamKey(streaming: StreamMap, key: string): StreamMap {
  if (!(key in streaming)) return streaming;
  const next = { ...streaming };
  delete next[key];
  return next;
}

/** Same rows, same objects, same order — i.e. a merge that changed nothing. */
function sameRows(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Drop every streaming buffer belonging to a chat (on transcript replace). */
function dropChatStreaming(streaming: StreamMap, chatId: string): StreamMap {
  const prefix = `${chatId}:`;
  const keys = Object.keys(streaming).filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return streaming;
  const next = { ...streaming };
  for (const k of keys) delete next[k];
  return next;
}

export const useMessages = create<MessagesStore>((set) => ({
  byChat: {},
  pages: {},
  streaming: {},

  // Wholesale reset (boot / reconnect): also drop every stale streaming buffer —
  // they key off transcripts that no longer exist and would otherwise leak.
  hydrate: (byChat) => set({ byChat, pages: {}, streaming: {} }),

  resetStreaming: () =>
    set((s) => (Object.keys(s.streaming).length === 0 ? {} : { streaming: {} })),

  setForChat: (chatId, messages, page) =>
    set((s) => {
      const prev = s.byChat[chatId] ?? [];
      const snapIds = new Set(messages.map((m) => m.id));
      const snapReqIds = new Set(
        messages.flatMap((m) => (m.kind === "permission" ? [m.requestId] : [])),
      );

      // Where does this snapshot begin inside the window we already hold?
      //
      // A reconnect re-reads the NEWEST page while the reader may be scrolled up
      // over older rows paged in earlier. Overwriting the window with just that
      // page threw those rows away and collapsed the transcript to ~zero height,
      // which is what reset the scroll position on every dropped socket. Splicing
      // the snapshot in at its first overlapping row keeps everything above it —
      // the same row objects, so the same DOM and the same scroll offset.
      let cut = -1;
      let from = 0;
      if (prev.length > 0) {
        const positions = new Map(prev.map((m, i) => [m.id, i] as const));
        for (let i = 0; i < messages.length; i++) {
          const at = positions.get(messages[i]!.id);
          if (at !== undefined) {
            cut = at;
            from = i;
            break;
          }
        }
      }

      // The snapshot is authoritative, but a live `chat-message` /
      // `permission-request` can land during the in-flight GET. Merge instead of
      // replacing so such a row is neither DROPPED (arrived after the server read
      // its snapshot) nor DUPLICATED (arrived before, already in the snapshot):
      //   - non-permission rows: keep prev rows whose id isn't in the snapshot.
      //   - permission rows are keyed by requestId (only persisted on resolve),
      //     so carry ANY prev card whose requestId is absent from the snapshot —
      //     pending (open) or just-resolved mid-load — keyed by requestId.
      // A row that raced the GET is necessarily NEWER than the newest row the
      // server had read. Requiring that is what keeps this from also resurrecting
      // a window that drifted off the end of the snapshot entirely (a compaction,
      // a chat re-read after a long outage): those rows are stale history, not
      // arrivals, and re-appending them below the fold is how you get a
      // transcript that reads in the wrong order.
      const newestSnapTs = messages.length > 0 ? messages[messages.length - 1]!.ts : -Infinity;
      const extra = (cut >= 0 ? prev.slice(cut) : prev).filter((m) =>
        m.kind === "permission"
          ? !snapReqIds.has(m.requestId)
          : !snapIds.has(m.id) && m.ts >= newestSnapTs,
      );

      // Reuse the row object we already hold for any id the snapshot repeats. It
      // carries client-side work the snapshot doesn't — a lean tool row the
      // reader expanded is hydrated in place (see `replaceRows`) and would
      // otherwise re-clip itself on every reconnect — and it lets the
      // no-op check below keep the array identity when nothing actually changed.
      const prevById = new Map(prev.map((m) => [m.id, m] as const));
      const head = cut >= 0 ? prev.slice(0, cut) : [];
      const tail = (cut >= 0 ? messages.slice(from) : messages).map(
        (m) => prevById.get(m.id) ?? m,
      );
      const next = [...head, ...tail, ...extra];

      // `hasMore` describes what's ABOVE the window. When the snapshot spliced
      // into rows we already hold, the caller's "the page came back full" answer
      // is about the SNAPSHOT — the older rows still sitting above it, and
      // whatever the last page-up learned about them, are unaffected.
      const prevPage = s.pages[chatId] ?? DEFAULT_PAGE;
      const nextPage: ChatPage = {
        ...DEFAULT_PAGE,
        ...(page ?? {}),
        ...(cut > 0 ? { hasMore: prevPage.hasMore } : {}),
      };

      return {
        // Identity-stable when the snapshot told us nothing new (the ordinary
        // reconnect): no new array means no transcript re-render at all.
        byChat: sameRows(prev, next) ? s.byChat : { ...s.byChat, [chatId]: next },
        pages: { ...s.pages, [chatId]: nextPage },
        streaming: dropChatStreaming(s.streaming, chatId),
      };
    }),

  prependForChat: (chatId, older, page) =>
    set((s) => {
      const prev = s.byChat[chatId] ?? [];
      // Guard against a double-fired page (two sentinel hits racing): only rows we
      // don't already hold go in, so a repeat request can't duplicate the window.
      const have = new Set(prev.map((m) => m.id));
      const fresh = older.filter((m) => !have.has(m.id));
      return {
        byChat: fresh.length
          ? { ...s.byChat, [chatId]: [...fresh, ...prev] }
          : s.byChat,
        pages: {
          ...s.pages,
          [chatId]: {
            ...(s.pages[chatId] ?? DEFAULT_PAGE),
            ...(page ?? {}),
          },
        },
      };
    }),

  setPage: (chatId, page) =>
    set((s) => ({
      pages: {
        ...s.pages,
        [chatId]: { ...(s.pages[chatId] ?? DEFAULT_PAGE), ...page },
      },
    })),

  replaceRows: (chatId, rows) =>
    set((s) => {
      const prev = s.byChat[chatId];
      if (!prev || rows.length === 0) return {};
      const byId = new Map(rows.map((r) => [r.id, r]));
      let changed = false;
      const next = prev.map((m) => {
        const full = byId.get(m.id);
        if (!full) return m;
        changed = true;
        return full;
      });
      return changed ? { byChat: { ...s.byChat, [chatId]: next } } : {};
    }),

  evictExcept: (keep) =>
    set((s) => {
      const keepSet = new Set(keep);
      const stale = Object.keys(s.byChat).filter((id) => !keepSet.has(id));
      if (stale.length === 0) return {};
      const byChat = { ...s.byChat };
      const pages = { ...s.pages };
      let streaming = s.streaming;
      for (const id of stale) {
        delete byChat[id];
        delete pages[id];
        // A dropped transcript's in-flight buffers key off rows that no longer
        // exist — they'd never be reconciled and would leak for the session.
        streaming = dropChatStreaming(streaming, id);
      }
      return { byChat, pages, streaming };
    }),

  trimWindow: (chatId) =>
    set((s) => {
      const rows = s.byChat[chatId];
      if (!rows || rows.length <= MAX_WINDOW_ROWS + TRIM_SLACK) return {};
      return {
        byChat: {
          ...s.byChat,
          [chatId]: rows.slice(rows.length - MAX_WINDOW_ROWS),
        },
        // The rows just dropped are older history the server still holds, so the
        // "load earlier" affordance has to come back on — otherwise a trim would
        // silently make the transcript unpageable at the top.
        pages: {
          ...s.pages,
          [chatId]: { ...(s.pages[chatId] ?? DEFAULT_PAGE), hasMore: true },
        },
      };
    }),

  append: (chatId, message) =>
    set((s) => {
      const rows = s.byChat[chatId] ?? [];
      // A finalized row supersedes its in-flight streaming buffer — clear it so
      // `streaming` doesn't grow unbounded over a long session. A `result` row is
      // the TURN-END marker: clear EVERY of the chat's streaming buffers, so an
      // assistant message whose finalized row never landed (interrupt / abort /
      // mid-stream persist failure) can't leave a stuck StreamingRow behind.
      const streaming =
        message.kind === "result"
          ? dropChatStreaming(s.streaming, chatId)
          : dropStreamKey(s.streaming, `${chatId}:${message.id}`);
      // Permission rows are keyed by requestId, not id: a resolved row from the
      // server replaces the earlier pending card in place (keeping its position)
      // instead of stacking a duplicate.
      if (message.kind === "permission") {
        const idx = rows.findIndex(
          (r) => r.kind === "permission" && r.requestId === message.requestId,
        );
        if (idx >= 0) {
          const next = rows.slice();
          next[idx] = message;
          return { byChat: { ...s.byChat, [chatId]: next }, streaming };
        }
      }
      return { byChat: { ...s.byChat, [chatId]: [...rows, message] }, streaming };
    }),

  upsertPermissionRequest: (chatId, request) =>
    set((s) => {
      const rows = s.byChat[chatId] ?? [];
      // Already have a card for this request (pending or resolved)? Leave it be.
      if (rows.some((r) => r.kind === "permission" && r.requestId === request.id)) {
        return {};
      }
      const row: PermissionRow = {
        kind: "permission",
        id: `perm-${request.id}`,
        chatId,
        ts: request.createdAt ?? Date.now(),
        requestId: request.id,
        toolName: request.toolName,
        input: request.input,
        decision: "pending",
        displayName: request.displayName,
        title: request.title,
        description: request.description,
      };
      return { byChat: { ...s.byChat, [chatId]: [...rows, row] } };
    }),

  chunk: (chatId, messageId, delta, channel) =>
    set((s) => {
      const key = `${chatId}:${messageId}`;
      const cur = s.streaming[key] ?? { text: "", thinking: "" };
      return {
        streaming: {
          ...s.streaming,
          [key]: {
            text: channel === "text" ? cur.text + delta : cur.text,
            thinking: channel === "thinking" ? cur.thinking + delta : cur.thinking,
          },
        },
      };
    }),

  resolvePermission: (chatId, requestId, decision) =>
    set((s) => {
      const rows = s.byChat[chatId];
      if (!rows) return {};
      return {
        byChat: {
          ...s.byChat,
          [chatId]: rows.map((r) =>
            r.kind === "permission" && r.requestId === requestId
              ? { ...r, decision }
              : r,
          ),
        },
      };
    }),

  clearStreaming: (chatId) =>
    set((s) => {
      const streaming = dropChatStreaming(s.streaming, chatId);
      // Identity-stable when there was nothing to drop (no needless re-render).
      return streaming === s.streaming ? {} : { streaming };
    }),
}));

const EMPTY: ChatMessage[] = [];

/** Selector: transcript for a chat (stable empty ref when absent). */
export function useChatMessages(chatId: string | null): ChatMessage[] {
  return useMessages((s) => (chatId ? (s.byChat[chatId] ?? EMPTY) : EMPTY));
}

/** Selector: backward-paging state for a chat's window (stable default ref). */
export function useChatPage(chatId: string | null): ChatPage {
  return useMessages((s) => (chatId ? (s.pages[chatId] ?? DEFAULT_PAGE) : DEFAULT_PAGE));
}

/** An in-flight assistant turn assembled from `message-chunk` deltas. */
export interface StreamRow {
  messageId: string;
  text: string;
  thinking: string;
}

const NO_STREAMS: StreamRow[] = [];

/**
 * Selector: the live streaming rows for ONE chat.
 *
 * Subscribing to the whole `streaming` map is a trap — `chunk()` returns a new map
 * object per token FROM ANY CHAT, so a component reading it re-renders on every
 * token streamed anywhere in the app. This narrows to the chat's own buffers and
 * compares by content, so a background chat's stream can't touch this transcript.
 *
 * Rows already finalized as a persisted `chat-message` are filtered out (the real
 * row supersedes its buffer), as is everything when the turn isn't `running` — a
 * blocked turn's text already landed as an `assistant` row, and re-showing its
 * buffer strands a stuck ●●● pulse under a finished section.
 */
export function useStreamRows(chatId: string, running: boolean): StreamRow[] {
  return useStoreWithEqualityFn(
    useMessages,
    (s) => {
      if (!running) return NO_STREAMS;
      const prefix = `${chatId}:`;
      const rows: StreamRow[] = [];
      let finalized: Set<string> | null = null;
      for (const [key, buf] of Object.entries(s.streaming)) {
        if (!key.startsWith(prefix)) continue;
        if (!buf.text && !buf.thinking) continue;
        const messageId = key.slice(prefix.length);
        // Built lazily: most chats have no live buffers, so the transcript scan
        // shouldn't run at all on the common path.
        finalized ??= new Set((s.byChat[chatId] ?? EMPTY).map((m) => m.id));
        if (finalized.has(messageId)) continue;
        rows.push({ messageId, text: buf.text, thinking: buf.thinking });
      }
      return rows.length === 0 ? NO_STREAMS : rows;
    },
    // The selector rebuilds its array every call, so a content compare (not
    // Object.is) is what actually keeps an unrelated chat's tokens from
    // re-rendering this one.
    sameStreamRows,
  );
}

/** Content compare for stream rows (same ids, same buffered text). */
function sameStreamRows(a: StreamRow[], b: StreamRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.messageId !== y.messageId || x.text !== y.text || x.thinking !== y.thinking) {
      return false;
    }
  }
  return true;
}

/**
 * Selector: current context-window occupancy (tokens) for a chat, read from the
 * most recent `result` row's `contextTokens` (the last main-loop request's own
 * usage — NOT the session-cumulative total). Null until the first turn reports
 * it. Returns a scalar, so the subscriber only re-renders when the number
 * changes — not on every streamed chunk.
 */
export function useContextTokens(chatId: string | null): number | null {
  return useMessages((s) => {
    if (!chatId) return null;
    const rows = s.byChat[chatId];
    if (!rows) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.kind === "result") return r.contextTokens ?? null;
    }
    return null;
  });
}

/**
 * Selector: the model's context-window size (tokens) for a chat, read from the
 * most recent `result` row's `contextWindow` (the SDK's authoritative `maxTokens`
 * for the session's model — 1M for the Opus 1M variant, 200k otherwise). Null
 * until a turn reports it, so the meter can fall back to a sensible default.
 */
export function useContextWindow(chatId: string | null): number | null {
  return useMessages((s) => {
    if (!chatId) return null;
    const rows = s.byChat[chatId];
    if (!rows) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.kind === "result") return r.contextWindow ?? null;
    }
    return null;
  });
}
