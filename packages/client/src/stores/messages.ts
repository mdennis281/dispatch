import { create } from "zustand";
import type { ChatMessage, PermissionRequest, PermissionRow } from "@cm/shared";

interface MessagesStore {
  /** chatId → ordered transcript rows */
  byChat: Record<string, ChatMessage[]>;
  /** in-flight streaming buffers: `${chatId}:${messageId}` → partial text */
  streaming: Record<string, { text: string; thinking: string }>;

  hydrate: (byChat: Record<string, ChatMessage[]>) => void;
  /** Replace one chat's transcript (REST snapshot on open) without touching others. */
  setForChat: (chatId: string, messages: ChatMessage[]) => void;
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
  streaming: {},

  // Wholesale reset (boot / reconnect): also drop every stale streaming buffer —
  // they key off transcripts that no longer exist and would otherwise leak.
  hydrate: (byChat) => set({ byChat, streaming: {} }),

  setForChat: (chatId, messages) =>
    set((s) => {
      // The REST snapshot is authoritative, but a live `chat-message` /
      // `permission-request` can land during the in-flight GET. Merge instead of
      // replacing so such a row is neither DROPPED (arrived after the server read
      // its snapshot) nor DUPLICATED (arrived before, already in the snapshot):
      //   - non-permission rows: keep prev rows whose id isn't in the snapshot.
      //   - permission rows are keyed by requestId (only persisted on resolve),
      //     so carry ANY prev card whose requestId is absent from the snapshot —
      //     pending (open) or just-resolved mid-load — keyed by requestId.
      const prev = s.byChat[chatId] ?? [];
      const snapIds = new Set(messages.map((m) => m.id));
      const snapReqIds = new Set(
        messages.flatMap((m) => (m.kind === "permission" ? [m.requestId] : [])),
      );
      const extra = prev.filter((m) =>
        m.kind === "permission"
          ? !snapReqIds.has(m.requestId)
          : !snapIds.has(m.id),
      );
      return {
        byChat: { ...s.byChat, [chatId]: [...messages, ...extra] },
        streaming: dropChatStreaming(s.streaming, chatId),
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
