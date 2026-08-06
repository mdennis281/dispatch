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
 * Under the Electron shell there's a third and better source: the preload
 * bridges `webUtils.getPathForFile`, which resolves ANY dropped file — Explorer
 * and Finder included — to its real path. That's the only thing the desktop
 * build can do that the browser build can't, so it's feature-detected rather
 * than assumed, and every caller still works without it.
 *
 * Order of preference, then: the desktop bridge (exact), the text flavors
 * (exact when offered), and finally the caller resolving a bare basename
 * against the project index (a guess — see Composer.resolveDroppedNames).
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

/* ------------------------------------------------------------------ *
 * Electron shell
 * ------------------------------------------------------------------ */

/** The surface `packages/desktop/src/preload.ts` exposes. Kept in sync by hand. */
export interface DesktopBridge {
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    cmDesktop?: DesktopBridge;
  }
}

/**
 * The desktop bridge, or null in a browser tab.
 *
 * Read live rather than cached at module load: the bundle is byte-identical in
 * both shells and a cached `false` from an early import would be wrong forever.
 */
export function desktopBridge(): DesktopBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.cmDesktop;
  return typeof bridge?.getPathForFile === "function" ? bridge : null;
}

/** Are we running inside the Electron shell (and so able to resolve any drop)? */
export function isDesktop(): boolean {
  return desktopBridge() !== null;
}

/**
 * Real paths for the dropped files, via the Electron bridge. Empty in a browser,
 * and empty for the files the bridge can't place (a File synthesized by a paste
 * rather than dragged off disk).
 */
export function pathsFromFiles(dt: DataTransfer | null | undefined): string[] {
  const bridge = desktopBridge();
  if (!bridge || !dt?.files?.length) return [];
  const out: string[] = [];
  for (const file of Array.from(dt.files)) {
    let path = "";
    try {
      path = bridge.getPathForFile(file);
    } catch {
      /* bridge is best-effort; the text flavors and the index are still there */
    }
    if (path) out.push(path);
  }
  return dedupe(out);
}

/**
 * Every real path this drop discloses, desktop bridge first.
 *
 * The bridge wins over `text/uri-list` because it describes the actual files
 * being dropped, whereas a drag source composes the text flavors by hand and
 * can disagree with itself (VS Code publishes both, editors publish a tab's
 * path while dragging a selection).
 */
export function pathsFromDrop(dt: DataTransfer | null | undefined): string[] {
  const fromFiles = pathsFromFiles(dt);
  return fromFiles.length ? fromFiles : pathsFromDataTransfer(dt);
}

/* ------------------------------------------------------------------ *
 * Telling the user, mid-drag, what a drop will do
 * ------------------------------------------------------------------ */

/**
 * What dropping THIS drag would produce:
 *   "image"  → attached and uploaded
 *   "path"   → the real path, inserted verbatim (certain)
 *   "lookup" → only a basename is on offer, so we'll search the project index
 *   null     → not something the composer takes
 *
 * Deliberately computed from what a `dragover` can see. The payload itself is
 * sealed until `drop` (`getData` returns "" and `getAsFile` returns null), but
 * `types` and each item's `kind`/`type` are readable throughout the drag —
 * which is exactly enough to promise the right outcome before the user commits
 * to it. Mirrors Composer.handleDrop's precedence; the two must agree.
 */
export type DropIntent = "image" | "path" | "lookup" | null;

export function dropIntent(dt: DataTransfer | null | undefined): DropIntent {
  if (!dt) return null;
  const types = safeTypes(dt);
  const fileItems = dt.items
    ? Array.from(dt.items).filter((it) => it.kind === "file")
    : [];
  const hasFiles = types.includes("Files") || fileItems.length > 0 || !!dt.files?.length;

  if (hasFiles) {
    // Any image in the set and handleDrop takes the image branch for the whole
    // drop, so say so — an unannounced "your .ts was ignored" is worse than an
    // unannounced path.
    if (fileItems.some((it) => it.type.startsWith("image/"))) return "image";
    // In Electron the path is guaranteed; in a browser it depends on whether
    // the drag source volunteered a URI list.
    return isDesktop() || types.includes("text/uri-list") ? "path" : "lookup";
  }

  // No files, but a path-shaped drag: a VS Code editor tab, a terminal, a
  // JetBrains project-tree node. `text/plain` alone is excluded — a dragged
  // word is text, not a file, and we can't tell which until the drop.
  return types.includes("text/uri-list") ? "path" : null;
}

/** `types` as a plain array, tolerating the odd host that omits it entirely. */
function safeTypes(dt: DataTransfer): string[] {
  try {
    return dt.types ? Array.from(dt.types) : [];
  } catch {
    return [];
  }
}
