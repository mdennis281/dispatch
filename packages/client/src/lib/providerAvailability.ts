/**
 * Can a chat on this provider run right now? The client half of #426.
 *
 * Derived from `/api/harnesses` through the SAME `providerAvailability` the
 * server's `HarnessRegistry.resolve` uses, so the composer never offers Send
 * for a turn the server is about to refuse — and never refuses one it would
 * run. It is derived rather than stored on the chat, which is what makes a
 * chat recover by itself: the server announces `providers-changed` when a
 * provider plugin is switched on or off, the list is re-read (stores/index.ts),
 * and every banner computed from it goes away with no flag to clear.
 */
import { useEffect, useMemo } from "react";
import {
  providerAvailability,
  type HarnessKind,
  type ProviderUnavailable,
  type SubscriptionStatus,
} from "@dispatch/shared";
import { api, type HarnessInfo } from "./api.js";
import { useHarnesses } from "../stores/harnesses.js";
import { useSubscriptions } from "../stores/subscriptions.js";

/** Re-read the registered providers into the store. Never throws. */
export async function refreshHarnesses(): Promise<void> {
  const list = await api.harnesses.list().catch(() => null);
  if (list) useHarnesses.getState().setHarnesses(list);
}

/**
 * The registered providers, fetching them once if nothing has yet.
 *
 * The fetch is here, not only in the app's hydrate, because the setup wizard
 * and the new-project screen can render before hydrate has asked — and an
 * empty list read as "nothing is installed" would block them for no reason.
 */
export function useRegisteredProviders(): { harnesses: HarnessInfo[]; loaded: boolean } {
  const harnesses = useHarnesses((s) => s.harnesses);
  const loaded = useHarnesses((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void refreshHarnesses();
  }, [loaded]);
  return { harnesses, loaded };
}

/**
 * Why `provider` cannot run, or null when it can. Also null until the list has
 * loaded: claiming "not available" for a provider we simply have not heard
 * about yet would flash a warning on every chat at startup.
 */
export function useProviderAvailability(
  provider: HarnessKind | undefined | null,
  account?: Pick<SubscriptionStatus, "login"> | null,
): ProviderUnavailable | null {
  const { harnesses, loaded } = useRegisteredProviders();
  return useMemo(
    () => (loaded ? chatAvailability(provider, harnesses, account) : null),
    [loaded, provider, harnesses, account],
  );
}

/**
 * The server's rule for one chat. The provider entry's `login` is the DEFAULT
 * account's; when the caller knows the chat's own account (`account` given,
 * even as null), that account's login replaces it — the broker judges the
 * account the chat is pinned to, and so must the banner. An account with no
 * probe yet is never "logged out": the server still refuses if it must.
 */
export function chatAvailability(
  provider: HarnessKind | undefined | null,
  harnesses: readonly HarnessInfo[],
  account?: Pick<SubscriptionStatus, "login"> | null,
): ProviderUnavailable | null {
  if (account === undefined) return providerAvailability(provider, harnesses);
  return providerAvailability(
    provider,
    harnesses.map((h) => (h.kind === provider ? { ...h, login: account?.login } : h)),
  );
}

/** How often a "not logged in" banner re-asks while it is showing. */
const LOGGED_OUT_RECHECK_MS = 15_000;

/**
 * Keep re-reading while a chat shows "not logged in". The user fixes that in a
 * terminal, not here, and nothing else would ask again: the composer refuses
 * the send that would have reached the server, and `providers-changed` only
 * fires once some probe has seen the flip. Each read is a `peek` server-side,
 * which re-probes a stale negative and announces the flip when it lands.
 */
export function useRecheckWhileLoggedOut(unavailable: ProviderUnavailable | null): void {
  const loggedOut = unavailable?.reason === "logged-out";
  useEffect(() => {
    if (!loggedOut) return;
    const recheck = () => {
      void refreshHarnesses();
      void useSubscriptions.getState().load();
    };
    const timer = setInterval(recheck, LOGGED_OUT_RECHECK_MS);
    window.addEventListener("focus", recheck);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", recheck);
    };
  }, [loggedOut]);
}

/**
 * Is `provider` registered right now? For the few surfaces that only mean
 * anything on ONE provider — Claude Code's auto-memory editor, its
 * `autoCompactWindow` setting. Claude is a plugin (#428), and on an install
 * with it switched off those surfaces would edit files nothing reads.
 *
 * False until the list has loaded: a Claude-only control flashing in and then
 * out is worse than one that appears a beat late.
 */
export function useProviderRegistered(provider: HarnessKind): boolean {
  const { harnesses, loaded } = useRegisteredProviders();
  return loaded && harnesses.some((h) => h.kind === provider);
}

/**
 * The providers a chat could be switched to right now: registered, installed
 * and not known to be logged out — the same rule the banner applies, so it
 * never offers "Switch to X" for an X that would show the banner itself.
 */
export function useAvailableProviders(): HarnessInfo[] {
  const { harnesses } = useRegisteredProviders();
  return useMemo(() => harnesses.filter((h) => providerAvailability(h.kind, [h]) === null), [harnesses]);
}
