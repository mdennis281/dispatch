/**
 * Popping an artifact out into a window of its own, and keeping the app's pane
 * and that window from both being live views of it.
 *
 * WHY only one live view: a live view reads and writes the artifact's
 * persisted `localStorage` (components/artifacts/useArtifactStorage). Two of
 * them each seed their frame from their own mirror and PATCH the server with
 * their own writes, so a game saved in the window is overwritten by the pane's
 * stale copy on its next save, and vice versa — silently, with no error
 * anywhere. So while an artifact is out, the pane shows a placeholder and does
 * not mount the view at all.
 *
 * The two sides talk over a `BroadcastChannel`, not through the `Window`
 * handle `window.open` returns, because the handle does not survive the app
 * reloading: an F5 in the main window would forget every pop-out, and the pane
 * would come back live beside a window that still is. The channel is
 * per-origin, so the app asks "who's out there?" on start and every window
 * answers. The handle is still kept while we have it — it is the only reliable
 * way to focus a window from a click (a window focusing ITSELF on a channel
 * message has no user activation to do it with) and to notice a window that
 * died without a `pagehide`.
 *
 * The channel also carries `latest`: the window has no transcript, so the
 * cards that feed `noteLatest` in the app never render there. The app relays
 * every newer version it learns of for an artifact that is out, and the window
 * feeds it into its own store — a separate JS context with its own zustand
 * instance, so nothing reaches it otherwise. The window's own socket may feed
 * the same store from a server event too; `noteLatest` only moves forward, so
 * two sources agreeing is a no-op.
 */
import { useArtifactView, artifactKey } from "../stores/artifacts.js";

const CHANNEL = "dispatch:artifact-window";

/**
 * After a window goes without saying its storage is settled — closed by its
 * own ✕, which only gets a `keepalive` PATCH off in `pagehide` — the pane waits
 * this long before it fetches that storage, so the fetch doesn't overtake the
 * save. Also long enough to absorb a pop-out's own reload, where `gone` is
 * followed by `present` within a few hundred ms and the pane should not flash
 * live in between.
 */
const GONE_GRACE_MS = 700;
/** How often to look for a window that closed without telling us. */
const CLOSED_POLL_MS = 1000;
/** If a window asked to come back hasn't answered by now, it is hung — take it back anyway. */
const BRING_BACK_TIMEOUT_MS = 5000;

export type ArtifactWindowMsg =
  /** app → windows: say if you're there (sent when an app tab starts). */
  | { type: "who" }
  /** window → app: I am a live view of this artifact. */
  | { type: "present"; chatId: string; id: string; title?: string; version?: number }
  /** window → app: I'm going. `settled` = my last storage write has landed. */
  | { type: "gone"; chatId: string; id: string; settled: boolean }
  /** app → window: come to the front. */
  | { type: "focus"; chatId: string; id: string }
  /** app → window: hand the artifact back to the pane and close. */
  | { type: "bring-back"; chatId: string; id: string }
  /** app → window: the newest version the app has seen. */
  | { type: "latest"; chatId: string; id: string; version: number };

export interface ArtifactWindowTarget {
  chatId: string;
  id: string;
  /** A pinned version, or null to follow the newest. */
  version: number | null;
}

/** `?artifact=<chatId>/<artifactId>[&v=<n>]` — what `main.tsx` mounts the window view for. */
export function artifactWindowUrl(target: ArtifactWindowTarget, origin: string): string {
  const v = target.version != null ? `&v=${target.version}` : "";
  return `${origin}/?artifact=${encodeURIComponent(target.chatId)}/${encodeURIComponent(target.id)}${v}`;
}

export function parseArtifactWindowParams(search: string): ArtifactWindowTarget | null {
  // Split the RAW value, then decode each half. `URLSearchParams.get` decodes
  // `%2F` too, after which a slash inside an id is indistinguishable from the
  // separator.
  const raw = /(?:^\?|&)artifact=([^&]*)/.exec(search)?.[1];
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  let chatId: string;
  let id: string;
  try {
    chatId = decodeURIComponent(raw.slice(0, slash));
    id = decodeURIComponent(raw.slice(slash + 1));
  } catch {
    return null;
  }
  const v = Number(new URLSearchParams(search).get("v"));
  return { chatId, id, version: Number.isInteger(v) && v > 0 ? v : null };
}

/**
 * The window NAME, one per artifact. Naming it is what makes a second "Open in
 * window" for the same artifact reuse its window instead of stacking another
 * live view beside it. Not the version: switching versions happens inside.
 */
