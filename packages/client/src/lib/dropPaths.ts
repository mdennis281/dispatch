/**
 * Recovering real filesystem paths from a drag.
 *
 * A browser is never told the path of a file dropped from the OS file manager —
 * `DataTransfer.files` carries the CONTENT and a bare basename, and that's the
 * whole security boundary. But a drag originating from an app that already
 * thinks in paths (VS Code, JetBrains, most terminals, some file managers) also
 * publishes `text/uri-list` / `text/plain` holding the real path, and that we
 * can read.
 *
 * So: try the text flavors first and take a genuine path when one is offered;
 * the caller falls back to resolving the basename against the project index
 * when it isn't (see Composer.resolveDroppedNames).
 */

/**
 * Decode a `file://` URI into a filesystem path, or null if it isn't one.
 *
 * The leading-slash strip is the Windows case: `file:///C:/x` is a correct URI
 * whose PATH component is `/C:/x`, which is not a usable Windows path.
 */
export function fileUrlToPath(uri: string): string | null {
  const trimmed = uri.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  let path = trimmed.slice("file://".length);
  // `file://host/share/x` (UNC) keeps its host; `file:///x` does not.
  if (path.startsWith("/")) {
    const decoded = safeDecode(path);
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  }
  return `\\\\${safeDecode(path).replace(/\//g, "\\")}`;
}

/** `decodeURIComponent` that yields the input rather than throwing on bad escapes. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Does this string look like an absolute filesystem path? Only absolute forms
 * count: a bare `foo.ts` from a text drag is just as likely to be prose, and
 * guessing wrong pastes junk into the composer.
 */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || /[\r\n]/.test(t)) return false;
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(t);
}

/**
 * Every real path a drag is willing to disclose, in preference order.
 * Empty when the drag carries only file CONTENT (the plain OS-file-manager case).
 */
export function pathsFromDataTransfer(dt: DataTransfer | null | undefined): string[] {
  if (!dt) return [];
  const out: string[] = [];

  // `text/uri-list` is the standards-blessed flavor: one URI per line, `#` comments.
  for (const line of (readData(dt, "text/uri-list") ?? "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const path = fileUrlToPath(line);
    if (path) out.push(path);
  }
  if (out.length) return dedupe(out);

  // Plain text: what VS Code and most terminals actually put on a path drag.
  const plain = (readData(dt, "text/plain") ?? "").trim();
  if (plain) {
    const asUrl = fileUrlToPath(plain);
    if (asUrl) return [asUrl];
    if (looksLikePath(plain)) return [plain];
  }
  return [];
}

/**
 * `getData` throws in some browsers when called outside a drop handler (and on
 * a protected drag source). A path we can't read is just a path we fall back
 * from, never an error worth surfacing.
 */
function readData(dt: DataTransfer, type: string): string | null {
  try {
    return dt.getData(type) || null;
  } catch {
    return null;
  }
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** The filename half of a path, for either separator. */
export function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
