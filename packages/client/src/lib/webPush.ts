/**
 * Web Push registration + notification filters for THIS device.
 *
 * ── Why this exists alongside browserNotify.ts ─────────────────────────────
 * `browserNotify.ts` raises a toast from the running page. That is enough on a
 * desktop, where the window survives in the background. It is worth nothing on
 * iOS: a backgrounded home-screen web app is SUSPENDED — the WebSocket drops,
 * timers stop, and no code of ours runs until the icon is tapped — so the only
 * notification a phone can ever receive is one the server pushed. This module
 * registers for those.
 *
 * ── Where the preferences live, and why they're also sent to the server ────
 * The filters are per-DEVICE: the phone wants a ping when a check goes red, the
 * machine with the app on screen does not. So they are stored in this browser's
 * localStorage and never in server-side AppSettings, which would promise every
 * device what one device chose.
 *
 * They are nonetheless UPLOADED with the subscription, because iOS forbids the
 * obvious implementation. A push handler that decides not to show a notification
 * is a "silent push", and a few of those cost you the subscription outright — so
 * a muted event has to be one the server never sends. localStorage stays the
 * source of truth and the UI edits it; the server holds a copy per endpoint and
 * does the filtering. `shared/notify.ts` is the single predicate both run.
 *
 * ── Presence ───────────────────────────────────────────────────────────────
 * A push to a screen you're already looking at is noise (the badge and the
 * inline card are right there), and the server can't know. So this reports
 * visible/hidden transitions, plus a heartbeat while visible, and the server
 * skips endpoints that were in front recently.
 */
import { create } from "zustand";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  type NotificationPrefs,
} from "@dispatch/shared";
import { api } from "./api.js";

const PREFS_KEY = "cm:notification-prefs";

/* --------------------------------------------------------------- storage */

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

export function loadPrefs(): NotificationPrefs {
  try {
    const raw = backing()?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = NotificationPrefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_PREFS;
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

function savePrefs(prefs: NotificationPrefs): void {
  try {
    backing()?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

/* -------------------------------------------------------- device identity */

const DEVICE_ID_KEY = "cm:push-device-id";
const ENDPOINT_KEY = "cm:push-endpoint";
/** Shared with public/sw.js, whose `pushsubscriptionchange` has no localStorage. */
const PUSH_DEVICE_CACHE = "dispatch-push-device";
const PUSH_DEVICE_KEY = "/__push-device";

/**
 * This device's permanent push identity, minted on first use.
 *
 * The endpoint can't serve: the push service rotates it at will, and every
 * rotation used to leave the old registration on the server still receiving
 * pushes under the prefs it was registered with. Sending this lets the server
 * keep exactly one entry per device. Lost on a reinstall (localStorage goes with
 * the app), which is why Settings can also remove a device by hand.
 */
export function deviceId(): string {
  const store = backing();
  try {
    const known = store?.getItem(DEVICE_ID_KEY);
    if (known) return known;
    const fresh = crypto.randomUUID();
    store?.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // private mode — dedup by endpoint alone this time
  }
}

/** The endpoint this device last registered, if it is not `current`. */
function previousEndpoint(current: string): string | undefined {
  try {
    const last = backing()?.getItem(ENDPOINT_KEY);
    return last && last !== current ? last : undefined;
  } catch {
    return undefined;
  }
}

/** Remember what was just registered, here and where the service worker can see it. */
async function rememberRegistration(endpoint: string, id: string): Promise<void> {
  try {
    backing()?.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    /* best-effort */
  }
  try {
    const cache = await caches.open(PUSH_DEVICE_CACHE);
    await cache.put(PUSH_DEVICE_KEY, new Response(JSON.stringify({ deviceId: id, endpoint })));
  } catch {
    /* no Cache Storage — the worker falls back to oldSubscription alone */
  }
}

/** Register `sub` with the server as THIS device, retiring any older entry for it. */
async function register(sub: PushSubscription, prefs: NotificationPrefs): Promise<void> {
  const id = deviceId();
  await api.push.subscribe({
    subscription: sub.toJSON(),
    prefs,
    label: deviceLabel(),
    deviceId: id,
    replaces: previousEndpoint(sub.endpoint),
  });
  await rememberRegistration(sub.endpoint, id);
}

/** The device's IANA zone, so the server can evaluate quiet hours across DST. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Something recognisable in the Settings device list. Best-effort, never precise. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}

/* ---------------------------------------------------------- availability */

export type PushState =
  | "unsupported" // no PushManager here at all
  | "needs-install" // iOS Safari tab — push only exists for a home-screen app
  | "unsubscribed"
  | "subscribed";

/** True when this looks like iOS/iPadOS, where the home-screen rule applies. */
function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Macintosh; the touch points are what give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** True when the page is running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // The legacy Safari-only flag — still the reliable one on iOS.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext
  );
}

/**
 * Why push can't be set up here, phrased for display, or null when it can.
 *
 * The iOS cases are first because they are the ones with no error message
 * anywhere else: Safari simply doesn't expose `PushManager` in a tab, so the
 * feature looks broken rather than unavailable.
 */
export function pushUnavailableReason(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) {
    return "This origin isn't secure, so the browser withholds push. Reach Dispatch over HTTPS (or http://localhost) to use it.";
  }
  if (isIos() && !isStandalone()) {
    return "On iOS, push only works from an installed app. Tap Share → Add to Home Screen, then open Dispatch from that icon and enable it there.";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "This browser doesn't support Web Push.";
  }
  return null;
}

/* -------------------------------------------------------------- internals */

/** VAPID keys travel as base64url; `pushManager.subscribe` wants raw bytes. */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  // Returned as the backing ArrayBuffer rather than the view: lib.dom types
  // `applicationServerKey` as an ArrayBuffer-backed BufferSource, and a
  // `Uint8Array<ArrayBufferLike>` doesn't satisfy that.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  try {
    // `ready` rather than `getRegistration`: on a first load the worker is still
    // installing, and subscribing against a registration with no active worker
    // throws in Safari.
    return await navigator.serviceWorker.ready;
  } catch {
    return undefined;
  }
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- store */

