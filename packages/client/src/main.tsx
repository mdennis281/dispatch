import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import {
  hydrateFromMock,
  useConnection,
  useChats,
} from "./stores/index.js";
import { ws } from "./lib/ws.js";
import { RunnerLogWindow } from "./components/panels/RunnerLogWindow.js";
import { capturePwaInstall } from "./lib/pwaInstall.js";
import { useWebPush, startPresenceReporting } from "./lib/webPush.js";
import { focusAttentionTarget } from "./components/attention/focus.js";
import { watchSystemTheme, syncThemeColor } from "./stores/theme.js";
import "./index.css";
import { initializeAuth, useAuth } from "./stores/auth.js";
import type { AuthSessionResponse } from "@dispatch/shared";
import { startLiveApp } from "./lib/live.js";
import { ProgramPreview } from "./preview/program/ProgramPreview.js";

// The palette itself was applied by the inline script in index.html (before the
// first paint); this only subscribes to later OS changes, which matters solely
// while the preference is "system".
watchSystemTheme();
// …and once for the window frame, which the pre-paint script CANNOT do: the
// `theme-color` meta it would have to edit is parsed after that script runs, so
// on a light theme the window buttons keep the dark slab from the generated
// default until something re-applies. `applyTheme` covers every later change;
// this covers the load. Runs after `./index.css` above (imports are evaluated
// first), so the palette it reads from is present.
syncThemeColor();

// A detached log window (opened via openRunnerLogWindow) loads this same bundle
// with `?logs=<runnerId>` — render only the read-only log terminal for it.
const isLogWindow = new URLSearchParams(location.search).has("logs");

// A DEV-only design surface for the Program ("workflows") proposal, reachable
// at /program-preview. The dev server's SPA fallback hands index.html to every
// path, so a pathname check is all the routing this needs — and it is gated on
// DEV so no production bundle can ever land on it.
const isProgramPreview =
  import.meta.env.DEV && location.pathname.startsWith("/program-preview");

// The full app shell — the only mode that should open a socket, run auth, or
// register PWA plumbing. Both the log popup and the preview are standalone
// renders that would otherwise fight the app for those globals.
const isShell = !isLogWindow && !isProgramPreview;

// Wire the reactive data spine (active chat → transcript, active project → panels)
// then open the WS. The backend's `hello` triggers the REST hydrate, so live data
// flows into the stores the moment we connect; a reconnect resyncs automatically.
if (isShell) {
  void initializeAuth().then(() => {
    const status = useAuth.getState().status;
    if (!status?.enabled || useAuth.getState().user) {
      startLiveApp();
    }
  });
}

// Dev-only fallback: if no backend ever opens the socket, seed the offline mock
// so the shell still renders (design work / screenshots). A real `hello` replaces
// it via hydrateFromServer, so this never masks live data. Skipped for a log
// window, which must reflect the real backend (never mock output).
if (import.meta.env.DEV && isShell) {
  setTimeout(() => {
    const connected = useConnection.getState().state === "open";
    const empty = useChats.getState().order.length === 0;
    if (!connected && empty) {
      hydrateFromMock();
      // Tell the connecting screen to stand down: this shell is showing mock
      // data deliberately, and covering it with "the server isn't running" is
      // exactly what the seed exists to avoid.
      useConnection.getState().noteMockSeeded();
    }
  }, 1200);
}

// Register the service worker that makes this installable (see public/sw.js).
// Production only: in dev it would sit in front of Vite's module graph and serve
// a stale shell after an HMR-triggered reload. A log window is a child popup of
// an already-registered client and has nothing to add.
if (import.meta.env.PROD && isShell && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      // Not fatal — the app runs fine unregistered, it just isn't installable.
      console.warn("[dispatch] service worker registration failed:", err);
    });
  });
}

// Watch for the browser's install offer NOW, at module scope: Chromium fires
// `beforeinstallprompt` as soon as the criteria are met, which on a warm load
// happens before React's first render — a listener added in an effect misses it
// and the install card never appears. See lib/pwaInstall.ts.
if (isShell) capturePwaInstall();

// Clicking a desktop notification comes back one of two ways, because the
// service worker can't reach into a page that isn't running yet:
//   - app already open → the SW focuses it and posts the target here;
//   - app closed       → the SW opens a window with the target in the hash.
if (isShell) {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const d = e.data as { type?: string; chatId?: string; permissionRequestId?: string };
      if (d?.type === "auth-session") {
        useAuth.getState().applySession(e.data.session as AuthSessionResponse);
        ws.connect();
        return;
      }
      if (d?.type === "attention-focus" && d.chatId) {
        focusAttentionTarget(d.chatId, d.permissionRequestId);
      }
    });
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const chatId = hash.get("chat");
  if (chatId) {
    // Clear it first: the chat is about to become app state, and a stale hash
    // would re-select it on every reload for the rest of the session.
    history.replaceState(null, "", location.pathname + location.search);
    // After hydrate, or setActiveChat targets a chat the store hasn't seen.
    window.setTimeout(() => focusAttentionTarget(chatId, hash.get("attn") ?? undefined), 400);
  }
}

// Reconcile this device's push subscription with the server on every load, and
// start reporting whether the app is in front. Both are cheap and both heal a
// failure that is otherwise silent: a subscription the server forgot, and pushes
// arriving on a screen you're already looking at. Deferred to `load` so it never
// competes with first paint, and skipped for the log popup, which is a child of
// an already-registered client.
if (isShell) {
  window.addEventListener("load", () => {
    void useWebPush
      .getState()
      .hydrate()
      .then(() => startPresenceReporting());
  });
}

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <StrictMode>
    {isLogWindow ? <RunnerLogWindow /> : isProgramPreview ? <ProgramPreview /> : <App />}
  </StrictMode>,
);
