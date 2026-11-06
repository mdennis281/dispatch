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
 *  - `style-src … blob:` — a bundled stylesheet, which the asset loader below
 *    links as a blob URL.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  "style-src 'unsafe-inline' blob:",
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
  /** A bundle-mode frame is listening and wants its page and assets. */
  | { kind: "boot-ready" }
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
function bridge(storage: Record<string, string>, bundle = false): string {
  return `(() => {
  const TAG = ${JSON.stringify(ARTIFACT_MESSAGE_TAG)};
  const post = (m) => { try { parent.postMessage(Object.assign({ [TAG]: true }, m), "*"); } catch {} };
  let sent = 0;
  const send = (message) => {
    if (sent++ > 50) return;
    post({ kind: "error", message: String(message).slice(0, 2000) });
  };
  const reporters = () => {
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
        " — artifacts have no network; inline the resource, ship it in assets_dir, or build it as a data: or blob: URL.");
    });
  };
  reporters();
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
${bundle ? ASSET_LOADER : ""}
})();`;
}

/**
 * Pure helpers the asset loader runs in the frame. Kept as SOURCE, not as
 * functions turned into strings with `toString()`: a minifier is free to
 * rename or hoist helpers out of a compiled function, and the frame would get
 * code that references names it never received. Tests evaluate this same
 * string, so what is tested is byte-for-byte what runs.
 *
 * `resolveAssetRef(base, ref)` — a reference as written in a file in directory
 * `base` → `{ path, hash }` in the bundle, or null for anything that is not a
 * bundle path (a scheme, `//host`, a `..` above the root). The query is dropped:
 * a blob URL with one names nothing.
 *
 * `rewriteAssetRefs(text, base, find)` — every quoted string, `url(…)` and
 * unquoted `attr=value` in `text` that names a bundled file becomes that file's
 * blob URL. Anything `find` doesn't know is left byte-for-byte alone, so a false
 * candidate (a string that merely looks like a path) costs nothing.
 *
 * `runtimeAssetRefs(u, baseURI)` — the candidates for a URL handed to `fetch`,
 * `img.src` and friends at runtime. Beyond a plain relative path, two shapes
 * show up in practice: a srcdoc frame resolves relative URLs against the
 * PARENT's address, so `new URL("a.png", document.baseURI)` arrives as
 * `http://dispatch/chat/a.png`; and loaders that resolve relative to their own
 * file produce `blob:null/a.png` from a blob URL. For both, the path's suffixes
 * are tried longest first.
 */
export const ASSET_HELPERS = `
function resolveAssetRef(base, ref) {
  if (typeof ref !== "string" || !ref || ref.length > 2048) return null;
  let hash = "";
  const h = ref.indexOf("#");
  if (h >= 0) { hash = ref.slice(h); ref = ref.slice(0, h); }
  const q = ref.indexOf("?");
  if (q >= 0) ref = ref.slice(0, q);
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null;
  const parts = ref.startsWith("/") || !base ? [] : base.split("/");
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? { path: parts.join("/"), hash } : null;
}
function rewriteAssetRefs(text, base, find) {
  const swap = (ref) => {
    const r = resolveAssetRef(base, ref);
    if (!r) return null;
    const u = find(r.path);
    return u ? u + r.hash : null;
  };
  return text.replace(
    /(\\\\?["'\\x60])([^"'\\x60\\s<>(){}\\\\]{1,1024}?)\\1|url\\(\\s*([^)"'\\s]{1,1024})\\s*\\)|(=)([^\\s"'\\x60=<>(){};,\\\\]{1,1024})/g,
    (m, q, a, b, eq, c) => {
      if (q !== undefined) { const u = swap(a); return u ? q + u + q : m; }
      if (b !== undefined) { const u = swap(b); return u ? "url(" + u + ")" : m; }
      const u = swap(c);
      return u ? "=" + u : m;
    },
  );
}
function runtimeAssetRefs(u, baseURI) {
  if (u && typeof u === "object" && typeof u.href === "string") u = u.href;
  if (typeof u !== "string") return [];
  const rel = resolveAssetRef("", u);
  if (rel) return [rel];
  let rest = null;
  const m = /^blob:(?:null|[a-z][a-z0-9+.-]*:\\/\\/[^/]+)\\/(.*)$/i.exec(u);
  if (m) rest = m[1];
  else {
    try {
      const abs = new URL(u);
      if ((abs.protocol === "http:" || abs.protocol === "https:") && abs.origin === new URL(baseURI).origin) {
        rest = abs.pathname + abs.hash;
      }
    } catch {}
  }
  if (rest === null) return [];
  const r = resolveAssetRef("", rest);
  if (!r) return [];
  const segs = r.path.split("/");
  const out = [];
  for (let i = 0; i < segs.length; i++) out.push({ path: segs.slice(i).join("/"), hash: r.hash });
  return out;
}
`;

