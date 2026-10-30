import { create } from "zustand";
import {
  DEFAULT_ATTENTION_FILTER,
  showsInQueue,
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
  /**
   * Replace the list with a REST snapshot, then replay every add/resolve/clear
   * that arrived over the socket since {@link beginSync} — see `journal`.
   */
  hydrate: (items: AttentionItem[]) => void;
  /** Call BEFORE requesting the snapshot `hydrate` will be handed. */
  beginSync: () => void;
  /** The snapshot request failed: stop journaling for it. */
  abortSync: () => void;
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
    visible: sorted.filter((i) => showsInQueue(filter, i)),
  };
}

type Op =
  | { op: "add"; item: AttentionItem }
  | { op: "resolve"; id: string }
  | { op: "clearChat"; chatId: string };

function apply(items: AttentionItem[], op: Op): AttentionItem[] {
  switch (op.op) {
    case "add":
      return [...items.filter((i) => i.id !== op.item.id), op.item];
    case "resolve":
      return items.filter((i) => i.id !== op.id);
    case "clearChat":
      return items.filter((i) => i.chatId !== op.chatId);
  }
}

/**
 * Socket events seen while a snapshot is in flight, in arrival order.
 *
 * The reconnect hydrate fetches `/api/attention` alongside seven other reads
 * and applies it only once ALL of them return — 2–18s on a loaded server. The
 * socket is live the whole time. An `attention-resolve` landing in that gap was
 * applied, then the stale snapshot put the item straight back, and the server
 * never re-sends a resolve: an answered question sat in the queue until a page
 * reload (2026-10-29). The mirror case is worse — an `attention-add` in the gap
 * was wiped, leaving a blocked chat with no marker anywhere.
 *
 * Replaying the journal over the snapshot is always safe: every op in it is at
 * least as new as the snapshot, because journaling starts before the request.
 * A counter rather than a flag, so overlapping hydrates keep the journal until
 * the LAST of them lands.
 */
let syncDepth = 0;
let journal: Op[] = [];

export const useAttention = create<AttentionStore>((set) => {
  const mutate = (op: Op) => {
    if (syncDepth > 0) journal.push(op);
    set((s) => slice(apply(s.items, op), s.filter));
  };
  const endSync = () => {
    syncDepth = Math.max(0, syncDepth - 1);
    if (syncDepth === 0) journal = [];
  };
  return {
    items: [],
    visible: [],
    filter: DEFAULT_ATTENTION_FILTER,
    hydrate: (items) => {
      const replayed = journal.reduce(apply, items);
      endSync();
      set((s) => slice(replayed, s.filter));
    },
    beginSync: () => {
      syncDepth += 1;
    },
    abortSync: endSync,
    add: (item) => mutate({ op: "add", item }),
    resolve: (id) => mutate({ op: "resolve", id }),
    clearChat: (chatId) => mutate({ op: "clearChat", chatId }),
    setFilter: (filter) => set((s) => ({ filter, ...slice(s.items, filter) })),
  };
});

/** Count of visible items that actually block work (permissions + questions). */
export function useAttentionCount(): number {
  return useAttention(
    (s) =>
      s.visible.filter((i) => i.kind === "permission" || i.kind === "question").length,
  );
}
