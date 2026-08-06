import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, Project, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { WorktreeService } from "./worktree.js";
import { WorktreeDetector } from "./worktree-detector.js";

/* -------------------------------------------------- real temp git repo fixture */

let root: string;
let repo: string;
let wtRoot: string;
let dataDir: string;
let bus: EventBus;
let events: WsServerEvent[];
let store: Store;
let worktrees: WorktreeService;
let detector: WorktreeDetector;
let toolSeq: number;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stripFinalNewline: true,
  });
  return r.stdout;
}

/** Simulate the agent creating a worktree via Bash (`git worktree add`). */
async function agentAddsWorktree(branch: string): Promise<string> {
  const p = join(wtRoot, branch.replace(/\//g, "-"));
  await git(repo, "worktree", "add", "-b", branch, p);
  return p;
}

/**
 * Simulate the agent's Bash `tool_use` row on the bus — this is the signal the
 * detector reads to record which chat CREATED a branch (attribution).
 */
function agentRunsCommand(chatId: string, command: string): void {
  const n = toolSeq++;
  bus.publish({
    type: "chat-message",
    chatId,
    message: {
      kind: "tool_use",
      id: `tu-${n}`,
      chatId,
      ts: 1_000 + n,
      toolUseId: `tuid-${n}`,
      name: "Bash",
      input: { command },
    },
  });
}

/** Record the creating-command AND actually create the worktree (as `chatId`). */
async function agentCreatesWorktree(
  chatId: string,
  branch: string,
): Promise<string> {
  const p = join(wtRoot, branch.replace(/\//g, "-"));
  agentRunsCommand(chatId, `git worktree add -b ${branch} ${p}`);
  return agentAddsWorktree(branch);
}

/**
 * PERSIST a worktree-create tool_use row into a chat's transcript (messages.jsonl)
 * — the durable signal history-based reconstruction reads after a restart (the bus
 * events above are only in-memory).
 */
async function persistWorktreeCommand(
  chatId: string,
  branch: string,
  ts: number,
): Promise<void> {
  await store.appendMessage({
    kind: "tool_use",
    id: `m-${chatId}-${branch}`,
    chatId,
    ts,
    toolUseId: `tu-${chatId}-${branch}`,
    name: "Bash",
    input: { command: `pnpm worktree ${branch}` },
  });
}

function mkProject(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Proj",
    repoPath: repo,
    worktreeRoot: wtRoot,
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

const chatUpdates = () =>
  events.filter(
    (e): e is Extract<WsServerEvent, { type: "chat-update" }> =>
      e.type === "chat-update",
  );
const worktreeUpdates = () =>
  events.filter(
    (e): e is Extract<WsServerEvent, { type: "worktree-update" }> =>
      e.type === "worktree-update",
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-wtd-"));
  repo = join(root, "repo");
  wtRoot = join(root, "worktrees");
  dataDir = join(root, "data");
  await mkdir(repo, { recursive: true });
  await mkdir(wtRoot, { recursive: true });

  await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo });
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "keep.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");

  bus = new EventBus();
  events = [];
  toolSeq = 0;
  bus.subscribe((e) => events.push(e));
  store = new Store(dataDir);
  await store.init();
  worktrees = new WorktreeService({ bus, store });
  detector = new WorktreeDetector({ store, bus, worktrees });

  await store.saveProject(mkProject());
});

afterEach(async () => {
  detector.stop();
  await rm(root, { recursive: true, force: true });
});

describe("WorktreeDetector.detectForChat", () => {
  it("attaches an agent-created worktree to the chat that created it", async () => {
    await store.saveChat(mkChat());
    await detector.start(); // seeds the baseline (only the primary checkout)

    const wtPath = await agentCreatesWorktree("chatA", "feat/x");
    const res = await detector.detectForChat("chatA");

    expect(res.attached).toHaveLength(1);
    // The stored path is exactly what `git worktree list` reports.
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toEqual(res.attached);
    expect(res.attached[0].replace(/\\/g, "/")).toContain("feat-x");

    // Emits chat-update AND worktree-update tagged to the owning chat.
    expect(chatUpdates().some((e) => e.chat.id === "chatA")).toBe(true);
    const wu = worktreeUpdates().find((e) => e.chatId === "chatA");
    expect(wu).toBeTruthy();
    expect(wu!.worktree).toMatchObject({ branch: "feat/x", chatId: "chatA" });

    expect(wtPath).toBeTruthy();
  });

  it("attaches MULTIPLE worktrees created in one turn", async () => {
    await store.saveChat(mkChat());
    await detector.start();

    await agentCreatesWorktree("chatA", "feat/a");
    await agentCreatesWorktree("chatA", "feat/b");
    const res = await detector.detectForChat("chatA");

    expect(res.attached).toHaveLength(2);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(2);
    const branches = worktreeUpdates()
      .filter((e) => e.chatId === "chatA")
      .map((e) => e.worktree.branch)
      .sort();
    expect(branches).toEqual(["feat/a", "feat/b"]);
  });

  it("never attaches the primary checkout", async () => {
    await store.saveChat(mkChat());
    await detector.start();
    const res = await detector.detectForChat("chatA");
    expect(res.attached).toEqual([]);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toEqual([]);
  });

  it("does NOT attribute a worktree that pre-existed the baseline seed", async () => {
    // A worktree that existed before we started watching is not the chat's work.
    await agentAddsWorktree("feat/preexisting");
    await store.saveChat(mkChat());
    await detector.start(); // seed now includes feat/preexisting

    const res = await detector.detectForChat("chatA");
    expect(res.attached).toEqual([]);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toEqual([]);
  });

  it("is idempotent — a second pass attaches nothing new", async () => {
    await store.saveChat(mkChat());
    await detector.start();
    await agentCreatesWorktree("chatA", "feat/once");

    const first = await detector.detectForChat("chatA");
    expect(first.attached).toHaveLength(1);
    const second = await detector.detectForChat("chatA");
    expect(second.attached).toEqual([]);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
  });

  it("detaches a worktree the agent has removed", async () => {
    await store.saveChat(mkChat());
    await detector.start();
    const wtPath = await agentCreatesWorktree("chatA", "feat/gone");
    const attach = await detector.detectForChat("chatA");
    expect(attach.attached).toHaveLength(1);

    // Agent tears the worktree down.
    await git(repo, "worktree", "remove", "--force", wtPath);
    const res = await detector.detectForChat("chatA");

    expect(res.removed).toEqual(attach.attached);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toEqual([]);
  });

  it("does not steal a worktree already owned by another chat", async () => {
    // chatB owns feat/shared; chatA's detection must leave it alone.
    await detector.start();
    const wtPath = await agentAddsWorktree("feat/shared");
    const listed = await worktrees.list(mkProject());
    const info = listed.find((w) => w.branch === "feat/shared")!;
    await store.saveChat(mkChat({ id: "chatB", worktrees: [info.path] }));
    await store.saveChat(mkChat({ id: "chatA" }));

    const res = await detector.detectForChat("chatA");
    expect(res.attached).toEqual([]);
    const a = await store.getChat("chatA");
    const b = await store.getChat("chatB");
    expect(a!.worktrees).toEqual([]);
    expect(b!.worktrees).toEqual([info.path]);
    expect(wtPath).toBeTruthy();
  });
});

describe("WorktreeDetector bus wiring", () => {
  it("detects on the turn-complete (chat-status idle) signal", async () => {
    await store.saveChat(mkChat());
    await detector.start();

    // Turn starts (seeds), agent creates a worktree, turn completes.
    bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
    await detector.drain();
    await agentCreatesWorktree("chatA", "feat/live");
    bus.publish({ type: "chat-status", chatId: "chatA", status: "idle" });
    await detector.drain();

    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
    expect(worktreeUpdates().some((e) => e.worktree.branch === "feat/live")).toBe(
      true,
    );
  });

  it("also detects on a session-ended (done) signal", async () => {
    await store.saveChat(mkChat());
    await detector.start();
    await agentCreatesWorktree("chatA", "feat/onend");
    bus.publish({ type: "chat-status", chatId: "chatA", status: "done" });
    await detector.drain();

    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
  });

  it("seeds a project first seen at runtime at turn START, not turn end", async () => {
    // Project + chat created AFTER the detector started (nothing seeded yet). A
    // worktree that already existed before the turn must NOT be attributed; only
    // one created during the turn is.
    await detector.start(); // seedAll finds p1 (already saved in beforeEach)

    const p2Repo = join(root, "repo2");
    const p2Wt = join(root, "wt2");
    await mkdir(p2Repo, { recursive: true });
    await mkdir(p2Wt, { recursive: true });
    await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: p2Repo });
    await git(p2Repo, "config", "user.email", "t@t");
    await git(p2Repo, "config", "user.name", "t");
    await git(p2Repo, "config", "commit.gpgsign", "false");
    await writeFile(join(p2Repo, "f.txt"), "x\n");
    await git(p2Repo, "add", "-A");
    await git(p2Repo, "commit", "-m", "init");
    // A pre-existing worktree on the runtime project.
    await git(p2Repo, "worktree", "add", "-b", "feat/old", join(p2Wt, "feat-old"));

    await store.saveProject(
      mkProject({ id: "p2", repoPath: p2Repo, worktreeRoot: p2Wt }),
    );
    await store.saveChat(mkChat({ id: "chatP2", projectId: "p2" }));

    // Turn start seeds p2's baseline (includes feat/old)…
    bus.publish({ type: "chat-status", chatId: "chatP2", status: "running" });
    await detector.drain();
    // …then the agent creates a NEW worktree during the turn (record + create)…
    agentRunsCommand(
      "chatP2",
      `git worktree add -b feat/new ${join(p2Wt, "feat-new")}`,
    );
    await git(p2Repo, "worktree", "add", "-b", "feat/new", join(p2Wt, "feat-new"));
    bus.publish({ type: "chat-status", chatId: "chatP2", status: "idle" });
    await detector.drain();

    const reloaded = await store.getChat("chatP2");
    expect(reloaded!.worktrees).toHaveLength(1);
    const branches = worktreeUpdates()
      .filter((e) => e.chatId === "chatP2")
      .map((e) => e.worktree.branch);
    expect(branches).toEqual(["feat/new"]);
  });
});

