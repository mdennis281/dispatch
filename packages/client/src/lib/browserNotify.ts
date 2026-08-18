/**
 * Desktop (browser) notifications for the Attention Queue.
 *
 * Dispatch already had two ways to be told an agent needs you: the in-app
 * Attention badge, which requires you to be looking at the app, and the outbound
 * webhook (ntfy/Pushover), which requires you to have set one up. This is the
 * middle one — the OS-level toast you get for free just by granting the
 * permission, so a three-hour run can interrupt you while you're in another
 * window.
 *
 * Rules it follows, all of them deliberate:
 *
 *   - **Only when you're not looking.** A notification fires only if the app is
 *     hidden or unfocused. With the window in front of you the badge and the
 *     inline card are already saying it, and a duplicate OS toast is noise.
 *   - **The permission is the switch.** The local preference exists so you can
 *     silence notifications without revoking a browser permission that's fiddly
 *     to re-grant, but the default is on: nothing fires until you've explicitly
 *     granted, so an opt-out default would mean asking twice.
 *   - **Resolved means gone.** Answer a permission prompt in the app and its
 *     toast is withdrawn, so the notification centre never accumulates a pile of
 *     decisions you already made.
 *
 * Delivery goes through the service worker's `showNotification` when one is
 * registered, and falls back to the `Notification` constructor otherwise. The
 * SW path is the one that survives the page being closed and is the ONLY path
 * that works on Android; the constructor is what dev (no SW registered — see
 * main.tsx) and older desktop setups get. Clicks come back differently for each:
 * the constructor gets an `onclick` here, the SW posts a message that main.tsx
 * routes to {@link focusAttentionTarget}.
 *
 * ── Why NONE of this reaches a phone ───────────────────────────────────────
 * Every path here runs in the OPEN PAGE. iOS suspends a backgrounded home-screen
 * web app outright — socket dropped, timers stopped — so on a phone this module
 * can only fire while you are already looking at the app, which is exactly when
 * `appIsInFront()` suppresses it. Server-sent Web Push (lib/webPush.ts +
 * services/push.ts) is the only delivery an iPhone ever sees; this module stays
 * for desktop, where the window survives in the background and a push round-trip
 * through Apple/Google would be a worse way to say the same thing.
 *
 * ── Why this can be unavailable ────────────────────────────────────────────
 * The Notification API needs a SECURE CONTEXT. `http://localhost` counts and
 * HTTPS counts; `http://192.168.x.x` does NOT. So on the machine running
 * Dispatch this always works, and over host-mode LAN access it never does —
 * Chromium withholds the API entirely. {@link notifyUnavailableReason} exists so
 * Settings can say which of those you're in rather than showing a button that
 * silently does nothing.
 */
import { create } from "zustand";
import { shouldNotify } from "@dispatch/shared";
import type { AttentionItem } from "@dispatch/shared";
import { useWebPush } from "./webPush.js";

/** Message the service worker posts back when a notification is clicked. */
export interface AttentionFocusMessage {
  type: "attention-focus";
  chatId: string;
  permissionRequestId?: string;
}

/** Per-kind copy. Mirrors the webhook notifier's KIND_META so both agree. */
const KIND_META: Record<
  AttentionItem["kind"],
  { title: string; /** Keep the toast up until it's dismissed. */ sticky: boolean }
> = {
  permission: { title: "Permission needed", sticky: true },
  question: { title: "Question", sticky: true },
  idle: { title: "Waiting for input", sticky: false },
  done: { title: "Task done", sticky: false },
  // Sticky: a review round that vanishes off the notification centre before you
  // look is the exact failure the `review` kind was added to fix.
  review: { title: "PR review activity", sticky: true },
};

const ICON = "/icons/icon-192.png";
const KEY = "cm:desktop-notifications";
const ASK_KEY = "cm:desktop-notifications-asked";

/* ------------------------------------------------------------ availability */

type Permission = "default" | "granted" | "denied" | "unsupported";

/** Whether this browser exposes the API at all (see the secure-context note above). */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function currentPermission(): Permission {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission as Permission;
}

/**
 * Why notifications can't be used here, or null when they can. Phrased for
 * display — the LAN case is by far the most likely and the least obvious.
 */
export function notifyUnavailableReason(): string | null {
  if (notificationsSupported()) return null;
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "This origin isn't a secure context, so the browser withholds notifications. Open Dispatch on http://localhost (or over HTTPS) to use them.";
  }
  return "This browser doesn't support notifications.";
}

/* -------------------------------------------------------------- preference */

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

