import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  GitService,
  assertRev,
  normalizePaths,
  parseBranchRefs,
  parseLog,
  parseNameStatus,
  parsePorcelainV2,
  parseStashList,
  parseTrack,
  stashRef,
  statusFromCode,
  type GitExecFn,
} from "./git.js";

const US = "\x1f";
const RS = "\x1e";

/* ------------------------------------------------------------ pure parsers */

describe("parsePorcelainV2", () => {
  it("reads the branch header (name, oid, upstream, ahead/behind)", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/thing",
      "# branch.upstream origin/feat/thing",
      "# branch.ab +3 -2",
      "",
    ].join("\0");
    const s = parsePorcelainV2(out);
    expect(s).toMatchObject({
      head: "abc123",
      branch: "feat/thing",
      upstream: "origin/feat/thing",
      ahead: 3,
      behind: 2,
      detached: false,
    });
  });

  it("flags a detached HEAD and leaves the branch unset", () => {
    const out = ["# branch.oid abc123", "# branch.head (detached)", ""].join("\0");
    const s = parsePorcelainV2(out);
    expect(s.detached).toBe(true);
    expect(s.branch).toBeUndefined();
  });

  it("treats an initial (unborn) commit as no HEAD", () => {
    const out = ["# branch.oid (initial)", "# branch.head main", ""].join("\0");
    expect(parsePorcelainV2(out).head).toBeUndefined();
  });

  it("splits a both-modified path into a staged AND an unstaged entry", () => {
    // `MM` = modified in the index and modified again in the working tree.
    const out = ["1 MM N... 100644 100644 100644 aaa bbb src/a.ts", ""].join("\0");
    const s = parsePorcelainV2(out);
    expect(s.staged).toEqual([
      { path: "src/a.ts", oldPath: undefined, status: "modified", staged: true, code: "MM" },
    ]);
    expect(s.unstaged).toEqual([
      { path: "src/a.ts", status: "modified", staged: false, code: "MM" },
    ]);
  });

  it("keeps a staged-only change out of the unstaged list", () => {
    const out = ["1 A. N... 000000 100644 100644 000 bbb src/new.ts", ""].join("\0");
    const s = parsePorcelainV2(out);
    expect(s.staged).toHaveLength(1);
    expect(s.staged[0]).toMatchObject({ status: "added", staged: true });
    expect(s.unstaged).toHaveLength(0);
  });

  it("reads a rename's original path from the following NUL field", () => {
    const out = [
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
      "src/old.ts",
      "1 .M N... 100644 100644 100644 ccc ddd src/other.ts",
      "",
    ].join("\0");
    const s = parsePorcelainV2(out);
    expect(s.staged).toEqual([
      {
        path: "src/new.ts",
        oldPath: "src/old.ts",
        status: "renamed",
        staged: true,
        code: "R.",
      },
    ]);
    // The record AFTER the rename must still parse — i.e. the origPath field
    // was consumed, not mistaken for a status record.
    expect(s.unstaged).toEqual([
      { path: "src/other.ts", status: "modified", staged: false, code: ".M" },
    ]);
  });

  it("handles paths containing spaces", () => {
    const out = ["1 .M N... 100644 100644 100644 aaa bbb my dir/a b.ts", ""].join("\0");
    expect(parsePorcelainV2(out).unstaged[0]?.path).toBe("my dir/a b.ts");
  });

  it("collects untracked, skips ignored, and collects unmerged", () => {
    const out = [
      "? new.txt",
      "! ignored.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
      "",
    ].join("\0");
    const s = parsePorcelainV2(out);
    expect(s.untracked).toEqual([
      { path: "new.txt", status: "untracked", staged: false, code: "??" },
    ]);
    expect(s.conflicted).toEqual([
      { path: "conflict.ts", status: "conflicted", staged: false, code: "UU" },
    ]);
    // Ignored entries are never surfaced.
    expect(JSON.stringify(s)).not.toContain("ignored.txt");
  });

  it("defaults ahead/behind to 0 with no upstream", () => {
    const s = parsePorcelainV2(["# branch.head main", ""].join("\0"));
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.upstream).toBeUndefined();
  });
});