describe("WorktreeDetector.refresh", () => {
  it("manually re-runs detection for a chat", async () => {
    await store.saveChat(mkChat());
    await detector.start();
    await agentCreatesWorktree("chatA", "feat/manual");

    const res = await detector.refresh("chatA");
    expect(res.attached).toHaveLength(1);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
  });

  it("refreshProject attributes newcomers project-wide (client Refresh button)", async () => {
    await store.saveChat(mkChat({ id: "chatA" }));
    await detector.start();
    bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
    await detector.drain();
    await agentCreatesWorktree("chatA", "feat/btn");

    const results = await detector.refreshProject("p1");
    expect(results.flatMap((r) => r.attached)).toHaveLength(1);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
  });
});

describe("WorktreeDetector attribution (bug: turn-complete steals others' worktrees)", () => {
  it("attributes a worktree to its CREATOR (B), not the chat whose turn completes first (A)", async () => {
    await store.saveChat(mkChat({ id: "chatA" }));
    await store.saveChat(mkChat({ id: "chatB" }));
    await detector.start();

    // Both sessions are live (bypass-style long turns).
    bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
    bus.publish({ type: "chat-status", chatId: "chatB", status: "running" });
    await detector.drain();

    // B is the one that actually creates the worktree.
    await agentCreatesWorktree("chatB", "feat/bbb");

    // A's turn completes FIRST → its detection pass must NOT grab feat/bbb.
    bus.publish({ type: "chat-status", chatId: "chatA", status: "idle" });
    await detector.drain();

    const a = await store.getChat("chatA");
    const b = await store.getChat("chatB");
    expect(a!.worktrees).toEqual([]);
    expect(b!.worktrees).toHaveLength(1);
    expect(b!.worktrees[0].replace(/\\/g, "/")).toContain("feat-bbb");
    const wu = worktreeUpdates().find((e) => e.worktree.branch === "feat/bbb");
    expect(wu!.chatId).toBe("chatB");
  });

  it("leaves a worktree UNATTACHED when no chat is known to have created it", async () => {
    await store.saveChat(mkChat({ id: "chatA" }));
    await detector.start();
    bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
    await detector.drain();

    // A worktree appears with NO recorded creating-command (e.g. made by a human).
    await agentAddsWorktree("feat/orphan");
    bus.publish({ type: "chat-status", chatId: "chatA", status: "idle" });
    await detector.drain();

    // Not dumped onto A — attribution declines rather than guess.
    const a = await store.getChat("chatA");
    expect(a!.worktrees).toEqual([]);
  });
});

