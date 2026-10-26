import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

/**
 * `versionOf` shells out to `claude --version`. We stub child_process so the
 * resolver's decision logic is testable without a real binary — the map is
 * exe path → the version string that binary reports (absent = won't launch).
 */
const versions = new Map<string, string>();
vi.mock("node:child_process", () => ({
  execFileSync: (exe: string) => {
    const v = versions.get(exe);
    if (!v) throw new Error("ENOENT");
    return `${v} (Claude Code)\n`;
  },
}));

const { resolveClaudeRuntime, bundledVersion } = await import("./runtime.js");

/** A file on disk that looks like an executable, reporting `version`. */
function fakeExe(dir: string, name: string, version?: string): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  if (version) versions.set(p, version);
  return p;
}

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

let dir: string;
let home: string;

/**
 * An env with HOME/USERPROFILE pointed at an empty temp dir, so the resolver's
 * `~/.local/bin` probe can't find the developer's REAL Claude Code install and
 * short-circuit whatever the test is actually asserting.
 */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, ...extra } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cm-runtime-"));
  home = mkdtempSync(join(tmpdir(), "cm-home-"));
  versions.clear();
});
afterEach(() => versions.clear());

describe("bundledVersion", () => {
  it("reads claudeCodeVersion off the installed SDK", () => {
    // Proves the exports-map workaround still resolves after an SDK bump.
    expect(bundledVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("resolveClaudeRuntime", () => {
  it("honours DISPATCH_CLAUDE_PATH verbatim", () => {
    const exe = fakeExe(dir, EXE, "2.0.1");
    const r = resolveClaudeRuntime(env({ DISPATCH_CLAUDE_PATH: exe }));
    expect(r).toMatchObject({ path: exe, source: "override" });
  });

  it("honours an explicit override even when it's older than bundled", () => {
    // Explicit beats safe — an override exists precisely to pin an odd build.
    const exe = fakeExe(dir, EXE, "1.0.0");
    expect(resolveClaudeRuntime(env({ DISPATCH_CLAUDE_PATH: exe })).path).toBe(exe);
  });

  it("prefers a PATH binary that is newer than the bundled runtime", () => {
    const bundled = bundledVersion()!;
    const newer = `${Number.parseInt(bundled, 10) + 1}.0.0`;
    const exe = fakeExe(dir, EXE, newer);
    const r = resolveClaudeRuntime(env({ PATH: dir }));
    expect(r).toMatchObject({ path: exe, version: newer, source: "installed" });
  });

  it("falls back to bundled when the installed binary is OLDER", () => {
    // The whole point of the version gate: never drag the app backwards.
    fakeExe(dir, EXE, "0.9.0");
    const r = resolveClaudeRuntime(env({ PATH: dir }));
    expect(r.path).toBeUndefined();
    expect(r.source).toBe("bundled");
  });

  it("falls back to bundled when the installed binary won't report a version", () => {
    fakeExe(dir, EXE); // present on disk, but --version fails
    expect(resolveClaudeRuntime(env({ PATH: dir })).source).toBe("bundled");
  });

  it("falls back to bundled when nothing is installed", () => {
    expect(resolveClaudeRuntime(env({ PATH: dir })).source).toBe("bundled");
  });

  it("skips unreadable PATH entries rather than throwing", () => {
    const bundled = bundledVersion()!;
    const newer = `${Number.parseInt(bundled, 10) + 1}.0.0`;
    const exe = fakeExe(dir, EXE, newer);
    const path = ["", join(dir, "does-not-exist"), dir].join(delimiter);
    expect(resolveClaudeRuntime(env({ PATH: path })).path).toBe(exe);
  });

  it("treats an equal version as good enough to prefer", () => {
    const exe = fakeExe(dir, EXE, bundledVersion()!);
    expect(resolveClaudeRuntime(env({ PATH: dir })).path).toBe(exe);
  });
});
