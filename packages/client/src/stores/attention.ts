import { create } from "zustand";
import type { AttentionItem } from "@cm/shared";

/** Rank order for the triage list: decisions first, then questions, then FYI. */
const RANK: Record<AttentionItem["kind"], number> = {
  permission: 0,
  question: 1,
  idle: 2,
  done: 3,
};

interface AttentionStore {
  items: AttentionItem[];
  hydrate: (items: AttentionItem[]) => void;
  add: (item: AttentionItem) => void;
  resolve: (id: string) => void;
  clearChat: (chatId: string) => void;
}

function sortItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || b.createdAt - a.createdAt,
  );
}

export const useAttention = create<AttentionStore>((set) => ({
  items: [],
  hydrate: (items) => set({ items: sortItems(items) }),
  add: (item) =>
    set((s) => ({
      items: sortItems([...s.items.filter((i) => i.id !== item.id), item]),
    })),
  resolve: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clearChat: (chatId) =>
    set((s) => ({ items: s.items.filter((i) => i.chatId !== chatId) })),
}));

/** Count of items that actually block work (permissions + questions). */
export function useAttentionCount(): number {
  return useAttention(
    (s) => s.items.filter((i) => i.kind === "permission" || i.kind === "question").length,
  );
}