describe("WorktreeDetector live-sync polling (bug: only fires on turn-complete)", () => {
  it("picks up a worktree mid-turn via a poll pass, before the turn completes", async () => {
    await store.saveChat(mkChat());
    await detector.start();

    // Turn starts → baseline seeded + poll loop begins.
    bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
    await detector.drain();
    expect(detector.isPolling()).toBe(true);

    // Agent creates a worktree DURING the still-running turn (records + on disk).
    await agentCreatesWorktree("chatA", "feat/mid");

    // A poll pass (what the interval fires) syncs it — no idle/done needed.
    const results = await detector.refreshProject("p1");
    expect(results.flatMap((r) => r.attached)).toHaveLength(1);
    const reloaded = await store.getChat("chatA");
    expect(reloaded!.worktrees).toHaveLength(1);
    expect(
      worktreeUpdates().some((e) => e.worktree.branch === "feat/mid"),
    ).toBe(true);

    // Turn ends → polling stops (don't spin forever).
    bus.publish({ type: "chat-status", chatId: "chatA", status: "idle" });
    await detector.drain();
    expect(detector.isPolling()).toBe(false);
  });

  it("the poll INTERVAL itself attaches a mid-turn worktree (no manual pass)", async () => {
    const fast = new WorktreeDetector({
      store,
      bus,
      worktrees,
      pollIntervalMs: 20,
    });
    try {
      await store.saveChat(mkChat());
      await fast.start();
      bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
      await fast.drain();
      await agentCreatesWorktree("chatA", "feat/tick");

      // Let the interval fire on its own and reconcile.
      const deadline = Date.now() + 3000;
      for (;;) {
        const c = await store.getChat("chatA");
        if ((c?.worktrees.length ?? 0) >= 1) break;
        if (Date.now() > deadline) throw new Error("poll interval never attached");
        await fast.drain();
        await new Promise((r) => setTimeout(r, 10));
      }
      const reloaded = await store.getChat("chatA");
      expect(reloaded!.worktrees).toHaveLength(1);
      expect(reloaded!.worktrees[0].replace(/\\/g, "/")).toContain("feat-tick");
    } finally {
      fast.stop();
      await fast.drain();
    }
  });

  it("does not poll when no chat is active", async () => {
    await detector.start();
    expect(detector.isPolling()).toBe(false);
  });
});

