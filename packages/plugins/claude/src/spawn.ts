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
 * given up, and the one that is given up is named on {@link spawnWithPid}.
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
  /**
   * It exited. Called at most once per {@link PidSink.onSpawn}.
   *
   * `stderrTail` is the last of what the child wrote to stderr, and it has to
   * come out THROUGH HERE because providing a custom spawner is what stops the
   * SDK collecting its own. `SpawnedProcess` declares no `stderr`, so only the
   * SDK's built-in launcher can populate the tail it puts in
   * "Claude Code process exited with code N" — the half of that message that
   * says why. Handing it back lets the session put it back on.
   */
  onExit(pid: number, stderrTail: string): void;
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
 * How long to wait for a dead child's stderr to close before giving up on it.
 *
 * The pipe normally closes within a tick of `exit`; this only covers the case
 * where a grandchild inherited the handle and is holding it open, which would
 * otherwise strand the pid in the registry for the life of the server.
 */
const STDERR_CLOSE_GRACE_MS = 1_000;

/**
 * Build a `spawnClaudeCodeProcess` implementation that reports its pid.
 *
 * ONE DIFFERENCE from the SDK's built-in launcher: it pre-checks that the
 * executable exists, and we let `spawn` fail instead — which surfaces as the
 * `error` event the SDK already listens for. Everything else it does — the
 * stderr tail, `windowsHide` — is reproduced below rather than inherited,
 * because providing a spawner opts out of all of it at once.
 *
 * Its other behaviour, deferring the exit report until stderr has ALSO closed so
 * the tail is complete, is reproduced here rather than given up. See the
 * `settle` comment below for what happens when it isn't.
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
      // Node defaults this to FALSE, so taking the spawn over drops what the
      // SDK's own launcher passes. The installed app runs detached with no
      // console of its own, which is the case every other spawn in this repo
      // sets it for (`codex/rpc.ts`, `services/terminal.ts`, `services/git.ts`,
      // `tools/app/build-payload.mjs`) — without it each session's subprocess
      // pops a console window that was never there before.
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    // A stderr stream that errors (the child died mid-write) must not become an
    // unhandled 'error' event on an EventEmitter nobody else is listening to.
    child.stderr.on("error", () => {});

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
      let grace: NodeJS.Timeout | undefined;
      const release = (): void => {
        if (released) return;
        released = true;
        if (grace) clearTimeout(grace);
        sink.onExit(pid, tail);
      };

      // Report the tail only once stderr has CLOSED as well as the process
      // having exited — which is exactly what the SDK's own launcher does, and
      // for exactly this reason. `exit` fires while the pipe still holds
      // whatever hasn't been read: a child that writes 40 KB and exits delivers
      // its stderr in chunks, so releasing on `exit` (even a tick later) hands
      // back the FIRST chunk and drops the last line — the one that says why.
      // Caught by a test that passed on Windows and failed on Linux, which is
      // the difference between a buffer that happened to drain in one go and
      // one that didn't.
      let exited = false;
      let drained = false;
      const settle = (): void => {
        if (exited && drained) release();
      };
      const onDrained = (): void => {
        drained = true;
        settle();
      };
      child.stderr.once("end", onDrained);
      child.stderr.once("close", onDrained);
      child.once("exit", () => {
        exited = true;
        // BOUNDED, so a stderr that never closes (an inherited handle held open
        // by a grandchild) can't strand the pid in the registry forever.
        grace ??= setTimeout(onDrained, STDERR_CLOSE_GRACE_MS);
        grace.unref?.();
        settle();
      });
      // A child that never starts emits `error` and no `exit`: nothing to drain,
      // and nothing to wait for.
      child.once("error", release);
    }

    return child;
  };
}
