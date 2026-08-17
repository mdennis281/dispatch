/**
 * FILESYSTEM BROWSING — the wire shapes behind `/api/fs/*`, plus the path and
 * filter arithmetic both sides have to agree on.
 *
 * A browser page cannot see a filesystem: `<input type=file>` and OS drag-and-drop
 * both hand back a bare basename, so every real path in this app comes from the
 * server. That makes the explorer a REST client, and this module the contract.
 *
 * Two things live here rather than on one side:
 *
 *   1. **Path arithmetic**, because the client has to compute a breadcrumb and a
 *      parent link without a round trip, while the server has to resolve the same
 *      strings against a real disk. `node:path` isn't available in a browser and
 *      `node:path/win32` on a Linux server is the wrong answer for a Linux disk —
 *      so these take the platform as an ARGUMENT. That's also what makes both
 *      platforms testable from one machine, which is the only way a Windows-only
 *      dev ever finds out they broke `/mnt/data`.
 *
 *   2. **The picker filter**, because "directories only", "`.png` only" and "pick
 *      at most one" decide both what the list greys out and what the server is
 *      willing to hand back to a search. One predicate, tested once.
 *
 * Every path that crosses the wire is ABSOLUTE and FORWARD-SLASHED, on every
 * platform — `C:/Users/me/notes.md`, not `C:\Users\me\notes.md`. Backslashes are
 * legal in POSIX filenames, so a mixed convention makes "is this a separator?"
 * unanswerable; picking one and converting at the edges makes it a non-question.
 */
import * as z from "zod";

/* ------------------------------------------------------------- path shapes */

/**
 * Which set of path rules to apply. Deliberately NOT read from `process` — the
 * client has no `process`, and a server browsing its own disk needs its own
 * rules regardless of where the page is rendered. The server sends its platform
 * with `/api/fs/roots`; the client passes it back into these helpers.
 */
export const FsPlatformSchema = z.enum(["win32", "posix"]);
export type FsPlatform = z.infer<typeof FsPlatformSchema>;

/** `C:/`, `c:/`, `//server/share/` (UNC), or POSIX `/`. */
const WIN_DRIVE_ROOT = /^[a-zA-Z]:\/$/;
const WIN_UNC_ROOT = /^\/\/[^/]+\/[^/]+\/?$/;

/**
 * Normalize any path the wire hands us into the canonical form above: forward
 * slashes, no trailing slash (except at a root, where the slash IS the root),
 * and `.`/`..` segments resolved.
 *
 * Resolving `..` here rather than trusting the caller matters because the
 * breadcrumb, the parent button and a typed path field all produce strings the
 * server will `stat`, and `C:/a/b/../..` and `C:/a/../a` are the same directory
 * — a UI that treated them as different would show two entries for one folder
 * and lose the selection when you arrived by the other route.
 */
export function fsNormalize(input: string, platform: FsPlatform): string {
  let p = input.replace(/\\/g, "/").trim();
  if (!p) return p;

  // Remember a UNC prefix before collapsing repeats, so `//server/share` doesn't
  // become `/server/share` — a completely different (and nonexistent) location.
  const unc = platform === "win32" && /^\/\//.test(p);
  p = p.replace(/\/{2,}/g, "/");
  if (unc) p = `/${p}`;

  // A bare drive letter means that drive's root, not "wherever the process is
  // cwd'd on drive C" — the shell meaning of `C:` is never what a UI click means.
  if (platform === "win32" && /^[a-zA-Z]:$/.test(p)) return `${p}/`;

  const root = fsRootOf(p, platform);
  const rest = root ? p.slice(root.length) : p;
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // Above a root there is nothing to pop to; `/..` is `/` on every OS.
      if (out.length) out.pop();
      else if (!root) out.push("..");
      continue;
    }
    out.push(seg);
  }
  if (root) return out.length ? root + out.join("/") : root;
  return out.join("/");
}

/**
 * The root prefix of an absolute path — `"C:/"`, `"//server/share/"`, `"/"` — or
 * `null` when the path is relative. Callers use this to know when they've run
 * out of parents.
 */
