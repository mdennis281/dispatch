/**
 * WorktreeReaper tests, against REAL git repositories in a temp dir.
 *
 * Not mocked, deliberately. This service removes directories, and the two
 * questions it has to get right — "has this branch landed?" and "is anything
 * still in there?" — are questions about git's actual behaviour, including the
 * one that broke the naive version: a squash merge rewrites the branch's
 * commits, so a landed branch is NOT an ancestor of the trunk and every
 * ancestry-based check calls it unmerged forever. A mocked `exec` would happily
 * confirm whatever the implementation already believed.
 *
 * The fixture is therefore a bare "origin", a clone, and real worktrees, so a
 * squash-merged branch in these tests is squash-merged the same way one is in
 * the repo this was written for.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, Project, TerminalInfo } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { WorktreeService, pathKey } from "./worktree.js";
import { WorktreeReaper, type WorktreeReaperDeps } from "./worktree-reaper.js";

let root: string;
let origin: string;
let repo: string;
let wtRoot: string;
let dataDir: string;
let bus: EventBus;
let store: Store;
let worktrees: WorktreeService;
let reaper: WorktreeReaper;
let liveTerminals: TerminalInfo[];

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, env: GIT_ENV, stripFinalNewline: true });
  return r.stdout;
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Proj",
    repoPath: repo,
    worktreeRoot: wtRoot,
    defaultBranch: "main",
    subApps: [],
    createdAt: Date.now(),
    ...over,
  };
}

function mkChat(over: Partial<Chat> = {}): Chat {
  return {
    id: "chatA",
    projectId: "p1",
    title: "T",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: Date.now(),
    ...over,
  };
}

function mkTerminal(cwd: string, over: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: `term-${cwd}`,
    chatId: "chatA",
    name: "sh",
    cwd,
    status: "live",
    createdAt: Date.now(),
    ...over,
  };
}

/**
 * A worktree on a new branch cut from main, with one commit of its own.
 *
 * The file is named AFTER the branch, which matters more than it looks: these
 * branches get merged into main during a test, so a shared filename with shared
 * content means the next branch cut from main has nothing to commit and `git
 * commit` exits 1.
 */
async function makeBranchWorktree(branch: string): Promise<string> {
  const slug = branch.replace(/\//g, "-");
  const p = join(wtRoot, slug);
  await git(repo, "worktree", "add", "-b", branch, p, "main");
  await writeFile(join(p, `${slug}.txt`), `work on ${branch}\n`);
  await git(p, "add", "-A");
  await git(p, "commit", "-m", `work on ${branch}`);
  return p;
}

/**
 * Attribute a worktree to a chat the way the running app does.
 *
 * The `list()` first is load-bearing: `attachToChat` → `setRecordChat` is
 * deliberately silent for a path the registry has never heard of, and these
 * fixtures cut their trees with raw `git worktree add`. Without a `list()` to
 * sync the registry, the chat would list the path while the CANDIDATE carried no
 * `chatId` — and every chat-ownership gate would quietly pass.
 */
async function attach(chatId: string, worktreePath: string): Promise<void> {
  await worktrees.list(mkProject());
  await worktrees.attachToChat(chatId, worktreePath);
}

/** Push the branch so it has a live upstream (`ahead 0`). */
async function push(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, "push", "-u", "origin", branch);
}

/** A true merge — the branch becomes an ancestor of main. */
async function mergeToMain(branch: string): Promise<void> {
  await git(repo, "merge", "--no-ff", "-m", `merge ${branch}`, branch);
  await git(repo, "push", "origin", "main");
  await git(repo, "fetch", "origin");
}

/**
 * A SQUASH merge — main gets the changes, but as a new commit, so `branch` is
 * NOT an ancestor of main. GitHub then deletes the remote branch. This is what
 * the repo this service was written for actually does, and the reason `merged`
 * cannot be answered by ancestry alone.
 */
