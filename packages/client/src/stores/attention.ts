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
   * that arrived over the socket since that snapshot's {@link beginSync} — see
   * `journal`. Without a token it is a plain replace (the offline fixture).
   */
  hydrate: (items: AttentionItem[], sync?: AttentionSync) => void;
  /** Call BEFORE requesting the snapshot; hand the token back to `hydrate`. */
  beginSync: () => AttentionSync;
  /** The snapshot request failed: stop journaling for it. */
  abortSync: (sync: AttentionSync) => void;
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
 * Replaying over the snapshot is safe only for ops newer than THAT snapshot's
 * request, so each sync replays from the index where it began, not from 0. A
 * shared start was wrong for overlapping hydrates (a second `hello` while the
 * first is in flight): B would replay an `add` journaled under A over a
 * snapshot taken after the item was resolved, and resurrect it.
 */
export interface AttentionSync {
  readonly start: number;
}
const active = new Set<AttentionSync>();
let journal: Op[] = [];

export const useAttention = create<AttentionStore>((set) => {
  const mutate = (op: Op) => {
    if (active.size > 0) journal.push(op);
    set((s) => slice(apply(s.items, op), s.filter));
  };
  const endSync = (sync: AttentionSync) => {
    active.delete(sync);
    // Only trimmed once nothing is in flight, so every live token's index holds.
    if (active.size === 0) journal = [];
  };
  return {
    items: [],
    visible: [],
    filter: DEFAULT_ATTENTION_FILTER,
    hydrate: (items, sync) => {
      const replayed =
        sync && active.has(sync) ? journal.slice(sync.start).reduce(apply, items) : items;
      if (sync) endSync(sync);
      set((s) => slice(replayed, s.filter));
    },
    beginSync: () => {
      const sync: AttentionSync = { start: journal.length };
      active.add(sync);
      return sync;
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
