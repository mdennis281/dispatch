import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitLayout, excludePathsFromGit, unexcludePathsFromGit } from "./git-exclude.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-gitex-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const readExclude = (gitDir: string) => readFile(join(gitDir, "info", "exclude"), "utf8");

describe("findGitLayout", () => {
  it("finds the repo from a nested dir, with `.git` as the common dir", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "a", "b"), { recursive: true });

    expect(findGitLayout(join(dir, "a", "b"))).toEqual({
      root: dir,
      commonDir: join(dir, ".git"),
    });
  });

  it("returns null when there is no repo above the dir", async () => {
    await mkdir(join(dir, "plain"), { recursive: true });
    expect(findGitLayout(join(dir, "plain"))).toBeNull();
  });

  it("follows a LINKED WORKTREE to the COMMON git dir, not its private one", async () => {
    // The layout `git worktree add` produces: the worktree's `.git` is a file
    // pointing at a private dir under the main repo, and that private dir names
    // the common dir. `info/exclude` lives in the COMMON one — reading the
    // pointer and stopping there would write a file git never consults.
    const main = join(dir, "main");
    const priv = join(main, ".git", "worktrees", "wt");
    const wt = join(dir, "wt");
    await mkdir(priv, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${priv}\n`, "utf8");
    await writeFile(join(priv, "commondir"), "../..\n", "utf8");

    expect(findGitLayout(wt)).toEqual({ root: wt, commonDir: join(main, ".git") });
  });

  it("treats a private git dir with no `commondir` as its own common dir", async () => {
    const priv = join(dir, "elsewhere");
    const wt = join(dir, "wt");
    await mkdir(priv, { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), `gitdir: ${priv}`, "utf8");

    expect(findGitLayout(wt)).toEqual({ root: wt, commonDir: priv });
  });
});

describe("excludePathsFromGit", () => {
  const gitDir = () => join(dir, ".git");

  beforeEach(async () => {
    await mkdir(gitDir(), { recursive: true });
  });

  it("writes one worktree-anchored pattern per path, in a managed block", async () => {
    await excludePathsFromGit(dir, [join(dir, ".claude", "skills", "mcp-setup")]);

    const text = await readExclude(gitDir());
    expect(text).toContain("/.claude/skills/mcp-setup/");
    expect(text).toContain("# BEGIN Dispatch");
    expect(text).toContain("# END Dispatch");
    // Narrow, NOT a blanket rule — a skill the user authors later must still show.
    expect(text).not.toContain("/.claude/skills/\n");
  });

  it("is idempotent — a second call adds nothing", async () => {
    const paths = [join(dir, ".claude", "skills", "mcp-setup")];
    await excludePathsFromGit(dir, paths);
    const first = await readExclude(gitDir());
    await excludePathsFromGit(dir, paths);

    expect(await readExclude(gitDir())).toBe(first);
  });

  it("MERGES a new skill into the existing block rather than replacing it", async () => {
    await excludePathsFromGit(dir, [join(dir, ".claude", "skills", "mcp-setup")]);
    await excludePathsFromGit(dir, [join(dir, ".agents", "skills", "upgrade-the-app")]);

    const text = await readExclude(gitDir());
    // Both survive: `info/exclude` is shared by every worktree of a repo, so a
    // rewrite would let two sessions take turns deleting each other's lines.
    expect(text).toContain("/.claude/skills/mcp-setup/");
    expect(text).toContain("/.agents/skills/upgrade-the-app/");
    expect(text.match(/# BEGIN Dispatch/g)).toHaveLength(1);
  });

  it("preserves whatever the user already had, and never duplicates their line", async () => {
    await mkdir(join(gitDir(), "info"), { recursive: true });
    await writeFile(
      join(gitDir(), "info", "exclude"),
      "# user's own\nscratch/\n/.claude/skills/mcp-setup/\n",
      "utf8",
    );

    await excludePathsFromGit(dir, [
      join(dir, ".claude", "skills", "mcp-setup"),
      join(dir, ".claude", "skills", "other"),
    ]);

    const text = await readExclude(gitDir());
    expect(text).toContain("scratch/");
    expect(text.match(/\/\.claude\/skills\/mcp-setup\//g)).toHaveLength(1);
    expect(text).toContain("/.claude/skills/other/");
  });

  it("ignores paths outside the worktree, and does nothing when given none", async () => {
    await excludePathsFromGit(dir, [join(tmpdir(), "somewhere-else", "skills", "x")]);
    expect(findGitLayout(dir)).not.toBeNull();
    // Nothing was in range, so the file was never created.
    await expect(readExclude(gitDir())).rejects.toThrow();

    await excludePathsFromGit(dir, []);
    await expect(readExclude(gitDir())).rejects.toThrow();
  });

  it("escapes glob metacharacters in a user-authored skill dir name", async () => {
    await excludePathsFromGit(dir, [join(dir, ".claude", "skills", "foo[1]*?")]);

    // Unescaped, `foo[1]` is a character class: it would match a sibling `foo1`
    // the user owns and miss the dir it was written for.
    expect(await readExclude(gitDir())).toContain("/.claude/skills/foo\\[1\\]\\*\\?/");
  });

  it("takes a pattern back out, and removes the block once it's empty", async () => {
    const skill = join(dir, ".claude", "skills", "mcp-setup");
    const other = join(dir, ".claude", "skills", "second");
    await excludePathsFromGit(dir, [skill, other]);

    await unexcludePathsFromGit([skill]);
    let text = await readExclude(gitDir());
    expect(text).not.toContain("/.claude/skills/mcp-setup/");
    expect(text).toContain("/.claude/skills/second/");

    await unexcludePathsFromGit([other]);
    text = await readExclude(gitDir());
    expect(text).not.toContain("# BEGIN Dispatch");
    expect(text.trim()).toBe("");
  });

  it("leaves the user's own lines alone when removing ours", async () => {
    await mkdir(join(gitDir(), "info"), { recursive: true });
    await writeFile(join(gitDir(), "info", "exclude"), "# user's own\nscratch/\n", "utf8");
    const skill = join(dir, ".claude", "skills", "mcp-setup");
    await excludePathsFromGit(dir, [skill]);

    await unexcludePathsFromGit([skill]);

    const text = await readExclude(gitDir());
    expect(text).toContain("scratch/");
    expect(text).toContain("# user's own");
    expect(text).not.toContain("/.claude/skills/mcp-setup/");
  });

  it("never removes a line the USER wrote for the same path", async () => {
    // `excludePathsFromGit` skips a pattern already in the file, so it was never
    // in our block — and taking ours away must not take theirs.
    await mkdir(join(gitDir(), "info"), { recursive: true });
    const skill = join(dir, ".claude", "skills", "mcp-setup");
    await writeFile(
      join(gitDir(), "info", "exclude"),
      "/.claude/skills/mcp-setup/\n",
      "utf8",
    );
    await excludePathsFromGit(dir, [skill]);

    await unexcludePathsFromGit([skill]);

    expect(await readExclude(gitDir())).toContain("/.claude/skills/mcp-setup/");
  });

  it("does not throw when the dir is not a repo at all", async () => {
    const plain = await mkdtemp(join(tmpdir(), "cm-gitex-plain-"));
    try {
      await expect(excludePathsFromGit(plain, [join(plain, "x")])).resolves.toBeUndefined();
    } finally {
      await rm(plain, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

/* ------------------------------------------- the part that actually matters */

async function gitAvailable(): Promise<boolean> {
  try {
    await execa("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserting that we WROTE an exclude file proves nothing about whether git reads
 * it — the pattern could be misanchored, or in the wrong dir for a worktree, and
 * every test above would still pass. These drive real git and check the thing the
 * user actually sees: `git status`.
 */
describe("against real git", () => {
  let repo: string;
  let available = true;

  beforeEach(async () => {
    available = await gitAvailable();
    if (!available) return;
    repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
    const run = (args: string[]) => execa("git", args, { cwd: repo });
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test User"]);
    await run(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "a.txt"), "one\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "initial"]);
  });

  const status = async (cwd: string) =>
    (await execa("git", ["status", "--porcelain"], { cwd })).stdout;

  it("hides a materialized skill dir that git would otherwise report", async () => {
    if (!available) return;
    const skill = join(repo, ".claude", "skills", "mcp-setup");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "body\n", "utf8");

    // CONTROL: without the exclude, this is exactly the churn users reported.
    expect(await status(repo)).toContain(".claude/");

    await excludePathsFromGit(repo, [skill]);
    expect(await status(repo)).toBe("");
  });

  it("leaves a TRACKED skill under the same dir visible", async () => {
    if (!available) return;
    const own = join(repo, ".claude", "skills", "hand-written");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "mine\n", "utf8");
    await execa("git", ["add", "-A"], { cwd: repo });
    await execa("git", ["commit", "-q", "-m", "own skill"], { cwd: repo });

    // Ours goes next to it and gets excluded…
    const skill = join(repo, ".claude", "skills", "mcp-setup");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "body\n", "utf8");
    await excludePathsFromGit(repo, [skill]);

    // …and the user's edit to their OWN skill still shows up. Exclude patterns
    // are only consulted for untracked paths, which is why the narrow rule is
    // safe even inside a directory the repo commits.
    await writeFile(join(own, "SKILL.md"), "mine, edited\n", "utf8");
    expect(await status(repo)).toContain("hand-written/SKILL.md");
    expect(await status(repo)).not.toContain("mcp-setup");
  });

  it("gives the path back once we un-exclude, so the USER'S skill is visible", async () => {
    if (!available) return;
    // Overriding a bundled skill by shipping your own at the same name is the
    // documented escape hatch. An append-only exclude would make that override
    // invisible to git forever — unstageable, with nothing on screen to say why.
    const skill = join(repo, ".claude", "skills", "mcp-setup");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "dispatch's copy\n", "utf8");
    await excludePathsFromGit(repo, [skill]);
    expect(await status(repo)).toBe("");

    // Teardown: our dir goes, and so must its pattern.
    await rm(skill, { recursive: true, force: true });
    await unexcludePathsFromGit([skill]);

    // The user now writes their own skill at exactly that path.
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "the user's own\n", "utf8");
    expect(await status(repo)).toContain(".claude/");
  });

  it("escapes a glob metacharacter so it hides ITS dir and not a sibling", async () => {
    if (!available) return;
    const odd = join(repo, ".claude", "skills", "foo[1]");
    const sibling = join(repo, ".claude", "skills", "foo1");
    for (const d of [odd, sibling]) {
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "SKILL.md"), "body\n", "utf8");
    }

    await excludePathsFromGit(repo, [odd]);

    // `-uall` because git collapses a wholly-untracked directory to one entry,
    // which would hide which of the two siblings actually survived.
    const out = (await execa("git", ["status", "--porcelain", "-uall"], { cwd: repo })).stdout;
    // Unescaped this reads as a character class: `foo[1]` stays listed and the
    // user's unrelated `foo1` disappears — both halves exactly backwards.
    expect(out).toContain("foo1/SKILL.md");
    expect(out).not.toContain("foo[1]/SKILL.md");
  });

  it("hides it inside a LINKED WORKTREE (exclude lands in the common dir)", async () => {
    if (!available) return;
    const wt = join(dir, "wt");
    await execa("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: repo });

    const skill = join(wt, ".claude", "skills", "mcp-setup");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "body\n", "utf8");
    expect(await status(wt)).toContain(".claude/");

    await excludePathsFromGit(wt, [skill]);
    expect(await status(wt)).toBe("");
  });
});
