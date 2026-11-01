/**
 * Removing a worktree must never delete THROUGH a link inside it.
 *
 * THE INCIDENT (2026-11-01). A dispatch-plugins worktree held `.dispatch-sdk`,
 * a gitignored junction to `claude-manager/packages/plugin-sdk`, and pnpm
 * `link:` dependencies that resolved through it. Removing that worktree with
 * `worktree {action:"remove", force:true}` deleted `packages/shared`,
 * `packages/plugin-sdk` and 11 `node_modules/.pnpm` packages out of the
 * Dispatch checkout. The step that followed the links was
 * `git worktree remove` itself: Git for Windows (2.40) walks a junction as if
 * it were a directory and deletes what it points at. Node's `rm` does not.
 *
 * On Windows every link here is a junction: the exact shape of the incident,
 * and creatable without privilege. Elsewhere `symlink(…, "junction")` makes an
 * ordinary directory symlink, so the same cases guard POSIX. File symlinks
 * need a privilege Windows rarely grants, so those cases run where they can.
 *
 * This file is in the Windows leg's explicit list (promote.yml): a Linux run
 * proves nothing about the platform the incident happened on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir, symlink, lstat, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { WorktreeService, realExec, samePath, type ExecFn } from "./worktree.js";
import { severLinks, restoreLinks, type SeveredLink } from "./tree-links.js";

/** Can this process make a FILE symlink? Windows says no without Developer Mode or admin. */
const canSymlinkFiles = (() => {
  const dir = mkdtempSync(join(tmpdir(), "cm-symcap-"));
  try {
    writeFileSync(join(dir, "f"), "");
    symlinkSync(join(dir, "f"), join(dir, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

async function git(cwd: string, ...args: string[]) {
  await execa("git", args, { cwd });
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

describe("worktree removal never deletes through a link", () => {
  let root: string;
  let repo: string;
  let wtRoot: string;
  let outside: string;
  let svc: WorktreeService;

  /** Everything the incident lost, by stand-in. Each must survive every case. */
  let sentinels: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cm-wtlinks-"));
    repo = join(root, "repo");
    wtRoot = join(root, "worktrees");
    outside = join(root, "outside");
    await mkdir(repo, { recursive: true });
    await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo });
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    // Gitignored, as `.dispatch-sdk` was — so a tree full of links is CLEAN,
    // and an unforced removal goes ahead just like a forced one.
    await writeFile(join(repo, ".gitignore"), ".dispatch-sdk\nnode_modules/\nlinked.txt\n");
    await writeFile(join(repo, "keep.txt"), "tracked\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init");

    // The other checkout: an SDK whose own node_modules links to a sibling
    // package — `plugin-sdk/node_modules/@dispatch/shared -> packages/shared`,
    // the second hop that cost the incident `packages/shared`.
    const sdk = join(outside, "plugin-sdk");
    const shared = join(outside, "shared");
    const store = join(outside, "store", "outdep");
    await mkdir(join(sdk, "node_modules", "@dispatch"), { recursive: true });
    await mkdir(shared, { recursive: true });
    await mkdir(store, { recursive: true });
    await symlink(shared, join(sdk, "node_modules", "@dispatch", "shared"), "junction");
    sentinels = [join(sdk, "SENTINEL"), join(shared, "SENTINEL"), join(store, "SENTINEL")];
    for (const s of sentinels) await writeFile(s, "keep me\n");

    svc = new WorktreeService({ bus: new EventBus(), exec: undefined });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function project(): Project {
    return {
      id: "p1",
      name: "Proj",
      repoPath: repo,
      worktreeRoot: wtRoot,
      subApps: [],
      createdAt: Date.now(),
    };
  }

  /** The incident's tree: an outbound junction, pnpm links through it, and pnpm's own in-tree links. */
  async function plantLinks(tree: string): Promise<void> {
    await symlink(join(outside, "plugin-sdk"), join(tree, ".dispatch-sdk"), "junction");
    const nm = join(tree, "node_modules");
    await mkdir(join(nm, "@dispatch"), { recursive: true });
    // A link to a link: `link:../.dispatch-sdk`.
    await symlink(join(tree, ".dispatch-sdk"), join(nm, "@dispatch", "plugin-sdk"), "junction");
    // pnpm's own shape, all inside the tree: node_modules/dep -> .pnpm/dep@1/node_modules/dep.
    const real = join(nm, ".pnpm", "dep@1.0.0", "node_modules", "dep");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "index.js"), "module.exports = 1;\n");
    await symlink(real, join(nm, "dep"), "junction");
    // And one buried deep in `.pnpm`, pointing out — a global virtual store's shape.
    await symlink(
      join(outside, "store", "outdep"),
      join(nm, ".pnpm", "dep@1.0.0", "node_modules", "outdep"),
      "junction",
    );
  }

  function expectSentinelsIntact(): void {
    for (const s of sentinels) expect(existsSync(s), `${s} was deleted through a link`).toBe(true);
    // The other checkout's own link survives too: nothing reached in and unlinked it.
    expect(existsSync(join(outside, "plugin-sdk", "node_modules", "@dispatch", "shared", "SENTINEL"))).toBe(true);
  }

  it("a forced removal deletes the tree and nothing its links point at", async () => {
    const info = await svc.create(project(), "feat/links", { base: "main", noFetch: true });
    await plantLinks(info.path);
    await writeFile(join(info.path, "dirty.txt"), "uncommitted\n");

    await svc.remove(info.path, true);

    expectSentinelsIntact();
    expect(existsSync(info.path)).toBe(false);
    const listed = await svc.list(project());
    expect(listed.some((w) => samePath(w.path, info.path))).toBe(false);
  });

  it("an unforced removal of a clean tree deletes nothing its links point at", async () => {
    const info = await svc.create(project(), "feat/clean-links", { base: "main", noFetch: true });
    await plantLinks(info.path);

    await svc.remove(info.path);

    expectSentinelsIntact();
    expect(existsSync(info.path)).toBe(false);
  });

  it("a dirty tree refused up front keeps every link, untouched", async () => {
    const info = await svc.create(project(), "feat/dirty-links", { base: "main", noFetch: true });
    await plantLinks(info.path);
    await writeFile(join(info.path, "dirty.txt"), "uncommitted\n");

    await expect(svc.remove(info.path)).rejects.toThrow(/worktree remove/);

    expectSentinelsIntact();
    expect(await isLink(join(info.path, ".dispatch-sdk"))).toBe(true);
    expect(await isLink(join(info.path, "node_modules", "dep"))).toBe(true);
    expect(existsSync(join(info.path, "dirty.txt"))).toBe(true);
  });

  it("a locked tree is refused up front, even forced, and keeps its links", async () => {
    const info = await svc.create(project(), "feat/locked-links", { base: "main", noFetch: true });
    await plantLinks(info.path);
    await git(repo, "worktree", "lock", info.path);

    await expect(svc.remove(info.path, true)).rejects.toThrow(/locked/);

    expectSentinelsIntact();
    expect(await isLink(join(info.path, ".dispatch-sdk"))).toBe(true);
    expect(existsSync(join(info.path, ".git"))).toBe(true);
  });

  it("puts the links back when git refuses after they were severed", async () => {
    // A refusal the up-front checks cannot see (submodules, a tree that went
    // dirty in between): git exits non-zero having touched nothing.
    const refusing: ExecFn = async (file, args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        return { stdout: "", stderr: "fatal: working trees containing submodules cannot be moved or removed", exitCode: 128 };
      }
      return realExec(file, args, opts);
    };
    const info = await svc.create(project(), "feat/refused-late", { base: "main", noFetch: true });
    await plantLinks(info.path);

    const refuser = new WorktreeService({ bus: new EventBus(), exec: refusing });
    await expect(refuser.remove(info.path)).rejects.toThrow(/submodules/);

    expectSentinelsIntact();
    // Restored, and still working: the SDK is reachable through both hops again.
    expect(await isLink(join(info.path, ".dispatch-sdk"))).toBe(true);
    expect(await readFile(join(info.path, "node_modules", "@dispatch", "plugin-sdk", "SENTINEL"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(info.path, "node_modules", "dep", "index.js"), "utf8")).toContain("module.exports");
  });

  it("finishing a half-done removal deletes nothing its links point at", async () => {
    // Git destroys `.git` and gives up — the PR #260 path, where Node finishes the job.
    const dying: ExecFn = async (file, args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        const target = args[args.length - 1]!;
        await rm(join(target, ".git"), { force: true });
        // Re-plant AFTER the up-front sever, so the finisher meets live links of its own.
        await plantLinks(target).catch(() => {});
        return { stdout: "", stderr: `fatal: failed to delete '${target}': Directory not empty`, exitCode: 128 };
      }
      return realExec(file, args, opts);
    };
    const info = await svc.create(project(), "feat/half-done", { base: "main", noFetch: true });

    await new WorktreeService({ bus: new EventBus(), exec: dying }).remove(info.path, true);

    expectSentinelsIntact();
    expect(existsSync(info.path)).toBe(false);
  });

  it("the orphan sweep deletes a husk and nothing its links point at", async () => {
    // What `remove()` used to leave behind: no `.git`, a `node_modules` full of junctions.
    const husk = join(wtRoot, "feat-dead");
    await mkdir(husk, { recursive: true });
    await plantLinks(husk);
    const listed = await svc.list(project());
    expect((await svc.listOrphanDirectories(project(), listed)).map((d) => samePath(d, husk))).toEqual([true]);

    await svc.removeOrphanDirectory(husk);

    expectSentinelsIntact();
    expect(existsSync(husk)).toBe(false);
  });

  it("refuses a worktree path that is itself a link", async () => {
    const info = await svc.create(project(), "feat/real", { base: "main", noFetch: true });
    const alias = join(root, "alias");
    await symlink(info.path, alias, "junction");

    await expect(svc.remove(alias, true)).rejects.toThrow(/link/);

    expect(existsSync(join(info.path, ".git"))).toBe(true);
    expect(existsSync(join(info.path, "keep.txt"))).toBe(true);
  });

  it.runIf(canSymlinkFiles)("a file symlink is unlinked, never its target", async () => {
    const target = join(outside, "file-target.txt");
    await writeFile(target, "keep me\n");
    const info = await svc.create(project(), "feat/file-link", { base: "main", noFetch: true });
    await symlink(target, join(info.path, "linked.txt"), "file");

    await svc.remove(info.path, true);

    expect(await readFile(target, "utf8")).toBe("keep me\n");
    expect(existsSync(info.path)).toBe(false);
  });

  describe("severLinks / restoreLinks", () => {
    it("unlinks every link, at any depth, without entering one", async () => {
      const tree = join(root, "tree");
      await mkdir(tree, { recursive: true });
      await plantLinks(tree);

      const severed = await severLinks(tree);

      expect(severed.map((l) => l.path).sort()).toEqual(
        [
          join(tree, ".dispatch-sdk"),
          join(tree, "node_modules", "@dispatch", "plugin-sdk"),
          join(tree, "node_modules", "dep"),
          join(tree, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "outdep"),
        ].sort(),
      );
      for (const l of severed) expect(existsSync(l.path)).toBe(false);
      expectSentinelsIntact();
      // Real content inside the tree is left for the delete that follows.
      expect(existsSync(join(tree, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep", "index.js"))).toBe(true);
    });

    it("unlinks a root that is itself a link and walks nothing behind it", async () => {
      const alias = join(root, "alias");
      await symlink(join(outside, "plugin-sdk"), alias, "junction");

      const severed = await severLinks(alias);

      expect(severed.map((l) => l.path)).toEqual([alias]);
      expect(await isLink(alias)).toBe(false);
      expectSentinelsIntact();
    });

    it("is a no-op on a path that is not there", async () => {
      expect(await severLinks(join(root, "nope"))).toEqual([]);
    });

    it("restores what it severed", async () => {
      const tree = join(root, "tree");
      await mkdir(tree, { recursive: true });
      await plantLinks(tree);
      const severed: SeveredLink[] = await severLinks(tree);

      expect(await restoreLinks(severed)).toEqual([]);

      for (const l of severed) expect(await isLink(l.path)).toBe(true);
      expect(await readFile(join(tree, ".dispatch-sdk", "SENTINEL"), "utf8")).toBe("keep me\n");
    });
  });
});
