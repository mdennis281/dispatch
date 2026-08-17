/**
 * Path arithmetic and picker rules, run against BOTH platforms from whichever
 * one the test happens to be on. That's the entire reason these functions take a
 * platform argument instead of reading `process.platform`: a Windows-only dev
 * otherwise never finds out they broke `/mnt/data`, and CI (Linux) never finds
 * out they broke `C:/`.
 */
import { describe, it, expect } from "vitest";
import {
  fsNormalize,
  fsRootOf,
  fsIsRoot,
  fsIsAbsolute,
  fsParent,
  fsBasename,
  fsJoin,
  fsCrumbs,
  fsIsInside,
  fsExtension,
  fsIsHiddenName,
  fsIsSelectable,
  fsIsVisible,
  fsSortEntries,
  type FsEntry,
} from "./fs-entry.js";

const W = "win32" as const;
const P = "posix" as const;

describe("fsNormalize", () => {
  it("forward-slashes a Windows path", () => {
    expect(fsNormalize("C:\\Users\\me\\notes.md", W)).toBe("C:/Users/me/notes.md");
  });

  it("expands a bare drive letter to that drive's root", () => {
    // `C:` in a shell means "cwd on drive C", which is never what a click means.
    expect(fsNormalize("C:", W)).toBe("C:/");
    expect(fsNormalize("d:", W)).toBe("d:/");
  });

  it("resolves . and .. on both platforms", () => {
    expect(fsNormalize("C:/a/b/../c/./d", W)).toBe("C:/a/c/d");
    expect(fsNormalize("/a/b/../c/./d", P)).toBe("/a/c/d");
  });

  it("cannot climb above a root", () => {
    expect(fsNormalize("/../../etc", P)).toBe("/etc");
    expect(fsNormalize("C:/../..", W)).toBe("C:/");
  });

  it("keeps a UNC prefix while collapsing other repeated slashes", () => {
    // `//server/share` → `/server/share` would be a different, nonexistent place.
    expect(fsNormalize("\\\\server\\share\\dir", W)).toBe("//server/share/dir");
    expect(fsNormalize("//server//share//a//b", W)).toBe("//server/share/a/b");
    expect(fsNormalize("/a//b///c", P)).toBe("/a/b/c");
  });

  it("treats a backslash as a literal character on POSIX", () => {
    // Backslash is a legal POSIX filename character. Converting it would rename
    // the file the user is pointing at.
    expect(fsNormalize("/tmp/we\\ird", P)).toBe("/tmp/we/ird");
  });

  it("drops a trailing slash except at a root", () => {
    expect(fsNormalize("/a/b/", P)).toBe("/a/b");
    expect(fsNormalize("/", P)).toBe("/");
    expect(fsNormalize("C:/a/", W)).toBe("C:/a");
    expect(fsNormalize("C:/", W)).toBe("C:/");
  });
});

describe("fsRootOf / fsIsRoot / fsIsAbsolute", () => {
  it("finds the root of each absolute shape", () => {
    expect(fsRootOf("C:/Users/me", W)).toBe("C:/");
    expect(fsRootOf("//server/share/x", W)).toBe("//server/share/");
    expect(fsRootOf("/home/me", P)).toBe("/");
  });

  it("returns null for a relative path", () => {
    expect(fsRootOf("Users/me", W)).toBeNull();
    expect(fsRootOf("home/me", P)).toBeNull();
    expect(fsIsAbsolute("some/dir", P)).toBe(false);
  });

  it("does not treat a drive letter as absolute on POSIX", () => {
    // `C:/code` is a RELATIVE path on Linux — a directory literally named `C:`.
    // Reading it as absolute is how a Linux server ends up stat-ing nonsense.
    expect(fsRootOf("C:/code", P)).toBeNull();
    expect(fsIsAbsolute("C:/code", P)).toBe(false);
    expect(fsIsAbsolute("C:/code", W)).toBe(true);
  });

  it("recognizes roots and only roots", () => {
    expect(fsIsRoot("C:/", W)).toBe(true);
    expect(fsIsRoot("C:", W)).toBe(true);
    expect(fsIsRoot("C:/Users", W)).toBe(false);
    expect(fsIsRoot("//server/share", W)).toBe(true);
    expect(fsIsRoot("//server/share/sub", W)).toBe(false);
    expect(fsIsRoot("/", P)).toBe(true);
    expect(fsIsRoot("/home", P)).toBe(false);
  });
});

describe("fsParent", () => {
  it("walks up one level", () => {
    expect(fsParent("C:/Users/me/notes.md", W)).toBe("C:/Users/me");
    expect(fsParent("/home/me/notes.md", P)).toBe("/home/me");
  });

  it("returns the drive root rather than a bare `C:`", () => {
    // The naive slice yields `C:`, which is not a path anyone can navigate to.
    expect(fsParent("C:/Users", W)).toBe("C:/");
  });

  it("returns / for a top-level POSIX directory", () => {
    expect(fsParent("/home", P)).toBe("/");
  });

  it("returns null at every root, which is what shows the drive list", () => {
    expect(fsParent("C:/", W)).toBeNull();
    expect(fsParent("/", P)).toBeNull();
    expect(fsParent("//server/share", W)).toBeNull();
  });

  it("stops at a UNC share rather than exposing the server as a directory", () => {
    expect(fsParent("//server/share/a", W)).toBe("//server/share/");
  });
});

