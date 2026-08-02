/**
 * Integration tests for `/api/git/*` — a real Fastify app over a real temporary
 * git repo, with only the AI commit-message query scripted. This is the seam
 * where the guards live (bad repoPath, crafted rev, destructive discard), so it
 * exercises the HTTP contract rather than the service internals (see
 * services/git.test.ts for those).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { GitService } from "../services/git.js";
import {
  CommitMessageService,
  makeFakeCommitQuery,
  sanitizeMessage,
  commitPrompt,
} from "../services/commit-message.js";

let dataDir: string;
let repo: string;
let app: FastifyInstance;

/** Skip the suite when `git` isn't on PATH. */
async function hasGit(): Promise<boolean> {
  try {
    await execa("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
let available = true;

beforeEach(async () => {
  available = await hasGit();
  if (!available) return;
  dataDir = await mkdtemp(join(tmpdir(), "cm-git-routes-"));
  repo = await mkdtemp(join(tmpdir(), "cm-git-repo-"));
  const run = (args: string[]) => execa("git", args, { cwd: repo });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test User"]);
  await run(["config", "commit.gpgsign", "false"]);
  await run(["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "a.txt"), "one\n");
  await run(["add", "."]);
  await run(["commit", "-q", "-m", "initial commit"]);

  const store = new Store(dataDir);
  await store.init();
  const bus = new EventBus();
  const git = new GitService();
  const commitMessage = new CommitMessageService({
    git,
    query: makeFakeCommitQuery(),
  });
  app = await buildApp({
    config: { ...loadConfig(), dataDir },
    store,
    bus,
    serviceOverrides: { git, commitMessage },
  });
});

afterEach(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
});

/** JSON bodies these routes accept. Typed (not `unknown`) so Fastify's
 *  `inject` overloads resolve to the response-returning one. */
type Body = Record<string, unknown>;

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, payload: Body) =>
  app.inject({ method: "POST", url, payload });
const del = (url: string, payload: Body) =>
  app.inject({ method: "DELETE", url, payload });

const q = (path: string, params: Record<string, string>) =>
  `${path}?${new URLSearchParams(params).toString()}`;

describe("GET /api/git/* — reading", () => {
  it("rejects a missing or non-repo path with 400", async () => {
    if (!available) return;
    expect((await get("/api/git/status")).statusCode).toBe(400);
    const notRepo = await get(q("/api/git/status", { repoPath: dataDir }));
    expect(notRepo.statusCode).toBe(400);
    expect(notRepo.json().error).toMatch(/not a git repository/);
  });

  it("returns a clean status, then the staged/unstaged/untracked split", async () => {
    if (!available) return;
    let res = await get(q("/api/git/status", { repoPath: repo }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ branch: "main", ahead: 0, behind: 0 });
    expect(res.json().staged).toEqual([]);

    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await writeFile(join(repo, "b.txt"), "new\n");

    res = await get(q("/api/git/status", { repoPath: repo }));
    expect(res.json().unstaged.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
    expect(res.json().untracked.map((f: { path: string }) => f.path)).toEqual(["b.txt"]);
  });

  it("lists branches and history", async () => {
    if (!available) return;
    const branches = await get(q("/api/git/branches", { repoPath: repo }));
    expect(branches.json()).toEqual([
      expect.objectContaining({ name: "main", isCurrent: true, isRemote: false }),
    ]);

    const log = await get(q("/api/git/log", { repoPath: repo, limit: "5" }));
    expect(log.json()).toHaveLength(1);
    expect(log.json()[0]).toMatchObject({ subject: "initial commit", author: "Test User" });
  });

  it("serves a file at each snapshot and 400s a crafted rev", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "working\n");
    await post("/api/git/stage", { repoPath: repo, paths: ["a.txt"] });
    await writeFile(join(repo, "a.txt"), "newer\n");

    const worktree = await get(
      q("/api/git/file", { repoPath: repo, relPath: "a.txt", rev: "WORKTREE" }),
    );
    expect(worktree.json().content).toBe("newer\n");
    const index = await get(
      q("/api/git/file", { repoPath: repo, relPath: "a.txt", rev: "INDEX" }),
    );
    expect(index.json().content).toBe("working\n");
    const head = await get(
      q("/api/git/file", { repoPath: repo, relPath: "a.txt", rev: "HEAD" }),
    );
    expect(head.json().content).toBe("one\n");

    // `--output=<path>` would make git write an arbitrary file; the rev guard
    // must reject it as a client error before git is ever spawned.
    const crafted = await get(
      q("/api/git/file", {
        repoPath: repo,
        relPath: "a.txt",
        rev: "--output=/tmp/pwn",
      }),
    );
    expect(crafted.statusCode).toBe(400);
    expect(crafted.json().error).toMatch(/invalid rev/);
  });

  it("400s a path that tries to escape the repo", async () => {
    if (!available) return;
    const res = await get(
      q("/api/git/file", { repoPath: repo, relPath: "../../etc/passwd" }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/git/* — staging and committing", () => {
  it("stages, unstages and returns the fresh status each time", async () => {
    if (!available) return;
    await writeFile(join(repo, "b.txt"), "new\n");

    const staged = await post("/api/git/stage", { repoPath: repo, paths: ["b.txt"] });
    expect(staged.statusCode).toBe(200);
    expect(staged.json().staged.map((f: { path: string }) => f.path)).toEqual(["b.txt"]);
    expect(staged.json().untracked).toEqual([]);

    const unstaged = await post("/api/git/unstage", { repoPath: repo, paths: ["b.txt"] });
    expect(unstaged.json().staged).toEqual([]);
    expect(unstaged.json().untracked.map((f: { path: string }) => f.path)).toEqual(["b.txt"]);
  });

  it("stages everything with `all`", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "edited\n");
    await writeFile(join(repo, "b.txt"), "new\n");
    const res = await post("/api/git/stage", { repoPath: repo, all: true });
    expect(res.json().staged.map((f: { path: string }) => f.path).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("commits the index and reports the new commit + clean status", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "committed\n");
    await post("/api/git/stage", { repoPath: repo, paths: ["a.txt"] });

    const res = await post("/api/git/commit", {
      repoPath: repo,
      message: "feat: commit through the API",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().commit).toMatchObject({ subject: "feat: commit through the API" });
    expect(res.json().status.staged).toEqual([]);
  });

  it("400s an empty commit message and 502s a commit with nothing staged", async () => {
    if (!available) return;
    const empty = await post("/api/git/commit", { repoPath: repo, message: "  " });
    expect(empty.statusCode).toBe(400);

    const nothing = await post("/api/git/commit", { repoPath: repo, message: "nope" });
    expect(nothing.statusCode).toBe(502);
    expect(nothing.json().error).toMatch(/nothing to commit/i);
  });

  it("discards working-tree edits and deletes untracked files", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "dirty\n");
    await writeFile(join(repo, "junk.txt"), "junk\n");

    const res = await post("/api/git/discard", {
      repoPath: repo,
      paths: ["a.txt", "junk.txt"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unstaged).toEqual([]);
    expect(res.json().untracked).toEqual([]);
    const file = await get(q("/api/git/file", { repoPath: repo, relPath: "a.txt" }));
    expect(file.json().content).toBe("one\n");
  });
});

describe("POST /api/git/commit-message — AI draft", () => {
  it("drafts from the staged diff", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "changed\n");
    await post("/api/git/stage", { repoPath: repo, paths: ["a.txt"] });

    const res = await post("/api/git/commit-message", { repoPath: repo });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("chore: update a.txt");
  });

  it("502s with a readable reason when nothing is staged", async () => {
    if (!available) return;
    const res = await post("/api/git/commit-message", { repoPath: repo });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/nothing staged/);
  });
});

describe("branches and stashes over HTTP", () => {
  it("creates, switches and deletes a branch", async () => {
    if (!available) return;
    const created = await post("/api/git/checkout", {
      repoPath: repo,
      branch: "feat/x",
      create: true,
    });
    expect(created.json().branch).toBe("feat/x");

    const back = await post("/api/git/checkout", { repoPath: repo, branch: "main" });
    expect(back.json().branch).toBe("main");

    const deleted = await del("/api/git/branch", {
      repoPath: repo,
      branch: "feat/x",
      force: true,
    });
    expect(deleted.json().map((b: { name: string }) => b.name)).toEqual(["main"]);
  });

  it("surfaces git's own refusal as a 502 the user can act on", async () => {
    if (!available) return;
    const res = await post("/api/git/checkout", { repoPath: repo, branch: "no-such-branch" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/no-such-branch/);
  });

  it("400s a crafted branch name before running git", async () => {
    if (!available) return;
    const res = await post("/api/git/checkout", { repoPath: repo, branch: "--orphan" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid rev/);
  });

  it("stashes, lists, pops and drops", async () => {
    if (!available) return;
    await writeFile(join(repo, "a.txt"), "stash me\n");

    const pushed = await post("/api/git/stash", { repoPath: repo, message: "wip" });
    expect(pushed.json().stashes).toHaveLength(1);
    expect(pushed.json().status.unstaged).toEqual([]);

    const listed = await get(q("/api/git/stashes", { repoPath: repo }));
    expect(listed.json()[0]).toMatchObject({ index: 0, ref: "stash@{0}", message: "wip" });

    // A stash is a commit, so the SAME endpoint that lists a commit's files
    // lists a stash's — that's what lets the UI preview one before restoring.
    const files = await get(q("/api/git/commit-files", { repoPath: repo, rev: "stash@{0}" }));
    expect(files.json().map((f: { path: string }) => f.path)).toEqual(["a.txt"]);

    const popped = await post("/api/git/stash/apply", { repoPath: repo, index: 0, pop: true });
    expect(popped.json().stashes).toEqual([]);
    expect(popped.json().status.unstaged.map((f: { path: string }) => f.path)).toEqual([
      "a.txt",
    ]);
  });

  it("400s a stash call with no index", async () => {
    if (!available) return;
    const res = await post("/api/git/stash/apply", { repoPath: repo });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/git/sync", () => {
  it("400s an unknown op", async () => {
    if (!available) return;
    const res = await post("/api/git/sync", { repoPath: repo, op: "nuke" });
    expect(res.statusCode).toBe(400);
  });

  it("502s a push with no remote instead of hanging on a credential prompt", async () => {
    if (!available) return;
    const res = await post("/api/git/sync", { repoPath: repo, op: "push" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/origin/);
  });
});

/* ------------------------------------------------- commit-message helpers */

describe("sanitizeMessage", () => {
  it("unwraps a fenced block", () => {
    expect(sanitizeMessage("```\nfeat: a thing\n```")).toBe("feat: a thing");
    expect(sanitizeMessage("```text\nfix: b\n\nbody\n```")).toBe("fix: b\n\nbody");
  });
  it("drops narration and surrounding quotes", () => {
    expect(sanitizeMessage("Here's a commit message:\nfeat: x")).toBe("feat: x");
    expect(sanitizeMessage('"feat: quoted"')).toBe("feat: quoted");
  });
  it("keeps a multi-line body but collapses blank-line runs", () => {
    expect(sanitizeMessage("feat: x\n\n\n\n- why")).toBe("feat: x\n\n- why");
  });
  it("returns empty for empty input", () => {
    expect(sanitizeMessage("   ")).toBe("");
  });
});

describe("commitPrompt", () => {
  it("includes the diff, recent style examples and an optional hint", () => {
    const prompt = commitPrompt("diff --git a/x b/x", ["feat: prior", "fix: older"], "be terse");
    expect(prompt).toContain("diff --git a/x b/x");
    expect(prompt).toContain("- feat: prior");
    expect(prompt).toContain("be terse");
  });
  it("omits the examples section when there are no commits", () => {
    expect(commitPrompt("diff", [])).not.toContain("Recent commit subjects");
  });
});
