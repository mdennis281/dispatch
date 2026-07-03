import { create } from "zustand";

/**
 * Rollback anchors: which message ids have a per-turn git-shadow checkpoint, so
 * the chat can offer "Roll back here" only where a restore point actually exists.
 * Fed by the `checkpoint` WS event + the REST snapshot loaded with a chat.
 */
interface CheckpointsStore {
  /** chatId → set of messageIds that have a checkpoint. */
  byChat: Record<string, Record<string, true>>;
  hydrate: (chatId: string, messageIds: string[]) => void;
  add: (chatId: string, messageId: string) => void;
  reset: () => void;
}

export const useCheckpoints = create<CheckpointsStore>((set) => ({
  byChat: {},
  hydrate: (chatId, messageIds) =>
    set((s) => {
      const map: Record<string, true> = {};
      for (const id of messageIds) map[id] = true;
      return { byChat: { ...s.byChat, [chatId]: map } };
    }),
  add: (chatId, messageId) =>
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: { ...(s.byChat[chatId] ?? {}), [messageId]: true },
      },
    })),
  reset: () => set({ byChat: {} }),
}));

/** Selector: does this message have a rollback checkpoint? */
export function useHasCheckpoint(chatId: string, messageId: string): boolean {
  return useCheckpoints((s) => !!s.byChat[chatId]?.[messageId]);
}
