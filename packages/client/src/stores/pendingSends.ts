/**
 * Messages the composer has sent that the server has not confirmed yet — the
 * "ghost" rows drawn at the foot of the transcript the instant Send is pressed.
 *
 * Why this exists: a send is a WebSocket frame with no reply, and the user row
 * only appears once the server has woken the session, surfaced memory and
 * written the row. On a cold chat that is seconds of an empty transcript after
 * the composer has already cleared — it reads as "my message vanished".
 *
 * This is TRANSPORT state ("the server hasn't got it"), deliberately separate
 * from the broker's agent queue (`useChats().pending`/`queued`, "the server has
 * it and the agent is busy"). A ghost lives only until the server answers for
 * it, and every way it can answer is matched on the `clientId` the send
 * carried, never on text — two identical "yes"es sent back to back are two
 * messages, not one:
 *
 *   - the user row arrives stamped with that `clientId` → the ghost goes and
 *     the real row takes its place at the same spot (both are the last thing in
 *     the transcript, so nothing jumps);
 *   - a `send-ack` arrives with no error → gone; this covers the send that was
 *     parked behind a live turn and wrote no row (it is the composer's
 *     "waiting" chip now, exactly as before this existed);
 *   - a `send-ack` arrives WITH an error → `failed`, with Retry / Edit;
 *   - the socket dies after the frame went out but before either answer →
 *     `failed` too. The server may or may not have it; a later row or a
 *     transcript resync carrying the `clientId` still clears it, and a Retry of
 *     a send the server already took is dropped server-side on the same id.
 */
import { create } from "zustand";
import type { ChatMessage, Effort, ImageRef, SendMode } from "@dispatch/shared";

export interface PendingSend {
  clientId: string;
  chatId: string;
  text?: string;
  images?: ImageRef[];
  effort?: Effort;
  sendMode?: SendMode;
  /** When Send was pressed — the ghost's clock. */
  ts: number;
  state: "sending" | "failed";
  /** Why it failed, for the row's tooltip. */
  error?: string;
  /**
   * The socket generation the frame was actually written to, or undefined
   * while it waits in the ws outbox. Only a frame that WENT OUT on a socket
   * that then died is in doubt — one still in the outbox is simply sent on the
   * next connection.
   */
  epoch?: number;
}

/** A failed ghost handed back to the composer (its Edit button). */
export interface ComposerRestore {
  chatId: string;
  text?: string;
  images?: ImageRef[];
  /** Distinguishes two restores of identical text. */
  nonce: number;
}

interface PendingSendsStore {
  /** chatId → ghosts, in send order. */
  byChat: Record<string, PendingSend[]>;
  restore: ComposerRestore | null;
  add: (send: PendingSend) => void;
  /** The server answered for it — row or clean ack. Drops the ghost. */
  settle: (chatId: string, clientId: string) => void;
  fail: (chatId: string, clientId: string, error: string) => void;
  /** Back to `sending` for a Retry; it waits in the outbox until `sentOn`. */
  resend: (chatId: string, clientId: string, epoch: number | undefined) => void;
  /** Its frame was written to socket `epoch` (a no-op once it has settled). */
  sentOn: (chatId: string, clientId: string, epoch: number) => void;
  /** Drop every ghost a fetched transcript already contains. */
  reconcile: (chatId: string, rows: readonly ChatMessage[]) => void;
  /** The outbox flushed on socket `epoch`: stamp everything that was waiting. */
  flushed: (epoch: number) => void;
  /** Socket `epoch` died: what went out on it and is unanswered is in doubt. */
  lost: (epoch: number) => void;
  /** Remove a failed ghost and hand its content back to that chat's composer. */
  restoreToComposer: (chatId: string, clientId: string) => void;
  clearRestore: (nonce: number) => void;
}

const LOST =
  "The connection dropped before the server confirmed this message. It may not have arrived.";

let restoreSeq = 0;

