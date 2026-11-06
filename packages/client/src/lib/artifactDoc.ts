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
 *     The frame gets an opaque origin: no cookies, no storage, no DOM access to
 *     the parent, and every request it makes is cross-origin to Dispatch. The
 *     content arrives by `srcdoc`, never by a URL on this origin, so there is no
 *     address to open "in a new tab" where it would run unsandboxed.
 *  2. A CSP `<meta>` that is the FIRST thing in the document
 *     ({@link ARTIFACT_CSP}): no network at all — no fetch, no CDN script, no
 *     remote image to smuggle data out in a URL. A policy can only be tightened
 *     by later markup, never loosened, so the artifact's own `<meta>` cannot
 *     undo it.
 *
 * Offline by design, not by accident: an artifact that renders only while some
 * CDN is up is a page that stops working on a plane and leaks every view to a
 * third party. The tool description tells the agent to inline what it needs.
 */

/**
 * `allow-scripts` is the point of an HTML artifact. `allow-popups` (+ escape)
 * so a link with `target=_blank` opens a normal tab rather than dying silently;
 * that tab is the LINK's origin, never ours. `allow-modals` for `alert()` in a
 * prototype. Never `allow-same-origin`, never `allow-top-navigation`.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals";

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The marker every bridge message carries, so stray `postMessage`s are ignored. */
export const ARTIFACT_MESSAGE_TAG = "__dispatchArtifact";

export interface ArtifactFrameMessage {
  [ARTIFACT_MESSAGE_TAG]: true;
  kind: "error";
  message: string;
}

/**
 * Runs before any artifact script. Reports what the human can't see and the
 * agent can't either: uncaught errors, rejected promises, `console.error`, and
 * — most usefully — CSP violations, which is how "I loaded React from a CDN"
 * shows up. Written as a string because it runs in the frame, not here.
 */
const BRIDGE = `(() => {
  const TAG = ${JSON.stringify(ARTIFACT_MESSAGE_TAG)};
  let sent = 0;
  const send = (message) => {
    if (sent++ > 50) return;
    try { parent.postMessage({ [TAG]: true, kind: "error", message: String(message).slice(0, 2000) }, "*"); } catch {}
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
      " — artifacts have no network; inline the resource instead.");
  });
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    send(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" "));
  };
})();`;

/**
 * A `</script>` inside the bridge would end it early. There is none today; this
 * keeps it that way if someone edits the string above.
 */
function inlineScript(code: string): string {
  return `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
}

function head(extra = ""): string {
  return (
    // The doctype FIRST, or the frame renders in quirks mode — and the
    // artifact's own doctype, arriving after our head, would be ignored.
    "<!doctype html><html><head>" +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    inlineScript(BRIDGE) +
    extra
  );
}

/**
 * The `srcdoc` for an html or svg artifact.
 *
 * The artifact's markup is appended AFTER our head, not parsed and merged: an
 * HTML parser already folds a second `<html>`/`<head>` into the first, and its
 * `<meta>`/`<style>`/`<title>` land in the head we opened. Parsing it ourselves
 * would be a second parser whose disagreements with the browser's are exactly
 * where a sandbox escape would hide.
 */
export function buildArtifactDocument(type: "html" | "svg", content: string): string {
  if (type === "svg") {
    return (
      head(
        "<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}" +
          "body>svg{max-width:100%;max-height:100vh;height:auto}</style>",
      ) +
      "</head><body>" +
      content +
      "</body></html>"
    );
  }
  return head() + content;
}

/** Narrow an arbitrary `message` event payload to one of ours. */
export function asArtifactMessage(data: unknown): ArtifactFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d[ARTIFACT_MESSAGE_TAG] !== true || d.kind !== "error" || typeof d.message !== "string") return null;
  return { [ARTIFACT_MESSAGE_TAG]: true, kind: "error", message: d.message.slice(0, 2000) };
}