async function squashMergeToMain(branch: string): Promise<void> {
  await git(repo, "merge", "--squash", branch);
  await git(repo, "commit", "-m", `squash ${branch}`);
  await git(repo, "push", "origin", "main");
  await git(repo, "push", "origin", "--delete", branch);
  await git(repo, "fetch", "origin", "--prune");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-reap-"));
  origin = join(root, "origin.git");
  repo = join(root, "repo");
  wtRoot = join(root, "worktrees");
  dataDir = join(root, "data");
  await mkdir(wtRoot, { recursive: true });

  // A real bare remote, so `@{upstream}` and `[gone]` mean what they mean.
  await execa("git", ["-c", "init.defaultBranch=main", "init", "--bare", origin]);
  await execa("git", ["-c", "init.defaultBranch=main", "clone", origin, repo]);
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "keep.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  await git(repo, "push", "-u", "origin", "main");

  bus = new EventBus();
  store = new Store(dataDir);
  await store.init();
  worktrees = new WorktreeService({ bus, store });
  liveTerminals = [];
  reaper = new WorktreeReaper({
    store,
    bus,
    worktrees,
    terminals: { list: () => liveTerminals },
    // No grace window by default: the fixture's trees are created milliseconds
    // before they're judged, and `too-new` has its own test.
    graceMs: 0,
  });

  await store.saveProject(mkProject());
});

afterEach(async () => {
  reaper.stop();
  store.close();
  await rm(root, { recursive: true, force: true });
});

/**
 * The candidate for `path`, or a failure that names what came back instead.
 *
 * Matched with `pathKey`, the same comparison the service uses — a hand-rolled
 * string compare here would pass or fail on separator and case rather than on
 * the behaviour under test.
 */
async function judge(path: string, opts: Parameters<WorktreeReaper["plan"]>[0] = {}) {
  const plan = await reaper.plan({ probeCap: Infinity, ...opts });
  const want = pathKey(path);
  const c = plan.candidates.find((x) => pathKey(x.path) === want);
  expect(c, `no candidate for ${path} in ${plan.candidates.map((x) => x.path).join(", ")}`)
    .toBeDefined();
  return c!;
}

/* ------------------------------------------------------------- the gates */

