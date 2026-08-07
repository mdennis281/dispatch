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
 * Order of preference, then: the text flavors (exact, when the drag source
 * offers them), and failing that the caller resolving a bare basename against
 * the project index (a guess — see Composer.resolveDroppedNames).
 *
 * The Electron build had a third and better source — a preload bridging
 * `webUtils.getPathForFile`, which placed ANY dropped file, Explorer included.
 * That went with the shell when Dispatch became a PWA, so an Explorer drag now
 * takes the basename path like every other browser drop.
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

/**
 * Every real path this drop discloses.
 *
 * Only the text flavors, now that Dispatch runs as a PWA. The Electron build
 * had a preload bridging `webUtils.getPathForFile`, which resolved ANY dropped
 * file — Explorer and Finder included — and took precedence here. Dropping the
 * shell drops that: an Explorer drag no longer carries its path, and falls
 * through to the caller's basename lookup (see `Composer.resolveDroppedNames`).
 * Drags from VS Code, JetBrains and terminals are unaffected — they publish the
 * path as text, which is what this reads.
 */
export function pathsFromDrop(dt: DataTransfer | null | undefined): string[] {
  return pathsFromDataTransfer(dt);
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
    // Whether we get a real path depends entirely on the drag source having
    // volunteered a URI list; Explorer does not.
    return types.includes("text/uri-list") ? "path" : "lookup";
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
