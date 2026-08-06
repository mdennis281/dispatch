/**
 * Which `claude` binary every SDK query spawns.
 *
 * The Agent SDK ships its own Claude Code runtime (`0.3.N` bundles `2.1.N`) and
 * spawns that by default. Convenient, but it freezes the runtime at whatever the
 * pinned dep knows: on SDK 0.3.199 the model picker topped out at Opus 4.8 and
 * `default` resolved to `claude-opus-4-8[1m]` — weeks after Opus 5 shipped and
 * while the very same machine's `claude` CLI was already serving it. Model
 * availability, slash commands, and agent definitions all come from the runtime,
 * so a stale binary silently makes the whole app stale.
 *
 * So we prefer the Claude Code the USER keeps updated, and fall back to the
 * bundled one. Resolution order:
 *
 *   1. `DISPATCH_CLAUDE_PATH` — explicit override, used verbatim, no checks.
 *   2. The installed CLI (`~/.local/bin/claude[.exe]`, then PATH) — but ONLY if
 *      it is at least as new as the bundled runtime. A machine with an old
 *      global install must not drag the app backwards; "prefer installed" is
 *      only ever an upgrade.
 *   3. `undefined` — let the SDK spawn its own bundled binary.
 *
 * Resolved once per process (the answer can't change under us) and exposed via
 * {@link claudeRuntime} so the boot log can say which binary won.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { envVar } from "../config.js";

const IS_WIN = process.platform === "win32";
/** Basename of a directly-spawnable Claude Code binary on this platform. */
const EXE_NAME = IS_WIN ? "claude.exe" : "claude";

/**
 * Where the native installer drops the binary. Read from the passed env (not
 * just `homedir()`) so tests can point it somewhere harmless.
 */
function localBin(env: NodeJS.ProcessEnv): string {
  const home = (IS_WIN ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, ".local", "bin", EXE_NAME);
}

export interface ClaudeRuntime {
  /** Path to spawn, or undefined to let the SDK use its bundled binary. */
  path?: string;
  /** Version we resolved, when known — for the boot log. */
  version?: string;
  /** Which rule won, for the boot log. */
  source: "override" | "installed" | "bundled";
}

/**
 * Compare dotted numeric versions. Returns >0 when `a` is newer. Trailing
 * non-numeric junk ("2.1.223-beta") compares as its leading number.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** The Claude Code version baked into the installed SDK (its `claudeCodeVersion`). */
export function bundledVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // The package's `exports` map doesn't expose ./package.json, so resolve the
    // entry point and read the manifest sitting next to it.
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = require(join(entry, "..", "package.json")) as { claudeCodeVersion?: string };
    return pkg.claudeCodeVersion;
  } catch {
    return undefined;
  }
}

/** `claude --version` → "2.1.222". Undefined if it won't run or won't parse. */
function versionOf(exe: string): string | undefined {
  try {
    const out = execFileSync(exe, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/** First spawnable `claude` binary on PATH. */
function fromPath(env: NodeJS.ProcessEnv): string | undefined {
  // Only real executables — a .cmd/.ps1 shim isn't directly spawnable the way
  // the SDK invokes it, so we'd trade a stale runtime for a launch failure.
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, EXE_NAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return undefined;
}

/** Resolve the runtime. Exported unmemoized so tests can drive the env. */
export function resolveClaudeRuntime(env: NodeJS.ProcessEnv = process.env): ClaudeRuntime {
  const override = envVar(env, "CLAUDE_PATH")?.trim();
  if (override) return { path: override, version: versionOf(override), source: "override" };

  const installed = [localBin(env), fromPath(env)].find((p) => p && existsSync(p));
  if (installed) {
    const version = versionOf(installed);
    const bundled = bundledVersion();
    // Unknown versions on either side => can't prove it's an upgrade, so don't
    // risk it; the bundled runtime is the known-good default.
    if (version && bundled && compareVersions(version, bundled) >= 0) {
      return { path: installed, version, source: "installed" };
    }
  }

  return { version: bundledVersion(), source: "bundled" };
}

/** The resolved runtime for this process. */
export const claudeRuntime: ClaudeRuntime = resolveClaudeRuntime();

/**
 * Spread into an SDK `Options` object to pin the runtime:
 * `{ ...options, ...claudeExecutableOption() }`. Empty when the bundled binary
 * wins, so the SDK keeps its own default resolution.
 */
export function claudeExecutableOption(): { pathToClaudeCodeExecutable?: string } {
  return claudeRuntime.path ? { pathToClaudeCodeExecutable: claudeRuntime.path } : {};
}
