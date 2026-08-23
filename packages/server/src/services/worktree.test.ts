import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, WsServerEvent, Chat } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import {
  WorktreeService,
  canonicalWorktreePath,
  parseWorktreePorcelain,
  parseNumstat,
  resolveNumstatPath,
  splitPatch,
  type ExecFn,
} from "./worktree.js";

/* ------------------------------------------------------------ pure parsers */

describe("parseWorktreePorcelain", () => {
  it("parses main + branch + detached + locked records", () => {
    const out = [
      "worktree C:/repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree C:/repo-worktrees/feat-x",
      "HEAD bbbb",
      "branch refs/heads/feat/x",
      "locked",
      "",
      "worktree C:/repo-worktrees/detached",
      "HEAD cccc",
      "detached",
      "",
    ].join("\n");
    const recs = parseWorktreePorcelain(out);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ path: "C:/repo", branch: "main", head: "aaaa" });
    expect(recs[1]).toMatchObject({ branch: "feat/x", locked: true });
    expect(recs[2]).toMatchObject({ branch: "(detached)", head: "cccc" });
  });
});

describe("resolveNumstatPath", () => {
  it("passes through a plain path", () => {
    expect(resolveNumstatPath("src/a.ts")).toEqual({ path: "src/a.ts" });
  });
  it("expands a brace rename", () => {
    expect(resolveNumstatPath("src/{old => new}/b.ts")).toEqual({
      path: "src/new/b.ts",
      oldPath: "src/old/b.ts",
    });
  });
  it("splits an arrow rename", () => {
    expect(resolveNumstatPath("old/a.ts => new/a.ts")).toEqual({
      path: "new/a.ts",
      oldPath: "old/a.ts",
    });
  });
});

describe("parseNumstat", () => {
  it("parses counts, renames, and binary rows", () => {
    const out = [
      "3\t1\tsrc/a.ts",
      "5\t0\tsrc/{old => new}/b.ts",
      "-\t-\tassets/img.png",
      "",
    ].join("\n");
    const e = parseNumstat(out);
    expect(e).toHaveLength(3);
    expect(e[0]).toMatchObject({ path: "src/a.ts", additions: 3, deletions: 1, binary: false });
    expect(e[1]).toMatchObject({ path: "src/new/b.ts", oldPath: "src/old/b.ts", additions: 5 });
    expect(e[2]).toMatchObject({ path: "assets/img.png", binary: true, additions: 0, deletions: 0 });
  });
});

describe("splitPatch", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " line1",
    "-old",
    "+new",
    "+added",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 000..333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "index 444..000",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");

  it("splits per-file with status + path + patch", () => {
    const map = splitPatch(patch);
    expect([...map.keys()].sort()).toEqual(["src/a.ts", "src/gone.ts", "src/new.ts"]);
    expect(map.get("src/a.ts")).toMatchObject({ status: "modified" });
    expect(map.get("src/new.ts")).toMatchObject({ status: "added" });
    expect(map.get("src/gone.ts")).toMatchObject({ status: "deleted" });
    expect(map.get("src/a.ts")!.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(map.get("src/new.ts")!.patch).toContain("+hello");
  });

  it("returns empty for an empty diff", () => {
    expect(splitPatch("").size).toBe(0);
  });
});

/* ---------------------------------------------- mocked exec (arg-array proof) */

function recordingExec(
  handler: (file: string, args: string[]) => { stdout?: string; exitCode?: number },
) {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const fn: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    const r = handler(file, args);
    return { stdout: r.stdout ?? "", stderr: "", exitCode: r.exitCode ?? 0 };
  };
  return { fn, calls };
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Proj",
    repoPath: "C:/repo",
    worktreeRoot: "C:/wt",
    subApps: [],
    createdAt: Date.now(),
    ...over,
  };
}