describe("fsBasename / fsJoin", () => {
  it("takes the last segment", () => {
    expect(fsBasename("C:/Users/me/notes.md", W)).toBe("notes.md");
    expect(fsBasename("/home/me/notes.md", P)).toBe("notes.md");
  });

  it("renders a root as itself", () => {
    expect(fsBasename("C:/", W)).toBe("C:/");
    expect(fsBasename("/", P)).toBe("/");
  });

  it("joins without doubling the root's slash", () => {
    expect(fsJoin("C:/", "Users", W)).toBe("C:/Users");
    expect(fsJoin("/", "home", P)).toBe("/home");
    expect(fsJoin("/home/me", "notes.md", P)).toBe("/home/me/notes.md");
  });

  it("treats the appended name as a literal segment", () => {
    // A file called `a/b` can't exist, so a name arriving with slashes is either
    // a bug or an attempt to escape the directory being written into.
    expect(fsJoin("/home", "/etc/", P)).toBe("/home/etc");
  });
});

describe("fsCrumbs", () => {
  it("starts at the drive and ends at the directory", () => {
    expect(fsCrumbs("C:/Users/me", W)).toEqual([
      { label: "C:/", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "me", path: "C:/Users/me" },
    ]);
  });

  it("starts at / on POSIX", () => {
    expect(fsCrumbs("/home/me", P)).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
    ]);
  });

  it("keeps a UNC share whole instead of splitting it into two crumbs", () => {
    // `//server` alone is not navigable, so it must never become a crumb.
    expect(fsCrumbs("//server/share/a", W)).toEqual([
      { label: "//server/share/", path: "//server/share/" },
      { label: "a", path: "//server/share/a" },
    ]);
  });

  it("gives a root exactly one crumb", () => {
    expect(fsCrumbs("/", P)).toEqual([{ label: "/", path: "/" }]);
  });
});

describe("fsIsInside", () => {
  it("counts a directory as inside itself", () => {
    expect(fsIsInside("/a/b", "/a/b", P)).toBe(true);
  });

  it("matches on segment boundaries, not string prefixes", () => {
    // `/a/bc` starts with `/a/b` as a STRING but is not inside it — getting this
    // wrong lets a move think it's descending into its own source.
    expect(fsIsInside("/a/bc", "/a/b", P)).toBe(false);
    expect(fsIsInside("/a/b/c", "/a/b", P)).toBe(true);
  });

  it("folds case on Windows and preserves it on POSIX", () => {
    expect(fsIsInside("C:/Users/Me/x", "c:/users/me", W)).toBe(true);
    // Two genuinely different directories on a case-sensitive filesystem.
    expect(fsIsInside("/Users/Me/x", "/users/me", P)).toBe(false);
  });

  it("does not confuse two drives", () => {
    expect(fsIsInside("D:/code", "C:/", W)).toBe(false);
    expect(fsIsInside("C:/code", "C:/", W)).toBe(true);
  });
});

describe("fsExtension", () => {
  it("lowercases and drops the dot", () => {
    expect(fsExtension("Photo.PNG")).toBe("png");
  });

  it("takes the last part of a multi-dot name", () => {
    expect(fsExtension("archive.tar.gz")).toBe("gz");
  });

  it("gives a dotfile no extension", () => {
    // `.gitignore` is a hidden file named gitignore, not a `.gitignore` file.
    expect(fsExtension(".gitignore")).toBe("");
    expect(fsExtension(".env.local")).toBe("local");
  });

  it("gives an extensionless name nothing", () => {
    expect(fsExtension("Makefile")).toBe("");
  });
});

describe("fsIsHiddenName", () => {
  it("hides dot-prefixed names on either platform", () => {
    expect(fsIsHiddenName(".git")).toBe(true);
    expect(fsIsHiddenName("src")).toBe(false);
  });
});

/* ------------------------------------------------------------------ filter */

const entry = (over: Partial<FsEntry> & { name: string }): FsEntry => ({
  path: `/x/${over.name}`,
  kind: "file",
  size: 0,
  modifiedAt: 0,
  createdAt: null,
  accessedAt: null,
  ext: fsExtension(over.name),
  hidden: fsIsHiddenName(over.name),
  ...over,
});

