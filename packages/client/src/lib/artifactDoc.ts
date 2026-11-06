/**
 * The document an HTML or SVG artifact is rendered as, and the rules it runs
 * under.
 *
 * THE THREAT. An artifact is HTML an agent wrote — possibly after reading an
 * issue, a web page or a file that told it what to write. Run on Dispatch's own
 * origin, its script could read the access token out of storage and drive the
 * whole API, terminals included: arbitrary code on the host, from a web page.
 *
 * THE BOUNDARY is two independent layers, so neither has to be perfect:
 *
 *  1. `<iframe sandbox>` WITHOUT `allow-same-origin` ({@link ARTIFACT_SANDBOX}).
 *     The frame gets an opaque origin: no cookies, no real storage (the bridge
 *     below supplies a persisted stand-in), no DOM access to the parent, and every request it makes is cross-origin to Dispatch. The
 *     content arrives by `srcdoc`, never by a URL on this origin, so there is no
 *     address to open "in a new tab" where it would run unsandboxed.
 *  2. A CSP `<meta>` that is the FIRST thing in the document
 *     ({@link ARTIFACT_CSP}): no network at all — no http fetch, no CDN script,
 *     no remote image to smuggle data out in a URL. Only the frame's own
 *     `data:`/`blob:` URLs load. A policy can only be tightened
 *     by later markup, never loosened, so the artifact's own `<meta>` cannot
 *     undo it.
 *
 * Offline by design, not by accident: an artifact that renders only while some
 * CDN is up is a page that stops working on a plane and leaks every view to a
 * third party. The tool description tells the agent to inline what it needs.
 */
import { ARTIFACT_STORAGE_KEY_MAX, ARTIFACT_STORAGE_MAX_CHARS } from "@dispatch/shared";

/**
 * `allow-scripts` is the point of an HTML artifact. `allow-popups` (+ escape)
 * so a link with `target=_blank` opens a normal tab rather than dying silently;
 * that tab is the LINK's origin, never ours. `allow-modals` for `alert()` in a
 * prototype. Never `allow-same-origin`, never `allow-top-navigation`.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals";

/**
 * What the frame may load. Every source is the frame's own memory — `data:`
 * and `blob:` URLs it built from bytes it already has — and nothing is a
 * network origin, ours included.
 *
 * `blob:` is safe to allow where `http:` is not because a blob URL minted in an
 * opaque-origin document is itself opaque: it can only name bytes the page
 * already held, so loading one is no more than the `'unsafe-eval'` the page
 * already has. That is what makes the next four lines possible:
 *
 *  - `worker-src blob:` — Workers built from inline code. A worker made from a
 *    blob inherits this policy, so it is exactly as offline as the page.
 *  - `script-src … blob:` — the same code `import()`ed or `importScripts`ed
 *    from a blob, which is how bundled engines load their own chunks.
 *  - `connect-src data: blob:` — `fetch()` of embedded data and blobs:
 *    texture loaders, `WebAssembly.instantiateStreaming`. Still no http(s).
 *  - `font-src … blob:` — fonts unpacked at runtime.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data: blob:",
  "connect-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The marker every bridge message carries, so stray `postMessage`s are ignored. */
export const ARTIFACT_MESSAGE_TAG = "__dispatchArtifact";

export type ArtifactFrameMessage =
  | { kind: "error"; message: string }
  /** One `localStorage` write: `clear` (if set) happened before `set`; null removes. */
  | { kind: "storage"; clear?: true; set: Record<string, string | null> };

/**
 * Runs before any artifact script.
 *
 * ERRORS. Reports what the human can't see and the agent can't either:
 * uncaught errors, rejected promises, `console.error`, and — most usefully —
 * CSP violations, which is how "I loaded React from a CDN" shows up.
 *
 * STORAGE. An opaque origin has no `localStorage` — the getter throws
 * SecurityError — and granting a real one would take `allow-same-origin`, the
 * one token that hands the page Dispatch's token. So the bridge installs a
 * replacement: a synchronous in-memory Storage seeded from the snapshot the
 * pane fetched, writing every change through to the parent, which persists it
 * per artifact. Sync reads matter: game code does
 * `JSON.parse(localStorage.getItem("save"))` on line one, and an async API
 * would mean rewriting every page that uses it. The quota is enforced HERE,
 * synchronously, with the same `QuotaExceededError` a real browser throws, so
 * a page learns at the `setItem` that failed rather than from a server 413 it
 * never sees. `sessionStorage` gets the same shape, unpersisted.
 */
