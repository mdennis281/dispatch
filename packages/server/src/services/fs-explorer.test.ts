/**
 * Explorer tests, in two halves.
 *
 * The PURE half feeds `/proc/mounts` text, `/etc/passwd` text and mode integers
 * to functions that take them as arguments, so the Linux branches run on a
 * Windows dev box and the Windows branches run in CI on Linux. That's the whole
 * reason those functions don't read `process.platform` themselves.
 *
 * The I/O half runs against a real temp directory on whatever platform is
 * hosting, with the shellouts (trash, PowerShell, git) injected.
 *
 * Those two halves are drawn where they are because a service told
 * `platform: "linux"` now — correctly — rejects `C:/…` as not absolute, and a
 * Windows box cannot produce a real POSIX path to hand it instead. So anything
 * that needs a live path is tested against the HOST platform, and the logic that
 * differs per platform is pulled out into pure functions (`resolvePosixOwner`,
 * `quotePs`, `parseLinuxMounts`, `formatPosixMode`) that run everywhere. The
 * few genuinely OS-bound assertions — the drive probe, `Get-Acl` — are gated on
 * the host and covered by CI's Windows leg.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsExplorerService,
  parseLinuxMounts,
  unescapeMountPath,
  isBrowsableMount,
  parsePasswd,
  parseGroup,
  formatPosixMode,
  shortenWindowsOwner,
  realBirthtime,
  uniqueName,
  windowsDriveCandidates,
  toFsPlatform,
  enclosingRepoRoot,
  fwd,
  FsPathError,
  resolvePosixOwner,
  quotePs,
  MAX_ENTRIES,
  SEARCH_SKIP_DIRS,
  type TrashFn,
} from "./fs-explorer.js";
import type { ExecFn } from "./worktree.js";

let dir: string;
/** The temp dir in the wire form the service speaks (absolute, forward slashes). */
let wire: string;

/**
 * The NUL `git log --format=%an%x00%at` puts between the author and the date.
 *
 * Named rather than embedded: a raw NUL byte in a source file is legal, totally
 * invisible in an editor, and makes the file read as binary to `grep` — and it
 * is the exact character this assertion is about, so it should be stated.
 */
const NUL = "\u0000";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-fsx-"));
  wire = fwd(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Windows creates directory junctions without elevation but refuses FILE
 * symlinks unless Developer Mode is on, so the symlink tests probe rather than
 * assume — a suite that fails on an un-elevated Windows box teaches people to
 * ignore it.
 */
async function symlinksWork(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "cm-fsx-probe-"));
  try {
    await writeFile(join(probe, "t"), "x");
    await symlink(join(probe, "t"), join(probe, "l"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}
const CAN_SYMLINK = await symlinksWork();

/* =========================================================== pure: platform */

describe("toFsPlatform", () => {
  it("collapses every non-Windows platform onto the POSIX rules", () => {
    expect(toFsPlatform("win32")).toBe("win32");
    expect(toFsPlatform("linux")).toBe("posix");
    expect(toFsPlatform("darwin")).toBe("posix");
    expect(toFsPlatform("freebsd")).toBe("posix");
  });
});

describe("parseLinuxMounts", () => {
  // A realistic slice of a desktop /proc/mounts, pseudo-filesystems and all.
  const MOUNTS = [
    "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
    "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
    "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
    "/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0",
    "cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid 0 0",
    "/dev/sdb1 /media/me/My\\040Drive exfat rw,nosuid,nodev,relatime 0 0",
    "tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime 0 0",
    "/dev/sdc1 /mnt/data xfs rw,relatime 0 0",
  ].join("\n");

  it("drops pseudo-filesystems", () => {
    const points = parseLinuxMounts(MOUNTS).map((m) => m.mountPoint);
    expect(points).not.toContain("/proc");
    expect(points).not.toContain("/sys");
    expect(points).not.toContain("/sys/fs/cgroup");
  });

  it("decodes the octal escapes in a mount path", () => {
    // `/media/me/My\040Drive` is a USB stick called "My Drive". Navigating to
    // the escaped form finds nothing at all.
    const usb = parseLinuxMounts(MOUNTS).find((m) => m.mountPoint.includes("My"));
    expect(usb?.mountPoint).toBe("/media/me/My Drive");
  });

  it("keeps device and type for the detail line", () => {
    const root = parseLinuxMounts(MOUNTS).find((m) => m.mountPoint === "/");
    expect(root).toMatchObject({ device: "/dev/nvme0n1p2", type: "ext4" });
  });

  it("keeps only the first mount of a repeated mount point", () => {
    const dup = "/dev/sda1 /mnt/x ext4 rw 0 0\n/dev/sdb1 /mnt/x ext4 rw 0 0";
    const mounts = parseLinuxMounts(dup);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].device).toBe("/dev/sda1");
  });

  it("ignores blank and malformed lines instead of throwing", () => {
    expect(parseLinuxMounts("")).toEqual([]);
    expect(parseLinuxMounts("garbage\n\n/dev/sda1")).toEqual([]);
  });

  it("skips a relative mount point", () => {
    expect(parseLinuxMounts("overlay overlay overlay rw 0 0")).toEqual([]);
  });
});

