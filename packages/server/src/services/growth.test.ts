import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROWTH_GENERATED_KEY, type GrowthProgress } from "@dispatch/shared";
import {
  GrowthAccumulator,
  GrowthService,
  parseNumstatLine,
  renameTarget,
  unquotePath,
} from "./growth.js";

/* ------------------------------------------------------------ pure parsers */

describe("renameTarget", () => {
  it("resolves a brace rename to the new path", () => {
    expect(renameTarget("src/{old => new}/a.ts")).toBe("src/new/a.ts");
    expect(renameTarget("src/{ => lib}/a.ts")).toBe("src/lib/a.ts");
    expect(renameTarget("src/{old => }/a.ts")).toBe("src/a.ts");
  });

  it("resolves a whole-path arrow rename", () => {
    expect(renameTarget("old.ts => new.tsx")).toBe("new.tsx");
  });

  it("leaves an ordinary path alone", () => {
    expect(renameTarget("src/a.ts")).toBe("src/a.ts");
  });
});

describe("unquotePath", () => {
  it("decodes git's C-style quoting, octal bytes included", () => {
    expect(unquotePath('"caf\\303\\251.ts"')).toBe("café.ts");
    expect(unquotePath('"a\\tb.md"')).toBe("a\tb.md");
    expect(unquotePath('"q\\"uote.txt"')).toBe('q"uote.txt');
  });

  it("passes an unquoted path through", () => {
    expect(unquotePath("plain.ts")).toBe("plain.ts");
  });
});

describe("parseNumstatLine", () => {
  it("reads additions, deletions and the path", () => {
    expect(parseNumstatLine("12\t3\tsrc/a.ts")).toEqual({
      additions: 12,
      deletions: 3,
      binary: false,
      path: "src/a.ts",
    });
  });

  it("flags a binary entry and gives it no lines", () => {
    expect(parseNumstatLine("-\t-\tlogo.png")).toMatchObject({ binary: true, additions: 0 });
  });

  it("ignores header and blank lines", () => {
    expect(parseNumstatLine("")).toBeNull();
    expect(parseNumstatLine("\0abc\t1\tme\tsubject")).toBeNull();
  });
});

/* ------------------------------------------------------------- accumulator */

describe("GrowthAccumulator", () => {
  const header = (sha: string, ct: number, author: string, subject: string) =>
    `\0${sha}\t${ct}\t${author}\t${subject}`;

  it("buckets by UTC day and keys, and keeps whole-history totals", () => {
    const acc = new GrowthAccumulator();
    const day0 = 1_700_000_000; // some Tuesday
    acc.feed(header("a", day0, "ann", "first"));
    acc.feed("10\t0\tsrc/a.ts");
    acc.feed("5\t0\tREADME.md");
    acc.feed("-\t-\tlogo.png");
    acc.feed(header("b", day0 + 3600, "bob", "second"));
    acc.feed("2\t4\tsrc/a.ts");
    acc.feed(header("c", day0 + 86_400 * 2, "ann", "third"));
    acc.feed("1000\t0\tpnpm-lock.yaml");
    acc.feed("1\t1\tsrc/b.tsx");
    const out = acc.finish();

    expect(acc.commits).toBe(3);
    expect(acc.binaries).toBe(1);
    expect(out.authors).toBe(2);
    expect(out.points).toHaveLength(2);
    expect(out.points[0]).toMatchObject({
      commits: 2,
      additions: 17,
      deletions: 4,
      keys: { ".ts": { additions: 12, deletions: 4 }, ".md": { additions: 5, deletions: 0 } },
    });
    expect(out.points[1]!.keys[GROWTH_GENERATED_KEY]).toEqual({ additions: 1000, deletions: 0 });
    expect(out.totals[".ts"]).toEqual({ additions: 12, deletions: 4 });
  });

  it("ranks notable commits by non-generated lines", () => {
    const acc = new GrowthAccumulator();
    acc.feed(header("lock", 1, "x", "bump lockfile"));
    acc.feed("9000\t0\tpnpm-lock.yaml");
    acc.feed(header("real", 2, "x", "write code"));
    acc.feed("50\t10\tsrc/a.ts");
    acc.feed("20\t0\tsrc/b.ts");
    const { notable } = acc.finish();
    expect(notable[0]).toMatchObject({ sha: "real", additions: 70, deletions: 10, files: 2 });
    // The lockfile bump moved zero human lines and so does not rank at all.
    expect(notable.find((n) => n.sha === "lock")).toBeUndefined();
  });

  it("keeps tabs inside a subject", () => {
    const acc = new GrowthAccumulator();
    acc.feed(header("a", 1, "x", "one\ttwo"));
    acc.feed("1\t0\ta.ts");
    expect(acc.finish().notable[0]!.subject).toBe("one\ttwo");
  });
});