function loadEnabled(): boolean {
  try {
    return backing()?.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

interface NotifyStore {
  /** The local mute switch. Meaningless until `permission === "granted"`. */
  enabled: boolean;
  permission: Permission;
  /** True once the in-app nudge has been answered either way — it asks once. */
  asked: boolean;
  setEnabled: (v: boolean) => void;
  /** Prompt the browser. Resolves to the resulting permission. */
  request: () => Promise<Permission>;
  /** Dismiss the nudge without prompting (Settings still offers it later). */
  dismissAsk: () => void;
}

function markAsked(): void {
  try {
    backing()?.setItem(ASK_KEY, "1");
  } catch {
    /* the nudge reappears next load; harmless */
  }
}

export const useBrowserNotify = create<NotifyStore>((set) => ({
  enabled: loadEnabled(),
  permission: currentPermission(),
  asked: (() => {
    try {
      return backing()?.getItem(ASK_KEY) === "1";
    } catch {
      return false;
    }
  })(),
  dismissAsk: () => {
    markAsked();
    set({ asked: true });
  },
  setEnabled: (v) => {
    try {
      backing()?.setItem(KEY, v ? "on" : "off");
    } catch {
      /* quota / private mode — a lost preference beats a thrown save */
    }
    set({ enabled: v });
  },
  request: async () => {
    if (!notificationsSupported()) return "unsupported";
    let result: Permission;
    try {
      result = (await Notification.requestPermission()) as Permission;
    } catch {
      // Safari < 16 only has the callback form; treat a throw as "no change".
      result = currentPermission();
    }
    markAsked();
    set({ permission: result, asked: true });
    return result;
  },
}));

/**
 * Whether to show the in-app nudge that asks for the permission.
 *
 * The prompt itself needs a user gesture — firing `requestPermission()` on load
 * is what gets an origin auto-blocked by Firefox and glared at by Chrome — so
 * something on screen has to be clicked, and the gear-behind-a-modal toggle
 * alone would leave the feature effectively undiscoverable.
 */
export function useShouldAskToNotify(): boolean {
  return useBrowserNotify(
    (s) => s.permission === "default" && !s.asked && notificationsSupported(),
  );
}

/* ---------------------------------------------------------------- delivery */

/**
 * Constructor-path notifications, kept so `attention-resolve` can withdraw one.
 * The SW path doesn't need this — `getNotifications({ tag })` finds them.
 */
const live = new Map<string, Notification>();

/** True when the human is demonstrably looking at the app right now. */
function appIsInFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

async function swRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

/**
 * Raise an OS notification for one attention item. Never throws and never
 * awaits anything the caller needs — the WS reducer calls it and moves on.
 */
export async function notifyAttention(item: AttentionItem, chatTitle?: string): Promise<void> {
  const { enabled, permission } = useBrowserNotify.getState();
  if (!enabled || permission !== "granted") return;
  if (appIsInFront()) return;
  // The same per-kind filters and quiet hours the server applies to pushes.
  // Both sides run the ONE predicate in shared/notify.ts, so a kind muted in
  // Settings cannot leak through whichever path happens to deliver first.
  if (!shouldNotify(useWebPush.getState().prefs, item, Date.now())) return;

  const meta = KIND_META[item.kind];
  if (!meta) return; // defensive: a kind added server-side that we don't know

  const title = chatTitle ? `${meta.title} — ${chatTitle}` : meta.title;
  const options: NotificationOptions = {
    body: item.summary,
    icon: ICON,
    badge: ICON,
    // One toast per item: a re-sent `attention-add` replaces rather than stacks.
    tag: item.id,
    requireInteraction: meta.sticky,
    data: {
      type: "attention-focus",
      chatId: item.chatId,
      permissionRequestId: item.permissionRequestId,
    } satisfies AttentionFocusMessage,
  };

  const reg = await swRegistration();
  if (reg) {
    try {
      await reg.showNotification(title, options);
      return;
    } catch {
      // Fall through — some desktop builds reject showNotification without push.
    }
  }

  try {
    const n = new Notification(title, options);
    live.set(item.id, n);
    n.onclose = () => live.delete(item.id);
    n.onclick = () => {
      window.focus();
      n.close();
      // Imported lazily: this module is loaded by the store spine, and the focus
      // helper reaches back into the chats store — a static import would close
      // that cycle at module-eval time.
      void import("../components/attention/focus.js").then((m) =>
        m.focusAttentionTarget(item.chatId, item.permissionRequestId),
      );
    };
  } catch {
    /* Android throws on the constructor; nothing more to try. */
  }
}

/** Withdraw the toast for an item that no longer needs anyone (resolved / cleared). */
export async function closeAttentionNotification(id: string): Promise<void> {
  live.get(id)?.close();
  live.delete(id);
  const reg = await swRegistration();
  if (!reg) return;
  try {
    for (const n of await reg.getNotifications({ tag: id })) n.close();
  } catch {
    /* not supported here — the toast just lingers until dismissed */
  }
}