describe("unescapeMountPath", () => {
  it("decodes spaces and tabs", () => {
    expect(unescapeMountPath("/media/My\\040Drive")).toBe("/media/My Drive");
    expect(unescapeMountPath("/a\\011b")).toBe("/a\tb");
  });

  it("leaves an unescaped path alone", () => {
    expect(unescapeMountPath("/mnt/data")).toBe("/mnt/data");
  });
});

describe("isBrowsableMount", () => {
  const m = (mountPoint: string, device = "/dev/sda1", type = "ext4") => ({
    mountPoint,
    device,
    type,
  });

  it("always offers the root filesystem", () => {
    expect(isBrowsableMount(m("/"))).toBe(true);
  });

  it("offers removable media locations", () => {
    expect(isBrowsableMount(m("/mnt/data"))).toBe(true);
    expect(isBrowsableMount(m("/media/me/stick"))).toBe(true);
    expect(isBrowsableMount(m("/run/media/me/stick"))).toBe(true);
  });

  it("offers a real block device mounted somewhere unusual", () => {
    expect(isBrowsableMount(m("/srv/archive"))).toBe(true);
  });

  it("hides a bind-mounted FILE, which is not a place you can browse", () => {
    // Extremely common in containers: /etc/resolv.conf is a mount, not a folder.
    expect(isBrowsableMount(m("/etc/resolv.conf"))).toBe(false);
  });

  it("hides /boot, which is a mount nobody opens a file picker for", () => {
    expect(isBrowsableMount(m("/boot/efi", "/dev/nvme0n1p1", "vfat"))).toBe(false);
  });

  it("hides a virtual device's mount", () => {
    expect(isBrowsableMount(m("/var/lib/docker/overlay", "overlay", "overlay"))).toBe(false);
  });
});

describe("parsePasswd / parseGroup", () => {
  const PASSWD = [
    "# comment",
    "root:x:0:0:root:/root:/bin/bash",
    "toor:x:0:0:alt root:/root:/bin/bash",
    "michael:x:1000:1000:Michael:/home/michael:/bin/bash",
    "malformed",
    "",
  ].join("\n");

  it("maps uid to name", () => {
    const users = parsePasswd(PASSWD);
    expect(users.get(1000)).toBe("michael");
  });

  it("keeps the FIRST name for a duplicated uid", () => {
    // root and toor both own uid 0; the canonical name is the one listed first.
    expect(parsePasswd(PASSWD).get(0)).toBe("root");
  });

  it("skips comments and malformed lines", () => {
    expect(parsePasswd(PASSWD).size).toBe(2);
    expect(parsePasswd("")).toEqual(new Map());
  });

  it("parses groups the same way", () => {
    const groups = parseGroup("wheel:x:10:\nstaff:x:20:michael");
    expect(groups.get(10)).toBe("wheel");
    expect(groups.get(20)).toBe("staff");
  });
});

describe("formatPosixMode", () => {
  it("renders the common modes", () => {
    expect(formatPosixMode(0o755)).toBe("rwxr-xr-x");
    expect(formatPosixMode(0o644)).toBe("rw-r--r--");
    expect(formatPosixMode(0o600)).toBe("rw-------");
    expect(formatPosixMode(0o000)).toBe("---------");
    expect(formatPosixMode(0o777)).toBe("rwxrwxrwx");
  });

  it("reports permissions only, not the file type", () => {
    // 0o40755 is a DIRECTORY with 755. The type is already `kind`; repeating it
    // as a leading `d` would say the same thing twice.
    expect(formatPosixMode(0o40755 & 0o777)).toBe("rwxr-xr-x");
  });
});

describe("shortenWindowsOwner", () => {
  it("drops the machine or domain prefix", () => {
    expect(shortenWindowsOwner("DESKTOP-A1\\Michael")).toBe("Michael");
    expect(shortenWindowsOwner("BUILTIN\\Administrators")).toBe("Administrators");
  });

  it("passes through a bare account and trims", () => {
    expect(shortenWindowsOwner("  SYSTEM \n")).toBe("SYSTEM");
  });

  it("returns null for empty output", () => {
    expect(shortenWindowsOwner("   ")).toBeNull();
  });
});