export function fsRootOf(path: string, platform: FsPlatform): string | null {
  const p = path.replace(/\\/g, "/");
  if (platform === "win32") {
    const drive = /^([a-zA-Z]:)(\/|$)/.exec(p);
    if (drive) return `${drive[1]}/`;
    const share = /^(\/\/[^/]+\/[^/]+)(\/|$)/.exec(p);
    if (share) return `${share[1]}/`;
    return null;
  }
  return p.startsWith("/") ? "/" : null;
}

/** True when `path` is a filesystem root and has nowhere further up to go. */
export function fsIsRoot(path: string, platform: FsPlatform): boolean {
  const p = fsNormalize(path, platform);
  if (platform === "win32") return WIN_DRIVE_ROOT.test(p) || WIN_UNC_ROOT.test(p);
  return p === "/";
}

/** True when `path` is absolute for this platform. */
export function fsIsAbsolute(path: string, platform: FsPlatform): boolean {
  return fsRootOf(path, platform) !== null;
}

/**
 * The containing directory, or `null` at a root.
 *
 * `null` is load-bearing: it's what tells the UI to offer the ROOTS list (drives
 * on Windows, mounts on Linux) instead of a "go up" that would land on the same
 * directory you're already in.
 */
export function fsParent(path: string, platform: FsPlatform): string | null {
  const p = fsNormalize(path, platform);
  if (!p || fsIsRoot(p, platform)) return null;
  const cut = p.lastIndexOf("/");
  if (cut < 0) return null;
  const root = fsRootOf(p, platform);
  // `C:/Users` → cut is at index 2, leaving `C:` — which normalizes back to the
  // drive root. A plain slice would produce a path that isn't one.
  if (root && cut < root.length) return root;
  if (cut === 0) return platform === "posix" ? "/" : null;
  return p.slice(0, cut);
}

/** The last segment — a filename, or a root rendered as itself (`C:/`). */
export function fsBasename(path: string, platform: FsPlatform): string {
  const p = fsNormalize(path, platform);
  if (fsIsRoot(p, platform)) return p;
  const cut = p.lastIndexOf("/");
  return cut < 0 ? p : p.slice(cut + 1);
}

/** Append one segment. `name` is treated as a literal name, never a sub-path. */
export function fsJoin(dir: string, name: string, platform: FsPlatform): string {
  const base = fsNormalize(dir, platform);
  const leaf = name.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!leaf) return base;
  return fsNormalize(base.endsWith("/") ? base + leaf : `${base}/${leaf}`, platform);
}

/** One crumb: the label to render and the path to navigate to. */
export interface FsCrumb {
  label: string;
  path: string;
}

/**
 * Breadcrumb trail from the root down to `path`, inclusive. The first crumb is
 * the root itself so the trail always starts somewhere clickable.
 */
export function fsCrumbs(path: string, platform: FsPlatform): FsCrumb[] {
  const p = fsNormalize(path, platform);
  const root = fsRootOf(p, platform);
  if (!root) return p ? [{ label: p, path: p }] : [];
  const crumbs: FsCrumb[] = [{ label: root, path: root }];
  const rest = p.slice(root.length);
  let cursor = root;
  for (const seg of rest.split("/").filter(Boolean)) {
    cursor = cursor.endsWith("/") ? cursor + seg : `${cursor}/${seg}`;
    crumbs.push({ label: seg, path: cursor });
  }
  return crumbs;
}

/**
 * True when `child` is `parent` or sits underneath it. Used to decide whether a
 * move would swallow its own source directory, and to label a location as
 * "inside project X".
 *
 * Windows compares case-insensitively because its filesystems are — treating
 * `C:/Users` and `c:/users` as different locations would let a move onto "a
 * different directory" quietly delete the source.
 */