describe("WorktreeReaper.plan — what blocks a removal", () => {
  it("clears a merged, clean, fully-pushed worktree", async () => {
    const p = await makeBranchWorktree("feat/done");
    await push(p, "feat/done");
    await mergeToMain("feat/done");

    const c = await judge(p);
    expect(c.blockers).toEqual([]);
    expect(c.probed).toBe(true);
    expect(c.branchDeletable).toBe(true);
  });

  it("blocks a tree whose branch has not landed", async () => {
    const p = await makeBranchWorktree("feat/wip");
    await push(p, "feat/wip");

    expect((await judge(p)).blockers).toContain("unmerged");
  });

  it("blocks a tree with uncommitted changes", async () => {
    const p = await makeBranchWorktree("feat/dirty");
    await push(p, "feat/dirty");
    await mergeToMain("feat/dirty");
    await writeFile(join(p, "keep.txt"), "edited\n");

    expect((await judge(p)).blockers).toContain("dirty");
  });

  it("blocks a tree with an UNTRACKED file — the one that exists nowhere else", async () => {
    const p = await makeBranchWorktree("feat/untracked");
    await push(p, "feat/untracked");
    await mergeToMain("feat/untracked");
    await writeFile(join(p, "scratch-notes.md"), "do not delete me\n");

    expect((await judge(p)).blockers).toContain("dirty");
  });

  it("blocks a tree holding commits the remote never saw", async () => {
    const p = await makeBranchWorktree("feat/ahead");
    await push(p, "feat/ahead");
    await mergeToMain("feat/ahead");
    // A commit made AFTER the merge, never pushed.
    await writeFile(join(p, "late.txt"), "late\n");
    await git(p, "add", "-A");
    await git(p, "commit", "-m", "late work");

    expect((await judge(p)).blockers).toContain("unpushed");
  });

  it("blocks a never-pushed branch with no merged PR to vouch for it", async () => {
    const p = await makeBranchWorktree("feat/local-only");
    // Merged into main locally, but the branch itself never left this machine
    // and nothing recorded a PR. There is no evidence the work exists elsewhere.
    await git(repo, "merge", "--no-ff", "-m", "m", "feat/local-only");

    const c = await judge(p);
    expect(c.blockers).toContain("unpushed");
  });

  it("treats a branch it can't get tracking for as unpushed", async () => {
    const p = await makeBranchWorktree("feat/detached-head");
    await push(p, "feat/detached-head");
    await mergeToMain("feat/detached-head");
    // Detach: there is now no branch, so `for-each-ref` has nothing to say about
    // this tree. "We couldn't find out" must not read as "it's pushed".
    await git(p, "checkout", "--detach");

    const c = await judge(p);
    expect(c.blockers).toContain("unpushed");
  });

  it("never offers the primary checkout", async () => {
    const c = await judge(repo);
    expect(c.blockers).toContain("primary");
  });

  it("never offers a worktree sitting on the trunk", async () => {
    // git refuses to check a branch out in two places, so the primary has to
    // step off main first — which is exactly the arrangement that produces a
    // `main` worktree in real life.
    await git(repo, "checkout", "-b", "scratch");
    const p = join(wtRoot, "trunk");
    await git(repo, "worktree", "add", p, "main");

    // `main` IS an ancestor of itself, so `merged` reads TRUE here. Without the
    // explicit gate the trunk is the FIRST thing the reaper would take.
    const c = await judge(p);
    expect(c.blockers).toContain("default-branch");
  });

  it("respects `git worktree lock` as an explicit keep", async () => {
    const p = await makeBranchWorktree("feat/locked");
    await push(p, "feat/locked");
    await mergeToMain("feat/locked");
    await git(repo, "worktree", "lock", p);

    expect((await judge(p)).blockers).toContain("locked");
  });

  it("blocks while the owning chat is mid-turn", async () => {
    const p = await makeBranchWorktree("feat/busy");
    await push(p, "feat/busy");
    await mergeToMain("feat/busy");
    await store.saveChat(mkChat({ status: "running" }));
    await attach("chatA", p);

    expect((await judge(p)).blockers).toContain("chat-live");
  });

  it("releases the tree once that chat goes idle", async () => {
    const p = await makeBranchWorktree("feat/wasbusy");
    await push(p, "feat/wasbusy");
    await mergeToMain("feat/wasbusy");
    await store.saveChat(mkChat({ status: "idle" }));
    await attach("chatA", p);

    expect((await judge(p)).blockers).toEqual([]);
  });

  it("blocks while a live shell is sitting in it", async () => {
    const p = await makeBranchWorktree("feat/shell");
    await push(p, "feat/shell");
    await mergeToMain("feat/shell");
    liveTerminals = [mkTerminal(join(p, "packages", "server"))];

    // A shell in a SUBDIRECTORY still counts — it is standing in the tree.
    expect((await judge(p)).blockers).toContain("terminal-live");
  });

  it("ignores a shell that has already exited", async () => {
    const p = await makeBranchWorktree("feat/deadshell");
    await push(p, "feat/deadshell");
    await mergeToMain("feat/deadshell");
    liveTerminals = [mkTerminal(p, { status: "exited" })];

    expect((await judge(p)).blockers).toEqual([]);
  });

  it("honors the grace window", async () => {
    const graced = new WorktreeReaper({
      store,
      bus,
      worktrees,
      graceMs: 60 * 60_000,
    });
    const p = await makeBranchWorktree("feat/fresh");
    await push(p, "feat/fresh");
    await mergeToMain("feat/fresh");

    const plan = await graced.plan({ probeCap: Infinity });
    const c = plan.candidates.find((x) => x.branch === "feat/fresh");
    expect(c?.blockers).toContain("too-new");
  });
});

/* ------------------------------------------------- the squash-merge case */

