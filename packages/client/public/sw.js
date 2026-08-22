/**
 * Service worker for the Dispatch PWA.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * Dispatch is a control plane for live agents talking to a server on localhost.
 * Caching `/api` would serve stale truth about running work, which is worse than
 * any offline benefit — so API requests stay network-only. The worker may add
 * an in-memory access token or refresh a session, but never caches a response.
 * There is no background sync and no API cache.
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
const CACHE = "dispatch-shell-v3";
let accessToken = null;
let refreshInFlight = null;

self.addEventListener("message", (event) => {
  if (event.data?.type === "auth-token") accessToken = event.data.token || null;
});

async function refreshSession(retryConflict = true) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const response = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-dispatch-session": "refresh" },
    });
    if (response.status === 409 && retryConflict) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      refreshInFlight = null;
      return refreshSession(false);
    }
    if (!response.ok) { accessToken = null; return false; }
    const session = await response.json();
    accessToken = session.accessToken;
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "auth-session", session });
    return true;
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/**
 * `new Request(request, { headers })` inherits the original's mode, and a
 * `no-cors` request — which is what the browser issues for EVERY same-origin
 * subresource, `<img src="/api/…">` included — silently drops any header that
 * isn't CORS-safelisted. `authorization` is not, so the token never reaches the
 * wire and the request comes back 401. Re-issue such a GET in `same-origin`
 * mode, where the header survives.
 */
function withToken(request) {
  const headers = new Headers(request.headers);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (request.mode === "no-cors" && request.method === "GET") {
    return fetch(request.url, {
      headers,
      method: "GET",
      mode: "same-origin",
      credentials: "same-origin",
      cache: request.cache,
      redirect: request.redirect,
    });
  }
  return fetch(new Request(request, { headers }));
}

async function authenticatedFetch(request) {
  let response = await withToken(request);
  const path = new URL(request.url).pathname;
  if (response.status === 401 && !path.startsWith("/api/auth/") && await refreshSession()) {
    response = await withToken(request);
  }
  return response;
}

/**
 * An API call ORIGINATING IN THIS WORKER (push re-subscription), which the
 * `fetch` handler below never sees — that only intercepts requests made by a
 * page. Auth is optional in Dispatch, so a missing token is not an error; but if
 * a session exists we must attach it, and a cold worker woken by a push has no
 * token in memory yet and has to refresh one first.
 */
async function apiFetch(path, init = {}) {
  if (!accessToken) await refreshSession().catch(() => false);
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return fetch(path, { ...init, headers, credentials: "same-origin", mode: "same-origin" });
}

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

/** Live server truth — never cached (API requests may receive auth headers). */
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
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") && !url.pathname.startsWith("/api/auth/")) {
    event.respondWith(authenticatedFetch(request));
    return;
  }
  if (request.method !== "GET") return;
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
/**
 * Server-sent Web Push — the ONLY notification path that reaches a phone.
 *
 * Everything else in this app raises notifications from the page (see
 * lib/browserNotify.ts), which requires the page to still be running. iOS
 * suspends a backgrounded home-screen web app outright: the socket drops, the
 * timers stop, and nothing of ours runs again until the icon is tapped. A push
 * is what wakes this worker when the app is closed.
 *
 * ── The rule that makes this handler look paranoid ─────────────────────────
 * WebKit REQUIRES a visible notification for every push. A handler that returns
 * without calling `showNotification` is treated as a silent push, and after a
 * handful of them iOS revokes the subscription outright — the failure mode being
 * that notifications work for a day and then stop with no error anywhere. So:
 *
 *   - `event.waitUntil` always wraps a `showNotification` — never a bare async
 *     function that might resolve without displaying anything;
 *   - an unparseable or empty payload still shows a generic notification rather
 *     than bailing;
 *   - FILTERING IS NOT DONE HERE. Which events a device wants is decided
 *     server-side (services/push.ts) precisely because dropping a push locally
 *     is the thing that costs you the subscription.
 */
/**
 * One notification per CHAT, not per attention item.
 *
 * Six things happening in one chat used to be six rows in the tray, and clearing
 * them was six swipes. They collapse into one that says how many are waiting.
 */
const chatTag = (chatId) => (chatId ? `chat:${chatId}` : "dispatch");

/**
 * Is this device subscribed through Apple's push service?
 *
 * Compares the parsed HOSTNAME, not a substring: `https://evil.test/?x=web.
 * push.apple.com` contains the name without being Apple, and the answer here
 * decides whether it is safe to display nothing. Mirrors `isAppleEndpoint` in
 * services/push.ts.
 *
 * Fails SAFE — an endpoint it cannot read is treated as Apple. Being wrong that
 * way shows one unnecessary notification on a desktop; being wrong the other way
 * costs an iPhone its subscription and stops notifications for days.
 */
