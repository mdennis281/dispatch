import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { TrunkSyncService } from "./trunk-sync.js";

let root: string;
let repo: string;
let other: string;
let remote: string;
let bus: EventBus;
let store: Store;
let project: Project;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false });
  return r.stdout;
}

/** Advance the shared remote from a second clone, so `repo` falls behind. */
async function advanceRemote(file: string): Promise<void> {
  await writeFile(join(other, file), "x\n");
  await git(other, "add", "-A");
  await git(other, "commit", "-m", `feat: ${file}`);
  await git(other, "push", "origin", "main");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-trunksync-"));
  repo = join(root, "repo");
  other = join(root, "other");
  remote = join(root, "remote.git");
  await execa("git", ["init", "--bare", "-b", "main", remote]);
  await execa("git", ["clone", remote, repo]);
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  await writeFile(join(repo, "README.md"), "hi\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  await git(repo, "push", "-u", "origin", "main");
  await execa("git", ["clone", remote, other]);
  await git(other, "config", "user.email", "o@example.com");
  await git(other, "config", "user.name", "O");

  bus = new EventBus();
  store = new Store(join(root, "data"));
  await store.init?.();
  project = await store.saveProject({
    id: "p1",
    name: "P",
    repoPath: repo,
    worktreeRoot: "../wt",
    subApps: [],
    defaultBranch: "main",
    createdAt: 1,
    workflow: { profile: "review" },
  } as Project);
}, 30_000);

afterEach(async () => {
  bus.clear();
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const svc = (memoryDir?: string) =>
  new TrunkSyncService({
    store,
    bus,
    ...(memoryDir ? { projectConfig: { getConfig: () => ({ memoryDir }) } } : {}),
  });

/** Commit `files` locally on the trunk (simulating a memory commit we made). */
async function localCommit(files: Record<string, string>, message: string): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(repo, rel)), { recursive: true });
    await writeFile(join(repo, rel), body);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message);
}

describe("TrunkSyncService", () => {
  it("fast-forwards the primary checkout after a merge", async () => {
    await advanceRemote("a.txt");
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("1");

    const result = await svc().sync(project, "merge");

    expect(result.status).toBe("synced");
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("2");
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("feat: a.txt");
  });

  it("reports already-current when nothing moved", async () => {
    expect((await svc().sync(project, "merge")).status).toBe("already-current");
  });

  it("respects the profile's sync trigger", async () => {
    await advanceRemote("a.txt");
    // `review` syncs at merge, so a ship trigger must not touch it.
    expect((await svc().sync(project, "ship")).status).toBe("skipped-policy");
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("does nothing for a profile that never syncs", async () => {
    const none = { ...project, workflow: { profile: "none" as const } };
    await advanceRemote("a.txt");
    expect((await svc().sync(none, "merge")).status).toBe("skipped-policy");
  });

  it("refuses when the primary checkout is parked off the trunk", async () => {
    await git(repo, "checkout", "-b", "wip");
    await advanceRemote("a.txt");
    const result = await svc().sync(project, "merge");
    expect(result.status).toBe("skipped-off-trunk");
    expect(result.detail).toContain("wip");
  });

  it("refuses to resolve a diverged trunk rather than guessing", async () => {
    await advanceRemote("a.txt");
    // Local commit on main that isn't upstream → no fast-forward is possible.
    await writeFile(join(repo, "local.txt"), "l\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "local only");

    const result = await svc().sync(project, "merge");

    expect(result.status).toBe("failed");
    // The local commit is still there — nothing was rebased or merged under us.
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("local only");
  });

  it("resolves the project through a chat", async () => {
    await advanceRemote("a.txt");
    const chat = await store.saveChat({
      id: "c1",
      projectId: "p1",
      title: "t",
      modeId: "auto",
      effort: "medium",
      status: "idle",
      worktrees: [],
      createdAt: 1,
      updatedAt: 1,
    } as never);
    expect((await svc().syncForChat(chat.id, "merge")).status).toBe("synced");
    expect((await svc().syncForChat(undefined, "merge")).status).toBe("skipped-policy");
  });
});

describe("TrunkSyncService — diverged trunk carrying memory commits", () => {
  const MEM = ".dispatch/memory";
  const memDir = () => join(repo, ".dispatch", "memory");

  it("replays a memory-only local commit onto the moved trunk", async () => {
    // Exactly the state seen in the wild: a memory commit landed locally, then a
    // PR auto-merged upstream with nobody watching. Neither side is an ancestor
    // of the other, so --ff-only can't help — and refusing would strand the
    // memory commit permanently.
    await localCommit({ [`${MEM}/fact.md`]: "m\n" }, "chore(memory): update fact");
    await advanceRemote("a.txt");

    const result = await svc(memDir()).sync(project, "merge");

    expect(result.status).toBe("rebased-memory");
    const log = await git(repo, "log", "--oneline", "-3");
    expect(log).toContain("chore(memory): update fact");
    expect(log).toContain("feat: a.txt");
    // Rebased, not merged — the memory commit sits on top and pushes cleanly.
    expect(await git(repo, "rev-list", "--count", `origin/main..HEAD`)).toBe("1");
    expect((await git(repo, "push", "origin", "main")) !== undefined).toBe(true);
  });

  it("still refuses when a local commit touches anything outside memory", async () => {
    await localCommit(
      { [`${MEM}/fact.md`]: "m\n", "src.ts": "real work\n" },
      "chore(memory): update fact",
    );
    await advanceRemote("a.txt");

    const result = await svc(memDir()).sync(project, "merge");

    expect(result.status).toBe("failed");
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update fact");
  });

  it("refuses when it can't tell which files are memory", async () => {
    await localCommit({ [`${MEM}/fact.md`]: "m\n" }, "chore(memory): update fact");
    await advanceRemote("a.txt");
    // No memory-dir resolver wired up → no basis to call the divergence ours.
    expect((await svc().sync(project, "merge")).status).toBe("failed");
  });

  it("leaves no half-finished rebase behind when the replay conflicts", async () => {
    await localCommit({ [`${MEM}/fact.md`]: "local\n" }, "chore(memory): update fact");
    // Upstream touched the SAME memory file — the replay can't apply cleanly.
    await writeFile(join(other, "conflict-marker.txt"), "x\n");
    await mkdir(join(other, ".dispatch", "memory"), { recursive: true });
    await writeFile(join(other, `${MEM}/fact.md`), "upstream\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "feat: upstream memory");
    await git(other, "push", "origin", "main");

    const result = await svc(memDir()).sync(project, "merge");

    expect(result.status).toBe("failed");
    // No rebase left in progress for a human to trip over.
    expect(await git(repo, "status", "--porcelain=v2", "--branch")).not.toContain("rebase");
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update fact");
  });
});