/* ------------------------------------------------------------ real git */

/** Skip the integration block when `git` isn't on PATH (CI images without it). */
async function hasGit(): Promise<boolean> {
  try {
    await execa("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("GrowthService.walk (real git)", () => {
  let dir: string;
  let available = true;
  const run = (args: string[], cwd = dir) =>
    execa("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" } });

  beforeAll(async () => {
    available = await hasGit();
    if (!available) return;
    dir = await mkdtemp(join(tmpdir(), "cm-growth-"));
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test User"]);
    await run(["config", "commit.gpgsign", "false"]);

    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "1\n2\n3\n");
    await writeFile(join(dir, "pnpm-lock.yaml"), Array(50).fill("x").join("\n") + "\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "init"]);

    // A feature branch merged with a real merge commit, so the first-parent
    // walk has a merge on its chain that must contribute the branch's diff.
    await run(["checkout", "-q", "-b", "feat"]);
    await writeFile(join(dir, "src", "b.tsx"), "a\nb\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "feat: b"]);
    await writeFile(join(dir, "src", "b.tsx"), "a\nb\nc\nd\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "feat: more b"]);
    await run(["checkout", "-q", "main"]);
    await run(["merge", "-q", "--no-ff", "--no-edit", "feat"]);

    // And a plain commit that deletes.
    await writeFile(join(dir, "src", "a.ts"), "1\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "trim a"]);
  });

  afterAll(async () => {
    if (available) await rm(dir, { recursive: true, force: true });
  });

  it("walks the first-parent chain and lands on HEAD's line count", async () => {
    if (!available) return;
    const seen: GrowthProgress[] = [];
    const report = await new GrowthService().walk({
      projectId: "p1",
      repoPath: dir,
      onProgress: (p) => seen.push(p),
    });

    // init, the merge, trim — the two branch commits are behind the merge.
    expect(report.commits).toBe(3);
    expect(report.ref).toBe("main");
    expect(report.authors).toBe(1);
    expect(report.binaries).toBe(0);

    // Running net per key equals the file contents at HEAD.
    const net = (k: string) => report.totals[k]!.additions - report.totals[k]!.deletions;
    expect(net(".ts")).toBe(1);
    expect(net(".tsx")).toBe(4);
    expect(net(GROWTH_GENERATED_KEY)).toBe(50);
    expect(report.totals[".tsx"]!.files).toBe(1);
    expect(report.totals[GROWTH_GENERATED_KEY]!.files).toBe(1);

    // The merge commit ranks by its whole landed diff.
    expect(report.notable[0]).toMatchObject({ subject: expect.stringMatching(/^Merge/), additions: 4 });

    expect(seen[0]).toEqual({ phase: "counting" });
    expect(seen.at(-1)).toEqual({ phase: "walking", done: 3, total: 3 });
    expect(report.points.reduce((n, p) => n + p.commits, 0)).toBe(3);
  });

  it("refuses an unborn repository with git's own words", async () => {
    if (!available) return;
    const empty = await mkdtemp(join(tmpdir(), "cm-growth-empty-"));
    try {
      await run(["init", "-q", "-b", "main"], empty);
      await expect(
        new GrowthService().walk({ projectId: "p", repoPath: empty, onProgress: () => {} }),
      ).rejects.toThrow(/HEAD|revision/i);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
