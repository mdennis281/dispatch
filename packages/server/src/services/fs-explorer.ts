/**
 * FsExplorerService — the disk, as seen by a browser tab.
 *
 * The client half of this app cannot see a filesystem at all: `<input type=file>`
 * and OS drag-and-drop both hand back a bare basename, and there is no web API
 * that enumerates drives or reports an mtime. So everything the explorer shows —
 * every listing, every stat, every drive letter — comes from here.
 *
 * Three things this module is deliberate about:
 *
 *   **Platform logic is pure and parameterized.** `parseLinuxMounts`,
 *   `formatPosixMode`, `parsePasswd` and friends take their input as a STRING and
 *   their platform as an ARGUMENT, so the Linux paths are exercised by the test
 *   suite on a Windows dev box and the Windows paths are exercised in CI on
 *   Linux. The alternative — branching on `process.platform` inside an I/O
 *   function — means half this file is only ever run by half the developers.
 *
 *   **Listing is cheap; detail is not.** A directory listing costs one `lstat`
 *   per entry and nothing else. Ownership (an `/etc/passwd` lookup, or an
 *   out-of-process `Get-Acl` on Windows) and "last edited by" (a `git log`) are
 *   answered one path at a time by {@link FsExplorerService.details}, because
 *   doing them per row would put thousands of subprocesses behind a single click
 *   into `node_modules`.
 *
 *   **Deletes go to the trash.** The Recycle Bin and the XDG trash spec exist
 *   because a file manager is one misclick away from destroying work, and a web
 *   UI with drag-and-drop is more than one. Permanent deletion is available, but
 *   it is asked for, never assumed.
 *
 * Reads span the whole filesystem; writes are allowed wherever the server's own
 * user can write. That is the same authority the terminal and agent tools in
 * this app already hand out, so gating it here would be theatre — the guards
 * below are the ones that catch BUGS (moving a directory into itself, deleting a
 * drive root), not the ones that pretend to contain a user who already has a shell.
 */
import {
  readdir,
  readlink,
  lstat,
  stat,
  statfs,
  mkdir,
  rename,
  rm,
  cp,
  open,
  readFile,
  access,
} from "node:fs/promises";
import { constants as FS, existsSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, extname } from "node:path";
import {
  fsNormalize,
  fsParent,
  fsIsRoot,
  fsIsInside,
  fsIsAbsolute,
  fsExtension,
  fsIsHiddenName,
  fsIsSelectable,
  type FsEntry,
  type FsEntryKind,
  type FsListing,
  type FsDetails,
  type FsRoot,
  type FsPlatform,
  type FsMutation,
  type FsMutationResult,
  type FsFilter,
} from "@dispatch/shared";
import { scorePath } from "./file-index.js";
import type { ExecFn } from "./worktree.js";
import { execa } from "execa";

/* ------------------------------------------------------------------- limits */

/** Entries returned for one directory before the listing is truncated. */
export const MAX_ENTRIES = 5_000;
/** Concurrent `lstat` calls while building a listing. */
const STAT_CONCURRENCY = 64;
/** Results a search returns before it stops walking. */
export const MAX_SEARCH_RESULTS = 500;
/** Directory entries a search will visit before giving up. */
export const MAX_SEARCH_VISITS = 200_000;
/** Wall-clock budget for one search, so a network mount can't hang a request. */
export const SEARCH_BUDGET_MS = 5_000;
/** Recursion depth for a search walk — deep enough for any real tree. */
const MAX_SEARCH_DEPTH = 24;

/**
 * Directories a search never descends into unless explicitly asked.
 *
 * These are build output and package caches: they hold the overwhelming majority
 * of files in a checkout and essentially none of the ones anybody is looking
 * for, so walking them turns a 40ms search into a 20s one that finds a thousand
 * copies of `index.js`.
 */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  "vendor",
]);

/**
 * Pseudo-filesystems that are mounted everywhere and interesting nowhere. A
 * Linux box has forty-odd mounts and maybe four of them are storage; listing
 * `cgroup` and `devpts` as places to browse buries the USB stick.
 */
export const PSEUDO_FS_TYPES: ReadonlySet<string> = new Set([
  "proc",
  "sysfs",
  "devtmpfs",
  "devpts",
  "cgroup",
  "cgroup2",
  "pstore",
  "bpf",
  "securityfs",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "binfmt_misc",
  "autofs",
  "efivarfs",
  "ramfs",
  "squashfs",
  "nsfs",
  "rpc_pipefs",
  "selinuxfs",
]);

/* --------------------------------------------------------- pure platform bits */

/** Node's platform string reduced to the two sets of path rules that exist. */
export function toFsPlatform(platform: NodeJS.Platform): FsPlatform {
  return platform === "win32" ? "win32" : "posix";
}

/** Forward slashes everywhere the UI shows a path, on every platform. */
export const fwd = (p: string): string => p.replace(/\\/g, "/");

/**
 * The top level of the git repo containing `path`, or null.
 *
 * Walks UP rather than checking one directory, because "is this tracked?" is a
 * question about the whole ancestry: `apps/new-service` inside a monorepo is
 * already in a repo even though it has no `.git` of its own.
 *
 * Lives here (rather than beside the route that first needed it) so services can
 * use it without importing from `routes/` — `routes/fs.ts` re-exports it for the
 * callers that already had it.
 */
