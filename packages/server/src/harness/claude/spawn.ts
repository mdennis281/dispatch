/**
 * The session subprocess, spawned by US rather than by the SDK — purely so its
 * pid is knowable.
 *
 * WHY THIS EXISTS. Every MCP server a session runs is a CHILD of the Claude Code
 * process: one chat carries a `claude` process plus a browser server, an ssh
 * server, whatever the project declares — measured at ~1.3 GB and ~9 processes
 * per chat on a real install. Dispatch has to be able to say "this chat is
 * holding nine processes" on its row, and to reap exactly those on request, and
 * that pid is the root of the only tree that answers either question. The SDK's
 * default spawn keeps it entirely to itself; `spawnClaudeCodeProcess` is the
 * documented seam for taking it over.
 *
 * Deliberately a thin wrapper over `child_process.spawn` and NOTHING else. Every
 * behaviour the SDK's own launcher has is either reproduced here or consciously
 * given up, and the two that are given up are listed on {@link spawnWithPid}.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** What the SDK hands a custom spawner (its `SpawnOptions`, structurally). */
export interface HarnessSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** Told the pid of each session subprocess as it starts and stops. */
export interface PidSink {
  /** A session subprocess is live under this pid. */
  onSpawn(pid: number): void;
  /** It exited. Called at most once per {@link PidSink.onSpawn}. */
  onExit(pid: number): void;
}

/**
 * How much of a doomed child's stderr to keep.
 *
 * The pipe MUST be drained. An unread stderr pipe fills its OS buffer and then
 * blocks the writer forever, and this is not hypothetical here: an unread
 * launcher stderr is what seeded the 106 MB crash-log loop that
 * `session.ts`'s permission-listener comment describes. Draining to nowhere
 * would be enough to prevent that, but the SDK's own launcher deliberately
 * holds a stderr tail so an exit error can quote it — so keep a bounded one and
 * lose neither property.
 */
const STDERR_TAIL_LIMIT = 8_192;

/**
 * Build a `spawnClaudeCodeProcess` implementation that reports its pid.
 *
 * TWO DIFFERENCES from the SDK's built-in launcher, both documented by it:
 *
 *  - It pre-checks that the executable exists; we let `spawn` fail instead,
 *    which surfaces as the `error` event the SDK already listens for.
 *  - It defers `exit` until stderr has also closed, so an exit error carries a
 *    complete tail. A custom spawner emits plain process exit — so the tail is
 *    kept here (see {@link STDERR_TAIL_LIMIT}) and attached to the child for a
 *    caller that wants it, rather than being reconstructed after the fact.
 *
 * `signal` is the SDK's FORWARDED signal, not the caller's: it fires only after
 * the stdin-EOF + ~2 s grace window, so handing it to `spawn` is safe and is
 * what gives the child its chance to shut down cleanly before the kill lands.
 */
export function spawnWithPid(sink: PidSink) {
  return (options: HarnessSpawnOptions): ChildProcessWithoutNullStreams => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      // stderr is PIPED, not ignored: `ignore` would make the tail impossible,
      // and the buffer hazard is handled by draining it below rather than by
      // refusing to have one.
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    // A stderr stream that errors (the child died mid-write) must not become an
    // unhandled 'error' event on an EventEmitter nobody else is listening to.
    child.stderr.on("error", () => {});
    Object.defineProperty(child, "stderrTail", { get: () => tail });

    // `pid` is undefined when the spawn itself failed synchronously (ENOENT on
    // the executable). There is no process to count or to reap, and the SDK
    // learns about it through the `error` event either way.
    const { pid } = child;
    if (typeof pid === "number") {
      sink.onSpawn(pid);
      // `once`, and on BOTH terminal events: a child that never starts emits
      // `error` and no `exit`, which would otherwise leak the pid into the
      // registry until something else swept it.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        sink.onExit(pid);
      };
      child.once("exit", release);
      child.once("error", release);
    }

    return child;
  };
}