describe("WorktreeService.create (mocked exec)", () => {
  it("fetches origin/main then adds the worktree off origin/main — no shell interpolation", async () => {
    const { fn, calls } = recordingExec((_file, args) => {
      if (args[0] === "rev-parse") return { stdout: "deadbeef\n" };
      return {};
    });
    const bus = new EventBus();
    const events: WsServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const svc = new WorktreeService({ exec: fn, bus });
    const project = mkProject();

    const info = await svc.create(project, "feat/x", { chatId: "c1" });
    const expectedPath = svc.worktreePath(project, "feat/x");

    expect(calls[0]).toEqual({ file: "git", args: ["fetch", "origin", "main"], cwd: "C:/repo" });
    expect(calls[1]).toEqual({
      file: "git",
      args: ["worktree", "add", "-b", "feat/x", expectedPath, "--end-of-options", "origin/main"],
      cwd: "C:/repo",
    });
    expect(info).toMatchObject({
      path: expectedPath,
      branch: "feat/x",
      base: "origin/main",
      head: "deadbeef",
      projectId: "p1",
      chatId: "c1",
    });
    const wtEvent = events.find((e) => e.type === "worktree-update");
    expect(wtEvent).toBeTruthy();
    expect(wtEvent).toMatchObject({ type: "worktree-update", chatId: "c1" });
  });

  it("honors a custom worktreeCmd, passing the branch as a discrete arg", async () => {
    const { fn, calls } = recordingExec((file, args) => {
      if (file === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: ["worktree C:/wt/feat-y", "HEAD abc123", "branch refs/heads/feat/y", ""].join("\n"),
        };
      }
      if (args[0] === "rev-parse") return { stdout: "abc123\n" };
      return {};
    });
    const svc = new WorktreeService({ exec: fn });
    const project = mkProject({ worktreeCmd: "pnpm worktree" });

    const info = await svc.create(project, "feat/y");

    expect(calls[0]).toEqual({ file: "pnpm", args: ["worktree", "feat/y"], cwd: "C:/repo" });
    // The custom command decides the path, so it comes back from the porcelain —
    // canonicalized, because that spelling is the registry's key.
    expect(info).toMatchObject({
      path: canonicalWorktreePath("C:/wt/feat-y"),
      branch: "feat/y",
    });
  });

  it("uses the project's defaultBranch for the base ref", async () => {
    const { fn, calls } = recordingExec((_file, args) =>
      args[0] === "rev-parse" ? { stdout: "x\n" } : {},
    );
    const svc = new WorktreeService({ exec: fn });
    const project = mkProject({ defaultBranch: "develop" });
    await svc.create(project, "feat/z", { noFetch: true });
    // With noFetch the first call is the add, off origin/develop.
    expect(calls[0].args).toEqual([
      "worktree",
      "add",
      "-b",
      "feat/z",
      svc.worktreePath(project, "feat/z"),
      "--end-of-options",
      "origin/develop",
    ]);
  });
});

/* ---------------------------------------------- real temp git repo (no network) */

async function git(cwd: string, ...args: string[]) {
  await execa("git", args, { cwd });
}

