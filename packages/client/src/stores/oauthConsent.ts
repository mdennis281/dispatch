/**
 * The consent page's trigger: `#oauth=<nonce>` in the boot hash.
 *
 * `/oauth/authorize` parks a connector's request server-side and redirects
 * the browser here with the nonce. `main.tsx` lifts it out of the hash on
 * load (and clears the hash, so a reload does not re-enter a consent that was
 * already answered) and parks it in this store; `App.tsx` renders the consent
 * page INSIDE `AuthGate` while a nonce is set, which is what makes "requires a
 * logged-in session" free — a signed-out owner sees the login sheet, then the
 * consent page.
 */
import { create } from "zustand";

interface OAuthConsentStore {
  nonce: string | null;
  begin: (nonce: string) => void;
  clear: () => void;
}

export const useOAuthConsent = create<OAuthConsentStore>((set) => ({
  nonce: null,
  begin: (nonce) => set({ nonce }),
  clear: () => set({ nonce: null }),
}));

/**
 * Pull the OAuth-related keys out of a boot hash. Pure, so it is tested: the
 * hash is the only input the consent page and the plugin callback have, and a
 * typo here is a connector that silently never gets its code.
 */
export function parseOAuthHash(hash: string): { nonce?: string; settings?: string; oauthError?: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const nonce = params.get("oauth") ?? undefined;
  const settings = params.get("settings") ?? undefined;
  const oauthError = params.get("oauthError") ?? undefined;
  return {
    ...(nonce ? { nonce } : {}),
    ...(settings ? { settings } : {}),
    ...(oauthError ? { oauthError } : {}),
  };
}