function bridge(storage: Record<string, string>): string {
  return `(() => {
  const TAG = ${JSON.stringify(ARTIFACT_MESSAGE_TAG)};
  const post = (m) => { try { parent.postMessage(Object.assign({ [TAG]: true }, m), "*"); } catch {} };
  let sent = 0;
  const send = (message) => {
    if (sent++ > 50) return;
    post({ kind: "error", message: String(message).slice(0, 2000) });
  };
  addEventListener("error", (e) => {
    const where = e.filename ? " (line " + e.lineno + ":" + e.colno + ")" : "";
    send((e.error && e.error.stack) || (e.message + where));
  });
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send("Unhandled rejection: " + ((r && (r.stack || r.message)) || String(r)));
  });
  addEventListener("securitypolicyviolation", (e) => {
    send("Blocked by the artifact sandbox (" + e.effectiveDirective + "): " + (e.blockedURI || "inline") +
      " — artifacts have no network; inline the resource, or build it as a data: or blob: URL.");
  });
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    send(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" "));
  };

  const MAX = ${ARTIFACT_STORAGE_MAX_CHARS};
  const KEY_MAX = ${ARTIFACT_STORAGE_KEY_MAX};
  const quota = (msg) => new DOMException(msg, "QuotaExceededError");
  const makeStorage = (seed, persist) => {
    const data = new Map(Object.entries(seed));
    let used = 0;
    for (const [k, v] of data) used += k.length + v.length;
    const api = {
      get length() { return data.size; },
      key(i) { const k = Array.from(data.keys())[i]; return k === undefined ? null : k; },
      getItem(k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem(k, v) {
        k = String(k); v = String(v);
        if (k.length > KEY_MAX) throw quota("Storage key is longer than " + KEY_MAX + " characters.");
        const prev = data.get(k);
        const next = used - (prev === undefined ? 0 : k.length + prev.length) + k.length + v.length;
        if (next > MAX) throw quota("The artifact's storage quota (" + MAX + " characters) has been exceeded.");
        data.set(k, v); used = next;
        if (persist) post({ kind: "storage", set: { [k]: v } });
      },
      removeItem(k) {
        k = String(k);
        const prev = data.get(k);
        if (prev === undefined) return;
        data.delete(k); used -= k.length + prev.length;
        if (persist) post({ kind: "storage", set: { [k]: null } });
      },
      clear() { data.clear(); used = 0; if (persist) post({ kind: "storage", clear: true, set: {} }); },
    };
    // Named-property access — localStorage.score = "3" — works on a real
    // Storage, and plenty of quick pages use it.
    const own = (t, p) => typeof p !== "string" || p in t;
    return new Proxy(api, {
      get: (t, p) => (own(t, p) ? Reflect.get(t, p) : (data.has(p) ? data.get(p) : undefined)),
      set: (t, p, v) => { if (own(t, p)) return Reflect.set(t, p, v); t.setItem(p, v); return true; },
      deleteProperty: (t, p) => { if (own(t, p)) return Reflect.deleteProperty(t, p); t.removeItem(p); return true; },
      has: (t, p) => (typeof p === "string" && data.has(p)) || p in t,
      ownKeys: () => Array.from(data.keys()),
      getOwnPropertyDescriptor: (t, p) =>
        typeof p === "string" && data.has(p)
          ? { value: data.get(p), enumerable: true, configurable: true, writable: true }
          : undefined,
    });
  };
  const install = (name, value) => {
    try { Object.defineProperty(window, name, { value, configurable: true, enumerable: true }); } catch {}
  };
  install("localStorage", makeStorage(${jsonForScript(storage)}, true));
  install("sessionStorage", makeStorage({}, false));
})();`;
}

/**
 * JSON that is safe inside a `<script>`. `<` is escaped so a stored value of
 * `</script><script>…` cannot close the bridge and run as markup — the storage
 * is written by the page, and the page is untrusted. U+2028/9 are line
 * terminators in older JS parsers.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Close-tag defence for the bridge itself: a `</script` in it would end it
 * early. Storage is already escaped by {@link jsonForScript}; this covers the
 * hand-written code if someone edits it.
 */
function inlineScript(code: string): string {
  return `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
}

function head(storage: Record<string, string>, extra = ""): string {
  return (
    // The doctype FIRST, or the frame renders in quirks mode — and the
    // artifact's own doctype, arriving after our head, would be ignored.
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    inlineScript(bridge(storage)) +
    extra
  );
}

/**
 * The `srcdoc` for an html or svg artifact. `storage` is the artifact's saved
 * `localStorage` as of this render.
 *
 * The artifact's markup is appended AFTER our head, not parsed and merged: an
 * HTML parser already folds a second `<html>`/`<head>` into the first, and its
 * `<meta>`/`<style>`/`<title>` land in the head we opened. Parsing it ourselves
 * would be a second parser whose disagreements with the browser's are exactly
 * where a sandbox escape would hide.
 */
export function buildArtifactDocument(
  type: "html" | "svg",
  content: string,
  storage: Record<string, string> = {},
): string {
  if (type === "svg") {
    return (
      head(
        storage,
        "<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}" +
          "body>svg{max-width:100%;max-height:100vh;height:auto}</style>",
      ) +
      "</head><body>" +
      content +
      "</body></html>"
    );
  }
  return head(storage) + content;
}

/**
 * Narrow an arbitrary `message` event payload to one of ours. Everything in a
 * storage write is checked, since the page wrote it: string keys within the
 * key limit, string-or-null values. A malformed write is dropped whole.
 */
export function asArtifactMessage(data: unknown): ArtifactFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d[ARTIFACT_MESSAGE_TAG] !== true) return null;
  if (d.kind === "error" && typeof d.message === "string") {
    return { kind: "error", message: d.message.slice(0, 2000) };
  }
  if (d.kind === "storage" && d.set && typeof d.set === "object" && !Array.isArray(d.set)) {
    const set: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(d.set as Record<string, unknown>)) {
      if (!k || k.length > ARTIFACT_STORAGE_KEY_MAX) return null;
      if (v !== null && typeof v !== "string") return null;
      set[k] = v;
    }
    return d.clear === true ? { kind: "storage", clear: true, set } : { kind: "storage", set };
  }
  return null;
}