describe("WorktreeReaper — squash merges", () => {
  // Two tests rather than a before/after in one, deliberately: the merged-branch
  // answer is TTL-cached inside WorktreeService, so recording the PR and
  // re-asking within the window would just replay the first answer — and the
  // test would "prove" the fix doesn't work.
  it("ancestry alone calls a squash-merged branch unmerged, forever", async () => {
    const p = await makeBranchWorktree("feat/squashed-nopr");
    await push(p, "feat/squashed-nopr");
    await squashMergeToMain("feat/squashed-nopr");

    // The squash rewrote the commits and the remote branch is gone. Without a
    // recorded PR there is nothing left that knows this work landed.
    expect((await judge(p)).blockers).toContain("unmerged");
  });

  it("still reaps a squash-merged branch, on the strength of its recorded PR", async () => {
    const p = await makeBranchWorktree("feat/squashed");
    await push(p, "feat/squashed");
    await squashMergeToMain("feat/squashed");
    await store.saveChat(
      mkChat({
        prs: [
          {
            number: 97,
            url: "https://github.com/o/r/pull/97",
            branch: "feat/squashed",
            state: "merged",
          },
        ],
      }),
    );

    const c = await judge(p);
    expect(c.blockers).toEqual([]);
    expect(c.prNumber).toBe(97);
    expect(c.branchDeletable).toBe(true);
  });

  it("does not treat an OPEN PR as landed", async () => {
    const p = await makeBranchWorktree("feat/open-pr");
    await push(p, "feat/open-pr");
    await squashMergeToMain("feat/open-pr");
    await store.saveChat(
      mkChat({
        prs: [
          {
            number: 98,
            url: "https://github.com/o/r/pull/98",
            branch: "feat/open-pr",
            state: "open",
          },
        ],
      }),
    );

    expect((await judge(p)).blockers).toContain("unmerged");
  });
});

/* ---------------------------------------------------------------- removal */

describe("WorktreeReaper.reap", () => {
  it("removes the directory and, when asked, the branch", async () => {
    const p = await makeBranchWorktree("feat/gone");
    await push(p, "feat/gone");
    await mergeToMain("feat/gone");

    const result = await reaper.reap([p], { deleteBranch: true });
    expect(result.removed).toBe(1);
    expect(result.outcomes[0]?.branchDeleted).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(await git(repo, "branch", "--list", "feat/gone")).toBe("");
  });

  it("leaves the branch alone when not asked", async () => {
    const p = await makeBranchWorktree("feat/keepbranch");
    await push(p, "feat/keepbranch");
    await mergeToMain("feat/keepbranch");

    await reaper.reap([p], { deleteBranch: false });
    expect(existsSync(p)).toBe(false);
    expect(await git(repo, "branch", "--list", "feat/keepbranch")).toContain(
      "feat/keepbranch",
    );
  });

  it("deletes a SQUASH-merged branch, which `git branch -d` would refuse", async () => {
    const p = await makeBranchWorktree("feat/squash-branch");
    await push(p, "feat/squash-branch");
    await squashMergeToMain("feat/squash-branch");
    await store.saveChat(
      mkChat({
        prs: [
          {
            number: 99,
            url: "u",
            branch: "feat/squash-branch",
            state: "merged",
          },
        ],
      }),
    );

    const result = await reaper.reap([p], { deleteBranch: true });
    expect(result.outcomes[0]?.branchDeleted).toBe(true);
    expect(await git(repo, "branch", "--list", "feat/squash-branch")).toBe("");
  });

  it("RE-JUDGES before removing — a tree that went dirty since the plan is refused", async () => {
    const p = await makeBranchWorktree("feat/raced");
    await push(p, "feat/raced");
    await mergeToMain("feat/raced");

    // Clean at plan time…
    expect((await judge(p)).blockers).toEqual([]);
    // …and dirty by the time the human presses the button.
    await writeFile(join(p, "oops.txt"), "unsaved\n");

    const result = await reaper.reap([p]);
    expect(result.removed).toBe(0);
    expect(result.outcomes[0]?.blockers).toContain("dirty");
    expect(existsSync(p)).toBe(true);
  });

  it("refuses a blocked path rather than skipping it silently", async () => {
    const p = await makeBranchWorktree("feat/notdone");
    await push(p, "feat/notdone");

    const result = await reaper.reap([p]);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]?.error).toMatch(/not safe to remove/);
    expect(existsSync(p)).toBe(true);
  });

  it("reports an unknown path instead of throwing", async () => {
    const result = await reaper.reap([join(wtRoot, "never-existed")]);
    expect(result.removed).toBe(0);
    expect(result.outcomes[0]?.error).toMatch(/no longer a known worktree/);
  });
});