/**
 * Bundle mode: the page arrives AFTER the frame is up, with its files.
 *
 * WHY TWO PHASES. The assets — up to 256 MB of textures and wasm — cannot ride
 * in the `srcdoc` (as data: URLs they would be a third bigger and parsed as one
 * giant string), and the frame cannot fetch them (no network, by design). So
 * the srcdoc is just the head and this loader. It says `boot-ready`; the parent
 * answers with the page and every asset as a Blob (by reference, not copied);
 * the loader mints a blob URL per file, points the page's references at them,
 * and only then writes the page into the document with `document.open()`.
 *
 * `document.open()` keeps what matters and drops one thing: the CSP, the
 * storage shim and the patched prototypes all survive (same Window, same
 * policy container), but every window event listener is ERASED — so the error
 * reporters are installed again right after it, or a page that throws on load
 * would throw silently.
 *
 * References are fixed two ways, because neither covers everything alone:
 *  - REWRITING the text of the page and of every text asset — markup, CSS
 *    `url()`, JSON (glTF `uri`s), scripts' string literals — which is the only
 *    way to reach what the parser loads by itself (`<img src>`, a stylesheet's
 *    fonts). Text assets are rewritten depth-first, so a stylesheet that names
 *    a font gets the font's URL before the page gets the stylesheet's; a cycle
 *    falls back to the unrewritten file rather than looping.
 *  - SHIMS for URLs built at runtime: `fetch`, `XMLHttpRequest`, `Worker`, the
 *    `src`/`href` setters, `setAttribute`, `Audio`, and `artifactAsset(path)`
 *    for anything else.
 */