describe("parseBranchRefs", () => {
  const row = (fields: string[]) => fields.join(US);

  it("distinguishes local from remote by the FULL refname", () => {
    // The short name of a remote ref (`origin/main`) is shape-identical to a
    // local branch literally named `origin/main` — only the full ref settles it.
    const out = [
      row([
        "refs/heads/origin/main",
        "origin/main",
        " ",
        "",
        "",
        "1700000000",
        "local subject",
        "aaa1111",
        "",
      ]),
      row([
        "refs/remotes/origin/main",
        "origin/main",
        " ",
        "",
        "",
        "1700000001",
        "remote subject",
        "bbb2222",
        "",
      ]),
    ].join("\n");
    const branches = parseBranchRefs(out);
    expect(branches).toHaveLength(2);
    expect(branches.find((b) => b.subject === "local subject")?.isRemote).toBe(false);
    expect(branches.find((b) => b.subject === "remote subject")?.isRemote).toBe(true);
  });

  it("marks the current branch, parses track counts, ms dates and worktree path", () => {
    const out = row([
      "refs/heads/main",
      "main",
      "*",
      "origin/main",
      "[ahead 2, behind 1]",
      "1700000000",
      "subject here",
      "abc1234",
      "C:/repo-worktrees/main",
    ]);
    const [b] = parseBranchRefs(out);
    expect(b).toMatchObject({
      name: "main",
      isCurrent: true,
      isRemote: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      lastCommitAt: 1_700_000_000_000,
      subject: "subject here",
      head: "abc1234",
      worktreePath: "C:/repo-worktrees/main",
    });
  });

  it("drops the origin/HEAD symref alias", () => {
    const out = row([
      "refs/remotes/origin/HEAD",
      "origin/HEAD",
      " ",
      "",
      "",
      "1700000000",
      "s",
      "aaa",
      "",
    ]);
    expect(parseBranchRefs(out)).toHaveLength(0);
  });

  it("sorts current first, then locals, then by recency", () => {
    const rows = [
      row(["refs/remotes/origin/x", "origin/x", " ", "", "", "1700000900", "s", "a", ""]),
      row(["refs/heads/old", "old", " ", "", "", "1700000100", "s", "b", ""]),
      row(["refs/heads/new", "new", " ", "", "", "1700000500", "s", "c", ""]),
      row(["refs/heads/main", "main", "*", "", "", "1700000200", "s", "d", ""]),
    ].join("\n");
    expect(parseBranchRefs(rows).map((b) => b.name)).toEqual([
      "main",
      "new",
      "old",
      "origin/x",
    ]);
  });
});

describe("parseTrack", () => {
  it("parses both counts, one-sided counts, and non-counts", () => {
    expect(parseTrack("[ahead 2, behind 1]")).toEqual({ ahead: 2, behind: 1 });
    expect(parseTrack("[ahead 3]")).toEqual({ ahead: 3, behind: 0 });
    expect(parseTrack("[behind 4]")).toEqual({ ahead: 0, behind: 4 });
    expect(parseTrack("[gone]")).toEqual({});
    expect(parseTrack("")).toEqual({});
  });
});

