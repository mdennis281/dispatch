/**
 * The tracked-PR catalog, client side.
 *
 * A STANDING store, unlike `stores/workspace`'s worktree and terminal lists
 * which are fetched when the modal opens. The difference is deliberate and is
 * the whole reason the registry exists: a PR's state changes while nobody is
 * looking — CI finishes, a reviewer starts, a thread lands — so the answer has
 * to already be here when you open the tab, and it has to keep changing while
 * the tab is open. It hydrates once on connect (see `hydrateFromServer`) and
 * follows `pr-record-update` from there.
 *
 * Keyed by `owner/repo#number`, never by number alone: PR numbers restart at 1
 * per repository, and a store keyed on the bare number is what stopped the old
 * project overlay from folding live events in at all.
 */
import { create } from "zustand";
import type { PrRecord } from "@dispatch/shared";

interface PrsStore {
  byKey: Record<string, PrRecord>;
  /** Replace the whole roster (hydrate / reconnect). */
  hydrate: (records: PrRecord[]) => void;
  /** Apply one `pr-record-update`. */
  upsert: (record: PrRecord) => void;
}

export const usePrs = create<PrsStore>((set) => ({
  byKey: {},
  hydrate: (records) =>
    set({ byKey: Object.fromEntries(records.map((r) => [r.key, r])) }),
  upsert: (record) =>
    set((s) => ({ byKey: { ...s.byKey, [record.key]: record } })),
}));

/** Every tracked PR, most recently CHANGED first. */
export function selectPrs(s: PrsStore): PrRecord[] {
  return Object.values(s.byKey).sort((a, b) => b.lastChangedAt - a.lastChangedAt);
}
