import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Chat, ChatStatus, AgentActivity } from "@cm/shared";
import { clearDraft } from "../lib/composerDrafts.js";

interface ChatsStore {
  /** chatId → Chat */
  byId: Record<string, Chat>;
  /** display order (most-recent activity first is applied at hydrate time) */
  order: string[];
  activeChatId: string | null;
  /** derived live activity per chat (from chat-status events) */
  activity: Record<string, AgentActivity | undefined>;
  /** steering messages submitted but not yet consumed, per chat (server truth) */
  queued: Record<string, number>;
  /**
   * chatId → a `watch_pr` on this chat reached a terminal PR state (merged/closed)
   * and hasn't been superseded by a new message. Combined with an `idle` status it
   * renders the sidebar dot green ("PR done") instead of the neutral idle gray.
   */
  prSettled: Record<string, boolean>;
  /**
   * chatId → epoch-ms of last observed activity (message/chunk/status/update).
   * Drives the sidebar's recency order + its "age" label. Seeded from the
   * server's `updatedAt`/`createdAt` at hydrate, then advanced by live events —
   * so a chat floats to the top the instant it starts streaming.
   */
  lastActivity: Record<string, number>;

  setActiveChat: (id: string) => void;
  hydrate: (chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
  /** Advance a chat's last-activity clock (coalesced so bursty chunks don't churn). */
  bumpActivity: (chatId: string, ts?: number) => void;
  /** Drop a deleted chat; if it was active, reselect a sibling (same project first). */
  removeChat: (chatId: string) => void;
  setStatus: (
    chatId: string,
    status: ChatStatus,
    activity?: AgentActivity,
    queued?: number,
    prSettled?: boolean,
  ) => void;
}

export const useChats = create<ChatsStore>((set) => ({
  byId: {},
  order: [],
  activeChatId: null,
  activity: {},
  queued: {},
  prSettled: {},
  lastActivity: {},

  setActiveChat: (id) => set({ activeChatId: id }),

  hydrate: (chats) => {
    const byId: Record<string, Chat> = {};
    const lastActivity: Record<string, number> = {};
    for (const c of chats) {
      byId[c.id] = c;
      lastActivity[c.id] = c.updatedAt ?? c.createdAt;
    }
    const order = [...chats]
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
      .map((c) => c.id);
    set({ byId, order, lastActivity, activeChatId: order[0] ?? null });
  },

  upsertChat: (chat) =>
    set((s) => ({
      byId: { ...s.byId, [chat.id]: chat },
      order: s.order.includes(chat.id) ? s.order : [chat.id, ...s.order],
      lastActivity: {
        ...s.lastActivity,
        [chat.id]: Math.max(
          s.lastActivity[chat.id] ?? 0,
          chat.updatedAt ?? chat.createdAt,
        ),
      },
    })),

  bumpActivity: (chatId, ts) =>
    set((s) => {
      const now = ts ?? Date.now();
      const prev = s.lastActivity[chatId] ?? 0;
      // Coalesce bursty chunk activity into ~1 update/sec so streaming doesn't
      // thrash the sidebar's recency sort.
      if (now - prev < 750) return {};
      return { lastActivity: { ...s.lastActivity, [chatId]: Math.max(prev, now) } };
    }),

  removeChat: (chatId) => {
    // The chat's assets are gone with it, so its saved composer draft (which
    // references them) has to go too — otherwise it lingers in localStorage
    // until the age sweep.
    clearDraft(chatId);
    set((s) => {
      if (!s.byId[chatId]) return {};
      const removed = s.byId[chatId];
      const byId = { ...s.byId };
      delete byId[chatId];
      const activity = { ...s.activity };
      delete activity[chatId];
      const queued = { ...s.queued };
      delete queued[chatId];
      const prSettled = { ...s.prSettled };
      delete prSettled[chatId];
      const lastActivity = { ...s.lastActivity };
      delete lastActivity[chatId];
      const order = s.order.filter((id) => id !== chatId);
      // Keep a selection alive: prefer another chat in the same project, else any
      // remaining chat, else nothing.
      const activeChatId =
        s.activeChatId === chatId
          ? (order.find((id) => byId[id]?.projectId === removed.projectId) ??
             order[0] ??
             null)
          : s.activeChatId;
      return { byId, order, activity, queued, prSettled, lastActivity, activeChatId };
    });
  },

  setStatus: (chatId, status, activity, queued, prSettled) =>
    set((s) => ({
      byId: s.byId[chatId]
        ? { ...s.byId, [chatId]: { ...s.byId[chatId]!, status } }
        : s.byId,
      activity: { ...s.activity, [chatId]: activity },
      queued: { ...s.queued, [chatId]: queued ?? 0 },
      prSettled: { ...s.prSettled, [chatId]: prSettled ?? false },
    })),
}));

/** Selector: chats for a project, ordered by most-recent activity first. */
export function useProjectChats(projectId: string | null): Chat[] {
  return useChats(
    useShallow((s) => {
      const at = (c: Chat) => s.lastActivity[c.id] ?? c.updatedAt ?? c.createdAt;
      return s.order
        .map((id) => s.byId[id]!)
        .filter((c): c is Chat => !!c && (!projectId || c.projectId === projectId))
        .sort((a, b) => at(b) - at(a));
    }),
  );
}
