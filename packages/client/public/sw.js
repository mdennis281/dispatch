/**
 * Service worker for the Dispatch PWA.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * Dispatch is a control plane for live agents talking to a server on localhost.
 * Caching `/api` would serve stale truth about running work, which is worse than
 * any offline benefit — so every non-navigation, non-asset request is passed
 * straight through, untouched. There is no background sync and no API cache.
 *
 * What it IS for:
 *   1. Installability. A Chromium PWA wants a service worker with a fetch
 *      handler before it will offer "Install", and being installable is the
 *      whole point — that is what gives the app its own window, its own taskbar
 *      identity, and its own icon.
 *   2. A shell that survives the server being down. The launcher starts the
 *      server before opening the window, but a server that dies mid-session
 *      would otherwise replace the app with Chrome's dinosaur. Falling back to
 *      a cached shell keeps the window looking like the app while it retries.
 *
 * Navigation is network-FIRST, never cache-first: a freshly published payload
 * must never be shadowed by a stale index.html holding references to asset
 * hashes that no longer exist on disk.
 */

/** Bump to evict every previous shell. Old caches are dropped on activate. */
const CACHE = "dispatch-shell-v1";

/** The minimum needed to render something recognisable with no network. */
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  // Take over as soon as this worker is ready rather than waiting for every tab
  // to close — an installed app is often a single long-lived window that would
  // otherwise never hand over.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Individually, so one 404 during development can't fail the whole install.
      Promise.allSettled(SHELL.map((url) => cache.add(url))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Live server truth — never cached, never intercepted. */
const isLiveData = (url) => url.pathname.startsWith("/api") || url.pathname.startsWith("/ws");

/**
 * Vite emits content-hashed filenames under /assets, so a hit is guaranteed to
 * be the exact bytes that name refers to — the one place cache-first is not
 * just safe but strictly correct.
 */
const isHashedAsset = (url) =>
  url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveData(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          // Keep the shell current so the fallback below stays useful.
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match("/");
          if (cached) return cached;
          return new Response(
            "<!doctype html><meta charset=utf-8><title>Dispatch</title>" +
              "<body style=\"background:#14171B;color:#8b9198;font:14px system-ui;" +
              'display:grid;place-items:center;height:100vh;margin:0">' +
              "<p>The Dispatch server isn't responding. Start it and reload.</p>",
            { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
          );
        }
      })(),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
  }
});

/**
 * Clicking an Attention notification should land you on the thing that needs
 * you, not merely on the app.
 *
 * The notification carries `data` shaped like the client's
 * `AttentionFocusMessage` (see `lib/browserNotify.ts`). We focus an existing
 * window if there is one — an installed PWA usually has exactly one, and opening
 * a second would fork the session UI — and only open a new one when the app is
 * fully closed, in which case the target rides in on the URL hash because there
 * is no client to postMessage to yet.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (!data || data.type !== "attention-focus") return;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // The log popup loads the same bundle with ?logs=… and renders only a
      // terminal — it can't show a chat, so never hand it the focus request.
      const app = clientList.find((c) => !new URL(c.url).searchParams.has("logs"));
      if (app) {
        await app.focus();
        app.postMessage(data);
        return;
      }
      const params = new URLSearchParams({ chat: data.chatId });
      if (data.permissionRequestId) params.set("attn", data.permissionRequestId);
      await self.clients.openWindow(`/#${params.toString()}`);
    })(),
  );
});