describe("fsIsSelectable", () => {
  const file = entry({ name: "a.png" });
  const dir = entry({ name: "assets", kind: "directory", ext: "" });

  it("honours a files-only picker", () => {
    expect(fsIsSelectable(file, { select: "file" })).toBe(true);
    expect(fsIsSelectable(dir, { select: "file" })).toBe(false);
  });

  it("honours a directories-only picker", () => {
    expect(fsIsSelectable(dir, { select: "directory" })).toBe(true);
    expect(fsIsSelectable(file, { select: "directory" })).toBe(false);
  });

  it("takes either when asked for either", () => {
    expect(fsIsSelectable(file, { select: "any" })).toBe(true);
    expect(fsIsSelectable(dir, { select: "any" })).toBe(true);
  });

  it("filters files by extension, case- and dot-insensitively", () => {
    const f = { select: "file" as const, extensions: [".PNG", "jpg"] };
    expect(fsIsSelectable(entry({ name: "a.png" }), f)).toBe(true);
    expect(fsIsSelectable(entry({ name: "b.JPG" }), f)).toBe(true);
    expect(fsIsSelectable(entry({ name: "c.gif" }), f)).toBe(false);
  });

  it("never applies an extension filter to a directory", () => {
    // A folder named `assets.png` is still a folder, and a directory picker
    // filtered to png should offer every folder — otherwise it offers none.
    const dotted = entry({ name: "assets.png", kind: "directory" });
    expect(fsIsSelectable(dotted, { select: "any", extensions: ["gif"] })).toBe(true);
    expect(fsIsSelectable(dir, { select: "directory", extensions: ["png"] })).toBe(true);
  });

  it("refuses a broken symlink, which resolves to nothing to hand back", () => {
    expect(fsIsSelectable(entry({ name: "dangling", kind: "symlink" }), { select: "any" })).toBe(
      false,
    );
    expect(fsIsSelectable(entry({ name: "sock", kind: "other" }), { select: "any" })).toBe(false);
  });

  it("treats an empty extension list as no constraint", () => {
    expect(fsIsSelectable(entry({ name: "Makefile" }), { select: "file", extensions: [] })).toBe(
      true,
    );
  });
});

describe("fsIsVisible", () => {
  it("hides dotfiles until asked", () => {
    const dotfile = entry({ name: ".env" });
    expect(fsIsVisible(dotfile, { showHidden: false })).toBe(false);
    expect(fsIsVisible(dotfile, { showHidden: true })).toBe(true);
  });

  it("never removes a row for failing an extension filter", () => {
    // Extension filters grey rows out; they don't erase them. An empty-looking
    // folder you know has files in it is indistinguishable from a wrong turn.
    expect(fsIsVisible(entry({ name: "a.gif" }), { showHidden: false })).toBe(true);
  });
});

/* ----------------------------------------------------------------- sorting */

describe("fsSortEntries", () => {
  const dirA = entry({ name: "beta", kind: "directory", size: null, modifiedAt: 5 });
  const dirB = entry({ name: "alpha", kind: "directory", size: null, modifiedAt: 1 });
  const f1 = entry({ name: "a.txt", size: 300, modifiedAt: 30 });
  const f2 = entry({ name: "b.txt", size: 100, modifiedAt: 10 });
  const all = [f1, dirA, f2, dirB];

  it("floats directories above files in both directions", () => {
    const asc = fsSortEntries(all, { key: "size", desc: false });
    expect(asc.slice(0, 2).every((e) => e.kind === "directory")).toBe(true);
    const desc = fsSortEntries(all, { key: "size", desc: true });
    expect(desc.slice(0, 2).every((e) => e.kind === "directory")).toBe(true);
  });

  it("sorts by name naturally, so file10 follows file9", () => {
    const nat = fsSortEntries(
      [entry({ name: "file10" }), entry({ name: "file9" }), entry({ name: "file1" })],
      { key: "name", desc: false },
    ).map((e) => e.name);
    expect(nat).toEqual(["file1", "file9", "file10"]);
  });

  it("sorts by size and by modified time", () => {
    expect(
      fsSortEntries([f1, f2], { key: "size", desc: false }).map((e) => e.name),
    ).toEqual(["b.txt", "a.txt"]);
    expect(
      fsSortEntries([f1, f2], { key: "modified", desc: true }).map((e) => e.name),
    ).toEqual(["a.txt", "b.txt"]);
  });

  it("sinks unknown values to the bottom in BOTH directions", () => {
    // A permission-denied row has no size. Treating null as 0 parks it at the
    // top of an ascending sort, which is where the interesting files should be.
    const unknown = entry({ name: "denied", size: null, unreadable: true });
    const asc = fsSortEntries([unknown, f1, f2], { key: "size", desc: false });
    expect(asc[asc.length - 1].name).toBe("denied");
    const desc = fsSortEntries([unknown, f1, f2], { key: "size", desc: true });
    expect(desc[desc.length - 1].name).toBe("denied");
  });

  it("breaks ties on name so two identical fetches produce one order", () => {
    const same = [
      entry({ name: "z.txt", size: 10, modifiedAt: 7 }),
      entry({ name: "a.txt", size: 10, modifiedAt: 7 }),
    ];
    expect(fsSortEntries(same, { key: "size", desc: true }).map((e) => e.name)).toEqual([
      "a.txt",
      "z.txt",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [f1, f2];
    fsSortEntries(input, { key: "name", desc: true });
    expect(input.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });
});
