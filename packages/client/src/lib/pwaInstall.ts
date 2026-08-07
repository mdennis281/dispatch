/**
 * "Install Dispatch" — the browser-tab nudge.
 *
 * Dispatch is meant to be used as an installed PWA: that is what gives it its
 * own window, its own taskbar identity and its own icon, and it's the difference
 * between a tab you lose among thirty others and an app you alt-tab to. But
 * Chrome's own install affordance is a small icon in the address bar that nobody
 * finds, so a session opened in an ordinary tab stays an ordinary tab forever.
 * This is the missing prompt.
 *
 * Mechanics worth knowing:
 *
 *   - **The event fires before React mounts.** Chromium dispatches
 *     `beforeinstallprompt` as soon as the installability criteria are met,
 *     which on a warm load beats the first render. So {@link capturePwaInstall}
 *     is called from `main.tsx` at module scope, not from a component effect —
 *     an effect that subscribes later simply never sees the event.
 *   - **`prompt()` needs a user gesture and works once.** We stash the event and
 *     fire it from the card's click handler; whatever the outcome, the event is
 *     spent and gets dropped. Chromium re-fires a fresh one on a later load if
 *     the app still isn't installed.
 *   - **Absence is normal.** No event means: already installed, or not
 *     installable (dev — no service worker registered there — or a LAN origin,
 *     which isn't a secure context), or a browser that never implemented it
 *     (Firefox, Safari). In every one of those the card just never appears,
 *     which is the correct behaviour and why the card is driven by the event
 *     rather than by a guess about the environment.
 */
import { create } from "zustand";

/** The non-standard Chromium event. Typed here because lib.dom has no shape for it. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const KEY = "cm:pwa-install-snoozed";
/**
 * How long "Not now" holds. Long enough not to nag, short enough that the nudge
 * comes back if you keep working in a tab — the whole point is to get installed.
 */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

function loadSnoozedUntil(): number {
  try {
    const raw = backing()?.getItem(KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * True when the page is already running as an installed app, in which case there
 * is nothing to nudge. `window-controls-overlay` is in the list because the
 * manifest asks for it first (see manifest.webmanifest) — miss it and an
 * installed window would be told to install itself.
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const modes = ["standalone", "window-controls-overlay", "fullscreen", "minimal-ui"];
  if (modes.some((m) => window.matchMedia(`(display-mode: ${m})`).matches)) return true;
  // iOS Safari's pre-standard flag.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

interface InstallStore {
  /** The deferred Chromium event, or null when installing isn't on offer. */
  deferred: BeforeInstallPromptEvent | null;
  /** Set once `appinstalled` fires, so the card leaves immediately. */
  installed: boolean;
  snoozedUntil: number;
  /** Run the real browser install flow. Must be called from a click handler. */
  install: () => Promise<"accepted" | "dismissed" | "unavailable">;
  /** "Not now" — hide the card for {@link SNOOZE_MS}. */
  snooze: () => void;
}

export const usePwaInstall = create<InstallStore>((set, get) => ({
  deferred: null,
  installed: isStandalone(),
  snoozedUntil: loadSnoozedUntil(),
  install: async () => {
    const evt = get().deferred;
    if (!evt) return "unavailable";
    // Spent either way: a BeforeInstallPromptEvent can only be prompted once.
    set({ deferred: null });
    try {
      await evt.prompt();
      const { outcome } = await evt.userChoice;
      if (outcome === "accepted") set({ installed: true });
      else get().snooze();
      return outcome;
    } catch {
      return "unavailable";
    }
  },
  snooze: () => {
    const until = Date.now() + SNOOZE_MS;
    try {
      backing()?.setItem(KEY, String(until));
    } catch {
      /* quota / private mode — worst case the card returns next load */
    }
    set({ snoozedUntil: until });
  },
}));

/** Whether the install card should be on screen right now. */
export function useShouldOfferInstall(): boolean {
  return usePwaInstall(
    (s) => s.deferred !== null && !s.installed && Date.now() >= s.snoozedUntil,
  );
}

/**
 * Subscribe to the install lifecycle. Call once, at module scope, before React
 * mounts — see the note above about the event beating the first render.
 */
export function capturePwaInstall(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Suppress Chromium's own mini-infobar; this card replaces it.
    e.preventDefault();
    usePwaInstall.setState({ deferred: e as BeforeInstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => {
    usePwaInstall.setState({ deferred: null, installed: true });
  });
}
