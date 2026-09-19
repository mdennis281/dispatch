/**
 * Spawn seam shared by every service that shells out to `git`, `gh` and the
 * OS process tools: resolves the executable ONCE per name, and keeps a running
 * account of what each command family costs the event loop.
 *
 * WHY THE RESOLUTION. On Windows execa hands every spawn to cross-spawn, which
 * runs `which.sync` over PATH × PATHEXT before `child_process.spawn` ever
 * happens. On the box this was profiled on (2026-09-19) that is 58 PATH entries
 * × 13 extensions ≈ 750 `statSync` calls per `git`/`gh` invocation — all on the
 * event loop — and with Defender and the search indexer contending for the
 * disk each one took milliseconds. One spawn cost hundreds of ms of loop time,
 * `/api/health` took 0.8–2.4 s to answer `ok`, HAProxy's check timed out, and
 * the whole app 503'd for everyone while the store underneath was perfectly
 * healthy. `which` short-circuits to a single stat when the command is already
 * an absolute path, so resolving each binary once — with async `access`, off
 * the loop — and spawning THAT removes the walk from every call after the first.
 *
 * WHY THE ACCOUNTING. That outage was invisible from inside the process: the
 * supervisor discards stdout, health said `ok`, and nothing measured the loop.
 * `execStats` is what `/api/health` and `perf.log` name when the loop stalls,
 * so the next episode says "gh from watch_pr, 40 spawns, 6 s sync" instead of
 * needing a live CPU profile to find out.
 */
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { execa, type Options, type Result } from "execa";

/* --------------------------------------------------------------- resolution */

const resolved = new Map<string, Promise<string>>();

/** PATHEXT as cross-spawn/which read it: lower-cased, leading dot kept. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same walk `which` does, but asynchronous and once. The FIRST hit wins —
 * PATH order, then PATHEXT order — which is also what cross-spawn would have
 * picked on every call, so the resolved binary is the one the process was
 * already running.
 */
async function walkPath(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = windowsExtensions(env);
  // A name that already carries an extension (`gh.exe`) is tried bare first,
  // exactly as `which` does.
  const candidates = file.includes(".") ? ["", ...exts] : exts;
  for (const dir of dirs) {
    for (const ext of candidates) {
      const candidate = join(dir, file + ext);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Absolute path for `file`, memoised for the life of the process.
 *
 * Only Windows pays the PATH walk (posix `execvp` does the lookup in the
 * kernel, and cross-spawn stays out of the way there), so elsewhere the name
 * is returned untouched. A name that cannot be found is ALSO returned untouched
 * so the spawn fails exactly as it would have — `gh` not installed is a
 * condition the callers already handle and report.
 */
export function resolveBinary(file: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== "win32" || isAbsolute(file) || /[\\/]/.test(file)) {
    return Promise.resolve(file);
  }
  let hit = resolved.get(file);
  if (!hit) {
    hit = walkPath(file, env).then((found) => found ?? file);
    // A failed walk must not be cached: PATH may gain the tool later (an
    // install mid-session) and the memo would pin the miss forever.
    hit.then((found) => {
      if (found === file) resolved.delete(file);
    });
    resolved.set(file, hit);
  }
  return hit;
}

/** Test seam: forget every resolution. */
export function resetResolvedBinaries(): void {
  resolved.clear();
}

/* --------------------------------------------------------------- accounting */

export interface ExecStat {
  /** The command name as the caller spelled it (`git`, `gh`), not its path. */
  file: string;
  /** Spawns started. */
  count: number;
  /**
   * Milliseconds the `execa()` CALL itself took, summed — the part that runs
   * synchronously on the event loop (command resolution + `spawn`). This is
   * the number that stalls the server; wall time below is merely latency.
   */
  syncMs: number;
  /** Milliseconds from spawn to exit, summed. */
  wallMs: number;
  /** Longest single synchronous spawn seen. */
  maxSyncMs: number;
}

const stats = new Map<string, ExecStat>();

function statFor(file: string): ExecStat {
  let s = stats.get(file);
  if (!s) {
    s = { file, count: 0, syncMs: 0, wallMs: 0, maxSyncMs: 0 };
    stats.set(file, s);
  }
  return s;
}

/** Snapshot of every command family's cost since the last {@link resetExecStats}. */
export function execStats(): ExecStat[] {
  return [...stats.values()]
    .map((s) => ({ ...s, syncMs: Math.round(s.syncMs), wallMs: Math.round(s.wallMs), maxSyncMs: Math.round(s.maxSyncMs) }))
    .sort((a, b) => b.syncMs - a.syncMs);
}

/** Start a fresh accounting window (the perf monitor rolls one per minute). */
export function resetExecStats(): void {
  stats.clear();
}

/**
 * `execa`, but through the memoised binary and counted. Same arguments, same
 * result — every option execa accepts passes straight through — so a seam that
 * read `execa(file, args, opts)` reads `execBinary(file, args, opts)` and
 * nothing downstream changes.
 *
 * Returns a plain Promise of execa's result rather than its ResultPromise: the
 * resolution step is async, so the child does not exist yet when this returns.
 * A caller that needs the child object itself (to stream its output) keeps
 * calling execa directly, with `await resolveBinary(file)` as the command.
 */
export async function execBinary<O extends Options = {}>(
  file: string,
  args: readonly string[],
  options?: O,
): Promise<Result<O>> {
  const bin = await resolveBinary(file);
  const stat = statFor(file);
  const t0 = performance.now();
  const child = execa(bin, args, options as O);
  const sync = performance.now() - t0;
  stat.count += 1;
  stat.syncMs += sync;
  if (sync > stat.maxSyncMs) stat.maxSyncMs = sync;
  try {
    // execa's ResultPromise<O> does not narrow to Result<O> under a generic O
    // in TS's eyes, though that is exactly what awaiting it yields.
    return (await child) as unknown as Result<O>;
  } finally {
    stat.wallMs += performance.now() - t0;
  }
}