describe("realBirthtime", () => {
  it("nulls the epoch, which is what an unsupported filesystem reports", () => {
    // Rendering "1 Jan 1970" as a creation date is worse than rendering nothing.
    expect(realBirthtime(0)).toBeNull();
    expect(realBirthtime(-1)).toBeNull();
  });

  it("keeps a real timestamp", () => {
    expect(realBirthtime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe("uniqueName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueName("a.txt", new Set())).toBe("a.txt");
  });

  it("suffixes before the extension, not after", () => {
    // `a.txt (copy)` would lose the file's type association.
    expect(uniqueName("a.txt", new Set(["a.txt"]))).toBe("a (copy).txt");
  });

  it("counts up past an existing copy", () => {
    expect(uniqueName("a.txt", new Set(["a.txt", "a (copy).txt"]))).toBe("a (copy 2).txt");
  });

  it("treats a leading dot as part of the name", () => {
    // `.env` is a file NAMED env, so the suffix goes at the end.
    expect(uniqueName(".env", new Set([".env"]))).toBe(".env (copy)");
  });

  it("handles an extensionless name", () => {
    expect(uniqueName("Makefile", new Set(["Makefile"]))).toBe("Makefile (copy)");
  });
});

describe("windowsDriveCandidates", () => {
  it("covers A: through Z:", () => {
    const c = windowsDriveCandidates();
    expect(c).toHaveLength(26);
    expect(c[0]).toBe("A:");
    expect(c[25]).toBe("Z:");
  });
});

describe("enclosingRepoRoot", () => {
  it("walks up to the repo containing a nested path", async () => {
    await mkdir(join(dir, ".git"));
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(fwd(enclosingRepoRoot(nested) ?? "")).toBe(wire);
  });

  it("returns null outside a repo", async () => {
    expect(enclosingRepoRoot(dir)).toBeNull();
  });
});

/* ============================================================== I/O: listing */

describe("list", () => {
  const svc = () => new FsExplorerService();

  beforeEach(async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "a.txt"), "hello");
    await writeFile(join(dir, "Photo.PNG"), "x".repeat(20));
    await writeFile(join(dir, ".env"), "SECRET=1");
  });

  it("lists names, kinds, sizes and extensions", async () => {
    const listing = await svc().list(wire);
    const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
    expect(byName["src"]).toMatchObject({ kind: "directory", size: null });
    expect(byName["a.txt"]).toMatchObject({ kind: "file", size: 5, ext: "txt" });
    // Extension is lowercased so a filter of ["png"] matches Photo.PNG.
    expect(byName["Photo.PNG"]).toMatchObject({ size: 20, ext: "png" });
  });

  it("gives a directory a null size rather than its inode size", async () => {
    // A folder's stat size is the size of its directory entry, which people
    // read as "how big is this folder" and it never is.
    const listing = await svc().list(wire);
    expect(listing.entries.find((e) => e.name === "src")?.size).toBeNull();
  });

  it("flags dotfiles as hidden but still returns them", async () => {
    // Filtering is the client's job — the server reporting `hidden` and the
    // client deciding is what lets "show hidden" toggle without a refetch.
    const env = (await svc().list(wire)).entries.find((e) => e.name === ".env");
    expect(env).toMatchObject({ hidden: true });
  });

  it("echoes back a normalized path and the parent to climb to", async () => {
    const listing = await svc().list(`${wire}/src/..`);
    expect(listing.path).toBe(wire);
    expect(listing.parent).not.toBeNull();
    expect(listing.parent).not.toBe(listing.path);
  });

  it("reports timestamps in epoch ms", async () => {
    const entry = (await svc().list(wire)).entries.find((e) => e.name === "a.txt");
    const real = await stat(join(dir, "a.txt"));
    expect(entry?.modifiedAt).toBeCloseTo(real.mtimeMs, -2);
  });

  it("reports the enclosing repo when there is one", async () => {
    expect((await svc().list(wire)).repoRoot).toBeNull();
    await mkdir(join(dir, ".git"));
    expect((await svc().list(wire)).repoRoot).toBe(wire);
  });

  it("truncates a huge directory and says how many there really are", async () => {
    const many = join(dir, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => writeFile(join(many, `f${i}.txt`), "")),
    );
    const listing = await svc().list(fwd(many), { limit: 10 });
    expect(listing.entries).toHaveLength(10);
    expect(listing.truncated).toBe(true);
    expect(listing.total).toBe(40);
  });

  it("takes a STABLE alphabetical slice when truncating", async () => {
    // A truncated listing that reshuffles between two refreshes is unusable —
    // so the sort happens before the cut, not after.
    const many = join(dir, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => writeFile(join(many, `f${i}.txt`), "")),
    );
    const a = await svc().list(fwd(many), { limit: 8 });
    const b = await svc().list(fwd(many), { limit: 8 });
    expect(a.entries.map((e) => e.name)).toEqual(b.entries.map((e) => e.name));
  });

  it("clamps an absurd limit to the service cap", async () => {
    const listing = await svc().list(wire, { limit: 10_000_000 });
    expect(listing.entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it("rejects a directory that isn't there", async () => {
    await expect(svc().list(`${wire}/nope`)).rejects.toThrow();
  });

  it.skipIf(!CAN_SYMLINK)("reports a symlink by its TARGET's kind", async () => {
    await symlink(join(dir, "src"), join(dir, "link-to-dir"), "junction");
    const entry = (await svc().list(wire)).entries.find((e) => e.name === "link-to-dir");
    // Clicking a link to a folder should open the folder, so it lists as one.
    expect(entry?.kind).toBe("directory");
    expect(entry?.link?.broken).toBe(false);
  });

  it.skipIf(!CAN_SYMLINK)("marks a dangling symlink broken", async () => {
    await symlink(join(dir, "gone.txt"), join(dir, "dangling"));
    const entry = (await svc().list(wire)).entries.find((e) => e.name === "dangling");
    expect(entry).toMatchObject({ kind: "symlink", link: { broken: true } });
  });
});

describe("relative paths", () => {
  // `resolve()` anchors a relative path to the SERVER process's cwd, so without
  // a guard `list("packages")` quietly lists the Dispatch install's own source
  // tree. Writes refused this from the start; the reads did not, which meant two
  // halves of one API disagreed about what a path is. The check now lives in
  // `native()` — the single point where a wire string becomes a disk location —
  // so a future method cannot forget it.
  const svc = () => new FsExplorerService();

  it("are refused by every read, not just by writes", async () => {
    await expect(svc().list("packages")).rejects.toThrow(/absolute/);
    await expect(svc().details("packages/shared")).rejects.toThrow(/absolute/);
    await expect(svc().search("packages", "x")).rejects.toThrow(/absolute/);
  });

  it("are refused as an empty path too", async () => {
    await expect(svc().list("")).rejects.toThrow(/required/);
    await expect(svc().list("   ")).rejects.toThrow(/required/);
  });

  it("are reported as a caller error, so a route can answer 400 not 404", async () => {
    // A malformed request and a missing file are different problems; collapsing
    // them sends whoever is debugging it hunting for a file that never existed.
    await expect(svc().list("packages")).rejects.toBeInstanceOf(FsPathError);
    // A path that IS absolute and simply absent stays an ordinary error.
    await expect(svc().list(`${wire}/nope`)).rejects.not.toBeInstanceOf(FsPathError);
  });

  it("still refuse a relative mutation, before the batch reports anything", async () => {
    const r = await svc().mutate({ op: "mkdir", path: "relative/dir" });
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([]);
    expect(r.errors[0].message).toMatch(/absolute/);
  });

  it("do not reject a legitimately absolute path on this platform", async () => {
    await expect(svc().list(wire)).resolves.toBeTruthy();
  });
});

/* ============================================================== I/O: details */

describe("ownership resolution", () => {
  // Asserted as PURE functions rather than through `details()`.
  //
  // Forcing `platform: "linux"` on a Windows host used to work, but a service
  // told it is on POSIX now (correctly) rejects `C:/…` as not absolute — and a
  // Windows box cannot produce a real POSIX path to stat instead. Splitting the
  // resolution out means both platforms' logic runs everywhere, and `details()`
  // is only tested against the host it is actually on.
  it("maps uid and gid to names", () => {
    const users = parsePasswd("michael:x:1000:1000:M:/home/michael:/bin/bash");
    const groups = parseGroup("staff:x:1000:");
    expect(resolvePosixOwner({ uid: 1000, gid: 1000 }, users, groups)).toEqual([
      "michael",
      "staff",
    ]);
  });

  it("falls back to the raw id for a user not in /etc/passwd", () => {
    // An LDAP/SSSD uid is a true and useful answer even unresolved — much more
    // so than "unknown".
    expect(resolvePosixOwner({ uid: 4242, gid: 77 }, new Map(), new Map())).toEqual([
      "4242",
      "77",
    ]);
  });

  it("single-quotes a path for PowerShell, doubling an apostrophe", () => {
    // `Michael's Files` otherwise terminates the string and the remainder is
    // interpreted as PowerShell.
    expect(quotePs("C:\\Users\\Michael's Files")).toBe("'C:\\Users\\Michael''s Files'");
    expect(quotePs("C:/plain")).toBe("'C:/plain'");
  });
});

/* ============================================================== I/O: details */

describe("details", () => {
  it("reports ownership for a real file on THIS platform", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    const d = await new FsExplorerService().details(`${fwd(dir)}/f.txt`);
    // Whoever is running the suite owns the file they just wrote.
    expect(d.owner).toBeTruthy();
    expect(d.writable).toBe(true);
    if (process.platform === "win32") {
      // Windows carries a fake mode where everything is 0666/0777. Reporting it
      // would be noise dressed up as information.
      expect(d.mode).toBeNull();
      expect(d.group).toBeNull();
    } else {
      expect(d.mode).toMatch(/^[rwx-]{9}$/);
      expect(d.group).toBeTruthy();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "asks Get-Acl for the owner, with the path quoted",
    async () => {
      await writeFile(join(dir, "f.txt"), "x");
      const exec = vi.fn<ExecFn>(async (file) =>
        file === "powershell"
          ? { stdout: "DESKTOP-A1\\Michael\n", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 1 },
      );
      const d = await new FsExplorerService({ exec }).details(`${fwd(dir)}/f.txt`);
      expect(d.owner).toBe("Michael");
      const cmd = exec.mock.calls[0][1].at(-1) as string;
      expect(cmd).toContain("Get-Acl");
      expect(cmd).toContain("'");
    },
  );

  it("reports git authorship as the only honest 'edited by'", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "f.txt"), "x");
    const exec = vi.fn<ExecFn>(async (file, args) =>
      file === "git" && args[0] === "log"
        ? { stdout: `Ada Lovelace${NUL}1700000000`, stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 1 },
    );
    const d = await new FsExplorerService({ exec }).details(`${fwd(dir)}/f.txt`);
    expect(d.lastEditedBy).toBe("Ada Lovelace");
    // git prints seconds; everything else in this app is epoch-ms.
    expect(d.lastEditedAt).toBe(1_700_000_000_000);
  });

  it("reports no author outside a checkout, rather than pretending", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    const exec = vi.fn<ExecFn>(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const d = await new FsExplorerService({ exec }).details(`${fwd(dir)}/f.txt`);
    expect(d.lastEditedBy).toBeNull();
    // No repo means git was never even asked.
    expect(exec.mock.calls.filter((c) => c[0] === "git")).toHaveLength(0);
  });

  it("counts a directory's children so a delete can be warned about", async () => {
    await mkdir(join(dir, "d"));
    await writeFile(join(dir, "d", "1"), "");
    await writeFile(join(dir, "d", "2"), "");
    const d = await new FsExplorerService().details(`${fwd(dir)}/d`);
    expect(d.childCount).toBe(2);
    expect(d.entry.kind).toBe("directory");
  });

  it("gives a file no child count", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    expect((await new FsExplorerService().details(`${fwd(dir)}/f.txt`)).childCount).toBeNull();
  });
});

