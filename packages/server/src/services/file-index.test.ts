import { describe, it, expect, vi } from "vitest";
import { FileIndexService, rankFiles, scorePath, CACHE_TTL_MS } from "./file-index.js";
import type { ExecFn } from "./worktree.js";

/** An exec stub that answers `git ls-files -z` with the given paths. */
function lsFiles(paths: string[], exitCode = 0): { exec: ExecFn; calls: number } {
  const state = { calls: 0 };
  const exec: ExecFn = async () => {
    state.calls++;
    return { stdout: paths.join("\0"), stderr: "", exitCode };
  };
  return {
    exec,
    get calls() {
      return state.calls;
    },
  };
}

describe("scorePath", () => {
  it("ranks a filename prefix above a filename substring above a directory hit", () => {
    const prefix = scorePath("src/auth.ts", "auth")!;
    const substr = scorePath("src/my-auth.ts", "auth")!;
    const inDir = scorePath("auth/index.ts", "auth")!;
    expect(prefix).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(inDir);
  });

  it("matches a subsequence, but ranks it below every literal hit", () => {
    const sub = scorePath("chat/messages.ts", "cmsg")!;
    expect(sub).not.toBeNull();
    expect(sub).toBeLessThan(scorePath("chat/messages.ts", "messages")!);
  });

  it("is case-insensitive", () => {
    expect(scorePath("src/Auth.ts", "auth")).toBe(scorePath("src/auth.ts", "AUTH"));
  });

  it("returns null when the chars aren't all there, in order", () => {
    expect(scorePath("src/auth.ts", "zzz")).toBeNull();
    expect(scorePath("src/auth.ts", "hta")).toBeNull(); // right letters, wrong order
  });

  it("matches everything on an empty query", () => {
    expect(scorePath("anything.ts", "")).toBe(0);
  });
});

describe("rankFiles", () => {
  const FILES = [
    "packages/client/src/lib/auth.ts",
    "packages/server/src/auth.ts",
    "auth.ts",
    "packages/server/src/authz/policy.ts",
    "README.md",
  ];

  it("puts the shallowest exact filename first", () => {
    expect(rankFiles(FILES, "auth.ts", 10)[0]).toBe("auth.ts");
  });

  it("drops non-matches entirely", () => {
    expect(rankFiles(FILES, "auth", 10)).not.toContain("README.md");
  });

  it("honors the limit", () => {
    expect(rankFiles(FILES, "auth", 2)).toHaveLength(2);
  });

  it("returns everything (capped) for an empty query", () => {
    expect(rankFiles(FILES, "", 10)).toHaveLength(FILES.length);
  });

  it("is stable — the same query always yields the same order", () => {
    expect(rankFiles(FILES, "auth", 10)).toEqual(rankFiles([...FILES].reverse(), "auth", 10));
  });

  it("tolerates a zero/negative limit without throwing", () => {
    expect(rankFiles(FILES, "auth", 0)).toEqual([]);
  });
});

describe("FileIndexService", () => {
  it("returns both the relative and absolute form of each hit", async () => {
    const { exec } = lsFiles(["src/auth.ts"]);
    const svc = new FileIndexService({ exec });
    const [hit] = await svc.search("/repo", "auth");
    expect(hit!.rel).toBe("src/auth.ts");
    // join() is platform-native, so assert the shape rather than the separator.
    expect(hit!.abs).toMatch(/^[\\/]repo[\\/]src[\\/]auth\.ts$/);
  });

  it("splits on NUL, so paths with spaces survive intact", async () => {
    const { exec } = lsFiles(["src/my docs/a b.ts"]);
    const svc = new FileIndexService({ exec });
    const files = await svc.search("/repo", "a b");
    expect(files[0]!.rel).toBe("src/my docs/a b.ts");
  });

  it("yields nothing when the directory isn't a git checkout", async () => {
    // The picker should show an empty list, not surface a git error at someone
    // who asked for a file.
    const { exec } = lsFiles([], 128);
    const svc = new FileIndexService({ exec });
    expect(await svc.search("/not-a-repo", "auth")).toEqual([]);
  });

  it("caches the listing — typing a query doesn't re-run git per keystroke", async () => {
    const stub = lsFiles(["src/auth.ts", "src/main.ts"]);
    const svc = new FileIndexService({ exec: stub.exec });
    await svc.search("/repo", "a");
    await svc.search("/repo", "au");
    await svc.search("/repo", "aut");
    expect(stub.calls).toBe(1);
  });

  it("re-lists a different root", async () => {
    const stub = lsFiles(["src/auth.ts"]);
    const svc = new FileIndexService({ exec: stub.exec });
    await svc.search("/repo-a", "");
    await svc.search("/repo-b", "");
    expect(stub.calls).toBe(2);
  });

  it("re-lists once the cache goes stale", async () => {
    vi.useFakeTimers();
    try {
      const stub = lsFiles(["src/auth.ts"]);
      const svc = new FileIndexService({ exec: stub.exec });
      await svc.search("/repo", "");
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);
      await svc.search("/repo", "");
      expect(stub.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate() forces the next search to re-list", async () => {
    const stub = lsFiles(["src/auth.ts"]);
    const svc = new FileIndexService({ exec: stub.exec });
    await svc.search("/repo", "");
    svc.invalidate("/repo");
    await svc.search("/repo", "");
    expect(stub.calls).toBe(2);
  });

  it("caps results at MAX_RESULTS however large a limit is asked for", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    const { exec } = lsFiles(many);
    const svc = new FileIndexService({ exec });
    expect(await svc.search("/repo", "", 10_000)).toHaveLength(200);
  });
});
