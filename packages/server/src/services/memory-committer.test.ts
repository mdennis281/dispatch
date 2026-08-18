import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { MemoryCommitter } from "./memory-committer.js";
import { TrunkSyncService } from "./trunk-sync.js";

let root: string;
let repo: string;
let remote: string;
let dataDir: string;
let bus: EventBus;
let store: Store;
let events: WsServerEvent[];
let memoryDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false });
  return r.stdout;
}

/** A committer bound to a fake project-config that points at the repo memory dir. */
function makeCommitter(dir: string | null = memoryDir): MemoryCommitter {
  return new MemoryCommitter({
    store,
    bus,
    projectConfig: { getConfig: () => (dir ? { memoryDir: dir } : null) },
    debounceMs: 5,
  });
}

async function writeMemory(name: string, body = "x"): Promise<void> {
  await writeFile(join(memoryDir, `${name}.md`), `---\nname: ${name}\n---\n\n${body}\n`);
}

const PROJECT_ID = "p1";

async function saveProject(over: Partial<Project> = {}): Promise<Project> {
  return store.saveProject({
    id: PROJECT_ID,
    name: "P",
    repoPath: repo,
    worktreeRoot: "../wt",
    subApps: [],
    defaultBranch: "main",
    createdAt: 1,
    workflow: { profile: "review" },
    ...over,
  } as Project);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-memcommit-"));
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  dataDir = join(root, "data");
  memoryDir = join(repo, ".dispatch", "memory");
  await mkdir(memoryDir, { recursive: true });
  await execa("git", ["init", "--bare", "-b", "main", remote]);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  await writeFile(join(repo, "README.md"), "hi\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  store = new Store(dataDir);
  await store.init?.();
  await saveProject();
}, 30_000);

