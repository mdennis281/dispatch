/**
 * First-run setup gate.
 *
 * Separate from `useAuth` even though the wizard's first step is authentication,
 * because the two answer different questions and one of them can be answered
 * offline. `useAuth` decides whether this TAB may see the app; this decides
 * whether this INSTALL has ever been configured. Folding the second into the
 * first would mean a signed-in tab and a set-up install were the same fact —
 * and they are not: enabling auth is one optional step of four.
 *
 * `pending` starts null, not false. Until the server answers there is no honest
 * answer, and defaulting to "no wizard needed" would flash the empty app shell
 * over a fresh install for exactly as long as the request takes.
 */
import { create } from "zustand";
import type { SetupStatus } from "@dispatch/shared";
import { api } from "../lib/api.js";

/** How long `hydrate` waits for `/api/setup` before giving up. */
export const SETUP_PROBE_TIMEOUT_MS = 5000;

/**
 * Whether it is safe to ask the server about setup state yet.
 *
 * A function rather than an inline `&&` in `App`, because the probe FAILS OPEN
 * — one wrong boolean here is either a permanent "Starting Dispatch…" or a
 * wizard that never appears on an install that needs it — and CI does not run
 * the e2e spec that would otherwise be the only thing exercising it. Pulled out
 * so each clause can be pinned by a test that names the failure it prevents.
 */
export function shouldProbeSetup(auth: {
  /** `/api/auth/status` has answered (or been guessed at). */
  ready: boolean;
  /** The answer is a PLACEHOLDER because the server could not be reached. */
  unreachable: boolean;
  /** This install requires a login. */
  authEnabled: boolean;
  /** Somebody is signed in. */
  signedIn: boolean;
}): boolean {
  // Not `!authEnabled || signedIn` alone: `/api/setup` is behind the same bearer
  // gate as every other route, so asking without a session 401s — and a 401 is
  // indistinguishable here from "already set up".
  if (!auth.ready || auth.unreachable) return false;
  return !auth.authEnabled || auth.signedIn;
}

interface SetupStore {
  /** null = not asked yet. true = the wizard is owed. */
  pending: boolean | null;
  hydrate: () => Promise<void>;
  /** Called once the wizard finishes; the server has already been told. */
  markComplete: () => void;
}

export const useSetup = create<SetupStore>((set) => ({
  pending: null,
  hydrate: async () => {
    try {
      // Raced against a deadline, because the shell does not render until this
      // resolves. Without it a server that accepts the connection and then never
      // answers — a reverse proxy holding the request open with nothing behind
      // it — leaves the tab on "Starting Dispatch…" forever, with the connection
      // diagnostics that exist for exactly that case never getting to run.
      const status: SetupStatus = await Promise.race([
        api.setup.status(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("setup status timed out")), SETUP_PROBE_TIMEOUT_MS),
        ),
      ]);
      set({ pending: !status.completed });
    } catch {
      // A server we cannot reach is not a server that needs setting up. Failing
      // CLOSED here would put a four-step wizard over a working install every
      // time the network hiccuped — and step four creates a project, so the
      // recovery from guessing wrong is a duplicate.
      set({ pending: false });
    }
  },
  markComplete: () => set({ pending: false }),
}));