export function enclosingRepoRoot(path: string): string | null {
  let cur = resolve(path);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** One line of `/proc/mounts`, already split. */
export interface LinuxMount {
  device: string;
  mountPoint: string;
  type: string;
}

/**
 * Parse `/proc/mounts` (or `/etc/mtab`, same format) into the mounts worth
 * offering as browsing roots.
 *
 * The format is space-separated with octal escapes in the paths — a USB stick
 * called "My Drive" arrives as `/media/me/My\040Drive`, and a UI that showed the
 * escape (or worse, navigated to it) would simply not find the disk.
 *
 * Pure and string-in so the Linux branch is testable from Windows.
 */
export function parseLinuxMounts(text: string): LinuxMount[] {
  const out: LinuxMount[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [device, rawPoint, type] = parts;
    if (PSEUDO_FS_TYPES.has(type)) continue;
    const mountPoint = unescapeMountPath(rawPoint);
    if (!mountPoint.startsWith("/")) continue;
    // The same device mounted twice (bind mounts, overlay layers) is one place
    // as far as browsing is concerned; the first mount point wins.
    if (seen.has(mountPoint)) continue;
    seen.add(mountPoint);
    out.push({ device, mountPoint, type });
  }
  return out;
}

/** `\040` → space, `\011` → tab, etc. — the octal escapes fstab-format uses. */
export function unescapeMountPath(p: string): string {
  return p.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Should a Linux mount be offered as a root?
 *
 * `/` always. Otherwise the removable and external places people actually
 * browse to — `/mnt`, `/media`, `/run/media` — plus anything that is a real
 * block device rather than a virtual overlay. A container's `/etc/resolv.conf`
 * bind mount is technically a mount and is never a destination.
 */
export function isBrowsableMount(m: LinuxMount): boolean {
  if (m.mountPoint === "/") return true;
  if (/^\/(mnt|media|run\/media|Volumes)(\/|$)/.test(m.mountPoint)) return true;
  // A bind-mounted FILE (very common in containers) has an extension and is not
  // a directory anyone can browse.
  if (extname(m.mountPoint)) return false;
  return m.device.startsWith("/dev/") && !m.mountPoint.startsWith("/boot");
}

/** The 26 drive letters, in order. Probing them is how Windows enumerates. */
export function windowsDriveCandidates(): string[] {
  return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:`);
}

/**
 * Render a POSIX mode as `rwxr-xr-x`.
 *
 * Only the permission bits — the file-type nibble is already reported as `kind`,
 * and a UI that showed `drwxr-xr-x` beside a folder icon would be saying the same
 * thing twice.
 */
export function formatPosixMode(mode: number): string {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) {
    out += mode & (1 << (8 - i)) ? bits[i] : "-";
  }
  return out;
}

/**
 * Map uid → username from an `/etc/passwd` body.
 *
 * Node has no `getpwuid`, and shelling out to `id -nu` per file would be a
 * subprocess per row. `/etc/passwd` is a few kilobytes and readable by everyone,
 * so one read covers every local user. Network directories (LDAP/SSSD) won't
 * appear here, which is why the caller falls back to showing the raw uid rather
 * than claiming the user doesn't exist.
 */
export function parsePasswd(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const uid = Number(parts[2]);
    if (!Number.isFinite(uid)) continue;
    // First definition wins — a duplicated uid (root:x:0 and toor:x:0) should
    // resolve to the canonical name, which is the one listed first.
    if (!map.has(uid)) map.set(uid, parts[0]);
  }
  return map;
}

/** Same shape as `/etc/passwd` for `/etc/group`: gid → group name. */
export function parseGroup(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const gid = Number(parts[2]);
    if (!Number.isFinite(gid)) continue;
    if (!map.has(gid)) map.set(gid, parts[0]);
  }
  return map;
}

/**
 * uid/gid → names, given the maps parsed out of `/etc/passwd` and `/etc/group`.
 *
 * Pulled out as a pure function because the alternative — asserting it through
 * `details()` with an injected `platform: "linux"` — needs a real POSIX path on
 * disk, which a Windows dev box cannot produce. This way the resolution logic
 * (including the raw-id fallback) is verified on every platform and `details()`
 * only has to be tested against the host it's actually running on.
 */
export function resolvePosixOwner(
  st: { uid: number; gid: number },
  users: Map<number, string>,
  groups: Map<number, string>,
): [string, string] {
  // The raw id is the fallback, not "unknown": a uid from a network directory
  // (LDAP/SSSD) that isn't in /etc/passwd is still a true and useful answer.
  return [users.get(st.uid) ?? String(st.uid), groups.get(st.gid) ?? String(st.gid)];
}

/**
 * Single-quote a path for a PowerShell `-Command`, doubling embedded quotes.
 *
 * Exported for its own test: a path containing an apostrophe (`Michael's Files`)
 * otherwise terminates the string and the remainder is interpreted as
 * PowerShell.
 */
export function quotePs(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

/**
 * Windows `Get-Acl` prints the owner as `BUILTIN\Administrators` or
 * `DESKTOP-1\Michael`. Show the account, drop the machine name — the domain is
 * the same for every file on the box and only steals column width.
 */
export function shortenWindowsOwner(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const slash = t.lastIndexOf("\\");
  return slash >= 0 ? t.slice(slash + 1) : t;
}

/**
 * A birthtime the kernel actually recorded, or null.
 *
 * Node reports the epoch (or silently substitutes ctime) on filesystems that
 * don't store a creation time — most notably older ext4 without `statx`. Zero is
 * the detectable case and becomes null, because rendering "1 Jan 1970" as a
 * creation date is worse than rendering nothing. The ctime substitution is NOT
 * detectable from Node, so on those systems "created" may quietly be "metadata
 * last changed"; that is a kernel limitation, not something a guess can fix.
 */
export function realBirthtime(birthtimeMs: number): number | null {
  return birthtimeMs > 0 ? birthtimeMs : null;
}

/**
 * A free filename in `dir` given `taken`: `notes.txt` → `notes (copy).txt` →
 * `notes (copy 2).txt`.
 *
 * Only copy uses this. Move and rename fail loudly on a collision instead,
 * because silently landing at a different name than the one you dropped onto is
 * how a file gets lost — whereas a copy that refused to run because the source
 * and destination directories are the same would just be useless.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the NAME (`.env`), not an extension, so `dot > 0`.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (copy ${Date.now()})${ext}`;
}

/* ------------------------------------------------------------------- helpers */

/** Run `work` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Default runner: execa with an argument array, never rejecting. */
const realExec: ExecFn = async (file, args, opts) => {
  try {
    const r = await execa(file, args, {
      cwd: opts.cwd,
      reject: false,
      stripFinalNewline: true,
      windowsHide: true,
      timeout: 10_000,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", exitCode: 1 };
  }
};

/**
 * A path the caller got wrong — relative, or empty.
 *
 * A distinct type so the routes can answer 400 (you sent something malformed)
 * rather than 404 (it isn't there). Those are different problems with different
 * fixes, and collapsing them makes a client bug look like a missing file.
 */
export class FsPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsPathError";
  }
}

/** Move a path to the OS trash. Swapped for a spy in tests. */
export type TrashFn = (paths: string[]) => Promise<void>;

const realTrash: TrashFn = async (paths) => {
  // Imported lazily: `trash` pulls in globby and a PowerShell shim, and the
  // overwhelming majority of Dispatch processes never delete a file. Paying that
  // at boot to save 30ms on an action a human has to click is the wrong trade.
  const { default: trash } = await import("trash");
  await trash(paths, { glob: false });
};

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/* ------------------------------------------------------------------ service */

export interface FsExplorerDeps {
  /** Overridden in tests to exercise the other platform's branches. */
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  trash?: TrashFn;
  /** `/proc/mounts` reader, injected so the Linux branch is testable anywhere. */
  readMounts?: () => Promise<string | null>;
  /** `/etc/passwd` + `/etc/group` readers, same reason. */
  readPasswd?: () => Promise<string | null>;
  readGroups?: () => Promise<string | null>;
  home?: () => string;
}

/** What {@link FsExplorerService.list} was asked for. */
export interface ListOptions {
  /** Cap on entries returned. Clamped to {@link MAX_ENTRIES}. */
  limit?: number;
}

/** What {@link FsExplorerService.search} was asked for. */
export interface SearchOptions {
  limit?: number;
  filter?: Partial<FsFilter>;
  /** Descend into `node_modules`, `dist`, … See {@link SEARCH_SKIP_DIRS}. */
  includeIgnored?: boolean;
}

/** Projects and worktrees the roots list should offer, supplied by the route. */
export interface RootSources {
  projects: Array<{ id: string; name: string; repoPath: string }>;
  worktrees: Array<{ path: string; branch?: string; projectName?: string }>;
}

export class FsExplorerService {
  private readonly platform: NodeJS.Platform;
  private readonly fsPlatform: FsPlatform;
  private readonly exec: ExecFn;
  private readonly trashFn: TrashFn;
  private readonly readMounts: () => Promise<string | null>;
  private readonly readPasswd: () => Promise<string | null>;
  private readonly readGroups: () => Promise<string | null>;
  private readonly home: () => string;
  /** uid→name / gid→name, read once per process — see {@link parsePasswd}. */
  private users: Map<number, string> | null = null;
  private groups: Map<number, string> | null = null;

  constructor(deps: FsExplorerDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.fsPlatform = toFsPlatform(this.platform);
    this.exec = deps.exec ?? realExec;
    this.trashFn = deps.trash ?? realTrash;
    this.home = deps.home ?? homedir;
    this.readMounts =
      deps.readMounts ??
      (async () => {
        for (const f of ["/proc/mounts", "/etc/mtab"]) {
          try {
            return await readFile(f, "utf8");
          } catch {
            continue;
          }
        }
        return null;
      });
    this.readPasswd = deps.readPasswd ?? (() => readFile("/etc/passwd", "utf8").catch(() => null));
    this.readGroups = deps.readGroups ?? (() => readFile("/etc/group", "utf8").catch(() => null));
  }

  /** The path rules in force — the client needs this to compute breadcrumbs. */
  get pathPlatform(): FsPlatform {
    return this.fsPlatform;
  }

  /**
   * A native path in the forward-slashed wire form.
   *
   * Platform-aware, unlike the bare {@link fwd}: on POSIX a backslash is a legal
   * FILENAME character, so converting one would hand the client a path that
   * points somewhere else — and a file named `we\ird` could never be opened,
   * renamed or deleted through this UI.
   */
  private toWire(nativePath: string): string {
    return this.platform === "win32" ? fwd(nativePath) : nativePath;
  }

  /**
   * Wire form (absolute, forward-slashed) → the form `node:fs` wants.
   *
   * `resolve` is what converts `C:/a/b` back to `C:\a\b` on Windows; on POSIX it
   * is a no-op for an already-absolute path.
   *
   * It also REFUSES a relative path, and this is the right place for that check
   * because it is the single chokepoint where a wire string becomes a real disk
   * location — every read and every write goes through here, so no future method
   * can forget to validate. `resolve()` anchors a relative path to the server
   * process's own cwd, so without this `list("packages")` quietly lists the
   * Dispatch install's own source tree: not a location any UI asked for, and not
   * one a user could navigate back out of sensibly.
   *
   * Writes had this guard from the start (`assertMutable`); reads did not, which
   * meant the two halves of the same API disagreed about what a path is.
   */
  private native(wirePath: string): string {
    const norm = fsNormalize(wirePath, this.fsPlatform);
    if (!norm) throw new FsPathError("path required");
    if (!fsIsAbsolute(norm, this.fsPlatform)) {
      throw new FsPathError(`not an absolute path: ${norm}`);
    }
    return resolve(norm);
  }

  /* ------------------------------------------------------------- listing */

  /**
   * One directory's contents.
   *
   * Every entry gets exactly one `lstat` (two, plus a `readlink`, for symlinks),
   * run 64-wide because a cold directory on a spinning disk or a network share is
   * latency-bound rather than CPU-bound. An entry whose stat fails still appears,
   * flagged `unreadable` — a permission-denied file you can SEE and can't open is
   * a much better experience than a directory that silently lists 8 of its 12
   * files with no indication that anything is missing.
   */
  async list(wirePath: string, opts: ListOptions = {}): Promise<FsListing> {
    const norm = fsNormalize(wirePath, this.fsPlatform);
    const dir = this.native(norm);
    const limit = Math.min(Math.max(1, opts.limit ?? MAX_ENTRIES), MAX_ENTRIES);

    const names = await readdir(dir);
    // Sorted before the cap so truncation takes a stable, alphabetical slice
    // rather than whatever order the filesystem happened to hand back — a
    // truncated listing that reshuffles between two refreshes is unusable.
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const total = names.length;
    const slice = names.slice(0, limit);

    const entries = await mapLimit(slice, STAT_CONCURRENCY, (name) =>
      this.entryFor(dir, norm, name),
    );

    return {
      path: norm,
      parent: fsParent(norm, this.fsPlatform),
      entries,
      truncated: total > slice.length,
      total,
      repoRoot: this.repoRootOf(dir),
    };
  }

  /** Build one row. Never throws — a failure becomes an `unreadable` entry. */
  private async entryFor(nativeDir: string, wireDir: string, name: string): Promise<FsEntry> {
    const nativePath = join(nativeDir, name);
    const wirePath = fsNormalize(`${wireDir.replace(/\/$/, "")}/${name}`, this.fsPlatform);
    const base: FsEntry = {
      name,
      path: wirePath,
      kind: "other",
      size: null,
      modifiedAt: null,
      createdAt: null,
      accessedAt: null,
      ext: fsExtension(name),
      hidden: fsIsHiddenName(name),
    };

    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(nativePath);
    } catch {
      // A permission-denied file you can SEE and can't open beats a listing
      // that silently returns 8 of its 12 entries with nothing to indicate it.
      return { ...base, unreadable: true };
    }

    if (st.isSymbolicLink()) {
      const target = await readlink(nativePath).catch(() => null);
      // `stat` follows the link; ENOENT here is exactly what "broken" means.
      const resolved = await stat(nativePath).catch(() => null);
      return {
        ...base,
        // A link to a directory navigates like a directory, so it reports as one.
        // `symlink` as a kind is reserved for the case with no target to report.
        kind: resolved ? (resolved.isDirectory() ? "directory" : "file") : "symlink",
        size: resolved && !resolved.isDirectory() ? resolved.size : null,
        modifiedAt: resolved ? resolved.mtimeMs : st.mtimeMs,
        createdAt: realBirthtime(resolved ? resolved.birthtimeMs : st.birthtimeMs),
        accessedAt: resolved ? resolved.atimeMs : st.atimeMs,
        link: { target: target ? this.toWire(target) : null, broken: !resolved },
      };
    }

    const isDir = st.isDirectory();
    return {
      ...base,
      kind: isDir ? "directory" : st.isFile() ? "file" : "other",
      // A directory's `size` is the size of its own inode, which is a number
      // people read as "how big is this folder" and it never is. Null instead.
      size: isDir ? null : st.size,
      modifiedAt: st.mtimeMs,
      createdAt: realBirthtime(st.birthtimeMs),
      accessedAt: st.atimeMs,
    };
  }

  /** `enclosingRepoRoot` in wire form, for the listing's git column. */
  private repoRootOf(nativePath: string): string | null {
    const root = enclosingRepoRoot(nativePath);
    return root ? this.toWire(root) : null;
  }

  /* --------------------------------------------------------------- roots */

  /**
   * Everywhere worth starting from: this user's home, every project checkout and
   * worktree Dispatch knows about, and every volume the OS has mounted.
   *
   * The projects come first in the UI because they're what this app is FOR; the
   * volumes are there because "I need that CSV off the D: drive" is a real thing
   * to want from a file picker and the alternative is typing a path.
   */
  async roots(sources: RootSources = { projects: [], worktrees: [] }): Promise<FsRoot[]> {
    const out: FsRoot[] = [];
    const home = this.toWire(this.home());
    out.push({ path: home, label: "Home", kind: "home", detail: home });

    for (const p of sources.projects) {
      if (!p.repoPath) continue;
      out.push({
        path: this.toWire(resolve(p.repoPath)),
        label: p.name,
        kind: "project",
        detail: this.toWire(p.repoPath),
      });
    }
    for (const w of sources.worktrees) {
      out.push({
        path: this.toWire(resolve(w.path)),
        label: w.branch ?? basename(w.path),
        kind: "worktree",
        detail: w.projectName,
      });
    }
    out.push(...(await this.volumes()));

    // A project whose checkout IS the home directory, or a worktree listed twice
    // by two projects, would otherwise appear as two rows that navigate to the
    // same place. First occurrence wins, so the more specific label survives.
    const seen = new Set<string>();
    return out.filter((r) => {
      const key = this.fsPlatform === "win32" ? r.path.toLowerCase() : r.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Drives (Windows) / mounts (Linux) / volumes (macOS), with capacity. */
  private async volumes(): Promise<FsRoot[]> {
    const paths: Array<{ path: string; label: string; detail?: string }> =
      this.platform === "win32"
        ? await this.windowsDrives()
        : this.platform === "darwin"
          ? await this.macVolumes()
          : await this.linuxMounts();

    return mapLimit(paths, 8, async (v) => {
      const usage = await this.capacity(v.path);
      return {
        path: v.path,
        label: v.label,
        kind: "drive" as const,
        detail: v.detail,
        ...usage,
      };
    });
  }

  /**
   * Windows drives, found by probing all 26 letters.
   *
   * Not `wmic` (removed from Windows 11 24H2) and not a PowerShell
   * `Get-PSDrive` (a ~700ms process spawn on the path of opening a picker). 26
   * `access` calls against nonexistent drives return instantly, and the ones
   * that exist were going to be stat'ed anyway.
   */
  private async windowsDrives(): Promise<Array<{ path: string; label: string }>> {
    const found = await mapLimit(windowsDriveCandidates(), 26, async (letter) => {
      const path = `${letter}/`;
      try {
        await access(resolve(path), FS.R_OK);
        return { path, label: letter };
      } catch {
        return null;
      }
    });
    return found.filter((d): d is { path: string; label: string } => d !== null);
  }

  /** Real mounts out of `/proc/mounts`. */
  private async linuxMounts(): Promise<Array<{ path: string; label: string; detail: string }>> {
    const text = await this.readMounts();
    // No `/proc` (a stripped container, a BSD) still deserves a starting point.
    if (!text) return [{ path: "/", label: "/", detail: "filesystem" }];
    return parseLinuxMounts(text)
      .filter(isBrowsableMount)
      .map((m) => ({
        path: m.mountPoint,
        label: m.mountPoint === "/" ? "/" : basename(m.mountPoint) || m.mountPoint,
        detail: `${m.device} · ${m.type}`,
      }));
  }

  /** macOS keeps every mounted volume, including the boot disk, under /Volumes. */
  private async macVolumes(): Promise<Array<{ path: string; label: string }>> {
    const roots = [{ path: "/", label: "/" }];
    const names = await readdir("/Volumes").catch(() => [] as string[]);
    for (const n of names) roots.push({ path: `/Volumes/${n}`, label: n });
    return roots;
  }

  /** Total/free bytes for the volume holding `path`, or nulls if unavailable. */
  private async capacity(
    wirePath: string,
  ): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
    try {
      const s = await statfs(this.native(wirePath));
      // `bavail` (free to THIS user), not `bfree` (free including the root
      // reserve) — the reserve isn't space anybody gets to use.
      return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
    } catch {
      return { totalBytes: null, freeBytes: null };
    }
  }

  /* ------------------------------------------------------------- details */

  /**
   * The expensive facts for ONE path: ownership, mode, hard links, and the git
   * authorship that stands in for the "edited by" a filesystem never records.
   */
  async details(wirePath: string): Promise<FsDetails> {
    const norm = fsNormalize(wirePath, this.fsPlatform);
    const nativePath = this.native(norm);
    const parent = fsParent(norm, this.fsPlatform);
    const entry = await this.entryFor(
      parent ? this.native(parent) : nativePath,
      parent ?? norm,
      basename(nativePath) || norm,
    );

    const st = await stat(nativePath).catch(() => null);
    const writable = await access(nativePath, FS.W_OK).then(
      () => true,
      () => false,
    );

    const [owner, group] = await this.ownership(nativePath, st);
    const git = await this.lastCommitAuthor(nativePath);

    let childCount: number | null = null;
    if (entry.kind === "directory") {
      childCount = await readdir(nativePath).then(
        (n) => n.length,
        () => null,
      );
    }

    return {
      entry,
      owner,
      group,
      // File modes are a POSIX concept. Windows carries a fake one (everything
      // is 0666 or 0777) that describes nothing, so reporting it would be noise
      // dressed up as information.
      mode: this.platform === "win32" || !st ? null : formatPosixMode(st.mode & 0o777),
      writable,
      links: st ? st.nlink : null,
      lastEditedBy: git.author,
      lastEditedAt: git.at,
      childCount,
    };
  }

  /** [owner, group] for a path, by whatever means the platform offers. */
  private async ownership(
    nativePath: string,
    st: { uid: number; gid: number } | null,
  ): Promise<[string | null, string | null]> {
    if (this.platform === "win32") {
      // Windows ownership lives in an ACL, which Node cannot read. One
      // PowerShell call per SELECTED file is affordable; per listed row is not,
      // which is exactly why this lives in `details` and not in `list`.
      const r = await this.exec(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Acl -LiteralPath ${quotePs(nativePath)}).Owner`,
        ],
        { cwd: dirname(nativePath) },
      );
      return [r.exitCode === 0 ? shortenWindowsOwner(r.stdout) : null, null];
    }
    if (!st) return [null, null];
    if (!this.users) this.users = parsePasswd((await this.readPasswd()) ?? "");
    if (!this.groups) this.groups = parseGroup((await this.readGroups()) ?? "");
    return resolvePosixOwner(st, this.users, this.groups);
  }

  /**
   * Who last committed this file, per `git log -1`.
   *
   * This is the closest thing to "edited by" that exists. `stat` records when a
   * file changed and never who changed it — no filesystem in common use stores
   * that — so anything else would be invented. Outside a checkout it's null, and
   * the UI says "not tracked" rather than pretending nobody has touched it.
   */
  private async lastCommitAuthor(
    nativePath: string,
  ): Promise<{ author: string | null; at: number | null }> {
    const repo = enclosingRepoRoot(nativePath);
    if (!repo) return { author: null, at: null };
    const r = await this.exec(
      "git",
      ["log", "-1", "--format=%an%x00%at", "--", nativePath],
      { cwd: repo },
    );
    if (r.exitCode !== 0 || !r.stdout.trim()) return { author: null, at: null };
    const [author, at] = r.stdout.trim().split("\0");
    const ts = Number(at);
    return {
      author: author || null,
      // git prints seconds; everything else in this app is epoch-ms.
      at: Number.isFinite(ts) ? ts * 1000 : null,
    };
  }

  /* -------------------------------------------------------------- search */

  /**
   * Find files under `root` matching `query`.
   *
   * A bounded breadth-first walk, deliberately NOT `git ls-files`: this has to
   * work in `C:/Users/me/Downloads` as well as in a checkout, and it has to see
   * build output when asked. The composer's file picker still uses the
   * git-backed {@link FileIndexService} — that one is scoped to a repo, cached,
   * and one process instead of a hundred thousand `readdir`s, which is the right
   * tool for "@-mention a file in this project".
   *
   * Every bound here exists because a filesystem is unbounded: a result cap so a
   * one-character query doesn't stream 400k rows, a visit cap so `/` terminates,
   * a depth cap, a wall-clock budget so a disconnected network mount fails fast
   * instead of hanging the request, and no symlink following at all — which is
   * what stops `/proc/self/root` and an ordinary `ln -s .. loop` from walking
   * forever.
   */
  async search(rootPath: string, query: string, opts: SearchOptions = {}): Promise<FsEntry[]> {
    const root = fsNormalize(rootPath, this.fsPlatform);
    const limit = Math.min(Math.max(1, opts.limit ?? 100), MAX_SEARCH_RESULTS);
    const q = query.trim();
    const filter = opts.filter ?? {};
    const showHidden = filter.showHidden ?? false;
    const deadline = Date.now() + SEARCH_BUDGET_MS;

    /**
     * Stop once there is comfortably more than enough to rank.
     *
     * The walk is breadth-first, so hits arrive shallowest-first — and the
     * ranking's tiebreak is path length, which prefers exactly those. Collecting
     * five pages' worth and ranking them therefore returns the same top slice as
     * walking the whole disk would, for a fraction of the work: a broad query
     * like "readme" over a home directory used to spend the full 5s budget
     * finding its 12,000th match to then throw away all but 50.
     *
     * A NARROW query — the specific filename you're actually hunting — never
     * reaches this cap, so it still gets the exhaustive walk it needs.
     */
    const collectCap = limit * 5;
    const hits: Array<{ entry: FsEntry; score: number }> = [];
    const queue: Array<{ wire: string; native: string; depth: number }> = [
      { wire: root, native: this.native(root), depth: 0 },
    ];
    // A read CURSOR rather than `queue.shift()`. Shift reindexes the whole
    // array, so draining a queue of N directories is O(n²) — on a tree with
    // tens of thousands of directories that is real CPU stacked on top of the
    // I/O. The queue is never long-lived enough for the abandoned prefix to be
    // worth reclaiming.
    let head = 0;
    let visits = 0;

    while (head < queue.length) {
      if (Date.now() > deadline) break;
      const dir = queue[head++];
      if (!dir) break;

      let dirents: Dirent[];
      try {
        // `withFileTypes` is the difference between a search that finishes and
        // one that doesn't. The directory enumeration ALREADY carries the entry
        // type (FindFirstFile on Windows, `d_type` on Linux), so asking for it
        // here costs nothing — where an `lstat` per entry is a syscall per
        // entry, serialized, over hundreds of thousands of files. Measured on a
        // 40-repo directory: 11s before, well under 1s after.
        dirents = await readdir(dir.native, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip it, don't fail the search
      }

      for (const dirent of dirents) {
        // Checked per ENTRY, not per directory. One directory with 20k names
        // took ~6s to walk, so a budget tested only at the top of the outer
        // loop overshot by more than the budget itself.
        if (++visits > MAX_SEARCH_VISITS || Date.now() > deadline) {
          return this.rankSearch(hits, limit);
        }
        const name = dirent.name;
        if (!showHidden && fsIsHiddenName(name)) continue;
        // Never followed: an ordinary `ln -s .. loop` otherwise walks forever.
        // Skipped as a RESULT too, since a link resolves to something that is
        // already listed under its real path.
        if (dirent.isSymbolicLink()) continue;

        const wire = `${dir.wire.replace(/\/$/, "")}/${name}`;
        const native = join(dir.native, name);
        const isDir = dirent.isDirectory();

        if (isDir) {
          if (
            dir.depth + 1 <= MAX_SEARCH_DEPTH &&
            (opts.includeIgnored || !SEARCH_SKIP_DIRS.has(name))
          ) {
            queue.push({ wire, native, depth: dir.depth + 1 });
          }
        }

        const kind: FsEntryKind = isDir ? "directory" : dirent.isFile() ? "file" : "other";
        if (
          !fsIsSelectable(
            { name, kind },
            { select: filter.select ?? "any", extensions: filter.extensions },
          )
        ) {
          continue;
        }
        // Score against the path RELATIVE to the search root: matching against
        // the absolute path would let `C:/Users/michael/…` make every file under
        // a home directory a hit for "michael".
        const rel = wire.startsWith(root) ? wire.slice(root.length).replace(/^\//, "") : wire;
        const score = scorePath(rel, q);
        if (score === null) continue;

        // Only a HIT is worth a stat. This is the other half of the win above:
        // the numbers are needed for the handful of rows that come back, not
        // for the hundred thousand that were walked past.
        const st = await lstat(native).catch(() => null);
        if (hits.length >= collectCap) return this.rankSearch(hits, limit);
        hits.push({
          entry: {
            name,
            path: fsNormalize(wire, this.fsPlatform),
            kind,
            size: isDir || !st ? null : st.size,
            modifiedAt: st?.mtimeMs ?? null,
            createdAt: st ? realBirthtime(st.birthtimeMs) : null,
            accessedAt: st?.atimeMs ?? null,
            ext: fsExtension(name),
            hidden: fsIsHiddenName(name),
          },
          score,
        });
      }
    }
    return this.rankSearch(hits, limit);
  }

  /** Best score first, shallow before deep, then alphabetical for stability. */
  private rankSearch(hits: Array<{ entry: FsEntry; score: number }>, limit: number): FsEntry[] {
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path),
    );
    return hits.slice(0, limit).map((h) => h.entry);
  }

  /* ----------------------------------------------------------- mutations */

  /**
   * Apply one write.
   *
   * Partial success is a real outcome — deleting five files can fail on the two
   * that are open in another process — so this reports `changed` and `errors`
   * side by side rather than throwing on the first problem and leaving the
   * caller unable to say what did happen.
   */
  async mutate(m: FsMutation): Promise<FsMutationResult> {
    switch (m.op) {
      case "mkdir":
        return this.one(m.path, async (p) => {
          // Not `recursive: true`: "New folder" that silently succeeds on a name
          // that already exists has merged your new folder into an existing one.
          await mkdir(p, { recursive: false });
        });
      case "create-file":
        return this.one(m.path, async (p) => {
          // `wx` = create, fail if it exists. Never truncate a file that's there.
          const fh = await open(p, "wx");
          await fh.close();
        });
      case "rename":
        return this.rename(m.path, m.to);
      case "move":
        return this.transfer(m.paths, m.toDir, "move");
      case "copy":
        return this.transfer(m.paths, m.toDir, "copy");
      case "delete":
        return this.remove(m.paths, m.permanent);
    }
  }

  /** Run a single-path mutation, mapping a throw into the error channel. */
  private async one(
    wirePath: string,
    work: (nativePath: string) => Promise<void>,
  ): Promise<FsMutationResult> {
    const norm = fsNormalize(wirePath, this.fsPlatform);
    try {
      this.assertMutable(norm);
      await work(this.native(norm));
      return { ok: true, changed: [norm], errors: [] };
    } catch (err) {
      return { ok: false, changed: [], errors: [{ path: norm, message: message(err) }] };
    }
  }

  /**
   * The guards that catch BUGS rather than users.
   *
   * Writes are allowed anywhere this process can write — that's the same
   * authority the terminal already grants, and pretending otherwise would be
   * theatre. But a UI can generate a request no human meant: an empty path from
   * an uninitialized field, a relative one from a bad join, or a drive root from
   * a breadcrumb click plus a stray Delete key. None of those are decisions, so
   * none of them execute.
   */
  private assertMutable(norm: string): void {
    // Absoluteness is enforced by `native()`, the chokepoint every path crosses
    // on its way to the disk — but it is checked here TOO, because a mutation
    // that fails late has already been partly reported as a `changed` path in a
    // batch. Failing before the batch starts keeps the result honest.
    if (!norm) throw new FsPathError("path required");
    // `fsIsAbsolute`, not "does it have a parent" — `relative/dir` HAS a parent
    // (`relative`), so the weaker check let a relative path through to
    // `resolve()`, which silently anchored it to the server's own cwd. That's
    // how a "New folder" click lands inside the Dispatch install.
    if (!fsIsAbsolute(norm, this.fsPlatform)) {
      throw new FsPathError(`not an absolute path: ${norm}`);
    }
    if (fsIsRoot(norm, this.fsPlatform)) {
      throw new Error(`refusing to modify a filesystem root: ${norm}`);
    }
  }

  /** Rename in place. `to` is a bare name — a path here is always a mistake. */
  private async rename(wirePath: string, to: string): Promise<FsMutationResult> {
    const norm = fsNormalize(wirePath, this.fsPlatform);
    const fail = (msg: string): FsMutationResult => ({
      ok: false,
      changed: [],
      errors: [{ path: norm, message: msg }],
    });
    try {
      this.assertMutable(norm);
    } catch (err) {
      return fail(message(err));
    }
    const name = to.trim();
    if (!name) return fail("name required");
    // A rename is not a move. Accepting `../elsewhere/x` here would make the
    // "Rename" affordance quietly relocate the file.
    if (/[\\/]/.test(name)) return fail("a name cannot contain a path separator");
    if (name === "." || name === "..") return fail(`invalid name: ${name}`);

    const parent = fsParent(norm, this.fsPlatform);
    if (!parent) return fail("cannot rename a filesystem root");
    const target = fsNormalize(`${parent.replace(/\/$/, "")}/${name}`, this.fsPlatform);
    try {
      // `rename` overwrites an existing file silently on every platform, so
      // checking first is the only thing standing between "Rename" and a
      // destroyed sibling.
      //
      // The case-only rename (`readme.md` → `README.md`) has to stay legal
      // though, and on a case-INSENSITIVE filesystem the target "already
      // exists" — because it IS the source. Windows and macOS are both
      // case-insensitive by default, so string comparison alone gets this wrong
      // on two of three platforms; asking the filesystem whether the two paths
      // are the same file gets it right on all of them.
      const nativeTarget = this.native(target);
      if ((await pathExists(nativeTarget)) && !(await isSameFile(this.native(norm), nativeTarget))) {
        return fail(`${name} already exists`);
      }
      await rename(this.native(norm), nativeTarget);
      return { ok: true, changed: [target], errors: [] };
    } catch (err) {
      return fail(message(err));
    }
  }

  /** Move or copy a batch into `toDir`. */
  private async transfer(
    wirePaths: string[],
    toDirWire: string,
    mode: "move" | "copy",
  ): Promise<FsMutationResult> {
    const toDir = fsNormalize(toDirWire, this.fsPlatform);
    const changed: string[] = [];
    const errors: Array<{ path: string; message: string }> = [];

    let taken: Set<string>;
    try {
      taken = new Set(await readdir(this.native(toDir)));
    } catch (err) {
      return {
        ok: false,
        changed: [],
        errors: [{ path: toDir, message: `destination unreadable: ${message(err)}` }],
      };
    }

    for (const raw of wirePaths) {
      const src = fsNormalize(raw, this.fsPlatform);
      try {
        this.assertMutable(src);
        // Moving `/a` into `/a/b` would relocate a directory inside itself —
        // POSIX returns EINVAL, but Windows happily starts the operation and
        // leaves a half-moved tree behind. Refusing outright is the only
        // consistent answer.
        if (fsIsInside(toDir, src, this.fsPlatform)) {
          throw new Error("cannot move a directory into itself");
        }
        const name = basename(this.native(src));
        // Copy resolves a collision (`a.txt` → `a (copy).txt`) because copying
        // into the source's own directory is the single most common copy there
        // is. Move refuses, because landing under a name you didn't choose is
        // how a file becomes unfindable.
        const targetName = mode === "copy" ? uniqueName(name, taken) : name;
        if (mode === "move" && taken.has(targetName)) {
          throw new Error(`${targetName} already exists in the destination`);
        }
        const target = fsNormalize(`${toDir.replace(/\/$/, "")}/${targetName}`, this.fsPlatform);
        if (mode === "copy") {
          await cp(this.native(src), this.native(target), {
            recursive: true,
            errorOnExist: true,
            force: false,
            // Copy the LINK, not a duplicate of everything it points at — the
            // other way round can turn a 4-byte symlink into a recursive copy of
            // a whole other tree.
            verbatimSymlinks: true,
          });
        } else {
          await this.moveOne(this.native(src), this.native(target));
        }
        taken.add(targetName);
        changed.push(target);
      } catch (err) {
        errors.push({ path: src, message: message(err) });
      }
    }
    return { ok: errors.length === 0, changed, errors };
  }

  /**
   * `rename`, falling back to copy-then-delete across devices.
   *
   * EXDEV is not an edge case here: dragging from `C:` to `D:`, or out of a
   * container's overlay onto a bind mount, is an ordinary thing to do in a file
   * manager and `rename(2)` cannot do it.
   */
  private async moveOne(src: string, target: string): Promise<void> {
    try {
      await rename(src, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await cp(src, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await rm(src, { recursive: true, force: false });
    }
  }

  /**
   * Delete, to the trash by default.
   *
   * The whole batch goes to `trash` in one call because that's one PowerShell
   * spawn (Windows) or one XDG trash-directory resolution (Linux) instead of N —
   * and because the OS's own undo groups them, so restoring is one action too.
   * If trashing isn't available at all, this reports the failure rather than
   * quietly falling back to an unlink: "delete" and "delete forever" are
   * different decisions and only one of them was made.
   */
  private async remove(wirePaths: string[], permanent: boolean): Promise<FsMutationResult> {
    const norms: string[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const raw of wirePaths) {
      const norm = fsNormalize(raw, this.fsPlatform);
      try {
        this.assertMutable(norm);
        norms.push(norm);
      } catch (err) {
        errors.push({ path: norm, message: message(err) });
      }
    }
    // `trashed: false` — nothing was deleted, so nothing reached the trash.
    // Reporting the INTENT here would tell a caller its files are recoverable
    // from the Recycle Bin when they were never touched.
    if (!norms.length) return { ok: false, changed: [], errors, trashed: false };

    if (permanent) {
      for (const norm of norms) {
        try {
          // `force: false` so deleting something that's already gone is an
          // error the UI can report rather than a silent no-op that looks like
          // success — the usual cause is a stale listing.
          await rm(this.native(norm), { recursive: true, force: false });
        } catch (err) {
          errors.push({ path: norm, message: message(err) });
        }
      }
      const failed = new Set(errors.map((e) => e.path));
      return {
        ok: errors.length === 0,
        changed: norms.filter((n) => !failed.has(n)),
        errors,
        trashed: false,
      };
    }

    try {
      await this.trashFn(norms.map((n) => this.native(n)));
      return { ok: errors.length === 0, changed: norms, errors, trashed: true };
    } catch (err) {
      return {
        ok: false,
        changed: [],
        errors: [...errors, { path: norms[0], message: `could not move to trash: ${message(err)}` }],
        // The trash call THREW: nothing is in the trash. Saying otherwise sends
        // someone to the Recycle Bin to recover a file that is still on disk.
        trashed: false,
      };
    }
  }
}

async function pathExists(nativePath: string): Promise<boolean> {
  try {
    await lstat(nativePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Do these two paths name the same file on disk?
 *
 * device + inode, which is the filesystem's own answer and therefore the one
 * that's right on a case-insensitive volume. Node populates `ino` on NTFS too;
 * a zero from a filesystem that doesn't report one falls back to `false`, which
 * is the safe direction — it refuses a rename rather than overwriting.
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([lstat(a), lstat(b)]);
    if (!sa.ino || !sb.ino) return false;
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}
