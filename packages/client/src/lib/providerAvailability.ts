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
} from "@dispatch/shared";
import { api, type HarnessInfo } from "./api.js";
import { useHarnesses } from "../stores/harnesses.js";

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
): ProviderUnavailable | null {
  const { harnesses, loaded } = useRegisteredProviders();
  return useMemo(
    () => (loaded ? providerAvailability(provider, harnesses) : null),
    [loaded, provider, harnesses],
  );
}

/** The providers a chat could be switched to right now: registered and installed. */
export function useAvailableProviders(): HarnessInfo[] {
  const { harnesses } = useRegisteredProviders();
  return useMemo(() => harnesses.filter((h) => h.runtime.available), [harnesses]);
}
