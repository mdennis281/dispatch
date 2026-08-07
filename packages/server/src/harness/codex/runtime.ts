/**
 * Which `codex` binary the Codex harness spawns.
 *
 * Codex is harder to find than Claude Code. Unlike `claude`, which the native
 * installer puts on PATH at `~/.local/bin`, Codex commonly arrives bundled
 * inside something else and is NOT on PATH at all:
 *
 *   - the ChatGPT VS Code extension ships one under its `bin/<platform>/`
 *   - the plugin app-server keeps one at `~/.codex/plugins/.plugin-appserver/`
 *   - the desktop app drops content-addressed builds under
 *     `%LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/` (macOS/Linux: `~/.codex/bin`)
 *
 * These are genuinely different versions on the same machine — on the box this
 * was written against, the bundled plugin binary was 0.147 while the VS Code
 * extension's was 0.146. Since the app-server protocol only grows, we probe
 * every candidate and take the NEWEST, mirroring the "prefer the newer runtime"
 * rule the Claude side uses (see services/runtime.ts).
 *
 * Resolution order:
 *   1. `DISPATCH_CODEX_PATH` — explicit override, used verbatim, no checks.
 *   2. The newest of every candidate we can find and get `--version` out of.
 *   3. Unavailable — the harness reports `available: false` and the UI greys
 *      Codex out rather than failing at send time.
 *
 * Resolved once per process and re-resolvable in tests via
 * {@link resolveCodexRuntime}.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { envVar } from "../../config.js";
import type { HarnessRuntimeInfo } from "../types.js";

const IS_WIN = process.platform === "win32";
/** Basename of a directly-spawnable Codex binary on this platform. */
const EXE_NAME = IS_WIN ? "codex.exe" : "codex";

/** Home dir from the passed env (not just `homedir()`) so tests can redirect. */
function home(env: NodeJS.ProcessEnv): string {
  return (IS_WIN ? env.USERPROFILE : env.HOME) || homedir();
}

/** `$CODEX_HOME`, or its default location. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(home(env), ".codex");
}

/** Every immediate subdirectory of `dir`, or [] when it isn't readable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** First spawnable `codex` on PATH. */
function fromPath(env: NodeJS.ProcessEnv): string | undefined {
  // Only real executables — a .cmd/.ps1 shim isn't directly spawnable the way
  // we invoke it, so we'd trade a stale runtime for a launch failure.
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

/**
 * Every place a Codex binary is known to hide, most-canonical first.
 *
 * Ordering only matters as a tiebreak: the winner is chosen by version, so a
 * newer binary in a less canonical place still wins.
 */
export function codexCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const h = home(env);
  const ch = codexHome(env);
  const out: string[] = [];

  const onPath = fromPath(env);
  if (onPath) out.push(onPath);

  // The plugin app-server's own copy — a stable path, usually current.
  out.push(join(ch, "plugins", ".plugin-appserver", EXE_NAME));
  // Desktop-app content-addressed builds.
  const appBins = IS_WIN
    ? join(env.LOCALAPPDATA ?? join(h, "AppData", "Local"), "OpenAI", "Codex", "bin")
    : join(ch, "bin");
  for (const d of subdirs(appBins)) out.push(join(d, EXE_NAME));
  out.push(join(appBins, EXE_NAME));
  // The ChatGPT VS Code / Cursor extensions.
  for (const root of [
    join(h, ".vscode", "extensions"),
    join(h, ".vscode-insiders", "extensions"),
    join(h, ".cursor", "extensions"),
  ]) {
    for (const ext of subdirs(root)) {
      if (!ext.toLowerCase().includes("openai.chatgpt")) continue;
      const bin = join(ext, "bin");
      for (const plat of subdirs(bin)) out.push(join(plat, EXE_NAME));
      out.push(join(bin, EXE_NAME));
    }
  }
  // npm global install.
  out.push(join(h, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", EXE_NAME));
  out.push(join(h, ".local", "bin", EXE_NAME));

  // De-dupe, preserving order.
  return [...new Set(out)];
}

/**
 * `codex --version` → "0.147.0-alpha.6.5". Undefined if it won't run or parse.
 *
 * Deliberately captures the FULL version string including the prerelease tail,
 * because every Codex build that ships the v2 app-server protocol today is a
 * prerelease — dropping the tail would make 0.147.0-alpha.6 and 0.147.0-alpha.9
 * compare equal.
 */
export function versionOf(exe: string): string | undefined {
  try {
    const out = execFileSync(exe, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return /(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Compare two Codex versions. Returns >0 when `a` is newer.
 *
 * Semver-ish: numeric segments compare numerically, and a version WITHOUT a
 * prerelease tail outranks the same version with one (1.0.0 > 1.0.0-alpha.1),
 * which is plain semver precedence. Non-numeric segments fall back to string
 * comparison so "alpha" < "beta" orders sanely.
 */
export function compareCodexVersions(a: string, b: string): number {
  const split = (v: string): [string[], string[]] => {
    const [core, ...pre] = v.split("-");
    return [core!.split("."), pre.join("-") ? pre.join("-").split(".") : []];
  };
  const [ac, apre] = split(a);
  const [bc, bpre] = split(b);
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const na = Number.parseInt(ac[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(bc[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  // No prerelease outranks a prerelease.
  if (!apre.length && bpre.length) return 1;
  if (apre.length && !bpre.length) return -1;
  for (let i = 0; i < Math.max(apre.length, bpre.length); i++) {
    const sa = apre[i];
    const sb = bpre[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = Number.parseInt(sa, 10);
    const nb = Number.parseInt(sb, 10);
    const bothNumeric = Number.isFinite(na) && Number.isFinite(nb) && `${na}` === sa && `${nb}` === sb;
    if (bothNumeric) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export interface ResolveCodexDeps {
  /** Injectable so tests never shell out. */
  versionOf?: (exe: string) => string | undefined;
  exists?: (p: string) => boolean;
  candidates?: (env: NodeJS.ProcessEnv) => string[];
}

/** Resolve the Codex runtime. Exported unmemoized so tests can drive the env. */
export function resolveCodexRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveCodexDeps = {},
): HarnessRuntimeInfo {
  const probe = deps.versionOf ?? versionOf;
  const has = deps.exists ?? existsSync;
  const list = deps.candidates ?? codexCandidates;

  const override = envVar(env, "CODEX_PATH")?.trim();
  if (override) {
    return { kind: "codex", path: override, version: probe(override), source: "override", available: true };
  }

  let best: { path: string; version: string } | undefined;
  for (const candidate of list(env)) {
    if (!has(candidate)) continue;
    const version = probe(candidate);
    // A candidate we can't get a version out of isn't one we can trust to speak
    // the v2 protocol, and picking it could silently downgrade the app.
    if (!version) continue;
    if (!best || compareCodexVersions(version, best.version) > 0) best = { path: candidate, version };
  }

  if (!best) return { kind: "codex", source: "missing", available: false };
  return { kind: "codex", path: best.path, version: best.version, source: "installed", available: true };
}

let memo: HarnessRuntimeInfo | undefined;

/** The resolved Codex runtime for this process (probed at most once). */
export function codexRuntime(): HarnessRuntimeInfo {
  return (memo ??= resolveCodexRuntime());
}

/** Drop the memo (tests; also lets a process re-probe after an install). */
export function resetCodexRuntime(): void {
  memo = undefined;
}