const ASSET_LOADER = `
  ${ASSET_HELPERS}
  let booted = false;
  const boot = async (html, assets) => {
    const urls = new Map();
    const made = new Set();
    const mk = (blob) => { const u = URL.createObjectURL(blob); made.add(u); return u; };
    const texts = new Map();
    for (const a of assets) {
      if (a.rewrite) texts.set(a.path, { type: a.type, text: await a.blob.text(), blob: a.blob });
      else urls.set(a.path, mk(a.blob));
    }
    const state = new Map();
    const textUrl = (path) => {
      const t = texts.get(path);
      if (state.get(path) === "visiting") {
        if (!t.raw) t.raw = mk(t.blob);
        return t.raw;
      }
      if (!state.has(path)) {
        state.set(path, "visiting");
        // A stylesheet's url() and a glTF's uri are relative to THAT file; a
        // script's strings become URLs in the page, so they are relative to it.
        const dir = /javascript/.test(t.type) || !path.includes("/") ? "" : path.slice(0, path.lastIndexOf("/"));
        urls.set(path, mk(new Blob([rewriteAssetRefs(t.text, dir, find)], { type: t.type })));
        state.set(path, "done");
      }
      return urls.get(path);
    };
    const exact = (p) => (texts.has(p) ? textUrl(p) : urls.get(p));
    const find = (p) => {
      const hit = exact(p);
      if (hit) return hit;
      try { const d = decodeURIComponent(p); return d === p ? undefined : exact(d); } catch { return undefined; }
    };
    for (const path of texts.keys()) textUrl(path);

    const assetUrl = (u) => {
      if (typeof u === "string" && made.has(u)) return null;
      for (const r of runtimeAssetRefs(u, document.baseURI)) {
        const hit = find(r.path);
        if (hit) return hit + r.hash;
      }
      return null;
    };
    const swap = (u) => { const hit = assetUrl(u); return hit === null ? u : hit; };
    try { Object.defineProperty(window, "artifactAsset", {
      // A literal path in the page was already rewritten to its blob URL by the
      // time this runs, so one of ours is its own answer.
      value: (p) => { p = String(p); return made.has(p) ? p : assetUrl(p); },
      configurable: true,
    }); } catch {}

    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === "string" || input instanceof URL) return realFetch.call(this, swap(input), init);
      if (input instanceof Request) {
        const hit = assetUrl(input.url);
        if (hit) return realFetch.call(this, hit, init);
      }
      return realFetch.call(this, input, init);
    };
    const xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { return xhrOpen.call(this, method, swap(url), ...rest); };
    const wrapCtor = (name) => {
      const C = window[name];
      if (typeof C !== "function") return;
      window[name] = new Proxy(C, { construct: (t, args, nt) => { if (args.length) args[0] = swap(args[0]); return Reflect.construct(t, args, nt); } });
    };
    wrapCtor("Worker"); wrapCtor("SharedWorker"); wrapCtor("Audio");
    const patch = (C, prop) => {
      const proto = C && C.prototype;
      const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, Object.assign({}, d, { set(v) { d.set.call(this, swap(v)); } }));
    };
    patch(window.HTMLImageElement, "src"); patch(window.HTMLMediaElement, "src"); patch(window.HTMLMediaElement, "poster");
    patch(window.HTMLVideoElement, "poster"); patch(window.HTMLSourceElement, "src"); patch(window.HTMLScriptElement, "src");
    patch(window.HTMLLinkElement, "href"); patch(window.HTMLTrackElement, "src"); patch(window.HTMLEmbedElement, "src");
    const setAttr = Element.prototype.setAttribute;
    const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "data"]);
    Element.prototype.setAttribute = function (n, v) {
      return setAttr.call(this, n, URL_ATTRS.has(String(n).toLowerCase()) ? swap(v) : v);
    };

    const page = rewriteAssetRefs(html, "", find);
    document.open();
    reporters();
    document.write(page);
    document.close();
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (booted || e.source !== parent || !d || d[TAG] !== true || d.kind !== "boot") return;
    booted = true;
    boot(String(d.html), Array.isArray(d.assets) ? d.assets : []).catch((err) =>
      send("The artifact's assets failed to load: " + ((err && (err.stack || err.message)) || String(err))));
  });
  post({ kind: "boot-ready" });
`;

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

function head(storage: Record<string, string>, extra = "", bundle = false): string {
  return (
    // The doctype FIRST, or the frame renders in quirks mode — and the
    // artifact's own doctype, arriving after our head, would be ignored.
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    inlineScript(bridge(storage, bundle)) +
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
 * The `srcdoc` for an html artifact with assets: our head and the loader, and
 * nothing else — the page itself is posted in once the loader asks (see
 * {@link ASSET_LOADER}).
 */
export function buildArtifactBundleDocument(storage: Record<string, string> = {}): string {
  return head(storage, "", true) + "</head><body></body></html>";
}

/** One asset as the frame receives it in the `boot` message. */
export interface ArtifactBootAsset {
  path: string;
  type: string;
  blob: Blob;
  /** A text file whose references to other assets the loader rewrites. */
  rewrite: boolean;
}

/** The parent's answer to `boot-ready`. */
export function artifactBootMessage(html: string, assets: ArtifactBootAsset[]) {
  return { [ARTIFACT_MESSAGE_TAG]: true, kind: "boot" as const, html, assets };
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
  if (d.kind === "boot-ready") return { kind: "boot-ready" };
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
