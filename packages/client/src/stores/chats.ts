import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Chat, ChatStatus, AgentActivity } from "@cm/shared";

interface ChatsStore {
  /** chatId → Chat */
  byId: Record<string, Chat>;
  /** display order (most-recent activity first is applied at hydrate time) */
  order: string[];
  activeChatId: string | null;
  /** derived live activity per chat (from chat-status events) */
  activity: Record<string, AgentActivity | undefined>;

  setActiveChat: (id: string) => void;
  hydrate: (chats: Chat[]) => void;
  upsertChat: (chat: Chat) => void;
  /** Drop a deleted chat; if it was active, reselect a sibling (same project first). */
  removeChat: (chatId: string) => void;
  setStatus: (chatId: string, status: ChatStatus, activity?: AgentActivity) => void;
}

export const useChats = create<ChatsStore>((set) => ({
  byId: {},
  order: [],
  activeChatId: null,
  activity: {},

  setActiveChat: (id) => set({ activeChatId: id }),

  hydrate: (chats) => {
    const byId: Record<string, Chat> = {};
    for (const c of chats) byId[c.id] = c;
    const order = [...chats]
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
      .map((c) => c.id);
    set({ byId, order, activeChatId: order[0] ?? null });
  },

  upsertChat: (chat) =>
    set((s) => ({
      byId: { ...s.byId, [chat.id]: chat },
      order: s.order.includes(chat.id) ? s.order : [chat.id, ...s.order],
    })),

  removeChat: (chatId) =>
    set((s) => {
      if (!s.byId[chatId]) return {};
      const removed = s.byId[chatId];
      const byId = { ...s.byId };
      delete byId[chatId];
      const activity = { ...s.activity };
      delete activity[chatId];
      const order = s.order.filter((id) => id !== chatId);
      // Keep a selection alive: prefer another chat in the same project, else any
      // remaining chat, else nothing.
      const activeChatId =
        s.activeChatId === chatId
          ? (order.find((id) => byId[id]?.projectId === removed.projectId) ??
             order[0] ??
             null)
          : s.activeChatId;
      return { byId, order, activity, activeChatId };
    }),

  setStatus: (chatId, status, activity) =>
    set((s) => {
      const cur = s.byId[chatId];
      return {
        byId: cur ? { ...s.byId, [chatId]: { ...cur, status } } : s.byId,
        activity: { ...s.activity, [chatId]: activity },
      };
    }),
}));

/** Selector: chats for a project, in display order. */
export function useProjectChats(projectId: string | null): Chat[] {
  return useChats(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id]!)
        .filter((c): c is Chat => !!c && (!projectId || c.projectId === projectId)),
    ),
  );
}
