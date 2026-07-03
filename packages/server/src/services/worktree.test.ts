import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, WsServerEvent, Chat } from "@cm/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import {
  WorktreeService,
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
    expect(info).toMatchObject({ path: "C:/wt/feat-y", branch: "feat/y" });
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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cm-wt-"));
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

  it("links the worktree onto its owning chat when a Store is provided", async () => {
    const store = new Store(join(root, "data"));
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
});