export function artifactWindowName(chatId: string, id: string): string {
  return `dp-artifact-${chatId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function isArtifactWindowMsg(x: unknown): x is ArtifactWindowMsg {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.type === "who") return true;
  if (typeof m.chatId !== "string" || typeof m.id !== "string") return false;
  if (m.type === "latest") return typeof m.version === "number";
  return (
    m.type === "present" || m.type === "gone" || m.type === "focus" || m.type === "bring-back"
  );
}

/**
 * The window features for `window.open`.
 *
 * In the INSTALLED app, none. What Chromium does with each form, read from
 * its source (main, 2026-11; not yet confirmed on a real build):
 *
 *  - No features → blink's `GetWindowFeaturesFromString` leaves `is_popup`
 *    false (the HTML "popup window is requested" rule), so the disposition is
 *    NEW_FOREGROUND_TAB. `navigation_capturing_process.cc` then sees an
 *    auxiliary context opened from an app window on an in-scope URL
 *    (`ShouldAuxiliaryContextsKeepSameContainer`, `kPwaNavigationCapturing`
 *    on by default) and calls `CreateWebAppWindowFromNavigationParams` with
 *    `is_popup=false` — a full TYPE_APP window, i.e. another Dispatch window.
 *  - `popup=yes`, or any size/position token → `is_popup` true → NEW_POPUP →
 *    `browser_navigator.cc` coerces it to `CreateForAppPopup`, a TYPE_APP_POPUP.
 *
 * Contrary to what this feature was planned on, the popup is NOT excluded
 * from the overlay in source: `WebAppBrowserController::
 * AppUsesWindowControlsOverlay()` only checks the app's effective display
 * mode, and both window types report `display-mode: window-controls-overlay`
 * from `BrowserWebContentsDelegate::GetDisplayMode` once the per-app WCO
 * toggle is on. The full window is still the one wanted: it is a first-class
 * app window (resizable, remembered, grouped with the app), not a dialog.
 *
 * In a browser TAB there is no app window to get, and a featureless open
 * lands in a new tab — not what "Open in window" says — so there it asks for
 * a popup, sized like the pane's share of a laptop screen.
 */
export function artifactWindowFeatures(installed: boolean): string | undefined {
  return installed ? undefined : "popup=yes,width=1000,height=760";
}

function isInstalledWindow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return (
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  );
}

let channel: BroadcastChannel | null | undefined;
function getChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  }
  return channel;
}
function post(msg: ArtifactWindowMsg): void {
  getChannel()?.postMessage(msg);
}

/* ───────────────────────────── app side ───────────────────────────── */

const handles = new Map<string, Window>();
const goneTimers = new Map<string, number>();
let pollTimer: number | undefined;
let hubStarted = false;

function cancelGone(key: string): void {
  const t = goneTimers.get(key);
  if (t !== undefined) window.clearTimeout(t);
  goneTimers.delete(key);
}

function scheduleGone(chatId: string, id: string, graceMs: number): void {
  const key = artifactKey(chatId, id);
  cancelGone(key);
  const done = () => {
    goneTimers.delete(key);
    handles.delete(key);
    useArtifactView.getState().unmarkPopped(chatId, id);
  };
  if (graceMs <= 0) done();
  else goneTimers.set(key, window.setTimeout(done, graceMs));
}

function ensurePoll(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    for (const [key, win] of handles) {
      if (!win.closed) continue;
      handles.delete(key);
      const [chatId, id] = splitKey(key);
      // A window that closed cleanly already said `gone`; this catches the
      // ones that crashed or were killed and never got to.
      if (!goneTimers.has(key)) scheduleGone(chatId, id, GONE_GRACE_MS);
    }
    if (handles.size === 0) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }, CLOSED_POLL_MS);
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Listen for pop-outs. Idempotent; called by the app shell at boot so a window
 * that outlived an app reload is found before the pane renders live beside it.
 */
export function startArtifactWindowHub(): void {
  if (hubStarted) return;
  const ch = getChannel();
  if (!ch) return;
  hubStarted = true;
  ch.addEventListener("message", (e: MessageEvent) => {
    const msg: unknown = e.data;
    if (!isArtifactWindowMsg(msg)) return;
    if (msg.type === "present") {
      const key = artifactKey(msg.chatId, msg.id);
      cancelGone(key);
      useArtifactView.getState().markPopped(msg.chatId, msg.id, {
        ...(msg.title !== undefined ? { title: msg.title } : {}),
        ...(msg.version !== undefined ? { version: msg.version } : {}),
      });
      // Catch a new window up on what the app already knows — it may have
      // been opened (or reloaded) after the version it should be showing.
      const known = useArtifactView.getState().latest[key];
      if (known) post({ type: "latest", chatId: msg.chatId, id: msg.id, version: known });
    } else if (msg.type === "gone") {
      scheduleGone(msg.chatId, msg.id, msg.settled ? 0 : GONE_GRACE_MS);
    }
  });
  // Relay every newer version the app learns of to the window showing it.
  useArtifactView.subscribe((s, prev) => {
    if (s.latest === prev.latest) return;
    for (const [key, version] of Object.entries(s.latest)) {
      if (prev.latest[key] === version || !(key in s.popped)) continue;
      const [chatId, id] = splitKey(key);
      post({ type: "latest", chatId, id, version });
    }
  });
  post({ type: "who" });
}

/**
 * Pop an artifact out. Returns false when the browser refused to open a window
 * (a popup blocker), in which case nothing changed.
 */
export function openArtifactWindow(target: ArtifactWindowTarget, title?: string): boolean {
  startArtifactWindowHub();
  const { chatId, id } = target;
  const key = artifactKey(chatId, id);
  // Placeholder FIRST, before the window exists: this unmounts the pane's live
  // view, whose unmount sends its pending storage write — so that write is on
  // the wire before the new window has even started loading the bundle that
  // will fetch it.
  cancelGone(key);
  useArtifactView.getState().markPopped(chatId, id, title !== undefined ? { title } : {});
  const url = artifactWindowUrl(target, location.origin);
  const features = artifactWindowFeatures(isInstalledWindow());
  const win = window.open(url, artifactWindowName(chatId, id), features);
  if (!win) {
    useArtifactView.getState().unmarkPopped(chatId, id);
    return false;
  }
  handles.set(key, win);
  ensurePoll();
  return true;
}

export function focusArtifactWindow(chatId: string, id: string): void {
  const win = handles.get(artifactKey(chatId, id));
  if (win && !win.closed) win.focus();
  // Also ask it to focus itself: after an app reload there is no handle, and
  // while Chromium may refuse a focus() without user activation, it is the
  // only lever left.
  post({ type: "focus", chatId, id });
}

export function bringBackArtifact(chatId: string, id: string): void {
  const key = artifactKey(chatId, id);
  post({ type: "bring-back", chatId, id });
  // The window answers with `gone {settled:true}` once its last save landed.
  // One that never answers is hung or was never ours to command (opened from
  // a URL bar, say) — reclaim the pane rather than leave a dead placeholder.
  cancelGone(key);
  goneTimers.set(
    key,
    window.setTimeout(() => {
      const win = handles.get(key);
      if (win && !win.closed) win.close();
      goneTimers.delete(key);
      handles.delete(key);
      useArtifactView.getState().unmarkPopped(chatId, id);
    }, BRING_BACK_TIMEOUT_MS),
  );
}

/* ─────────────────────────── window side ─────────────────────────── */

export interface ArtifactWindowPresence {
  /** (Re)announce, e.g. once the title is known or the version changes. */
  announce(info: { title?: string; version?: number }): void;
  /** Say goodbye explicitly. `settled` = storage writes have landed. */
  leave(settled: boolean): void;
  dispose(): void;
}

/**
 * The pop-out's half: announce itself, answer `who`, obey `focus` and
 * `bring-back` addressed to it, and say `gone` when the page goes away.
 */
export function joinArtifactWindowChannel(
  chatId: string,
  id: string,
  handlers: { onBringBack: () => void },
): ArtifactWindowPresence {
  const ch = getChannel();
  let info: { title?: string; version?: number } = {};
  let left = false;
  const present = () => {
    if (!left) post({ type: "present", chatId, id, ...info });
  };
  const onMessage = (e: MessageEvent) => {
    const msg: unknown = e.data;
    if (!isArtifactWindowMsg(msg)) return;
    if (msg.type === "who") return present();
    if (msg.type === "present" || msg.type === "gone") return;
    if (msg.chatId !== chatId || msg.id !== id) return;
    if (msg.type === "focus") window.focus();
    else if (msg.type === "bring-back") handlers.onBringBack();
    else if (msg.type === "latest") useArtifactView.getState().noteLatest(chatId, id, msg.version);
  };
  // `pagehide`, not `beforeunload`: it fires on close AND on reload, and
  // doesn't disable the bfcache. Unsettled — the storage hook's own pagehide
  // handler is sending its last write as a keepalive at the same moment.
  const onHide = () => {
    if (left) return;
    left = true;
    post({ type: "gone", chatId, id, settled: false });
  };
  ch?.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onHide);
  present();
  return {
    announce(next) {
      info = next;
      present();
    },
    leave(settled) {
      if (left) return;
      left = true;
      post({ type: "gone", chatId, id, settled });
    },
    dispose() {
      ch?.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onHide);
    },
  };
}
