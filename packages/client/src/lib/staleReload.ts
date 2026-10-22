/**
 * Reload a tab whose bundle no longer matches the server it just shook hands with.
 *
 * Without this, a stale bundle was a dead end that only a human could clear: the
 * update screen reloads the ONE tab that launched an upgrade, so every other tab
 * — another window, a phone, the PWA when the upgrade came from an agent's
 * `upgrade.mjs` — reconnected to the new server, got a `hello` with a different
 * version, and sat on "This tab is running an old build" until someone clicked
 * Reload. Nothing in that state is ever going to change on its own: a stale
 * bundle reconnects perfectly and keeps dropping frames forever.
 *
 * Reloading is safe because composer drafts live in localStorage (see
 * composerDrafts.ts) — the reload loses nothing the user typed.
 *
 * Bounded, because the failure it is guarding against is a reload LOOP: if the
 * page that comes back is still the old build (a service worker or proxy holding
 * a cached shell), reloading again would spin forever. So per server version it
 * gets one plain reload, then one that refreshes the service worker and drops
 * its shell cache — what a hard reload would do — and after that it stops and leaves the
 * connecting screen up for a person to look at.
 */
import { isStaleBundle } from "./connectionDiagnosis.js";

const KEY = "dispatch:stale-reload";

/** Plain reload, then service-worker-clearing reload, then give up. */
export const MAX_STALE_RELOADS = 2;

interface Attempt {
  version: string;
  attempts: number;
}

export type StaleReloadPlan = "none" | "reload" | "hard-reload";

function read(storage: Storage | undefined): Attempt | undefined {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Attempt>;
    if (typeof parsed.version !== "string" || typeof parsed.attempts !== "number") return undefined;
    return { version: parsed.version, attempts: parsed.attempts };
  } catch {
    return undefined;
  }
}

function write(storage: Storage | undefined, value: Attempt | undefined): void {
  try {
    if (value) storage?.setItem(KEY, JSON.stringify(value));
    else storage?.removeItem(KEY);
  } catch {
    // Storage disabled (private mode, quota). Without a record we can't bound the
    // loop, which is why the caller treats an unwritable store as "don't reload".
  }
}

/**
 * Decide what to do about this `hello`, and record the attempt before returning.
 *
 * Pure apart from `storage`, which is passed in so tests don't need a window.
 * sessionStorage is the right store: it is per-tab (two tabs must not spend
 * each other's attempts) and it survives the reload it is counting.
 */
export function planStaleReload(
  clientVersion: string,
  serverVersion: string | undefined,
  storage: Storage | undefined,
): StaleReloadPlan {
  if (!isStaleBundle(clientVersion, serverVersion)) {
    // In agreement — whatever got us here worked. Forget it, so the NEXT upgrade
    // gets its own full budget.
    write(storage, undefined);
    return "none";
  }
  if (!storage) return "none";
  const prior = read(storage);
  const attempts = prior && prior.version === serverVersion ? prior.attempts : 0;
  if (attempts >= MAX_STALE_RELOADS) return "none";
  const next = { version: serverVersion as string, attempts: attempts + 1 };
  write(storage, next);
  // Read back: if the write didn't stick, a reload would come back here with no
  // memory of having tried, and that's the loop.
  if (read(storage)?.attempts !== next.attempts) return "none";
  return next.attempts === 1 ? "reload" : "hard-reload";
}

/**
 * Carry out a plan. The hard variant is what Ctrl+Shift+R does, minus the user.
 *
 * It refreshes the service worker and drops its SHELL caches, but never
 * unregisters it: push subscriptions belong to the registration, so an
 * unregister would silently unsubscribe this device from notifications. The
 * push-device cache (see public/sw.js) is left alone for the same reason.
 */
export async function runStaleReload(plan: StaleReloadPlan): Promise<void> {
  if (plan === "none") return;
  if (plan === "hard-reload") {
    try {
      const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(registrations.map((r) => r.update()));
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("dispatch-shell")).map((n) => caches.delete(n)));
      }
    } catch {
      // Best effort — the reload below is still the right next step.
    }
  }
  location.reload();
}