function mapChat(
  byChat: Record<string, PendingSend[]>,
  chatId: string,
  fn: (list: PendingSend[]) => PendingSend[],
): Record<string, PendingSend[]> {
  const list = byChat[chatId];
  if (!list) return byChat;
  const next = fn(list);
  if (next === list) return byChat;
  const out = { ...byChat };
  if (next.length) out[chatId] = next;
  else delete out[chatId];
  return out;
}

/** Map every chat's ghosts, keeping identity when nothing changed. */
function mapAll(
  byChat: Record<string, PendingSend[]>,
  fn: (send: PendingSend) => PendingSend,
): Record<string, PendingSend[]> {
  let changed = false;
  const out: Record<string, PendingSend[]> = {};
  for (const [chatId, list] of Object.entries(byChat)) {
    let listChanged = false;
    const next = list.map((s) => {
      const n = fn(s);
      if (n !== s) listChanged = true;
      return n;
    });
    out[chatId] = listChanged ? next : list;
    if (listChanged) changed = true;
  }
  return changed ? out : byChat;
}

export const usePendingSends = create<PendingSendsStore>((set, get) => ({
  byChat: {},
  restore: null,

  add: (send) =>
    set((s) => ({ byChat: { ...s.byChat, [send.chatId]: [...(s.byChat[send.chatId] ?? []), send] } })),

  settle: (chatId, clientId) =>
    set((s) => {
      const byChat = mapChat(s.byChat, chatId, (list) =>
        list.some((p) => p.clientId === clientId) ? list.filter((p) => p.clientId !== clientId) : list,
      );
      return byChat === s.byChat ? s : { byChat };
    }),

  fail: (chatId, clientId, error) =>
    set((s) => {
      const byChat = mapChat(s.byChat, chatId, (list) =>
        list.map((p) => (p.clientId === clientId ? { ...p, state: "failed" as const, error } : p)),
      );
      return { byChat };
    }),

  resend: (chatId, clientId, epoch) =>
    set((s) => ({
      byChat: mapChat(s.byChat, chatId, (list) =>
        list.map((p) =>
          p.clientId === clientId ? { ...p, state: "sending" as const, error: undefined, epoch } : p,
        ),
      ),
    })),

  sentOn: (chatId, clientId, epoch) =>
    set((s) => ({
      byChat: mapChat(s.byChat, chatId, (list) =>
        list.map((p) =>
          p.clientId === clientId && p.state === "sending" ? { ...p, epoch } : p,
        ),
      ),
    })),

  reconcile: (chatId, rows) => {
    const list = get().byChat[chatId];
    if (!list) return;
    const seen = new Set<string>();
    for (const r of rows) if (r.kind === "user" && r.clientId) seen.add(r.clientId);
    if (!seen.size) return;
    set((s) => ({
      byChat: mapChat(s.byChat, chatId, (l) =>
        l.some((p) => seen.has(p.clientId)) ? l.filter((p) => !seen.has(p.clientId)) : l,
      ),
    }));
  },

  flushed: (epoch) =>
    set((s) => ({
      byChat: mapAll(s.byChat, (p) =>
        p.state === "sending" && p.epoch === undefined ? { ...p, epoch } : p,
      ),
    })),

  lost: (epoch) =>
    set((s) => ({
      byChat: mapAll(s.byChat, (p) =>
        p.state === "sending" && p.epoch === epoch ? { ...p, state: "failed", error: LOST } : p,
      ),
    })),

  restoreToComposer: (chatId, clientId) => {
    const ghost = get().byChat[chatId]?.find((p) => p.clientId === clientId);
    if (!ghost) return;
    set((s) => ({
      byChat: mapChat(s.byChat, chatId, (l) => l.filter((p) => p.clientId !== clientId)),
      restore: { chatId, text: ghost.text, images: ghost.images, nonce: ++restoreSeq },
    }));
  },

  clearRestore: (nonce) => set((s) => (s.restore?.nonce === nonce ? { restore: null } : s)),
}));

const EMPTY: PendingSend[] = [];

/** One chat's ghosts, stable when it has none. */
export function useChatPendingSends(chatId: string): PendingSend[] {
  return usePendingSends((s) => s.byChat[chatId] ?? EMPTY);
}

/** A fresh id for one send. Not a secret — only has to not collide. */
export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
