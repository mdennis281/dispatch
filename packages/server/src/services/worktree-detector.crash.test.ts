/**
 * Regression: two projects' chats active at once must not kill the server.
 *
 * The live crash (2026-08-07, twice) looked like "Dispatch dies the second you
 * have chats from two different projects running". The mechanism was here:
 *
 *   onPollTick()  →  void enqueue(() => pollActiveProjects()).finally(…)
 *   pollActiveProjects()  →  for (const projectId of projectIds)
 *                              await this.reconcileProject(project)   // no catch
 *
 * `pollActiveProjects` is the only loop in the server whose iteration count is
 * the number of DISTINCT projects with an active chat, and it was the only
 * `reconcileProject` call site without a `.catch` (`healAll` has one). So one
 * project failing to reconcile rejected the WHOLE pass — and because `.finally()`
 * returns a fresh promise that nothing was handling, that rejection was an
 * unhandled one, which Node treats as fatal.
 *
 * Both halves are asserted below: the healthy project must still reconcile
 * (isolation), and no unhandled rejection may escape (survival).
 */
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

let root: string;
let dataDir: string;
let bus: EventBus;
let store: Store;
let worktrees: WorktreeService;
let detector: WorktreeDetector;

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

/** A real git checkout + its worktree root, so `git worktree list` is truthful. */
async function makeRepo(name: string): Promise<{ repo: string; wtRoot: string }> {
  const repo = join(root, name);
  const wtRoot = join(root, `${name}-worktrees`);
  await mkdir(repo, { recursive: true });
  await mkdir(wtRoot, { recursive: true });
  await execa("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo });
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "keep.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  return { repo, wtRoot };
}

/** Publish the Bash `tool_use` row that tells the detector who created a branch. */
function agentCreates(chatId: string, command: string, n: number): void {
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
  } as WsServerEvent);
}

function mkProject(over: Partial<Project> & Pick<Project, "id">): Project {
  return {
    name: over.id,
    repoPath: "",
    worktreeRoot: "",
    subApps: [],
    createdAt: Date.now(),
    ...over,
  } as Project;
}

function mkChat(over: Partial<Chat> & Pick<Chat, "id" | "projectId">): Chat {
  return {
    title: "T",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: Date.now(),
    ...over,
  } as Chat;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-wtd-crash-"));
  dataDir = join(root, "data");
  bus = new EventBus();
  store = new Store(dataDir);
  await store.init();
  worktrees = new WorktreeService({ bus, store });
});

afterEach(async () => {
  detector?.stop();
  // Windows holds handles on freshly-created worktrees briefly; a failed cleanup
  // of a temp dir must not fail the test that just passed.
  store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

describe("WorktreeDetector — two projects active at once", () => {
  it("isolates a failing project's reconcile and raises no unhandled rejection", async () => {
    // Two real repos = two projects, each with one chat that owns a worktree.
    const a = await makeRepo("repoA");
    const b = await makeRepo("repoB");
    await store.saveProject(
      mkProject({ id: "pA", repoPath: a.repo, worktreeRoot: a.wtRoot }),
    );
    await store.saveProject(
      mkProject({ id: "pB", repoPath: b.repo, worktreeRoot: b.wtRoot }),
    );
    await store.saveChat(mkChat({ id: "chatA", projectId: "pA" }));
    await store.saveChat(mkChat({ id: "chatB", projectId: "pB" }));

    // Poll fast so the test doesn't wait out the 4s production interval.
    detector = new WorktreeDetector({ store, bus, worktrees, pollIntervalMs: 5 });
    await detector.start();

    // Each chat creates a worktree, so reconcile has an attachment to persist —
    // which is what makes it publish `chat-update` (the unguarded line).
    const wtA = join(a.wtRoot, "feat-a");
    const wtB = join(b.wtRoot, "feat-b");
    // The `tool_use` row is the signal the detector attributes ownership from,
    // so publish it exactly as a live agent's Bash call would.
    agentCreates("chatA", `git worktree add -b feat/a ${wtA}`, 1);
    agentCreates("chatB", `git worktree add -b feat/b ${wtB}`, 2);
    await git(a.repo, "worktree", "add", "-b", "feat/a", wtA);
    await git(b.repo, "worktree", "add", "-b", "feat/b", wtB);

    // A throwing bus subscriber is the realistic production trigger: any listener
    // bug turns `bus.publish` — which is synchronous — into a throw that unwinds
    // straight out of reconcileProject. Scoped to chatB so pA stays healthy.
    bus.subscribe((e: WsServerEvent) => {
      if (e.type === "chat-update" && e.chat.id === "chatB") {
        throw new Error("subscriber blew up on chatB");
      }
    });

    // Record anything Node would have killed the process for.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // Mark chatB active FIRST so it is reconciled FIRST: the failing project
      // must not be able to prevent the healthy one behind it from being handled.
      bus.publish({ type: "chat-status", chatId: "chatB", status: "running" });
      bus.publish({ type: "chat-status", chatId: "chatA", status: "running" });
      expect(detector.isPolling()).toBe(true);

      // Let several poll ticks land.
      await new Promise((r) => setTimeout(r, 120));
      await detector.drain();
      // Give the microtask queue a turn to surface any pending rejection.
      await new Promise((r) => setTimeout(r, 20));

      // Survival: nothing escaped as an unhandled rejection.
      expect(unhandled).toEqual([]);

      // Isolation: the healthy project was reconciled even though the project
      // polled before it threw. Without the per-project catch, the loop aborted
      // at chatB and chatA's worktree was never attached.
      const reloadedA = await store.getChat("chatA");
      expect(reloadedA!.worktrees).toHaveLength(1);
      expect(reloadedA!.worktrees[0].replace(/\\/g, "/")).toContain("feat-a");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
