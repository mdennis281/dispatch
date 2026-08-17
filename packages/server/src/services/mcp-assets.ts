/**
 * Recognizing "an MCP handed back a FILE" in a tool result.
 *
 * MCP can carry an image inline as base64, and for a screenshot that is fine.
 * For a video it is not: the bytes would go through the model's context window,
 * where a 4 MB capture costs more than the whole conversation around it and
 * tells the model nothing it can read. The point of a video is that the HUMAN
 * watches it.
 *
 * So the primary route is a REFERENCE. A server writes the file wherever it
 * likes and names it; Dispatch copies it into the chat's assets and shows a
 * player, while the model sees one short line. Two spellings are accepted:
 *
 *   • MCP's own `resource_link` (and a `resource` block carrying a `file://`
 *     uri) — the standard shape, so a server written against the spec works
 *     with no Dispatch-specific code at all.
 *   • a text block that is exactly `{"dispatch":"asset","path":"…"}` — the
 *     escape hatch for a server whose SDK cannot emit a resource_link.
 *
 * Nothing here reads the file: this module only decides what a block IS, so it
 * stays a pure function that tests can cover without a filesystem.
 */

/** A file an MCP result pointed at, before Dispatch has read it. */
export interface AssetReference {
  /** Filesystem path, absolute or relative to the server's cwd. */
  path: string;
  /** Optional caption; falls back to the file's own name. */
  alt?: string;
  /** Declared media type, when the block bothered to say. */
  mimeType?: string;
}

/** Strip a `file://` uri down to a filesystem path, or null if it isn't one. */
export function pathFromFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    // `new URL().pathname` percent-decodes and normalizes, which a manual slice
    // does not — a path with a space arrives as %20 and would not exist on disk.
    const url = new URL(uri);
    const p = decodeURIComponent(url.pathname);
    // A Windows path comes through as `/C:/x`; the leading slash is not part of it.
    return /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p;
  } catch {
    return null;
  }
}

/**
 * Decide whether a tool-result content block points at a file, and where.
 * Returns null for anything else — an ordinary text or image block is left for
 * the existing inline path to handle.
 */
export function parseAssetReference(block: unknown): AssetReference | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;

  // MCP's standard resource_link.
  if (b.type === "resource_link" && typeof b.uri === "string") {
    const path = pathFromFileUri(b.uri) ?? (isPlainPath(b.uri) ? b.uri : null);
    if (path) {
      return {
        path,
        alt: typeof b.name === "string" ? b.name : undefined,
        mimeType: typeof b.mimeType === "string" ? b.mimeType : undefined,
      };
    }
  }

  // An embedded `resource` whose contents were NOT inlined — it only has a uri.
  if (b.type === "resource" && b.resource && typeof b.resource === "object") {
    const r = b.resource as Record<string, unknown>;
    // `text`/`blob` mean the payload IS inline; that isn't a reference.
    if (r.text === undefined && r.blob === undefined && typeof r.uri === "string") {
      const path = pathFromFileUri(r.uri);
      if (path) {
        return {
          path,
          alt: typeof r.name === "string" ? r.name : undefined,
          mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined,
        };
      }
    }
  }

  // The escape hatch: a text block that is exactly a dispatch asset envelope.
  if (b.type === "text" && typeof b.text === "string") {
    const t = b.text.trim();
    if (!t.startsWith("{") || !t.includes('"dispatch"')) return null;
    try {
      const parsed = JSON.parse(t) as Record<string, unknown>;
      if (parsed.dispatch === "asset" && typeof parsed.path === "string" && parsed.path) {
        return {
          path: parsed.path,
          alt: typeof parsed.alt === "string" ? parsed.alt : undefined,
          mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : undefined,
        };
      }
    } catch {
      // Not our envelope. Leave the text exactly as it was.
    }
  }

  return null;
}

/** A bare path (no scheme) — accepted so a server can skip the file:// dance. */
function isPlainPath(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false; // http://, https://, …
  return s.length > 0;
}

/**
 * Cap for inlining base64 from a tool result. Above this the bytes are NOT put
 * in the transcript — a server sending a video this way should send a reference
 * instead, and this is where it finds that out.
 */
export const MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024;

/** Cap for a referenced file Dispatch will copy into the chat's assets. */
export const MAX_REFERENCED_ASSET_BYTES = 256 * 1024 * 1024;

/**
 * Decoded byte count a base64 string WOULD produce, without decoding it.
 *
 * Checking the size after `Buffer.from(s, "base64")` is too late: the
 * allocation the cap exists to prevent has already happened, so a server
 * returning a gigabyte of base64 could exhaust memory on a payload that was
 * always going to be refused. Every 4 input characters become 3 output bytes,
 * less one per `=` of padding.
 *
 * Whitespace inside the string decodes to nothing, so this OVER-estimates a
 * prettified payload — deliberately: over-estimating refuses something
 * borderline, under-estimating admits the allocation this is here to stop.
 */
export function approxBase64Bytes(s: string): number {
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

/**
 * Decide whether a resolved path may be ingested.
 *
 * WITHOUT this, "copy the file an MCP names" is an arbitrary local-file read.
 * That is nearly harmless for a stdio server — it already runs as a local child
 * with the manager's own filesystem access, so it could read the file itself —
 * but a REMOTE http/sse server has no such access, and returning
 * `file:///etc/passwd` (or `../../…`, or a symlink pointing there) would borrow
 * the manager's. The file lands in the chat's assets, where a human reads it.
 *
 * So a reference must resolve INSIDE one of the roots the caller nominates:
 * the chat's own directory (where a server writes its output) and the OS temp
 * directory (where plenty of tools stage a capture). Everything else is
 * refused, and the tool's original block is left intact.
 *
 * `resolved` is expected to be REALPATH'd by the caller — comparing the
 * pre-symlink path would let a link inside the worktree point anywhere.
 */
export function isPathWithinRoots(resolved: string, roots: string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(resolved);
  // Case-insensitive where the filesystem is: on Windows a differently-cased
  // spelling of an allowed root is the SAME directory and must still pass.
  const fold = (s: string): string =>
    process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s;
  const t = fold(target);
  return roots.some((root) => {
    const r = fold(norm(root));
    if (!r) return false;
    // Exact match, or a genuine child. The trailing "/" matters: without it
    // `/repo-secrets` would pass as a child of `/repo`.
    return t === r || t.startsWith(`${r}/`);
  });
}