export function fsIsInside(child: string, parent: string, platform: FsPlatform): boolean {
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const c = fold(fsNormalize(child, platform));
  const p = fold(fsNormalize(parent, platform));
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

/* ------------------------------------------------------------------ entries */

/**
 * What a listed thing IS.
 *
 * A symlink reports the kind of its TARGET (`directory` for a link to a folder)
 * with `link` set alongside, because that's what navigation and filtering need —
 * clicking a link to a folder should open the folder. `symlink` as a kind is
 * reserved for the broken case, where there is no target kind to report.
 */
export const FsEntryKindSchema = z.enum(["file", "directory", "symlink", "other"]);
export type FsEntryKind = z.infer<typeof FsEntryKindSchema>;

/** Where a symlink points, for the detail pane and the broken-link styling. */
export const FsLinkSchema = z.object({
  /** The link's literal target, as stored (may be relative). Null if unreadable. */
  target: z.string().nullable(),
  /** The target doesn't resolve to anything that exists. */
  broken: z.boolean(),
});
export type FsLink = z.infer<typeof FsLinkSchema>;

/**
 * One row in a directory listing.
 *
 * Timestamps are epoch-ms or `null`, never `0`. A missing birthtime comes back
 * from the kernel as the epoch, and rendering "1 Jan 1970" as a creation date is
 * worse than rendering nothing — `null` is the difference between "unknown" and
 * "known to be very old", which only the server can tell apart.
 */
export const FsEntrySchema = z.object({
  /** Bare filename, exactly as stored on disk. */
  name: z.string(),
  /** Absolute, forward-slashed. */
  path: z.string(),
  kind: FsEntryKindSchema,
  /** Bytes. Null for directories and for anything that couldn't be stat'ed. */
  size: z.number().nullable(),
  /** Content last written (epoch ms). */
  modifiedAt: z.number().nullable(),
  /** Birth time where the platform records one — see the note above. */
  createdAt: z.number().nullable(),
  /** Last read (epoch ms). Often disabled by mount options; null when unknown. */
  accessedAt: z.number().nullable(),
  /** Lowercased extension without the dot (`"png"`), `""` when there is none. */
  ext: z.string(),
  /** Conventionally hidden — see `fsIsHiddenName` for what that can and can't see. */
  hidden: z.boolean(),
  /** Present only for symlinks. */
  link: FsLinkSchema.optional(),
  /** The stat call failed (a permission-denied entry still lists, greyed). */
  unreadable: z.boolean().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

/** A directory's contents, plus what it took to get them. */
export const FsListingSchema = z.object({
  /** The directory listed, normalized — echoed back so the UI can trust it. */
  path: z.string(),
  /** Containing directory, or null at a root (show the roots list instead). */
  parent: z.string().nullable(),
  entries: z.array(FsEntrySchema),
  /** Entries dropped because the directory exceeded the cap. */
  truncated: z.boolean(),
  /** How many entries the directory actually holds, before the cap. */
  total: z.number(),
  /** Set when this directory is inside a git checkout — enables git columns. */
  repoRoot: z.string().nullable(),
});
export type FsListing = z.infer<typeof FsListingSchema>;

/**
 * A place worth offering as a starting point: a drive, a mount, the home
 * directory, a project checkout, a worktree.
 *
 * Grouped by `kind` in the UI, which is why the kind is a field rather than
 * three separate arrays — new kinds (a bookmark, a recent) shouldn't need a new
 * response shape.
 */
export const FsRootKindSchema = z.enum([
  "home",
  "drive",
  "mount",
  "project",
  "worktree",
]);
export type FsRootKind = z.infer<typeof FsRootKindSchema>;

export const FsRootSchema = z.object({
  path: z.string(),
  /** What to call it: `"C:"`, `"/"`, `"Home"`, the project's name, a branch. */
  label: z.string(),
  kind: FsRootKindSchema,
  /** Secondary line — a mount's device, a worktree's project. */
  detail: z.string().optional(),
  /** Total bytes of the containing volume, when it could be measured. */
  totalBytes: z.number().nullable().optional(),
  /** Free bytes on that volume. */
  freeBytes: z.number().nullable().optional(),
});
export type FsRoot = z.infer<typeof FsRootSchema>;

/**
 * The expensive facts, fetched for ONE path when something is selected rather
 * than for every row in a listing.
 *
 * Ownership costs a `/etc/passwd` lookup on POSIX and an out-of-process `Get-Acl`
 * on Windows; "last edited by" costs a `git log`. Per row, over a directory of
 * two thousand files, that's thousands of subprocesses — so the listing stays
 * cheap and this fills the detail pane.
 */
export const FsDetailsSchema = z.object({
  entry: FsEntrySchema,
  /** Owning user's NAME where resolvable, else the raw uid/SID, else null. */
  owner: z.string().nullable(),
  /** Owning group (POSIX only; null on Windows). */
  group: z.string().nullable(),
  /** POSIX mode as `"rwxr-xr-x"`; null on Windows, where it means nothing. */
  mode: z.string().nullable(),
  /** Whether THIS server process can write it — drives the disabled states. */
  writable: z.boolean(),
  /** Hard-link count; >1 means deleting this path doesn't free the bytes. */
  links: z.number().nullable(),
  /**
   * Who last committed a change to this file, from `git log -1`. The filesystem
   * has no notion of "edited by" — `stat` records WHEN, never WHO — so this is
   * the only honest answer available, and it's only available inside a checkout.
   */
  lastEditedBy: z.string().nullable(),
  /** When that commit landed (epoch ms). */
  lastEditedAt: z.number().nullable(),
  /** Directories only: immediate child count, so the UI can warn before a delete. */
  childCount: z.number().nullable(),
});
export type FsDetails = z.infer<typeof FsDetailsSchema>;

/* ------------------------------------------------------------------- filter */

/** What a picker will accept. */
export const FsSelectKindSchema = z.enum(["file", "directory", "any"]);
export type FsSelectKind = z.infer<typeof FsSelectKindSchema>;

/**
 * A picker's rules. Sent to the server for searches (so it doesn't stream back
 * thousands of rows the UI is about to grey out) and applied in the client for
 * listings.
 */
export const FsFilterSchema = z.object({
  select: FsSelectKindSchema.default("file"),
  /**
   * Acceptable extensions, lowercase and dot-less (`["png","jpg"]`). Empty or
   * omitted means "any". Ignored for directories, which have no meaningful
   * extension even when their name contains a dot (`my.project/`).
   */
  extensions: z.array(z.string()).optional(),
  /** Whether more than one thing can come back. */
  multiple: z.boolean().default(false),
  /** Show dotfiles / hidden entries. */
  showHidden: z.boolean().default(false),
});
export type FsFilter = z.infer<typeof FsFilterSchema>;

/** The everything-allowed filter, for the plain browser. */
export const FS_FILTER_ANY: FsFilter = {
  select: "any",
  multiple: true,
  showHidden: false,
};

/**
 * The extension of a filename, lowercased and without the dot.
 *
 * A leading dot doesn't count: `.gitignore` is a hidden file NAMED gitignore,
 * not a file with a `gitignore` extension, and treating it as the latter makes
 * an "extensions: "ignore"" filter behave bizarrely. Multi-dot names take the
 * last part only (`archive.tar.gz` → `gz`), which is what a file dialog does.
 */
export function fsExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Conventionally hidden?
 *
 * A leading dot, which is the whole story on POSIX and most of it on Windows —
 * where tools have largely adopted dotfiles too. It is NOT the whole story on
 * Windows: `C:/ProgramData` is hidden by a file ATTRIBUTE, and Node's `stat`
 * exposes no attribute bits on any platform, so there is nothing to read. The
 * alternative is an out-of-process `Get-ChildItem -Force` per directory, which
 * would put a PowerShell spawn in the path of every single click.
 *
 * So: dot-prefixed names hide, attribute-hidden Windows system folders show.
 * Showing something that could have been hidden is the safe direction to be
 * wrong in — the other way round hides a file the user can plainly see in
 * Explorer and cannot find here.
 */
export function fsIsHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Can this entry be CHOSEN? (As opposed to merely shown — directories stay
 * visible in a file picker because you have to walk through them to reach the
 * files, they just aren't clickable as an answer.)
 */
export function fsIsSelectable(
  entry: Pick<FsEntry, "name" | "kind">,
  filter: Pick<FsFilter, "select" | "extensions">,
): boolean {
  const isDir = entry.kind === "directory";
  if (filter.select === "file" && isDir) return false;
  if (filter.select === "directory" && !isDir) return false;
  // A broken symlink resolves to nothing, so there is nothing to hand back.
  if (entry.kind === "symlink" || entry.kind === "other") return false;
  // Extensions constrain files only: a directory called `assets.png` is still a
  // directory, and a "directory" picker filtered to `.png` should offer all of
  // them, not none.
  if (isDir) return true;
  const exts = filter.extensions?.filter(Boolean).map((e) => e.replace(/^\./, "").toLowerCase());
  if (!exts?.length) return true;
  return exts.includes(fsExtension(entry.name));
}

/**
 * Should this entry appear in the list at all?
 *
 * Only hidden-ness can remove a row. Extension filters deliberately do NOT —
 * a picker that erases every file except `.png` leaves you staring at a folder
 * you know has files in it, unable to tell whether you're in the wrong place or
 * whether the filter is doing its job. Greying out says both.
 */
export function fsIsVisible(
  entry: Pick<FsEntry, "name" | "hidden">,
  filter: Pick<FsFilter, "showHidden">,
): boolean {
  return filter.showHidden || !entry.hidden;
}

/* ------------------------------------------------------------------ sorting */

export const FsSortKeySchema = z.enum(["name", "size", "modified", "created", "kind"]);
export type FsSortKey = z.infer<typeof FsSortKeySchema>;

export interface FsSort {
  key: FsSortKey;
  desc: boolean;
}

/**
 * Order a listing. Directories always come first regardless of key or direction,
 * which is the convention every file manager follows for a reason: the folders
 * are the navigation, and burying them halfway down a size-sorted list of files
 * turns "go deeper" into a hunt.
 *
 * `null` timestamps and sizes sort last in both directions — an unknown value is
 * not a small one, and letting it sink to the bottom keeps a permission-denied
 * entry from squatting at the top of a "newest first" list.
 */
export function fsSortEntries(entries: FsEntry[], sort: FsSort): FsEntry[] {
  const dirRank = (e: FsEntry) => (e.kind === "directory" ? 0 : 1);
  const nullsLast = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return 0;
  };
  const dir = sort.desc ? -1 : 1;
  return [...entries].sort((a, b) => {
    const byDir = dirRank(a) - dirRank(b);
    if (byDir) return byDir;

    switch (sort.key) {
      case "size": {
        const n = nullsLast(a.size, b.size);
        if (n) return n;
        if (a.size !== b.size) return ((a.size ?? 0) - (b.size ?? 0)) * dir;
        break;
      }
      case "modified":
      case "created": {
        const key = sort.key === "modified" ? "modifiedAt" : "createdAt";
        const n = nullsLast(a[key], b[key]);
        if (n) return n;
        if (a[key] !== b[key]) return ((a[key] ?? 0) - (b[key] ?? 0)) * dir;
        break;
      }
      case "kind": {
        const cmp = a.ext.localeCompare(b.ext);
        if (cmp) return cmp * dir;
        break;
      }
      case "name":
        break;
    }
    // Name is both the default key and every other key's tiebreak, so equal
    // sizes/dates still produce ONE stable order rather than reshuffling between
    // two identical fetches. `numeric` gets `file10` after `file9`.
    const byName = a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return sort.key === "name" ? byName * dir : byName;
  });
}

/* ---------------------------------------------------------------- mutations */

/** What a write asked for — one shape for the whole `/api/fs/mutate` family. */
export const FsMutationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mkdir"), path: z.string() }),
  z.object({ op: z.literal("create-file"), path: z.string() }),
  /** Rename in place: `to` is a bare NAME, not a path. */
  z.object({ op: z.literal("rename"), path: z.string(), to: z.string() }),
  z.object({ op: z.literal("move"), paths: z.array(z.string()), toDir: z.string() }),
  z.object({ op: z.literal("copy"), paths: z.array(z.string()), toDir: z.string() }),
  z.object({
    op: z.literal("delete"),
    paths: z.array(z.string()),
    /**
     * Skip the trash and unlink. Defaults false: a misclick in a file manager
     * should be recoverable, and the Recycle Bin / XDG trash is the OS's own
     * answer for that.
     */
    permanent: z.boolean().default(false),
  }),
]);
export type FsMutation = z.infer<typeof FsMutationSchema>;

/** What a write did. Partial success is real: deleting 3 of 5 files reports both. */
export const FsMutationResultSchema = z.object({
  ok: z.boolean(),
  /** Paths that ended up written/created/removed. */
  changed: z.array(z.string()),
  /** Per-path failures, so the UI can name the two that didn't work. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  /**
   * True when a delete actually reached the trash. False means it was permanent
   * — either because it was asked for, or because this system has no trash. The
   * UI says which BEFORE the click, and this confirms which happened.
   */
  trashed: z.boolean().optional(),
});
export type FsMutationResult = z.infer<typeof FsMutationResultSchema>;
