import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@dispatch/shared";
import { probePath, inferProjectsRoot } from "./fs.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-fs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mkProject = (repoPath: string): Project => ({
  id: repoPath,
  name: "p",
  repoPath,
  worktreeRoot: ".worktrees",
  subApps: [],
  createdAt: 1,
});

describe("probePath", () => {
  it("reports a path that isn't there, and the nearest thing that is", async () => {
    const missing = join(dir, "nope", "deeper");
    const p = await probePath(missing);
    expect(p.exists).toBe(false);
    expect(p.isDirectory).toBe(false);
    expect(p.existingParent).toBe(dir.replace(/\\/g, "/"));
  });

  it("calls a file a file", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hi");
    const p = await probePath(file);
    expect(p.exists).toBe(true);
    expect(p.isDirectory).toBe(false);
  });

  it("calls an empty directory empty and not a repo", async () => {
    const p = await probePath(dir);
    expect(p).toMatchObject({ exists: true, isDirectory: true, isGit: false, empty: true });
  });

  it("sees a git repo, and doesn't count .git or .dispatch as content", async () => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, ".dispatch"));
    const p = await probePath(dir);
    expect(p.isGit).toBe(true);
    expect(p.repoRoot).toBe(dir.replace(/\\/g, "/"));
    // A directory holding only what this app just made is still a fresh start.
    expect(p.empty).toBe(true);
  });

  it("reports the ENCLOSING repo for a nested path, existing or not", async () => {
    await mkdir(join(dir, ".git"));
    const nested = join(dir, "apps", "service");
    await mkdir(nested, { recursive: true });
    const inner = await probePath(nested);
    // The whole point: `apps/service` has no `.git` of its own but is already
    // tracked, so `git init` there would nest a second repo inside the first.
    expect(inner).toMatchObject({ isGit: true, repoRoot: dir.replace(/\\/g, "/") });
    const notYet = await probePath(join(dir, "apps", "does-not-exist"));
    expect(notYet).toMatchObject({ exists: false, isGit: true });
  });

  it("distinguishes a missing directory from missing parents", async () => {
    // Only the leaf has to be created — its parent is right there.
    const leaf = await probePath(join(dir, "child"));
    expect(leaf).toMatchObject({ exists: false, parentExists: true });
    // Two levels missing: the immediate parent does NOT exist, even though an
    // ancestor does. `existingParent` alone can't tell these apart.
    const deep = await probePath(join(dir, "a", "b"));
    expect(deep).toMatchObject({ exists: false, parentExists: false });
    expect(deep.existingParent).toBe(dir.replace(/\\/g, "/"));
  });

  it("flags a relative path, since it resolves against the server's cwd", async () => {
    const rel = await probePath("some-relative-dir");
    expect(rel.absolute).toBe(false);
    expect(await probePath(dir)).toMatchObject({ absolute: true });
  });

  it("returns a repo's committed manifest verbatim, with the mirrored fields parsed", async () => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, ".dispatch"));
    const yaml =
      "# hand-authored\nname: Adopted App\nworktreeRoot: ../adopted-wt\ninstructions:\n  - file: house.md\n";
    await writeFile(join(dir, ".dispatch", "project.yaml"), yaml);
    const p = await probePath(dir);
    // Verbatim: the comment and the `instructions:` block both survive, because
    // re-deriving this file is exactly how they get lost.
    expect(p.dispatchConfig).toBe(yaml);
    expect(p.dispatchName).toBe("Adopted App");
    expect(p.dispatchWorktreeRoot).toBe("../adopted-wt");
  });

  it("still previews an unparseable manifest, just without a name", async () => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, ".dispatch"));
    await writeFile(join(dir, ".dispatch", "project.yaml"), "name: [unclosed\n");
    const p = await probePath(dir);
    expect(p.dispatchConfig).toContain("unclosed");
    expect(p.dispatchName).toBeNull();
  });

  it("reports no manifest for a repo that has none", async () => {
    await mkdir(join(dir, ".git"));
    const p = await probePath(dir);
    expect(p.dispatchConfig).toBeNull();
    expect(p.dispatchName).toBeNull();
  });

  it("stops calling a repo empty once it has code", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "index.ts"), "export {}");
    const p = await probePath(dir);
    expect(p).toMatchObject({ isGit: true, empty: false });
  });

  it("forward-slashes the path it echoes back", async () => {
    const p = await probePath(dir);
    expect(p.path).not.toContain("\\");
  });
});

describe("inferProjectsRoot", () => {
  // A drive letter is only absolute on Windows; `path.resolve("C:/code")` on
  // Linux prepends cwd and the inferred root comes back as a nonsense hybrid.
  // Drop the prefix off-Windows so the fixture is absolute either way.
  const D = process.platform === "win32" ? "C:" : "";

  it("learns the root the existing projects share", () => {
    const root = inferProjectsRoot(
      [mkProject(`${D}/Users/me/projects/a`), mkProject(`${D}/Users/me/projects/b`)],
      `${D}/Users/me`,
    );
    expect(root).toBe(`${D}/Users/me/projects`);
  });

  it("picks the parent the most projects sit under", () => {
    const root = inferProjectsRoot(
      [
        mkProject(`${D}/work/one`),
        mkProject(`${D}/code/a`),
        mkProject(`${D}/code/b`),
        mkProject(`${D}/code/c`),
      ],
      `${D}/Users/me`,
    );
    expect(root).toBe(`${D}/code`);
  });

  it("falls back to the home directory when there's nothing to learn from", () => {
    // `~/projects` doesn't exist under a temp dir, so this is the last fallback.
    expect(inferProjectsRoot([], dir)).toBe(dir.replace(/\\/g, "/"));
  });

  it("prefers a conventional ~/projects when one exists", async () => {
    await mkdir(join(dir, "projects"));
    expect(inferProjectsRoot([], dir)).toBe(`${dir.replace(/\\/g, "/")}/projects`);
  });
});
