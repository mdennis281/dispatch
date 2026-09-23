/**
 * Which ACP agent binary the harness spawns.
 *
 * Simpler than the Codex side on purpose. Codex hides in four places and ships
 * genuinely different versions on one machine, so `codex/runtime.ts` probes
 * every candidate and takes the newest. goose has one installer and one install
 * location per platform, so "first one that answers `--version`" is honest here
 * and a version comparator would be ceremony with nothing to compare.
 *
 * Resolution order:
 *   1. `DISPATCH_GOOSE_PATH` — explicit override, used verbatim, no checks.
 *   2. PATH, then the installer's default directory.
 *   3. Unavailable — the harness reports `available: false` and the UI greys the
 *      provider out rather than failing at send time.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { envVar } from "../../config.js";
import type { HarnessRuntimeInfo } from "../types.js";

const IS_WIN = process.platform === "win32";
/** Basename of a directly-spawnable goose binary on this platform. */
const EXE_NAME = IS_WIN ? "goose.exe" : "goose";

/** Home dir from the passed env (not just `homedir()`) so tests can redirect. */
function home(env: NodeJS.ProcessEnv): string {
  return (IS_WIN ? env.USERPROFILE : env.HOME) || homedir();
}

/** First spawnable `goose` on PATH. */
function fromPath(env: NodeJS.ProcessEnv): string | undefined {
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
 * Every place a goose binary is known to live, most-canonical first.
 *
 * `~/.local/bin` is where `download_cli.sh` puts it on every platform including
 * Windows, which is why it is listed rather than assumed to be on PATH — the
 * installer prints a warning and carries on when PATH lacks it, so a working
 * install that the shell can't see is the COMMON case, not an edge one.
 *
 * The desktop app is the other real shape, and it is easy to miss: the Windows
 * bundle ships the CLI at `dist-windows/resources/bin/goose.exe` alongside the
 * Electron `Goose.exe`, so a user who "has goose installed" may have only the
 * GUI on disk with a perfectly good CLI buried two directories down. Finding it
 * is the difference between the provider working and the provider being greyed
 * out on a machine that does have goose.
 *
 * Order is preference, not version: unlike Codex there is one installer and one
 * release train, so a second copy is the same build rather than a newer one.
 */
export function gooseCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const onPath = fromPath(env);
  if (onPath) out.push(onPath);
  out.push(join(home(env), ".local", "bin", EXE_NAME));

  if (IS_WIN) {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      out.push(join(localAppData, "Programs", "Goose", EXE_NAME));
      // The Electron bundle's embedded CLI, installed and unpacked-in-place.
      out.push(join(localAppData, "Programs", "Goose", "resources", "bin", EXE_NAME));
    }
    // Deliberately NOT ~/Downloads, even though an extracted `Goose-win32-x64`
    // there is a real and common state. Downloads is transient and untrusted;
    // a stale unzip silently becoming the agent runtime is a footgun, and
    // `DISPATCH_GOOSE_PATH` is the right way to point at an unpacked build.
  } else {
    out.push(join("/Applications", "Goose.app", "Contents", "Resources", "bin", EXE_NAME));
    out.push(join(home(env), "Applications", "Goose.app", "Contents", "Resources", "bin", EXE_NAME));
  }
  return out;
}

/** `<exe> --version`, or undefined when it won't run. */
function versionOf(exe: string): string | undefined {
  try {
    const out = execFileSync(exe, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // goose prints a bare "1.51.0" rather than "goose 1.51.0", so take the
    // first version-shaped token instead of assuming a prefix to strip.
    return /(\d+\.\d+\.\d+[^\s]*)/.exec(out.trim())?.[1];
  } catch {
    return undefined;
  }
}

export interface ResolveGooseDeps {
  /** Injectable so tests never shell out. */
  versionOf?: (exe: string) => string | undefined;
  exists?: (p: string) => boolean;
  candidates?: (env: NodeJS.ProcessEnv) => string[];
}

/** Resolve the goose runtime. Exported unmemoized so tests can drive the env. */
export function resolveGooseRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveGooseDeps = {},
): HarnessRuntimeInfo {
  const probe = deps.versionOf ?? versionOf;
  const has = deps.exists ?? existsSync;
  const list = deps.candidates ?? gooseCandidates;

  const override = envVar(env, "GOOSE_PATH")?.trim();
  if (override) {
    return { kind: "goose", path: override, version: probe(override), source: "override", available: true };
  }

  for (const candidate of list(env)) {
    if (!has(candidate)) continue;
    const version = probe(candidate);
    // A binary we can't get a version out of is one we can't trust to speak
    // ACP, and spawning it would turn a clear "not installed" into a hang.
    if (!version) continue;
    return { kind: "goose", path: candidate, version, source: "installed", available: true };
  }

  return { kind: "goose", source: "missing", available: false };
}

let memo: HarnessRuntimeInfo | undefined;

/** The resolved goose runtime for this process (probed at most once). */
export function gooseRuntime(): HarnessRuntimeInfo {
  return (memo ??= resolveGooseRuntime());
}

/** Drop the memo (tests; also lets a process re-probe after an install). */
export function resetGooseRuntime(): void {
  memo = undefined;
}
