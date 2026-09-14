import { create } from "zustand";
import type { Subscription, SubscriptionStatus } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface SubscriptionsStore {
  /** Every account in effect (implicit ones included), in the server's order. */
  list: SubscriptionStatus[];
  /** False until the first read lands — a picker must not claim "one account" before then. */
  loaded: boolean;
  load: () => Promise<void>;
  /** Replace the stored list and adopt the server's answer. Throws on a refused save. */
  save: (subscriptions: Subscription[]) => Promise<void>;
}

/**
 * The login accounts, as the server resolves them.
 *
 * Read from the server rather than derived from settings on the client because
 * two facts it carries only the server can know: whether a directory holds a
 * login, and which account sits at the provider's default directory — the one a
 * legacy chat with no pin is actually running under (see `chatAccountOf`).
 */
export const useSubscriptions = create<SubscriptionsStore>((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    try {
      set({ list: await api.subscriptions.list(), loaded: true });
    } catch {
      /* best-effort: an older server has no route, and the pickers stay hidden */
    }
  },
  save: async (subscriptions) => {
    set({ list: await api.subscriptions.save(subscriptions), loaded: true });
  },
}));
