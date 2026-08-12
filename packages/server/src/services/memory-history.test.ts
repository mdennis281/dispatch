import { describe, it, expect, beforeEach } from "vitest";
import { MemoryHistoryService, parseMemoryLog } from "./memory-history.js";
import type { ExecFn, ExecResult } from "./memory-committer.js";
import type { Store } from "../store/index.js";

const RS = "\x1e";
const FS = "\x1f";

// Absolute-path fixtures must be rooted per platform: POSIX doesn't treat a
// drive letter as absolute, so a literal "C:/repo" resolves RELATIVE on Linux
// and the in-repo check silently inverts. See the CI gate note in the memory
// tests for the same trap.
const REPO = process.platform === "win32" ? "C:/repo" : "/repo";
const MEMORY_DIR = `${REPO}/.dispatch/memory`;

/** Store stub — history only reads the project's repoPath. */
function fakeStore(repoPath: string | null): Store {
  return {
    getProject: async (id: string) =>
      repoPath ? ({ id, repoPath, name: id, defaultBranch: "main" } as never) : null,
  } as unknown as Store;
}

/** Records the git invocation so a test can assert on the args, not just output. */
function fakeExec(result: Partial<ExecResult>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: 0, ...result };
  };
  return { exec, calls };
}

const CONFIG = { getConfig: () => ({ memoryDir: MEMORY_DIR }) };

describe("parseMemoryLog", () => {
  it("parses commits with their name-status files", () => {
    const stdout =
      `${RS}abc1234${FS}2026-08-01T10:00:00Z${FS}Michael${FS}chore(memory): update two memories\n` +
      "M\t.dispatch/memory/deploy-runbook.md\n" +
      "A\t.dispatch/memory/ci-runner.md\n" +
      "M\t.dispatch/memory/MEMORY.md\n" +
      `${RS}def5678${FS}2026-07-02T09:00:00Z${FS}Michael${FS}chore(memory): update ci-runner\n` +
      "D\t.dispatch/memory/old-fact.md\n";

    const commits = parseMemoryLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: "abc1234",
      date: "2026-08-01T10:00:00Z",
      author: "Michael",
      subject: "chore(memory): update two memories",
    });
    expect(commits[0]!.files).toEqual([
      { name: "deploy-runbook", kind: "modified" },
      { name: "ci-runner", kind: "added" },
      { name: "MEMORY", kind: "modified" },
    ]);
    // A deletion is the record of a fact deliberately retired — the single most
    // useful thing here, and the reason status is parsed at all.
    expect(commits[1]!.files).toEqual([{ name: "old-fact", kind: "deleted" }]);
  });

  it("parses a rename's two-path status line", () => {
    const stdout =
      `${RS}aaa${FS}2026-08-01T10:00:00Z${FS}M${FS}rename\n` +
      "R096\t.dispatch/memory/old-name.md\t.dispatch/memory/new-name.md\n";
    expect(parseMemoryLog(stdout)[0]!.files).toEqual([
      { name: "new-name", kind: "renamed", from: "old-name" },
    ]);
  });

  it("handles a commit with no file list and ignores empty records", () => {
    const stdout = `${RS}aaa${FS}2026-08-01T10:00:00Z${FS}M${FS}subject only`;
    const commits = parseMemoryLog(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.files).toEqual([]);
    expect(parseMemoryLog("")).toEqual([]);
    expect(parseMemoryLog(`${RS}   `)).toEqual([]);
  });
});

describe("MemoryHistoryService", () => {
  let calls: string[][];

  beforeEach(() => {
    calls = [];
  });

  it("reads the whole memory dir, repo-relative", async () => {
    const stdout = `${RS}abc${FS}2026-08-01T10:00:00Z${FS}M${FS}chore(memory): update x\nM\t.dispatch/memory/x.md\n`;
    const fake = fakeExec({ stdout });
    calls = fake.calls;
    const svc = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: CONFIG,
      exec: fake.exec,
    });

    const res = await svc.forProject("p1", { limit: 5 });
    expect(res.available).toBe(true);
    expect(res.commits).toHaveLength(1);
    expect(calls[0]).toContain("-n5");
    expect(calls[0]!.at(-1)).toBe(".dispatch/memory");
    // No --follow for a dir query; git refuses it with a non-single pathspec.
    expect(calls[0]).not.toContain("--follow");
  });

  it("follows renames for a single memory, and slugifies the name", async () => {
    const fake = fakeExec({ stdout: `${RS}abc${FS}2026-08-01T10:00:00Z${FS}M${FS}s\n` });
    calls = fake.calls;
    const svc = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: CONFIG,
      exec: fake.exec,
    });

    await svc.forProject("p1", { name: "Deploy Runbook" });
    expect(calls[0]).toContain("--follow");
    expect(calls[0]!.at(-1)).toBe(".dispatch/memory/deploy-runbook.md");
  });

  it("is unavailable — with a reason — when the project's memory isn't in the repo", async () => {
    const fake = fakeExec({});
    const noConfig = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: { getConfig: () => null },
      exec: fake.exec,
    });
    const res = await noConfig.forProject("p1");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/runtime store/);
    // It must not have shelled out at all.
    expect(fake.calls).toHaveLength(0);

    const outside = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: { getConfig: () => ({ memoryDir: `${REPO}/../elsewhere/memory` }) },
      exec: fake.exec,
    });
    expect((await outside.forProject("p1")).reason).toMatch(/outside the repo/);
  });

  it("is unavailable for an unknown project or a failing git", async () => {
    const fake = fakeExec({});
    const noProject = new MemoryHistoryService({
      store: fakeStore(null),
      projectConfig: CONFIG,
      exec: fake.exec,
    });
    expect(await noProject.forProject("nope")).toMatchObject({
      available: false,
      reason: "no such project",
    });

    const failing = fakeExec({ exitCode: 128, stderr: "not a git repository" });
    const svc = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: CONFIG,
      exec: failing.exec,
    });
    const res = await svc.forProject("p1");
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/not a git repository/);
  });

  it("treats an empty log as an ANSWER, not a failure", async () => {
    // A profile that doesn't commit memory leaves the dir untracked. That's a
    // real, explainable state — reporting it as unavailable would send an agent
    // hunting for a git problem that doesn't exist.
    const fake = fakeExec({ stdout: "" });
    const svc = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: CONFIG,
      exec: fake.exec,
    });
    const res = await svc.forProject("p1");
    expect(res.available).toBe(true);
    expect(res.commits).toEqual([]);
    expect(res.reason).toMatch(/no commits/);
  });

  it("rejects a name that slugifies to nothing", async () => {
    const fake = fakeExec({});
    const svc = new MemoryHistoryService({
      store: fakeStore(REPO),
      projectConfig: CONFIG,
      exec: fake.exec,
    });
    expect((await svc.forProject("p1", { name: "!!!" })).reason).toMatch(/invalid memory name/);
    expect(fake.calls).toHaveLength(0);
  });
});