/* ----------------------------------------------------------------- sweeps */

describe("WorktreeReaper.sweep", () => {
  it("takes the landed trees and leaves everything else", async () => {
    const done = await makeBranchWorktree("feat/sweep-done");
    await push(done, "feat/sweep-done");
    await mergeToMain("feat/sweep-done");

    const wip = await makeBranchWorktree("feat/sweep-wip");
    await push(wip, "feat/sweep-wip");

    const dirty = await makeBranchWorktree("feat/sweep-dirty");
    await push(dirty, "feat/sweep-dirty");
    await mergeToMain("feat/sweep-dirty");
    await writeFile(join(dirty, "wip.txt"), "hold on\n");

    const result = await reaper.sweep();
    expect(result.removed).toBe(1);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(wip)).toBe(true);
    expect(existsSync(dirty)).toBe(true);
  });

  it("stays within its probe budget, and says so", async () => {
    for (const b of ["feat/a", "feat/b", "feat/c"]) {
      const p = await makeBranchWorktree(b);
      await push(p, b);
      await mergeToMain(b);
    }
    const plan = await reaper.plan({ probeCap: 2 });
    expect(plan.probed).toBe(2);
    expect(plan.truncated).toBe(true);
  });

  it("names what it removed, rather than just counting", async () => {
    const notices: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "notice") notices.push(e.text);
    });
    const p = await makeBranchWorktree("feat/announced");
    await push(p, "feat/announced");
    await mergeToMain("feat/announced");

    await reaper.sweep();
    expect(notices.some((t) => t.includes("feat/announced"))).toBe(true);
  });

  it("does nothing, and says nothing, when there is nothing to do", async () => {
    const notices: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "notice") notices.push(e.text);
    });
    const p = await makeBranchWorktree("feat/still-going");
    await push(p, "feat/still-going");

    const result = await reaper.sweep();
    expect(result.removed).toBe(0);
    expect(notices).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });
});

