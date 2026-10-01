import { create } from "zustand";
import {
  DEFAULT_ATTENTION_FILTER,
  passesAttentionFilter,
  type AttentionFilter,
  type AttentionItem,
} from "@dispatch/shared";

/**
 * Rank order for the triage list: decisions first, then questions, then review
 * rounds (real work, but nothing is blocked on it this second), then FYI.
 * Mirrors the server's KIND_PRIORITY in services/attention.ts.
 */
const RANK: Record<AttentionItem["kind"], number> = {
  permission: 0,
  question: 1,
  review: 2,
  idle: 3,
  done: 4,
};

interface AttentionStore {
  /** Everything the server is holding, filter or no filter. */
  items: AttentionItem[];
  /**
   * `items` minus the muted kinds — what every surface actually shows: the
   * popover, the sidebar's "Needs input" marker, the app badge.
   *
   * Derived on each mutation rather than filtered per render, and kept ALONGSIDE
   * the raw list rather than replacing it, which is the point of the whole
   * arrangement: muting is a display decision, so turning a kind back on shows
   * what arrived while it was off instead of a gap until the next event.
   */
  visible: AttentionItem[];
  /** `AppSettings.attentionQueue` — app-wide, so every device agrees. */
  filter: AttentionFilter;
  hydrate: (items: AttentionItem[]) => void;
  add: (item: AttentionItem) => void;
  resolve: (id: string) => void;
  clearChat: (chatId: string) => void;
  setFilter: (filter: AttentionFilter) => void;
}

function sortItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || b.createdAt - a.createdAt,
  );
}

/** The one place `items` and `visible` are produced, so they cannot disagree. */
function slice(
  items: AttentionItem[],
  filter: AttentionFilter,
): Pick<AttentionStore, "items" | "visible"> {
  const sorted = sortItems(items);
  return {
    items: sorted,
    visible: sorted.filter((i) => passesAttentionFilter(filter, i)),
  };
}

export const useAttention = create<AttentionStore>((set) => ({
  items: [],
  visible: [],
  filter: DEFAULT_ATTENTION_FILTER,
  hydrate: (items) => set((s) => slice(items, s.filter)),
  add: (item) =>
    set((s) => slice([...s.items.filter((i) => i.id !== item.id), item], s.filter)),
  resolve: (id) => set((s) => slice(s.items.filter((i) => i.id !== id), s.filter)),
  clearChat: (chatId) =>
    set((s) => slice(s.items.filter((i) => i.chatId !== chatId), s.filter)),
  setFilter: (filter) => set((s) => ({ filter, ...slice(s.items, filter) })),
}));

/** Count of visible items that actually block work (permissions + questions). */
export function useAttentionCount(): number {
  return useAttention(
    (s) =>
      s.visible.filter((i) => i.kind === "permission" || i.kind === "question").length,
  );
}