describe("parseLog", () => {
  it("parses records, converts unix seconds to ms, and splits decorations", () => {
    const out = [
      `${RS}abc123${US}abc12${US}feat: a thing${US}body line 1\nbody line 2${US}Ada${US}ada@example.com${US}1700000000${US}HEAD -> main, origin/main`,
      `${RS}def456${US}def45${US}fix: another${US}${US}Bob${US}bob@example.com${US}1699999000${US}`,
    ].join("");
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: "abc123",
      shortHash: "abc12",
      subject: "feat: a thing",
      body: "body line 1\nbody line 2",
      author: "Ada",
      authorEmail: "ada@example.com",
      at: 1_700_000_000_000,
      refs: ["HEAD -> main", "origin/main"],
    });
    expect(commits[1]?.body).toBeUndefined();
    expect(commits[1]?.refs).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseStashList", () => {
  it("parses the WIP form and keeps the branch", () => {
    const out = `${RS}stash@{0}${US}1700000000${US}WIP on main: 1a2b3c earlier subject`;
    expect(parseStashList(out)).toEqual([
      {
        index: 0,
        ref: "stash@{0}",
        message: "1a2b3c earlier subject",
        branch: "main",
        at: 1_700_000_000_000,
      },
    ]);
  });

  it("parses an explicit `git stash push -m` message", () => {
    const out = `${RS}stash@{1}${US}1700000000${US}On feat/x: my message`;
    expect(parseStashList(out)[0]).toMatchObject({
      index: 1,
      message: "my message",
      branch: "feat/x",
    });
  });

  it("skips rows whose ref isn't a stash selector", () => {
    expect(parseStashList(`${RS}garbage${US}1700000000${US}whatever`)).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("maps codes, taking the CURRENT path for a rename row", () => {
    const out = ["M\tsrc/a.ts", "A\tsrc/b.ts", "R100\tsrc/old.ts\tsrc/new.ts", "D\tgone.ts"].join(
      "\n",
    );
    const map = parseNameStatus(out);
    expect(map.get("src/a.ts")).toBe("modified");
    expect(map.get("src/b.ts")).toBe("added");
    expect(map.get("src/new.ts")).toBe("renamed");
    expect(map.get("gone.ts")).toBe("deleted");
  });
});

describe("statusFromCode", () => {
  it("maps every porcelain letter, falling back to unknown", () => {
    expect(statusFromCode("M")).toBe("modified");
    expect(statusFromCode("A")).toBe("added");
    expect(statusFromCode("D")).toBe("deleted");
    expect(statusFromCode("R")).toBe("renamed");
    expect(statusFromCode("C")).toBe("copied");
    expect(statusFromCode("T")).toBe("type-changed");
    expect(statusFromCode("U")).toBe("conflicted");
    expect(statusFromCode("?")).toBe("untracked");
    expect(statusFromCode("Z")).toBe("unknown");
  });
});

/* ----------------------------------------------------------------- guards */

describe("assertRev", () => {
  it("accepts shas, branches, traversal suffixes and stash selectors", () => {
    for (const rev of ["HEAD", "abc1234", "feat/x", "HEAD~2", "abc^", "stash@{0}^1"]) {
      expect(assertRev(rev)).toBe(rev);
    }
  });

  it("rejects anything that could be read as a flag or shell metacharacter", () => {
    // `--output=<path>` turns `git diff` into an arbitrary-file-write primitive,
    // which is exactly what this guard exists to stop.
    for (const rev of ["--output=/tmp/pwn", "-x", "a b", "a;rm -rf /", "a|b", "$(x)", ""]) {
      expect(() => assertRev(rev)).toThrow(/invalid rev/);
    }
  });
});

describe("normalizePaths", () => {
  it("normalizes separators and strips leading slashes", () => {
    expect(normalizePaths(["src\\a.ts", "/src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
  });
  it("rejects traversal and an empty batch", () => {
    expect(() => normalizePaths(["../escape.ts"])).toThrow(/invalid path/);
    expect(() => normalizePaths([])).toThrow(/no paths given/);
  });
});

describe("stashRef", () => {
  it("builds a selector only from a non-negative integer", () => {
    expect(stashRef(0)).toBe("stash@{0}");
    expect(stashRef(12)).toBe("stash@{12}");
    expect(() => stashRef(-1)).toThrow(/invalid stash index/);
    expect(() => stashRef(1.5)).toThrow(/invalid stash index/);
  });
});

/* ------------------------------------------------- service (mocked exec) */

describe("GitService argument construction", () => {
  let calls: { args: string[]; cwd: string }[];
  let git: GitService;

  const exec: GitExecFn = async (_file, args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    // `hasHead` probe → pretend HEAD exists unless a test overrides.
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "status") {
      return { stdout: ["? untracked.txt", ""].join("\0"), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  beforeEach(() => {
    calls = [];
    git = new GitService({ exec });
  });

  it("stages paths after a `--` separator so they can't be read as flags", async () => {
    await git.stage("C:/repo", ["src/a.ts"]);
    expect(calls[0]?.args).toEqual(["add", "--all", "--", "src/a.ts"]);
  });

  it("unstages via reset when HEAD exists", async () => {
    await git.unstage("C:/repo", ["src/a.ts"]);
    expect(calls.at(-1)?.args).toEqual(["reset", "-q", "HEAD", "--", "src/a.ts"]);
  });

  it("unstages via `rm --cached` on an unborn branch (no HEAD)", async () => {
    const noHead: GitExecFn = async (_f, args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      if (args[0] === "rev-parse") return { stdout: "", stderr: "", exitCode: 128 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await new GitService({ exec: noHead }).unstage("C:/repo", ["src/a.ts"]);
    expect(calls.at(-1)?.args).toEqual(["rm", "--cached", "-q", "-r", "--", "src/a.ts"]);
  });

  it("discards by DELETING untracked files and restoring tracked ones", async () => {
    await git.discard("C:/repo", ["untracked.txt", "src/tracked.ts"]);
    const argv = calls.map((c) => c.args);
    expect(argv).toContainEqual(["clean", "-f", "-d", "-q", "--", "untracked.txt"]);
    expect(argv).toContainEqual(["checkout", "--", "src/tracked.ts"]);
  });

  it("refuses an empty commit message before touching git", async () => {
    await expect(git.commit("C:/repo", "   ")).rejects.toThrow(/message is empty/);
    expect(calls).toHaveLength(0);
  });

  it("forces ref (not pathspec) interpretation with a trailing `--`", async () => {
    // `git checkout` does NOT understand `--end-of-options` — it reads the
    // literal string as a pathspec — so the trailing `--` is the disambiguator.
    await git.checkout("C:/repo", "feat/x");
    expect(calls[0]?.args).toEqual(["checkout", "feat/x", "--"]);
  });

  it("creates a branch off an explicit base", async () => {
    await git.checkout("C:/repo", "feat/new", { create: true, from: "origin/main" });
    expect(calls[0]?.args).toEqual([
      "checkout",
      "-b",
      "feat/new",
      "origin/main",
      "--",
    ]);
  });

  it("rejects a crafted branch name before spawning git", async () => {
    await expect(git.checkout("C:/repo", "--orphan")).rejects.toThrow(/invalid rev/);
    expect(calls).toHaveLength(0);
  });

  it("pushes with --set-upstream only when asked", async () => {
    await git.sync("C:/repo", "push", { setUpstream: true, branch: "feat/x" });
    expect(calls[0]?.args).toEqual(["push", "--set-upstream", "origin", "feat/x"]);
    calls = [];
    await git.sync("C:/repo", "push");
    expect(calls[0]?.args).toEqual(["push", "origin"]);
  });

  it("reads the index side with the empty-rev object spec (`:path`)", async () => {
    await git.readFile("C:/repo", "src/a.ts", "INDEX");
    expect(calls[0]?.args).toEqual(["show", "--end-of-options", ":src/a.ts"]);
  });

  it("rejects a crafted rev before spawning git", async () => {
    await expect(
      git.readFile("C:/repo", "src/a.ts", "--output=/tmp/pwn"),
    ).rejects.toThrow(/invalid rev/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces git's own stderr when a command fails", async () => {
    const failing: GitExecFn = async () => ({
      stdout: "",
      stderr: "error: Your local changes would be overwritten",
      exitCode: 1,
    });
    await expect(
      new GitService({ exec: failing }).checkout("C:/repo", "main"),
    ).rejects.toThrow(/local changes would be overwritten/);
  });

  it("returns an empty history for a repo with no commits", async () => {
    const unborn: GitExecFn = async () => ({
      stdout: "",
      stderr: "fatal: your current branch 'main' does not have any commits yet",
      exitCode: 128,
    });
    await expect(new GitService({ exec: unborn }).log("C:/repo")).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------ real-git integration */

/** Skip the integration block when `git` isn't on PATH (CI images without it). */
async function hasGit(): Promise<boolean> {
  try {
    await execa("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("GitService against a real repo", () => {
  let dir: string;
  let git: GitService;
  let available = true;

  beforeEach(async () => {
    available = await hasGit();
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), "cm-git-"));
    const run = (args: string[]) => execa("git", args, { cwd: dir });
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test User"]);
    await run(["config", "commit.gpgsign", "false"]);
    // Pin line endings so content assertions hold on Windows, where a global
    // `core.autocrlf=true` would rewrite LF→CRLF on checkout.
    await run(["config", "core.autocrlf", "false"]);
    await writeFile(join(dir, "a.txt"), "one\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "initial commit"]);
    git = new GitService();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports a clean tree, then a staged + unstaged + untracked split", async () => {
    if (!available) return;
    let status = await git.status(dir);
    expect(status.branch).toBe("main");
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);

    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await writeFile(join(dir, "b.txt"), "new file\n");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "c.txt"), "nested\n");

    status = await git.status(dir);
    expect(status.unstaged.map((f) => f.path)).toEqual(["a.txt"]);
    // `--untracked-files=all` lists files inside new directories individually.
    expect(status.untracked.map((f) => f.path)).toEqual(["b.txt", "nested/c.txt"]);

    await git.stage(dir, ["a.txt", "b.txt"]);
    status = await git.status(dir);
    expect(status.staged.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(status.unstaged).toHaveLength(0);

    await git.unstage(dir, ["b.txt"]);
    status = await git.status(dir);
    expect(status.staged.map((f) => f.path)).toEqual(["a.txt"]);
    expect(status.untracked.map((f) => f.path)).toContain("b.txt");
  });

  it("commits the index and reports the new HEAD", async () => {
    if (!available) return;
    await writeFile(join(dir, "a.txt"), "changed\n");
    await git.stage(dir, ["a.txt"]);
    const commit = await git.commit(dir, "feat: change a");
    expect(commit.subject).toBe("feat: change a");
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.log(dir, { limit: 10 });
    expect(log.map((c) => c.subject)).toEqual(["feat: change a", "initial commit"]);
    expect((await git.status(dir)).staged).toHaveLength(0);
  });

  it("reads the same path at three snapshots (worktree / index / HEAD)", async () => {
    if (!available) return;
    await writeFile(join(dir, "a.txt"), "staged\n");
    await git.stage(dir, ["a.txt"]);
    await writeFile(join(dir, "a.txt"), "working\n");

    expect((await git.readFile(dir, "a.txt", "WORKTREE")).content).toBe("working\n");
    expect((await git.readFile(dir, "a.txt", "INDEX")).content).toBe("staged\n");
    expect((await git.readFile(dir, "a.txt", "HEAD")).content).toBe("one\n");
  });

  it("reports a path missing at a rev as exists:false rather than throwing", async () => {
    if (!available) return;
    const f = await git.readFile(dir, "never-existed.ts", "HEAD");
    expect(f.exists).toBe(false);
    expect(f.content).toBe("");
  });

  it("discards working-tree edits and deletes untracked files", async () => {
    if (!available) return;
    await writeFile(join(dir, "a.txt"), "dirty\n");
    await writeFile(join(dir, "junk.txt"), "junk\n");
    await git.discard(dir, ["a.txt", "junk.txt"]);
    expect((await git.readFile(dir, "a.txt", "WORKTREE")).content).toBe("one\n");
    expect(existsSync(join(dir, "junk.txt"))).toBe(false);
  });

  it("creates, lists and switches branches", async () => {
    if (!available) return;
    await git.checkout(dir, "feat/x", { create: true });
    expect((await git.status(dir)).branch).toBe("feat/x");

    const branches = await git.branches(dir);
    expect(branches.map((b) => b.name).sort()).toEqual(["feat/x", "main"]);
    expect(branches.find((b) => b.name === "feat/x")?.isCurrent).toBe(true);
    expect(branches.every((b) => !b.isRemote)).toBe(true);

    await git.checkout(dir, "main");
    expect((await git.status(dir)).branch).toBe("main");
    await git.deleteBranch(dir, "feat/x", { force: true });
    expect((await git.branches(dir)).map((b) => b.name)).toEqual(["main"]);
  });

  it("stashes, lists, applies and drops", async () => {
    if (!available) return;
    await writeFile(join(dir, "a.txt"), "stash me\n");
    await git.stashPush(dir, { message: "my wip" });
    expect((await git.status(dir)).unstaged).toHaveLength(0);

    const stashes = await git.stashes(dir);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toMatchObject({ index: 0, ref: "stash@{0}", message: "my wip" });

    await git.stashApply(dir, 0, { pop: true });
    expect((await git.readFile(dir, "a.txt", "WORKTREE")).content).toBe("stash me\n");
    expect(await git.stashes(dir)).toHaveLength(0);
  });

  it("lists the files a commit touched with line counts", async () => {
    if (!available) return;
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(join(dir, "b.txt"), "brand new\n");
    await git.stageAll(dir);
    const commit = await git.commit(dir, "chore: touch two files");

    const files = await git.commitFiles(dir, commit.hash);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")).toMatchObject({ status: "modified", additions: 2 });
    expect(byPath.get("b.txt")).toMatchObject({ status: "added", additions: 1 });
  });

  it("tracks a rename as one staged entry carrying the old path", async () => {
    if (!available) return;
    await execa("git", ["mv", "a.txt", "renamed.txt"], { cwd: dir });
    const status = await git.status(dir);
    expect(status.staged).toHaveLength(1);
    expect(status.staged[0]).toMatchObject({
      path: "renamed.txt",
      oldPath: "a.txt",
      status: "renamed",
    });
  });
});
