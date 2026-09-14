import { create } from "zustand";
import { DEFAULT_HARNESS, type UsageSnapshot } from "@dispatch/shared";
import { api, type UsageTarget } from "../lib/api.js";
import { useSubscriptions } from "./subscriptions.js";

/**
 * The slot a target's snapshot lives in: the account id when known, else a
 * provider-default placeholder for a read made before the account list landed.
 */
export function usageKey(target: UsageTarget): string {
  return target.subscriptionId ?? `@${target.harness}`;
}

interface UsageStore {
  /**
   * Latest snapshot PER ACCOUNT — absent until that account's first load.
   *
   * Keyed by account, not provider, because limits belong to a login: two Claude
   * subscriptions have two unrelated 5-hour windows, and a provider-keyed slot
   * would show whichever one reported last under the other's name. (It was
   * keyed by provider before that, and by a single slot before THAT — which had
   * to drop every Claude push while the gauge read Codex.)
   */
  bySubscription: Record<string, UsageSnapshot>;
  /** Accounts with a manual refresh in flight (spins the card's button). */
  refreshing: Record<string, boolean>;
  /** The account the header gauge reads: the active chat's, else the app default's. */
  target: UsageTarget;
  /** Apply a `usage-update` bus event. */
  set: (usage: UsageSnapshot) => void;
  /** Point the gauge at an account — the app default provider's when omitted — and load it. */
  load: (target?: UsageTarget) => Promise<void>;
  /** Load one account's snapshot without moving the gauge (the card's switcher). */
  loadTarget: (target: UsageTarget) => Promise<void>;
  /** Force a server-side refresh of one account (the card's refresh button). */
  refresh: (target: UsageTarget) => Promise<void>;
}

/**
 * Latest `load` call. Resolving the app default awaits a settings read, and a
 * chat on another account can be opened while that is in flight — without this
 * the late default lands second and points the gauge back at the wrong account.
 */
let loadSeq = 0;

/** Does this snapshot have anything the gauge can draw? */
export const hasWindows = (u: UsageSnapshot | undefined): u is UsageSnapshot =>
  !!u && (!!u.fiveHour || !!u.sevenDay);

/** Subscription usage (5h + weekly, or Codex's windows) — feeds the header usage meter. */
export const useUsage = create<UsageStore>((set, get) => {
  /**
   * File a snapshot under the key it was asked for AND the account the server
   * says it is — a bare-provider read resolves to a real account, and the gauge
   * may be looking under either name.
   */
  const put = (target: UsageTarget, usage: UsageSnapshot) =>
    set((state) => {
      const next = { ...state.bySubscription, [usageKey(target)]: usage };
      if (usage.subscriptionId) next[usage.subscriptionId] = usage;
      return { bySubscription: next };
    });

  /**
   * A read that failed before reaching the server (network, a proxy's 502) must
   * still leave a snapshot behind. Only Claude's are pushed, so an empty slot
   * for any other account would read "Loading…" in the card indefinitely —
   * Refresh included, since it fails the same way. The last windows are kept,
   * marked stale, the way the server's own error snapshots do it.
   */
  const fail = (target: UsageTarget) =>
    set((state) => {
      const key = usageKey(target);
      const last = state.bySubscription[key];
      const failed: UsageSnapshot = last
        ? { ...last, stale: true, error: "unavailable" }
        : {
            fiveHour: null,
            sevenDay: null,
            fetchedAt: Date.now(),
            stale: true,
            error: "unavailable",
            provider: target.harness,
            ...(target.subscriptionId ? { subscriptionId: target.subscriptionId } : {}),
          };
      return { bySubscription: { ...state.bySubscription, [key]: failed } };
    });

  return {
    bySubscription: {},
    refreshing: {},
    target: { harness: DEFAULT_HARNESS },

    set: (usage) => {
      const harness = usage.provider ?? DEFAULT_HARNESS;
      // A push the server couldn't stamp comes from the poller it started at
      // boot, which is the account at the provider's default directory.
      const subscriptionId =
        usage.subscriptionId ??
        useSubscriptions.getState().list.find((s) => s.provider === harness && s.atDefaultDir)?.id;
      put({ harness, subscriptionId }, usage);
    },

    load: async (requested) => {
      const seq = ++loadSeq;
      const settings = requested ? null : await api.settings.get().catch(() => null);
      if (seq !== loadSeq) return;
      const target = requested ?? { harness: settings?.harness?.defaultHarness ?? DEFAULT_HARNESS };
      await get().loadTarget(target);
      // Move the gauge only once the new account has windows to show. The gauge
      // renders nothing without them, so moving first unmounted it (and an open
      // card) for as long as a cold Codex read took — and moving onto a failed
      // read hid it for good, with the previous account's windows still live and
      // now unreachable. An account that can't be read leaves the gauge where it
      // was; the card still shows that account as unavailable.
      if (seq === loadSeq && hasWindows(get().bySubscription[usageKey(target)])) set({ target });
    },

    loadTarget: async (target) => {
      try {
        put(target, await api.usage.get(target));
      } catch {
        fail(target);
      }
    },

    refresh: async (target) => {
      const key = usageKey(target);
      if (get().refreshing[key]) return;
      const flag = (on: boolean) =>
        set((state) => ({ refreshing: { ...state.refreshing, [key]: on } }));
      flag(true);
      try {
        put(target, await api.usage.refresh(target));
      } catch {
        fail(target);
      } finally {
        flag(false);
      }
    },
  };
});