interface PushStore {
  state: PushState;
  prefs: NotificationPrefs;
  /** The current subscription endpoint, or null. Identifies this device server-side. */
  endpoint: string | null;
  busy: boolean;
  error: string | null;
  /** A transient "that worked" line. Cleared by the next action. */
  notice: string | null;
  /** Read what's already registered and reconcile the server's copy. Safe to call twice. */
  hydrate: () => Promise<void>;
  /** Ask for permission (if needed) and register. Must be called from a click. */
  enable: () => Promise<PushState>;
  disable: () => Promise<void>;
  setPrefs: (next: NotificationPrefs) => void;
  /**
   * Send a sample push to this device, so "is it working" has an answer — and
   * so does "it isn't". Sets `notice` or `error`; never fails silently.
   */
  test: () => Promise<boolean>;
}

export const useWebPush = create<PushStore>((set, get) => ({
  state: pushSupported() ? "unsubscribed" : isIos() ? "needs-install" : "unsupported",
  prefs: loadPrefs(),
  endpoint: null,
  busy: false,
  error: null,
  notice: null,

  hydrate: async () => {
    if (!pushSupported()) {
      set({ state: isIos() && !isStandalone() ? "needs-install" : "unsupported" });
      return;
    }
    const sub = await existingSubscription();
    if (!sub) {
      set({ state: "unsubscribed", endpoint: null });
      return;
    }
    set({ state: "subscribed", endpoint: sub.endpoint });
    // Re-assert the registration on every load. It costs one request and it is
    // what heals the two states that otherwise fail silently: a device the
    // server forgot (registry wiped, or a different instance), and prefs edited
    // while the server was down.
    await register(sub, get().prefs).catch(() => undefined);
  },

  enable: async () => {
    const reason = pushUnavailableReason();
    if (reason) {
      set({ error: reason, state: isIos() && !isStandalone() ? "needs-install" : "unsupported" });
      return get().state;
    }
    set({ busy: true, error: null, notice: null });
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        set({ error: "Notification permission was not granted.", state: "unsubscribed" });
        return "unsubscribed";
      }
      const reg = await registration();
      if (!reg) throw new Error("no service worker");
      const { publicKey } = await api.push.key();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          // Required, and true is the only honest value: iOS enforces that every
          // push shows a notification anyway.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await register(sub, get().prefs);
      set({ state: "subscribed", endpoint: sub.endpoint });
      return "subscribed";
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not register for push." });
      return get().state;
    } finally {
      set({ busy: false });
    }
  },

  disable: async () => {
    const sub = await existingSubscription();
    set({ state: "unsubscribed", endpoint: null, error: null, notice: null });
    if (!sub) return;
    await api.push.unsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  },

  setPrefs: (next) => {
    savePrefs(next);
    set({ prefs: next });
    const endpoint = get().endpoint;
    if (!endpoint) return;
    // Fire-and-forget: localStorage already holds the truth, and `hydrate` on
    // the next load re-uploads it if this request never landed.
    void api.push.setPrefs(endpoint, next).catch(() => undefined);
  },

  test: async () => {
    const endpoint = get().endpoint;
    if (!endpoint) {
      set({ error: "This device isn't registered yet.", notice: null });
      return false;
    }
    set({ busy: true, error: null, notice: null });
    try {
      // The server sends synchronously and answers 502 with the push service's
      // own reason when it is refused, so this await is a real verdict. It used
      // to be swallowed, which made a total iOS outage look like a button that
      // does nothing at all.
      await api.push.test(endpoint);
      set({ notice: "Test push sent — it should arrive in a moment." });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "The test push could not be sent." });
      return false;
    } finally {
      set({ busy: false });
    }
  },
}));

/* -------------------------------------------------------------- presence */

/** How often we re-assert "still looking" while the app is visible. */
const HEARTBEAT_MS = 60_000;

/**
 * Tell the server when this device has the app in front of the human, so it can
 * skip pushing to a screen that is already showing the same thing. Idempotent —
 * calling it twice does not double the heartbeat.
 */
let presenceTimer: ReturnType<typeof setInterval> | undefined;
export function startPresenceReporting(): void {
  if (presenceTimer !== undefined) return;

  const report = (inFront: boolean) => {
    const endpoint = useWebPush.getState().endpoint;
    if (!endpoint) return;
    void api.push.presence(endpoint, inFront).catch(() => undefined);
  };
  const inFrontNow = () => document.visibilityState === "visible" && document.hasFocus();
  const sync = () => report(inFrontNow());

  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  // `pagehide` rather than `unload`: it is the one iOS actually fires, and a
  // device that closes the app without clearing presence would suppress its own
  // pushes until the TTL expired.
  window.addEventListener("pagehide", () => report(false));
  presenceTimer = setInterval(() => {
    if (inFrontNow()) report(true);
  }, HEARTBEAT_MS);
  sync();
}