describe("WorktreeDetector history-based heal (bug: persisted mis-attribution)", () => {
  it("rebuilds attribution from each chat's transcript + DROPS a pre-seeded wrong one", async () => {
    // Two worktrees on disk, each CREATED by a distinct chat (recorded in history).
    const pA = await agentAddsWorktree("feat/aaa");
    const pB = await agentAddsWorktree("feat/bbb");
    await persistWorktreeCommand("chatA", "feat/aaa", 1000);
    await persistWorktreeCommand("chatB", "feat/bbb", 2000);

    // Persisted BAD state an older build left: chatA WRONGLY owns feat/bbb; chatB
    // (the real creator) owns nothing.
    await store.saveChat(mkChat({ id: "chatA", worktrees: [pB] }));
    await store.saveChat(mkChat({ id: "chatB", worktrees: [] }));

    // A FRESH detector (empty in-memory maps) = a server restart. Its startup heal
    // must reconstruct ownership from the transcripts and rewrite chat.json.
    const fresh = new WorktreeDetector({ store, bus, worktrees });
    try {
      await fresh.start();
      await fresh.drain();
    } finally {
      fresh.stop();
    }

    const a = await store.getChat("chatA");
    const b = await store.getChat("chatB");
    const norm = (p: string) => p.replace(/\\/g, "/");

    // chatA: the wrong feat/bbb is gone, its real feat/aaa is in.
    expect(a!.worktrees).toHaveLength(1);
    expect(norm(a!.worktrees[0])).toContain("feat-aaa");
    expect(a!.worktrees.some((p) => norm(p).includes("feat-bbb"))).toBe(false);
    // chatB: gains the worktree it actually created.
    expect(b!.worktrees).toHaveLength(1);
    expect(norm(b!.worktrees[0])).toContain("feat-bbb");

    // The corrected records fanned out, and feat/aaa's worktree-update is tagged
    // to its true owner (chatA) — not whoever the bad data pointed at.
    expect(chatUpdates().some((e) => e.chat.id === "chatA")).toBe(true);
    expect(chatUpdates().some((e) => e.chat.id === "chatB")).toBe(true);
    const wuA = worktreeUpdates().find((e) => e.worktree.branch === "feat/aaa");
    expect(wuA?.chatId).toBe("chatA");
    const wuB = worktreeUpdates().find((e) => e.worktree.branch === "feat/bbb");
    expect(wuB?.chatId).toBe("chatB");

    expect(pA).toBeTruthy();
  });

  it("leaves a worktree no chat's history claims UNATTACHED after a heal", async () => {
    // feat/ownerless exists on disk but no chat's transcript created it.
    await agentAddsWorktree("feat/ownerless");
    await persistWorktreeCommand("chatA", "feat/mine", 1000);
    const pMine = await agentAddsWorktree("feat/mine");
    await store.saveChat(mkChat({ id: "chatA", worktrees: [] }));

    const fresh = new WorktreeDetector({ store, bus, worktrees });
    try {
      await fresh.start();
      await fresh.drain();
    } finally {
      fresh.stop();
    }

    const a = await store.getChat("chatA");
    // chatA gets only its own; the ownerless worktree is on nobody.
    expect(a!.worktrees).toHaveLength(1);
    expect(a!.worktrees[0].replace(/\\/g, "/")).toContain("feat-mine");
    expect(pMine).toBeTruthy();
  });
});