/* ============================================================== I/O: roots */

describe("roots", () => {
  it("builds Linux roots from /proc/mounts", async () => {
    const svc = new FsExplorerService({
      platform: "linux",
      home: () => "/home/michael",
      readMounts: async () =>
        "/dev/nvme0n1p2 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/sdb1 /media/me/Stick exfat rw 0 0",
    });
    const roots = await svc.roots();
    expect(roots[0]).toMatchObject({ kind: "home", path: "/home/michael" });
    const drives = roots.filter((r) => r.kind === "drive").map((r) => r.path);
    expect(drives).toEqual(["/", "/media/me/Stick"]);
  });

  it("still offers / when there is no /proc to read", async () => {
    // A stripped container has no /proc/mounts and still deserves a start point.
    const svc = new FsExplorerService({
      platform: "linux",
      home: () => "/root",
      readMounts: async () => null,
    });
    expect((await svc.roots()).some((r) => r.path === "/")).toBe(true);
  });

  it("lists projects and worktrees ahead of the volumes", async () => {
    const svc = new FsExplorerService({
      platform: "linux",
      home: () => "/home/me",
      readMounts: async () => "/dev/sda1 / ext4 rw 0 0",
    });
    const roots = await svc.roots({
      projects: [{ id: "p1", name: "Dispatch", repoPath: "/home/me/code/dispatch" }],
      worktrees: [{ path: "/home/me/code/dispatch/.worktrees/feat", branch: "feat/x", projectName: "Dispatch" }],
    });
    const kinds = roots.map((r) => r.kind);
    expect(kinds.indexOf("project")).toBeLessThan(kinds.indexOf("drive"));
    expect(roots.find((r) => r.kind === "worktree")).toMatchObject({ label: "feat/x" });
  });

  it("de-duplicates a project that IS the home directory", async () => {
    const svc = new FsExplorerService({
      platform: "linux",
      home: () => "/home/me",
      readMounts: async () => "",
    });
    const roots = await svc.roots({
      projects: [{ id: "p", name: "Home project", repoPath: "/home/me" }],
      worktrees: [],
    });
    expect(roots.filter((r) => r.path === "/home/me")).toHaveLength(1);
    // First occurrence wins, and home is listed first.
    expect(roots[0].kind).toBe("home");
  });

  it.skipIf(process.platform !== "win32")("finds the real drives on Windows", async () => {
    const roots = await new FsExplorerService().roots();
    const drives = roots.filter((r) => r.kind === "drive");
    expect(drives.length).toBeGreaterThan(0);
    // Probing yields `C:/`, which is navigable; a bare `C:` would not be.
    expect(drives.every((d) => /^[A-Z]:\/$/.test(d.path))).toBe(true);
    expect(drives.some((d) => d.path === "C:/")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("measures capacity for the root volume", async () => {
    const roots = await new FsExplorerService().roots();
    const root = roots.find((r) => r.kind === "drive" && r.path === "/");
    expect(root?.totalBytes).toBeGreaterThan(0);
  });
});

/* ============================================================ I/O: mutations */

describe("mutate", () => {
  const svc = (trash?: TrashFn) => new FsExplorerService(trash ? { trash } : {});

  it("creates a directory", async () => {
    const r = await svc().mutate({ op: "mkdir", path: `${wire}/new` });
    expect(r.ok).toBe(true);
    expect((await stat(join(dir, "new"))).isDirectory()).toBe(true);
  });

  it("refuses to 'create' a directory that already exists", async () => {
    // `recursive: true` would silently merge your new folder into an existing
    // one, which looks like success and isn't.
    await mkdir(join(dir, "new"));
    const r = await svc().mutate({ op: "mkdir", path: `${wire}/new` });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/EEXIST|exists/i);
  });

  it("creates an empty file without truncating an existing one", async () => {
    await writeFile(join(dir, "keep.txt"), "precious");
    const r = await svc().mutate({ op: "create-file", path: `${wire}/keep.txt` });
    expect(r.ok).toBe(false);
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("precious");
  });

  it("refuses to modify a filesystem root", async () => {
    const root = process.platform === "win32" ? "C:/" : "/";
    const r = await svc().mutate({ op: "delete", paths: [root], permanent: true });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/filesystem root/);
  });

  it("refuses a relative path, which would resolve against the server's cwd", async () => {
    const r = await svc().mutate({ op: "mkdir", path: "relative/dir" });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/absolute/);
  });

  /* ------------------------------------------------------------- rename */

  it("renames in place", async () => {
    await writeFile(join(dir, "old.txt"), "x");
    const r = await svc().mutate({ op: "rename", path: `${wire}/old.txt`, to: "new.txt" });
    expect(r.ok).toBe(true);
    expect(r.changed[0]).toBe(`${wire}/new.txt`);
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("x");
  });

  it("refuses a rename containing a path separator", async () => {
    // Otherwise "Rename" quietly becomes "Move somewhere else entirely".
    await writeFile(join(dir, "a.txt"), "x");
    for (const to of ["../a.txt", "sub/a.txt", "sub\\a.txt"]) {
      const r = await svc().mutate({ op: "rename", path: `${wire}/a.txt`, to });
      expect(r.ok).toBe(false);
      expect(r.errors[0].message).toMatch(/separator/);
    }
  });

  it("refuses to rename over an existing sibling", async () => {
    // `rename(2)` overwrites silently on both platforms; the destination file
    // would be gone with no diagnostic at all.
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    const r = await svc().mutate({ op: "rename", path: `${wire}/a.txt`, to: "b.txt" });
    expect(r.ok).toBe(false);
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("b");
  });

  it("allows a case-only rename", async () => {
    // On Windows/macOS the target "exists" — it's the same file. Blocking this
    // would make `readme.md` → `README.md` impossible.
    await writeFile(join(dir, "readme.md"), "x");
    const r = await svc().mutate({ op: "rename", path: `${wire}/readme.md`, to: "README.md" });
    expect(r.ok).toBe(true);
  });

  it("refuses an empty or dot name", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    for (const to of ["", "   ", ".", ".."]) {
      expect((await svc().mutate({ op: "rename", path: `${wire}/a.txt`, to })).ok).toBe(false);
    }
  });

  /* --------------------------------------------------------- move / copy */

  it("moves files into another directory", async () => {
    await mkdir(join(dir, "dst"));
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    const r = await svc().mutate({
      op: "move",
      paths: [`${wire}/a.txt`, `${wire}/b.txt`],
      toDir: `${wire}/dst`,
    });
    expect(r.ok).toBe(true);
    expect((await readdir(join(dir, "dst"))).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("refuses to move a directory into itself", async () => {
    // POSIX returns EINVAL; Windows starts the operation and leaves a
    // half-moved tree. Refusing outright is the only consistent answer.
    await mkdir(join(dir, "outer", "inner"), { recursive: true });
    const r = await svc().mutate({
      op: "move",
      paths: [`${wire}/outer`],
      toDir: `${wire}/outer/inner`,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/into itself/);
  });

  it("refuses a move that would overwrite, rather than renaming behind your back", async () => {
    await mkdir(join(dir, "dst"));
    await writeFile(join(dir, "a.txt"), "new");
    await writeFile(join(dir, "dst", "a.txt"), "old");
    const r = await svc().mutate({ op: "move", paths: [`${wire}/a.txt`], toDir: `${wire}/dst` });
    expect(r.ok).toBe(false);
    expect(await readFile(join(dir, "dst", "a.txt"), "utf8")).toBe("old");
  });

  it("reports partial success when only some paths fail", async () => {
    // Five files, two locked, is a real outcome — collapsing it into "failed"
    // leaves the caller unable to say what did happen.
    await mkdir(join(dir, "dst"));
    await writeFile(join(dir, "ok.txt"), "x");
    const r = await svc().mutate({
      op: "move",
      paths: [`${wire}/ok.txt`, `${wire}/missing.txt`],
      toDir: `${wire}/dst`,
    });
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([`${wire}/dst/ok.txt`]);
    expect(r.errors).toHaveLength(1);
  });

  it("copies into the SAME directory by picking a free name", async () => {
    // Copying a file next to itself is the most common copy there is, and it
    // can only work if the collision resolves.
    await writeFile(join(dir, "a.txt"), "x");
    const r = await svc().mutate({ op: "copy", paths: [`${wire}/a.txt`], toDir: wire });
    expect(r.ok).toBe(true);
    expect(r.changed[0]).toBe(`${wire}/a (copy).txt`);
    expect(await readFile(join(dir, "a (copy).txt"), "utf8")).toBe("x");
  });

  it("copies a directory tree recursively", async () => {
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await writeFile(join(dir, "src", "deep", "f.txt"), "deep");
    await mkdir(join(dir, "dst"));
    const r = await svc().mutate({ op: "copy", paths: [`${wire}/src`], toDir: `${wire}/dst` });
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, "dst", "src", "deep", "f.txt"), "utf8")).toBe("deep");
  });

  it("names two copies of the same file distinctly in one batch", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const r = await svc().mutate({
      op: "copy",
      paths: [`${wire}/a.txt`, `${wire}/a.txt`],
      toDir: wire,
    });
    expect(r.changed).toEqual([`${wire}/a (copy).txt`, `${wire}/a (copy 2).txt`]);
  });

  it("fails cleanly when the destination doesn't exist", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const r = await svc().mutate({ op: "move", paths: [`${wire}/a.txt`], toDir: `${wire}/nope` });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/destination unreadable/);
  });

  /* -------------------------------------------------------------- delete */

  it("sends deletes to the OS trash by default", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const trash = vi.fn<TrashFn>(async () => {});
    const r = await svc(trash).mutate({
      op: "delete",
      paths: [`${wire}/a.txt`],
      permanent: false,
    });
    expect(r.ok).toBe(true);
    expect(r.trashed).toBe(true);
    // Native separators: `trash` shells out to PowerShell / the XDG spec, and
    // neither takes the forward-slashed wire form on Windows.
    expect(trash).toHaveBeenCalledWith([join(dir, "a.txt")]);
  });

  it("trashes a whole batch in one call", async () => {
    // One PowerShell spawn instead of N — and the OS's own undo groups them, so
    // restoring is one action too.
    await writeFile(join(dir, "a.txt"), "x");
    await writeFile(join(dir, "b.txt"), "x");
    const trash = vi.fn<TrashFn>(async () => {});
    await svc(trash).mutate({
      op: "delete",
      paths: [`${wire}/a.txt`, `${wire}/b.txt`],
      permanent: false,
    });
    expect(trash).toHaveBeenCalledTimes(1);
    expect(trash.mock.calls[0][0]).toHaveLength(2);
  });

  it("does NOT silently unlink when trashing fails", async () => {
    // "Delete" and "delete forever" are different decisions, and only one of
    // them was made. A fallback would make the safe option destroy data.
    await writeFile(join(dir, "a.txt"), "x");
    const trash = vi.fn<TrashFn>(async () => {
      throw new Error("no trash on this system");
    });
    const r = await svc(trash).mutate({
      op: "delete",
      paths: [`${wire}/a.txt`],
      permanent: false,
    });
    expect(r.ok).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("x");
  });

  it("permanently deletes a tree when explicitly asked", async () => {
    await mkdir(join(dir, "tree", "deep"), { recursive: true });
    await writeFile(join(dir, "tree", "deep", "f.txt"), "x");
    const trash = vi.fn<TrashFn>(async () => {});
    const r = await svc(trash).mutate({
      op: "delete",
      paths: [`${wire}/tree`],
      permanent: true,
    });
    expect(r.ok).toBe(true);
    expect(r.trashed).toBe(false);
    expect(trash).not.toHaveBeenCalled();
    await expect(stat(join(dir, "tree"))).rejects.toThrow();
  });

  it("reports deleting something that is already gone", async () => {
    // `force: true` would report success for a stale listing's phantom row.
    const r = await svc().mutate({ op: "delete", paths: [`${wire}/ghost`], permanent: true });
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([]);
  });
});