describe("WorktreeService on a real temp repo", () => {
  let root: string;
  let repo: string;
  let wtRoot: string;
  let bus: EventBus;
  let events: WsServerEvent[];
  let svc: WorktreeService;
  // Two cases below build their own Store. Windows won't remove `root` while
  // any SQLite handle under it is open, so they get closed with the temp dir.
  let stores: Store[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cm-wt-"));
    stores = [];
    repo = join(root, "repo");
    wtRoot = join(root, "worktrees");
    await mkdir(repo, { recursive: true });
    await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo });
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "keep.txt"), "one\ntwo\nthree\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init");

    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    svc = new WorktreeService({ bus, exec: undefined });
  });
  afterEach(async () => {
    for (const s of stores) s.close();
    await rm(root, { recursive: true, force: true });
  });

  function project(): Project {
    return mkProject({ repoPath: repo, worktreeRoot: wtRoot });
  }

  it("creates a worktree+branch, lists it, diffs it, and removes it", async () => {
    const info = await svc.create(project(), "feat/test", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
    });
    expect(existsSync(info.path)).toBe(true);
    expect(info.branch).toBe("feat/test");
    expect(info.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(events.some((e) => e.type === "worktree-update")).toBe(true);

    // list includes the new worktree (by branch).
    const listed = await svc.list(project());
    expect(listed.some((w) => w.branch === "feat/test")).toBe(true);
    expect(listed.every((w) => w.projectId === "p1")).toBe(true);

    // Make changes in the worktree: add a file + modify the committed one, then
    // commit so the branch genuinely diverges from main (git diff ignores
    // untracked files — diffVsMain must not mutate the index to surface them).
    await writeFile(join(info.path, "added.txt"), "hello\nworld\n");
    await writeFile(join(info.path, "keep.txt"), "one\nTWO\nthree\nfour\n");
    await git(info.path, "add", "-A");
    await git(info.path, "commit", "-m", "work");

    const diff = await svc.diffVsMain(info.path, "main");
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    expect(byPath.has("added.txt")).toBe(true);
    expect(byPath.get("added.txt")).toMatchObject({ status: "added", additions: 2 });
    expect(byPath.get("added.txt")!.patch).toContain("+hello");
    expect(byPath.has("keep.txt")).toBe(true);
    expect(byPath.get("keep.txt")!.status).toBe("modified");
    expect(diff.additions).toBeGreaterThan(0);

    // remove it.
    await svc.remove(info.path, true);
    expect(existsSync(info.path)).toBe(false);
    const after = await svc.list(project());
    expect(after.some((w) => w.branch === "feat/test")).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  it("surfaces untracked (newly-created) files as added entries", async () => {
    const info = await svc.create(project(), "feat/untracked", {
      base: "main",
      noFetch: true,
    });
    // A brand-new file the agent created but never `git add`ed (no trailing NL
    // on the last line → still counted), plus a tracked edit to prove both show.
    await writeFile(join(info.path, "fresh.txt"), "alpha\nbeta\ngamma");
    await writeFile(join(info.path, "keep.txt"), "one\nTWO\nthree\n");

    const diff = await svc.diffVsMain(info.path, "main");
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    expect(byPath.get("fresh.txt")).toMatchObject({
      status: "added",
      additions: 3,
      deletions: 0,
      binary: false,
    });
    expect(byPath.get("keep.txt")).toMatchObject({ status: "modified" });
    expect(diff.additions).toBeGreaterThanOrEqual(3);
  });

  it("diffs vs the merge-base so a freshly-cut branch is empty even as the base advances", async () => {
    const info = await svc.create(project(), "feat/fresh", {
      base: "main",
      noFetch: true,
    });
    // Advance main AFTER cutting the branch (stale-base scenario): a naive
    // `git diff main` would now report main's new commit as the branch's change.
    await writeFile(join(repo, "onmain.txt"), "server-only\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "advance main");

    const diff = await svc.diffVsMain(info.path, "main");
    expect(diff.files).toHaveLength(0);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it("reads the diff's base side at the merge-base, not at the base ref's tip", async () => {
    const info = await svc.create(project(), "feat/viewer", {
      base: "main",
      noFetch: true,
    });
    // Same stale-base scenario as the diff test above, but this is the side the
    // Monaco viewer renders: read at main's TIP it would show main's rewrite as
    // the branch's own deletion, disagreeing with the (empty) changed-file list.
    await writeFile(join(repo, "keep.txt"), "one\ntwo\nthree\nFOUR-ON-MAIN\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "advance main");

    const forked = await svc.readFile(info.path, "keep.txt", {
      ref: "main",
      mergeBase: true,
    });
    expect(forked.content).toBe("one\ntwo\nthree\n");

    // Without the flag the exact rev is still honoured — other callers rely on it.
    const tip = await svc.readFile(info.path, "keep.txt", { ref: "main" });
    expect(tip.content).toBe("one\ntwo\nthree\nFOUR-ON-MAIN\n");
  });

  it("links the worktree onto its owning chat when a Store is provided", async () => {
    const store = new Store(join(root, "data"));
    stores.push(store);
    await store.init();
    const chat: Chat = {
      id: "chatA",
      projectId: "p1",
      title: "T",
      modeId: "auto",
      effort: "medium",
      worktrees: [],
      prs: [],
      createdAt: Date.now(),
    };
    await store.saveChat(chat);
    const svc2 = new WorktreeService({ bus, store });

    const info = await svc2.create(project(), "feat/linked", {
      base: "main",
      noFetch: true,
      chatId: "chatA",
    });
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toContain(info.path);
    expect(events.some((e) => e.type === "chat-update")).toBe(true);

    await svc2.remove(info.path, { force: true, chatId: "chatA" });
    const afterRemove = await store.getChat("chatA");
    expect(afterRemove!.worktrees).not.toContain(info.path);
  });

  it("detachFromChat unlinks a worktree path WITHOUT touching disk (idempotent)", async () => {
    const store = new Store(join(root, "data-detach"));
    stores.push(store);
    await store.init();
    const chat: Chat = {
      id: "chatB",
      projectId: "p1",
      title: "T",
      modeId: "auto",
      effort: "medium",
      worktrees: ["/wt/keep", "/wt/wrong"],
      prs: [],
      createdAt: Date.now(),
    };
    await store.saveChat(chat);
    const svc2 = new WorktreeService({ bus, store });
    const before = events.length;

    // First detach: the mis-attributed path leaves worktrees[], the other stays.
    const first = await svc2.detachFromChat("chatB", "/wt/wrong");
    expect(first).toBe(true);
    const reloaded = await store.getChat("chatB");
    expect(reloaded!.worktrees).toEqual(["/wt/keep"]);
    expect(events.slice(before).some((e) => e.type === "chat-update")).toBe(true);

    // Second detach of the same path is a no-op (already gone) → false, no re-save.
    const mid = events.length;
    const second = await svc2.detachFromChat("chatB", "/wt/wrong");
    expect(second).toBe(false);
    expect(events.slice(mid).some((e) => e.type === "chat-update")).toBe(false);
  });

  it("refuses to create a duplicate worktree path", async () => {
    await svc.create(project(), "feat/dup", { base: "main", noFetch: true });
    await expect(
      svc.create(project(), "feat/dup", { base: "main", noFetch: true }),
    ).rejects.toThrow(/already exists/);
  });

  // A worktreeRoot starting with `../` is how a busy repo keeps its trees OUT
  // of its own checkout — at ~100 live worktrees an in-repo root made every
  // filesystem-walking tool (grep, rg, a watcher) re-read 100 copies of the
  // repo, and .gitignore does nothing about that. Dispatch's own manifest uses
  // `../.worktrees/dispatch`, so the escape has to actually escape: resolve()
  // must climb out of repoPath rather than joining a literal ".." segment
  // underneath it.
  it("honors a parent-relative worktreeRoot by creating outside the repo", async () => {
    const outside = mkProject({ repoPath: repo, worktreeRoot: "../trees/dispatch" });
    const expected = join(root, "trees", "dispatch", "feat-outside");

    expect(svc.worktreePath(outside, "feat/outside")).toBe(expected);

    const info = await svc.create(outside, "feat/outside", {
      base: "main",
      noFetch: true,
    });
    expect(info.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(join(repo, ".."))).toBe(true);
    // The decisive bit: nothing named `..` or `trees` landed inside the repo.
    expect(existsSync(join(repo, "trees"))).toBe(false);

    // git agrees it is a worktree of THIS repo, not an unrelated checkout.
    const listed = await svc.list(outside);
    expect(listed.find((w) => w.branch === "feat/outside")?.path).toBe(expected);
  });
});

/* ------------------------------------------------------- attribution registry */

describe("WorktreeService — the attribution registry (real git)", () => {
  let root: string;
  let repo: string;
  let wtRoot: string;
  let store: Store;
  let svc: WorktreeService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cm-wtreg-"));
    repo = join(root, "repo");
    wtRoot = join(root, "worktrees");
    await mkdir(repo, { recursive: true });
    await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo });
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "keep.txt"), "one\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "init");

    store = new Store(join(root, "data"));
    await store.init();
    svc = new WorktreeService({ store, bus: new EventBus() });
  });
  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function project(over: Partial<Project> = {}): Project {
    return mkProject({ repoPath: repo, worktreeRoot: wtRoot, ...over });
  }

  it("records the owning chat AT CREATION, not after the fact", async () => {
    const info = await svc.create(project(), "feat/owned", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
      origin: "tool",
      label: "the work",
    });

    const rec = await store.getWorktreeRecord(info.path);
    expect(rec).toMatchObject({
      path: info.path,
      projectId: "p1",
      branch: "feat/owned",
      chatId: "chat1",
      origin: "tool",
      label: "the work",
    });
    expect(info).toMatchObject({ chatId: "chat1", origin: "tool", label: "the work" });
  });

  it("merges the record onto every list() row and flags the primary checkout", async () => {
    await svc.create(project(), "feat/listed", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
      origin: "tool",
    });

    const listed = await svc.list(project());
    const wt = listed.find((w) => w.branch === "feat/listed")!;
    expect(wt).toMatchObject({ chatId: "chat1", origin: "tool", projectId: "p1" });

    const primary = listed.find((w) => w.isPrimary)!;
    expect(primary.path).toBe(canonicalWorktreePath(repo));
    // The primary checkout is nobody's task worktree, whatever a row might say.
    expect(primary.chatId).toBeUndefined();
    expect(primary.origin).toBeUndefined();
  });

  it("back-fills a tree cut outside Dispatch as unattributed `external`", async () => {
    const path = join(wtRoot, "rogue");
    await git(repo, "worktree", "add", "-b", "feat/rogue", path, "main");

    const listed = await svc.list(project());
    const wt = listed.find((w) => w.branch === "feat/rogue")!;
    // Visible, and honest about not knowing whose it is — which is the point.
    expect(wt.origin).toBe("external");
    expect(wt.chatId).toBeUndefined();
  });

  it("drops the row when git stops reporting the tree", async () => {
    const info = await svc.create(project(), "feat/vanish", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
    });
    await git(repo, "worktree", "remove", "--force", info.path);

    await svc.list(project());
    expect(await store.getWorktreeRecord(info.path)).toBeNull();
  });

  it("forgets the row when WE remove the tree", async () => {
    const info = await svc.create(project(), "feat/removed", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
    });
    await svc.remove(info.path, { chatId: "chat1" });
    expect(await store.getWorktreeRecord(info.path)).toBeNull();
  });

  it("keeps the record's chatId in step with attach/detach", async () => {
    const info = await svc.create(project(), "feat/moved", {
      base: "main",
      noFetch: true,
    });
    await store.saveChat({
      id: "chatX",
      projectId: "p1",
      title: "t",
      harness: "claude",
      modeId: "default",
      status: "idle",
      effort: "medium",
      worktrees: [],
      prs: [],
      createdAt: Date.now(),
    });

    await svc.attachToChat("chatX", info.path);
    expect((await store.getWorktreeRecord(info.path))?.chatId).toBe("chatX");

    await svc.detachFromChat("chatX", info.path);
    expect((await store.getWorktreeRecord(info.path))?.chatId).toBeUndefined();
  });

  it("listAll applies the shared registry filter", async () => {
    await svc.create(project(), "feat/alpha", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
      origin: "tool",
    });
    await svc.create(project(), "feat/beta", {
      base: "main",
      noFetch: true,
      chatId: "chat2",
      origin: "tool",
    });

    const mine = await svc.listAll([project()], {
      scope: "chat",
      chatId: "chat1",
    });
    expect(mine.map((w) => w.branch)).toEqual(["feat/alpha"]);

    const searched = await svc.listAll([project()], { scope: "all", q: "beta" });
    expect(searched.map((w) => w.branch)).toEqual(["feat/beta"]);

    // Scope "all" also sees the primary checkout; the narrow scopes don't.
    const all = await svc.listAll([project()], { scope: "all" });
    expect(all.some((w) => w.isPrimary)).toBe(true);
  });

  /* ------------------------------------------------- merged / unmerged */

  /** A fresh service, because the merged answer is TTL-cached per instance. */
  const freshSvc = (): WorktreeService => new WorktreeService({ store, bus: new EventBus() });

  it("reports a branch git can see on the trunk as merged", async () => {
    const info = await svc.create(project(), "feat/lands", { base: "main", noFetch: true });
    await writeFile(join(info.path, "new.txt"), "x\n");
    await git(info.path, "add", "-A");
    await git(info.path, "commit", "-m", "work");

    const before = (await svc.list(project())).find((w) => w.branch === "feat/lands")!;
    expect(before.merged).toBe(false);

    // A real (non-squash) merge — git's own ancestry answers this one.
    await git(repo, "merge", "--no-ff", "-m", "merge", "feat/lands");
    const after = (await freshSvc().list(project())).find((w) => w.branch === "feat/lands")!;
    expect(after.merged).toBe(true);
  });

  it("counts a SQUASH-merged branch as merged, off the recorded PR", async () => {
    // The case git cannot see: a squash rewrites the commits, so the branch is
    // not an ancestor of the trunk and `--merged` calls it unmerged forever.
    // This repo squash-merges, so without the PR join the filter would select
    // nearly every worktree.
    const info = await svc.create(project(), "feat/squashed", { base: "main", noFetch: true });
    await writeFile(join(info.path, "sq.txt"), "x\n");
    await git(info.path, "add", "-A");
    await git(info.path, "commit", "-m", "work");
    await git(repo, "merge", "--squash", "feat/squashed");
    await git(repo, "commit", "-m", "feat: squashed (#1)");

    expect((await svc.list(project())).find((w) => w.branch === "feat/squashed")!.merged).toBe(
      false,
    );

    await store.saveChat({
      id: "chatMerged",
      projectId: "p1",
      title: "T",
      modeId: "auto",
      effort: "medium",
      worktrees: [],
      prs: [{ number: 1, url: "u", branch: "feat/squashed", state: "merged" }],
      createdAt: Date.now(),
    });
    expect(
      (await freshSvc().list(project())).find((w) => w.branch === "feat/squashed")!.merged,
    ).toBe(true);
  });

  it("leaves the primary checkout's merged state unknown", async () => {
    const primary = (await svc.list(project())).find((w) => w.isPrimary)!;
    // "Is the trunk merged into itself" is a category error, not a `false`.
    expect(primary.merged).toBeUndefined();
  });

  it("filters unmerged and unattributed, and never returns the primary for either", async () => {
    await svc.create(project(), "feat/mine", {
      base: "main",
      noFetch: true,
      chatId: "chat1",
    });
    const orphan = await svc.create(project(), "feat/orphan", { base: "main", noFetch: true });
    await writeFile(join(orphan.path, "o.txt"), "x\n");
    await git(orphan.path, "add", "-A");
    await git(orphan.path, "commit", "-m", "work");

    const unattributed = await freshSvc().listAll([project()], {
      scope: "all",
      unattributed: true,
    });
    expect(unattributed.map((w) => w.branch)).toEqual(["feat/orphan"]);

    // `feat/mine` has no commits of its own, so git already counts it as
    // merged; only the branch that diverged is selected.
    const unmerged = await freshSvc().listAll([project()], { scope: "all", unmerged: true });
    expect(unmerged.map((w) => w.branch)).toEqual(["feat/orphan"]);
    expect(unmerged.some((w) => w.isPrimary)).toBe(false);
  });

  it("sorts by the query rather than by whatever order git listed", async () => {
    await svc.create(project(), "feat/zulu", { base: "main", noFetch: true });
    await svc.create(project(), "feat/alpha", { base: "main", noFetch: true });
    const branches = async (query: Parameters<typeof svc.listAll>[1]): Promise<string[]> =>
      (await freshSvc().listAll([project()], query)).map((w) => w.branch);

    expect(await branches({ scope: "all", sort: "name", unattributed: true })).toEqual([
      "feat/alpha",
      "feat/zulu",
    ]);
    expect(
      await branches({ scope: "all", sort: "name", order: "desc", unattributed: true }),
    ).toEqual(["feat/zulu", "feat/alpha"]);
  });
});