describe("WorktreeReaper.sweepChat", () => {
  it("only touches trees the chat owns", async () => {
    const mine = await makeBranchWorktree("feat/mine");
    await push(mine, "feat/mine");
    await mergeToMain("feat/mine");

    const theirs = await makeBranchWorktree("feat/theirs");
    await push(theirs, "feat/theirs");
    await mergeToMain("feat/theirs");

    await store.saveChat(mkChat({ status: "idle" }));
    await attach("chatA", mine);

    const result = await reaper.sweepChat("chatA");
    expect(result.removed).toBe(1);
    expect(existsSync(mine)).toBe(false);
    // Another chat's tree is not this sweep's business, landed or not.
    expect(existsSync(theirs)).toBe(true);
  });

  it("ignores the grace window — the owner stopping is better evidence than a timer", async () => {
    const graced = new WorktreeReaper({
      store,
      bus,
      worktrees,
      graceMs: 60 * 60_000,
    });
    const p = await makeBranchWorktree("feat/just-landed");
    await push(p, "feat/just-landed");
    await mergeToMain("feat/just-landed");
    await store.saveChat(mkChat({ status: "idle" }));
    await attach("chatA", p);

    expect((await graced.sweepChat("chatA")).removed).toBe(1);
    expect(existsSync(p)).toBe(false);
  });

  it("still refuses a dirty tree, however idle its owner", async () => {
    const p = await makeBranchWorktree("feat/idle-dirty");
    await push(p, "feat/idle-dirty");
    await mergeToMain("feat/idle-dirty");
    await writeFile(join(p, "draft.md"), "unsaved thinking\n");
    await store.saveChat(mkChat({ status: "idle" }));
    await attach("chatA", p);

    expect((await reaper.sweepChat("chatA")).removed).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  it("is a no-op for a chat that owns nothing", async () => {
    await store.saveChat(mkChat({ status: "idle" }));
    expect((await reaper.sweepChat("chatA")).removed).toBe(0);
  });
});

/* ---------------------------------------------------------------- policy */

describe("WorktreeReaper — the settings policy", () => {
  /** A landed, clean, pushed tree — the thing a sweep would otherwise take. */
  async function landedTree(branch: string): Promise<string> {
    const p = await makeBranchWorktree(branch);
    await push(p, branch);
    await mergeToMain(branch);
    return p;
  }

  function withPolicy(policy: WorktreeReaperDeps["policy"]): WorktreeReaper {
    return new WorktreeReaper({ store, bus, worktrees, graceMs: 0, policy });
  }

  it("does nothing automatic while cleanup is switched off", async () => {
    const p = await landedTree("feat/policy-off");
    const r = withPolicy(async () => ({ enabled: false, deleteBranch: true }));

    expect((await r.sweep()).removed).toBe(0);
    await store.saveChat(mkChat({ status: "idle" }));
    await attach("chatA", p);
    expect((await r.sweepChat("chatA")).removed).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  it("still lets a human do it by hand — the switch is about UNATTENDED passes", async () => {
    const p = await landedTree("feat/manual-anyway");
    const r = withPolicy(async () => ({ enabled: false, deleteBranch: true }));

    // `plan`/`reap` are the Source Control panel's door, and it stays open.
    expect((await r.reap([p])).removed).toBe(1);
    expect(existsSync(p)).toBe(false);
  });

  it("takes `deleteBranch` from the policy rather than assuming", async () => {
    await landedTree("feat/policy-keeps-branch");
    const r = withPolicy(async () => ({ enabled: true, deleteBranch: false }));

    expect((await r.sweep()).removed).toBe(1);
    expect(await git(repo, "branch", "--list", "feat/policy-keeps-branch")).toContain(
      "feat/policy-keeps-branch",
    );
  });

  it("deletes the branch on a SWEEP when the policy says so", async () => {
    await landedTree("feat/sweep-branch-gone");
    const r = withPolicy(async () => ({ enabled: true, deleteBranch: true }));

    const result = await r.sweep();
    expect(result.outcomes[0]?.branchDeleted).toBe(true);
    expect(await git(repo, "branch", "--list", "feat/sweep-branch-gone")).toBe("");
  });

  it("fails CLOSED when the policy can't be read", async () => {
    const p = await landedTree("feat/policy-throws");
    const r = withPolicy(async () => {
      throw new Error("config unreadable");
    });

    // An unreadable setting must never be taken as permission to delete.
    expect((await r.sweep()).removed).toBe(0);
    expect(existsSync(p)).toBe(true);
  });
});

/* -------------------------------------------------------- the cheap pass */

describe("WorktreeReaper.plan — cheapOnly", () => {
  it("answers every gate but cleanliness, and admits it hasn't probed", async () => {
    const p = await makeBranchWorktree("feat/cheap");
    await push(p, "feat/cheap");
    await mergeToMain("feat/cheap");
    // Dirty — which only the probe could know, and which cheapOnly must NOT
    // claim to have ruled out.
    await writeFile(join(p, "x.txt"), "x\n");

    const c = await judge(p, { cheapOnly: true });
    expect(c.probed).toBe(false);
    expect(c.blockers).toEqual([]);

    // The full pass finds it.
    expect((await judge(p)).blockers).toContain("dirty");
  });
});