/* =============================================================== I/O: search */

describe("search", () => {
  const svc = () => new FsExplorerService();

  beforeEach(async () => {
    await mkdir(join(dir, "src", "components"), { recursive: true });
    await mkdir(join(dir, "node_modules", "react"), { recursive: true });
    await writeFile(join(dir, "src", "components", "Button.tsx"), "");
    await writeFile(join(dir, "src", "index.ts"), "");
    await writeFile(join(dir, "README.md"), "");
    await writeFile(join(dir, "node_modules", "react", "Button.tsx"), "");
  });

  it("finds a file by name anywhere under the root", async () => {
    const hits = await svc().search(wire, "Button");
    expect(hits.map((h) => h.name)).toContain("Button.tsx");
  });

  it("skips node_modules unless asked, so a search stays fast and relevant", async () => {
    const hits = await svc().search(wire, "Button");
    expect(hits.every((h) => !h.path.includes("node_modules"))).toBe(true);
    const all = await svc().search(wire, "Button", { includeIgnored: true });
    expect(all.some((h) => h.path.includes("node_modules"))).toBe(true);
    // Guard against someone trimming the skip list to nothing.
    expect(SEARCH_SKIP_DIRS.has("node_modules")).toBe(true);
  });

  it("filters to files or to directories", async () => {
    const dirs = await svc().search(wire, "components", { filter: { select: "directory" } });
    expect(dirs.map((d) => d.name)).toEqual(["components"]);
    const files = await svc().search(wire, "components", { filter: { select: "file" } });
    expect(files.every((f) => f.kind === "file")).toBe(true);
  });

  it("filters by extension", async () => {
    const hits = await svc().search(wire, "", { filter: { select: "file", extensions: ["md"] } });
    expect(hits.map((h) => h.name)).toEqual(["README.md"]);
  });

  it("hides dotfiles until asked", async () => {
    await writeFile(join(dir, ".secret-button"), "");
    expect((await svc().search(wire, "button")).some((h) => h.name === ".secret-button")).toBe(
      false,
    );
    const shown = await svc().search(wire, "button", { filter: { showHidden: true } });
    expect(shown.some((h) => h.name === ".secret-button")).toBe(true);
  });

  it("scores against the path relative to the root, not the absolute one", async () => {
    // Otherwise every file under `C:/Users/michael/…` is a hit for "michael".
    const parent = fwd(dir).split("/").pop() ?? "";
    expect(parent).toContain("cm-fsx-");
    expect(await svc().search(wire, "cm-fsx")).toEqual([]);
  });

  it("honours the result limit", async () => {
    const hits = await svc().search(wire, "", { limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it("stops early on a broad query but still returns the shallowest matches", async () => {
    // A broad query over a big tree used to spend the whole time budget finding
    // its ten-thousandth match to then discard all but a page of them. The walk
    // is breadth-first and the ranking prefers short paths, so the early-stopped
    // result is the same top slice — which is what this pins.
    const deep = join(dir, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    await writeFile(join(dir, "match-shallow.txt"), "");
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => writeFile(join(deep, `match-deep-${i}.txt`), "")),
    );
    const hits = await svc().search(wire, "match", { limit: 3 });
    expect(hits).toHaveLength(3);
    // The one at the root outranks sixty buried four levels down.
    expect(hits[0].name).toBe("match-shallow.txt");
  });

  it("returns an empty list rather than throwing on a missing root", async () => {
    // A stale bookmark shouldn't 500; the UI just shows no matches.
    expect(await svc().search(`${wire}/gone`, "x")).toEqual([]);
  });

  it.skipIf(!CAN_SYMLINK)("does not follow symlinks, so a loop terminates", async () => {
    // `ln -s .. loop` is an ordinary mistake and an infinite walk without this.
    await symlink(dir, join(dir, "src", "loop"), "junction");
    const hits = await svc().search(wire, "index");
    expect(hits.some((h) => h.path.includes("loop"))).toBe(false);
    expect(hits.map((h) => h.name)).toContain("index.ts");
  });
});