afterEach(async () => {
  bus.clear();
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("MemoryCommitter.flush", () => {
  it("commits new memory files on the trunk", async () => {
    await writeMemory("road-system");
    const result = await makeCommitter().flush(PROJECT_ID);
    expect(result.status).toBe("committed");
    expect(result.files).toEqual([".dispatch/memory/road-system.md"]);
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe(
      "chore(memory): update road-system",
    );
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("summarizes a multi-file change and ignores the generated index", async () => {
    await writeMemory("a");
    await writeMemory("b");
    await writeFile(join(memoryDir, "MEMORY.md"), "# Memory index\n");
    const result = await makeCommitter().flush(PROJECT_ID);
    expect(result.files).toHaveLength(3);
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update 2 memories");
  });

  it("never sweeps unrelated staged work into the memory commit", async () => {
    await writeFile(join(repo, "src.ts"), "export const x = 1;\n");
    await git(repo, "add", "src.ts");
    await writeMemory("fact");

    expect((await makeCommitter().flush(PROJECT_ID)).status).toBe("committed");

    // The memory commit landed…
    const files = await git(repo, "show", "--name-only", "--pretty=", "HEAD");
    expect(files.split("\n").filter(Boolean)).toEqual([".dispatch/memory/fact.md"]);
    // …and the human's staged file is still staged, untouched.
    expect(await git(repo, "diff", "--cached", "--name-only")).toBe("src.ts");
  });

  it("does nothing when the memory dir is unchanged", async () => {
    expect((await makeCommitter().flush(PROJECT_ID)).status).toBe("nothing-to-commit");
  });

  it("declines when the profile doesn't ask for memory commits", async () => {
    await saveProject({ workflow: { profile: "none" } });
    await writeMemory("fact");
    expect((await makeCommitter().flush(PROJECT_ID)).status).toBe("skipped-policy");
    expect(await git(repo, "status", "--porcelain")).not.toBe("");
  });

  it("declines when the memory dir isn't inside the repo (legacy .data store)", async () => {
    await writeMemory("fact");
    const outside = makeCommitter(join(root, "elsewhere", "memory"));
    expect((await outside.flush(PROJECT_ID)).status).toBe("skipped-no-repo-dir");
    expect((await makeCommitter(null).flush(PROJECT_ID)).status).toBe("skipped-no-repo-dir");
  });

  it("declines when the primary checkout is parked off the trunk", async () => {
    await git(repo, "checkout", "-b", "wip");
    await writeMemory("fact");
    const result = await makeCommitter().flush(PROJECT_ID);
    expect(result.status).toBe("skipped-off-trunk");
    expect(result.detail).toContain("wip");
    // The files are left dirty rather than committed onto someone's branch.
    expect(await git(repo, "status", "--porcelain")).not.toBe("");
  });

  it("pushes when the trunk tracks an upstream", async () => {
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
    await writeMemory("fact");
    const result = await makeCommitter().flush(PROJECT_ID);
    expect(result.status).toBe("committed");
    expect(result.pushed).toBe(true);
    expect(await git(remote, "log", "-1", "--pretty=%s")).toBe("chore(memory): update fact");
  });

  it("commits without pushing when there is no upstream", async () => {
    await writeMemory("fact");
    const result = await makeCommitter().flush(PROJECT_ID);
    expect(result.status).toBe("committed");
    expect(result.pushed).toBeUndefined();
  });

  it("reports a git failure as a notice instead of throwing", async () => {
    const broken = new MemoryCommitter({
      store,
      bus,
      projectConfig: { getConfig: () => ({ memoryDir }) },
      exec: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
    });
    await writeMemory("fact");
    const result = await broken.flush(PROJECT_ID);
    expect(result.status).toBe("failed");
    expect(events.some((e) => e.type === "notice" && e.level === "warn")).toBe(true);
  });
});

describe("MemoryCommitter boot sweep", () => {
  it("commits memory left dirty while the manager was down", async () => {
    // The exact state this exists for: writes that landed before the committer
    // existed, sitting in the checkout with nothing left to commit them.
    await writeMemory("stranded");
    const committer = makeCommitter();
    committer.start();
    await committer.drain();
    committer.stop();
    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update stranded");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("MemoryCommitter debounce", () => {
  it("coalesces a burst of memory events into a single commit", async () => {
    const committer = makeCommitter();
    committer.start();
    await writeMemory("a");
    await writeMemory("b");
    for (const name of ["a", "b"]) {
      bus.publish({
        type: "memory-update",
        projectId: PROJECT_ID,
        memory: {
          projectId: PROJECT_ID,
          name,
          description: "",
          type: "project",
          body: "x",
          file: `${name}.md`,
          updatedAt: 1,
        },
      });
    }
    await new Promise((r) => setTimeout(r, 60));
    await committer.drain();
    committer.stop();

    expect(await git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update 2 memories");
    // One commit, not two.
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("stops scheduling once stopped", async () => {
    const committer = makeCommitter();
    committer.start();
    committer.stop();
    // Written AFTER start(), so the boot sweep can't have picked it up — the only
    // thing that could commit it now is an event subscription that outlived stop().
    await committer.drain();
    const before = await git(repo, "rev-list", "--count", "HEAD");
    await writeMemory("a");
    bus.publish({ type: "memory-deleted", projectId: PROJECT_ID, name: "a" });
    await new Promise((r) => setTimeout(r, 40));
    await committer.drain();
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe(before);
  });
});

describe("MemoryCommitter trunk fast-forward", () => {
  it("fast-forwards the trunk before committing, so the push isn't stranded", async () => {
    // The unobserved-auto-merge case: origin moved, our checkout didn't. Without
    // the fast-forward the commit lands but the push is a non-fast-forward, and
    // the memory sits unpublished forever.
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
    const other = join(root, "other");
    await execa("git", ["clone", remote, other]);
    await git(other, "config", "user.email", "o@e.com");
    await git(other, "config", "user.name", "O");
    await writeFile(join(other, "upstream.txt"), "u\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-m", "feat: upstream");
    await git(other, "push", "origin", "main");

    await writeMemory("fact");
    const committer = new MemoryCommitter({
      store,
      bus,
      projectConfig: { getConfig: () => ({ memoryDir }) },
      trunkSync: new TrunkSyncService({ store, bus }),
    });
    const result = await committer.flush(PROJECT_ID);

    expect(result.status).toBe("committed");
    expect(result.pushed).toBe(true);
    expect(await git(remote, "log", "-1", "--pretty=%s")).toBe("chore(memory): update fact");
    // The upstream commit is an ancestor — we fast-forwarded onto it, not over it.
    expect(await git(repo, "log", "--oneline", "-3")).toContain("feat: upstream");
  });

  it("still commits when there is no trunk sync wired up", async () => {
    await writeMemory("fact");
    expect((await makeCommitter().flush(PROJECT_ID)).status).toBe("committed");
  });
});
