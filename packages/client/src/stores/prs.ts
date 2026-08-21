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
import { useShallow } from "zustand/react/shallow";
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

/**
 * Every tracked PR, most recently CHANGED first.
 *
 * Pure, and NOT for passing to `usePrs` directly — see `useAllPrs`. It stays
 * exported for `getState()` callers and for the tests, which is the only place a
 * one-shot answer is what's wanted.
 */
export function selectPrs(s: PrsStore): PrRecord[] {
  return Object.values(s.byKey).sort((a, b) => b.lastChangedAt - a.lastChangedAt);
}

/**
 * `selectPrs` as a hook — the only supported way to read the roster in React.
 *
 * `useShallow` is load-bearing, not an optimization. `selectPrs` builds a new
 * array on every call, zustand v5 has no equality argument, and its `getSnapshot`
 * is `selector(getState())` — so an uncached selector hands `useSyncExternalStore`
 * a different reference every time it checks. React reads that as "the store
 * changed during commit", re-renders synchronously, checks again, and never
 * converges: `Minified React error #185` (Maximum update depth exceeded) with the
 * whole app white, from a component that looks like it is only reading.
 *
 * That is why every other derived list in this directory is behind a hook rather
 * than an exported selector. This one wasn't, and `WorkspaceView` — which is
 * mounted at the app root and runs its hooks whether or not the overlay is open —
 * took the entire UI down with it.
 */
export function useAllPrs(): PrRecord[] {
  return usePrs(useShallow(selectPrs));
}

/**
 * The reviewer state for ONE pull request, from the registry row behind it.
 *
 * Exists because the per-chat PRs panel renders `PRInfo` — a live `gh` read that
 * knows nothing about Dispatch's own reviewer, which is registry bookkeeping and
 * lives only on `PrRecord`. Rather than widening that endpoint, the panel joins
 * to the standing catalog it is already subscribed to.
 *
 * Keyed by `owner/repo#number` where the repo is known. The `chatId` fallback is
 * for the rows that predate `repo` being recorded on a PR ref: a bare number is
 * ambiguous across repositories (see this module's docblock), but a bare number
 * scoped to ONE chat is not, because a chat has one checkout.
 *
 * Returns the stored object by reference, so it is safe to select directly —
 * unlike `selectPrs`, this builds nothing.
 */
export function usePrReviewAgent(
  chatId: string,
  prNumber: number,
  repo?: string,
): PrRecord["reviewAgent"] {
  return usePrs((s) => {
    if (repo) return s.byKey[`${repo}#${prNumber}`]?.reviewAgent;
    return Object.values(s.byKey).find((r) => r.chatId === chatId && r.number === prNumber)
      ?.reviewAgent;
  });
}