async function isApplePushDevice() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return true;
    return new URL(sub.endpoint).hostname === "web.push.apple.com";
  } catch {
    return true;
  }
}

/** Best-effort app-icon badge. Absent on Linux Chrome and in dev; never fatal. */
async function setBadge(count) {
  try {
    if (typeof count !== "number") return; // omitted — leave the badge alone
    if (count > 0) await self.navigator.setAppBadge?.(count);
    else await self.navigator.clearAppBadge?.();
  } catch {
    /* unsupported here */
  }
}

/**
 * Render a chat's CURRENT state into the tray.
 *
 * Every push carries the whole state of one chat rather than a delta, which is
 * what makes this safe to run out of order and what lets the push service
 * collapse queued messages by `Topic` (see `topicForChat` in services/push.ts).
 */
async function renderChatNotification(data) {
  const tag = chatTag(data?.chatId);

  // Close what this push supersedes. On Chrome `tag` alone would do it, but iOS
  // ignores `tag` outright (WebKit bug 258922, open since 2023), so without an
  // explicit close every push stacks another row on the phone.
  try {
    for (const n of await self.registration.getNotifications({ tag })) n.close();
  } catch {
    /* older WebKit answered this with an empty list; `tag` still helps on Chrome */
  }

  await setBadge(data?.badge);

  if (data && data.outstanding === 0) {
    // A withdrawal: the reason is gone, so nothing replaces what we just closed.
    //
    // The push service never sends one of these to an Apple endpoint, because a
    // push that displays nothing is what makes iOS revoke the subscription. This
    // re-checks it HERE anyway: the cost of being wrong is that notifications
    // stop working days later with no error anywhere, and the check is one await.
    if (!(await isApplePushDevice())) return;
    await self.registration.showNotification("Dispatch", {
      body: "That's been handled.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag,
    });
    return;
  }

  const more = data && data.outstanding > 1 ? ` (+${data.outstanding - 1} more)` : "";
  await self.registration.showNotification((data?.title || "Dispatch") + more, {
    body: data?.body || "An agent needs you.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag,
    // Replacing a notification must not buzz a second time for something the
    // human has already been told about; a genuinely new one still alerts,
    // because there was nothing there to replace.
    renotify: false,
    requireInteraction: !!data?.sticky,
    data: data
      ? {
          type: "attention-focus",
          chatId: data.chatId,
          permissionRequestId: data.permissionRequestId,
          url: data.url,
        }
      : null,
  });
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    /* fall through to the generic notification below */
  }

  // Never a bare async fn that might resolve without displaying anything — see
  // the header note above. `renderChatNotification` shows something on every
  // path except the withdrawal, which is gated on not being an Apple endpoint.
  event.waitUntil(
    renderChatNotification(data).catch(() =>
      self.registration.showNotification("Dispatch", {
        body: data?.body || "An agent needs you.",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: chatTag(data?.chatId),
      }),
    ),
  );
});

/**
 * The push service rotated this device's endpoint (it does this on its own
 * schedule, and iOS does it after a reinstall). Re-subscribe with the same
 * application server key and tell the server, or the device goes quiet with
 * nothing on either end reporting a problem.
 */
/**
 * VAPID keys travel as base64url; `pushManager.subscribe` wants raw bytes.
 * Passing the string straight through throws, which would make the whole
 * re-subscription below fail silently — the device simply stops receiving.
 */
function applicationServerKey(base64) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        // The old subscription's key is already a BufferSource; a freshly
        // fetched one is base64url and has to be decoded first.
        const key =
          event.oldSubscription?.options?.applicationServerKey ??
          applicationServerKey(
            await apiFetch("/api/push/key")
              .then((r) => r.json())
              .then((j) => j.publicKey),
          );
        const fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await apiFetch("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify({ subscription: fresh.toJSON() }),
        });
        if (event.oldSubscription) {
          await apiFetch("/api/push/unsubscribe", {
            method: "POST",
            body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
          }).catch(() => undefined);
        }
      } catch {
        // Nothing more to try from here — the next app launch re-subscribes.
      }
    })(),
  );
});

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
        // A test push carries no chat. Focusing the window is the whole of the
        // right behaviour there; posting a focus request for chat "" would send
        // the UI looking for a chat that doesn't exist.
        if (data.chatId) app.postMessage(data);
        return;
      }
      if (!data.chatId) {
        await self.clients.openWindow("/");
        return;
      }
      const params = new URLSearchParams({ chat: data.chatId });
      if (data.permissionRequestId) params.set("attn", data.permissionRequestId);
      await self.clients.openWindow(`/#${params.toString()}`);
    })(),
  );
});
