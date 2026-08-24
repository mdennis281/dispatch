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
          setTimeout(() => reject(new Error("setup status timed out")), 5000),
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
