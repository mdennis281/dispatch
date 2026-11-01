/**
 * TerminalService — named, PERSISTENT shells for the agent.
 *
 * The Bash tool resets cwd/env every call. This service gives a chat a set of
 * long-lived shells (keyed by name) whose cwd + environment survive across
 * commands, exposed to the agent as `mcp__dispatch-workspace__terminal` and mirrored
 * read-only in the UI.
 *
 * ── Backend chosen: a long-lived shell reading a PIPED stdin ─────────────────
 * `powershell.exe -Command -` on Windows; `bash` (falling back to `sh`) on
 * macOS and Linux. The POSIX half was MISSING until the install smoke ran a
 * terminal on a macOS runner: every platform spawned `powershell.exe`, the
 * spawn failed with ENOENT, and the terminal tool, the Terminals panel and
 * `run_subapp`-adjacent shells all reported "Terminal has exited." on the two
 * OSes this repo had never run a terminal on. The protocol below is the same
 * on both — only the spawn and the probe line differ (see `shellFor`).
 *
 * ── Why this shape and not node-pty ─────────────────────────────────────────
 * We deliberately DID NOT use node-pty. Its native postinstall build is gated
 * off by pnpm's `allowBuilds` policy on this repo, and a real ConPTY stream
 * carries ANSI + prompt-echo + line-wrapping that has to be parsed back out —
 * fragile and hard to unit-test. A plain `child_process` shell reading a piped
 * stdin gives us everything we need and is trivially fakeable in tests:
 *
 *   • `powershell -NoLogo -NoProfile -Command -` reads stdin line-by-line and
 *     executes INCREMENTALLY (verified) — not buffered-until-EOF.
 *   • Piped stdin → NO prompt string, NO command echo: stdout is just the
 *     command's real output; errors land on stderr. cwd (`Set-Location`) and
 *     env (`$env:X=…`) persist between writes because it's one live process.
 *
 * Per command we append a unique SENTINEL probe line that prints the exit code,
 * `$?`, and `$PWD.Path`; when we see that marker on stdout the command is done
 * and we can report `{ output, exitCode, cwd }`. Runs on one terminal are
 * serialized so output attribution stays clean. The command itself runs with
 * its stdin cut off from that pipe (`commandWrite`), or a command that reads
 * stdin would eat the probe.
 *
 * The shell spawn is injected (`deps.spawn`) so tests drive a scripted fake
 * process — no real PowerShell, fully deterministic.
 *
 * ── Plugin terminal backends (#414) ─────────────────────────────────────────
 * A plugin can register somewhere ELSE for a chat's shells to run (a container,
 * a VM). The protocol above needs nothing but a line of text each way, so a
 * backend only answers "get me a shell over there" and everything else —
 * sentinel, scrollback, background runs, transcripts — stays here, unchanged.
 *
 * Two things differ. Provisioning is slow, so a backend's spawn is ASYNC: the
 * terminal registers at once with a placeholder process and its run queue
 * starts on the connect, so a command written meanwhile waits rather than
 * going to a shell that does not exist yet. And a backend fails — the
 * hypervisor API has had outages — so a spawn that rejects or overruns its
 * deadline brings up a LOCAL shell instead, and says so in the terminal, in
 * the chat and in the next tool result. A silent fallback would be worse than
 * none: the agent would believe its tests ran in the container.
 *
 * With no backend registered, `open()` takes the original synchronous path
 * and none of the backend fields below is ever set — "nothing changes" is
 * literal.
 *
 * ── Background commands, and why they belong HERE ────────────────────────────
 * A dev server can't run through the sentinel path: `vite --port …` never
 * returns, so the marker never lands and that shell is wedged for the rest of
 * the chat. Agents therefore reached for the harness's own
 * `Bash/PowerShell{run_in_background:true}`, which spawns a grandchild of the
 * `claude` subprocess that Dispatch has NO record of — invisible to the Ports &
 * processes panel and orphaned when the session goes away. (One `the-salesman`
 * chat left four Vite servers and four npc-sim servers on 478xx that way.)
 *
 * `run({background:true})` closes that hole: same named shell, same scrollback,
 * but the call returns as soon as the command is WRITTEN instead of waiting for
 * the marker. The shell stays registered, so its pid is a handle the panel can
 * list, attribute to a chat, and tree-kill.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import treeKill from "tree-kill";
import { nanoid } from "nanoid";
import {
  applyRegistryQuery,
  LOCAL_TERMINAL_BACKEND,
  TERMINAL_RUN_HOOK_MAX_TIMEOUT_MS,
  TERMINAL_RUN_HOOK_TIMEOUT_MS,
  type RegistryQuery,
  type TerminalAfterRunInfo,
  type TerminalBackend,
  type TerminalExitReason,
  type TerminalLocation,
  type TerminalInfo,
  type TerminalLineRecord,
  type TerminalOrigin,
  type TerminalRecord,
  type TerminalStallInfo,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";

/* ------------------------------------------------------------------ spawn seam */

/** The minimal writable-stdin stream surface we drive. */
export interface ShellStdin {
  write(chunk: string): void;
  end?(): void;
  /**
   * Optional because the test fakes are plain objects, but a REAL stdin is an
   * emitter that reports EPIPE / ERR_STREAM_DESTROYED asynchronously — and an
   * unlistened 'error' event is an uncaught exception that kills the server.
   */
  on?(event: "error", listener: (err: Error) => void): void;
}

/** The minimal readable stream surface we consume (stdout/stderr). */
export interface ShellReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
}

/** The minimal child-process surface TerminalService depends on (real or fake). */
export interface ShellProcess {
  stdin: ShellStdin;
  stdout: ShellReadable;
  stderr: ShellReadable;
  kill(signal?: string): void;
  /**
   * `reason` is a {@link TerminalExitReason} from a backend handle — or, from a
   * real ChildProcess, the signal NAME string Node passes there. Only an
   * object with a `kind` counts (see `exitReasonOf`).
   */
  on(event: "exit", listener: (code: number | null, reason?: unknown) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  /** Backend handles only (see `TerminalBackendHandle`); a local shell never emits them. */
  on(event: "stalled", listener: (info?: TerminalStallInfo) => void): void;
  on(event: "resumed", listener: () => void): void;
  /**
   * Present on a real child process; absent on the test fakes. It is the handle
   * everything downstream hangs off — `ProcessService` walks the process table
   * DOWN from it to attribute a stray listener to this chat, and `kill()` tree-
   * kills it. Without it we could only kill the shell itself and would leave the
   * dev server it started running (the exact orphan this service exists to stop).
   */
  pid?: number;
}

/** Factory for a shell process rooted at `cwd`. Defaults to piped PowerShell. */
export type SpawnShell = (cwd: string) => ShellProcess;

/**
 * Which shell this platform drives, and how to ask it for the sentinel.
 *
 * Both shells execute a piped stdin INCREMENTALLY, line by line, which is what
 * the whole design rests on; both keep cwd and env across writes because they
 * are one live process. `bash` over `$SHELL` on purpose: zsh is the macOS
 * default and reads a pipe just as well, but the probe below is written once
 * and bash is the one shell present on every macOS and Linux box this can
 * land on (`sh` only as the last resort, where `$?` and `printf` still hold).
 */
export type ShellFlavour = "powershell" | "posix";
export const shellFlavour: ShellFlavour = process.platform === "win32" ? "powershell" : "posix";

/** Default shell: a persistent, stdin-piped PowerShell or bash (see file header). */
export const defaultSpawnShell: SpawnShell = (cwd) =>
  (shellFlavour === "powershell"
    ? nodeSpawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-Command", "-"],
        { cwd, windowsHide: true, env: process.env },
      )
    : nodeSpawn(posixShell(), [], { cwd, env: process.env })) as unknown as ShellProcess;

/** `bash` where it exists, else `sh`. Resolved per spawn: PATH can change. */
function posixShell(): string {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const name of ["bash", "sh"]) {
    for (const dir of dirs) {
      try {
        if (statSync(join(dir, name)).isFile()) return join(dir, name);
      } catch {
        /* not here */
      }
    }
  }
  return "/bin/sh";
}

/**
 * The probe line for one flavour: prints `<marker>|<exit>|<ok>|<cwd>` on
 * stdout right after the command, so `onLine` can resolve the run. Exported
 * for the unit tests, which drive a fake shell and only need the text.
 */
export function probeLine(marker: string, flavour: ShellFlavour = shellFlavour): string {
  if (flavour === "powershell") {
    // Capture $?/$LASTEXITCODE before anything else can change them — the
    // stdin restore included (see `commandWrite`).
    // `[Console]::Out.Flush` is implicit for Write-Output; the piped shell
    // flushes per line.
    return (
      `$__cm_ok = $?; $__cm_ec = $LASTEXITCODE; ${PS_STDIN_RESTORE}; ` +
      `Write-Output ("${marker}|" + $(if ($null -ne $__cm_ec) { $__cm_ec } ` +
      `elseif ($__cm_ok) { 0 } else { 1 }) + "|" + $__cm_ok + "|" + $PWD.Path)`
    );
  }
  // `$?` first, on the same line, before any other command can overwrite it.
  // `True`/`False` to match PowerShell's `$?` spelling, so the parser is one.
  return (
    `__cm_ec=$?; printf '%s|%s|%s|%s\\n' '${marker}' "$__cm_ec" ` +
    `"$([ "$__cm_ec" -eq 0 ] && echo True || echo False)" "$PWD"`
  );
}

/**
 * The PowerShell half of {@link commandWrite}: a kernel32 helper that points
 * the process's standard-input handle at NUL and back. One line of C# inside a
 * single-quoted PowerShell string, so it may contain no `'`. Every call is
 * caught, because a stdin that cannot be detached must never fail the command.
 */
const PS_STDIN_TYPE = "DispatchTerminal.Stdin";
const PS_STDIN_CS = [
  "using System; using System.Runtime.InteropServices;",
  "namespace DispatchTerminal { public static class Stdin {",
  '[DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);',
  '[DllImport("kernel32.dll")] static extern bool SetStdHandle(int n, IntPtr h);',
  '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  "[StructLayout(LayoutKind.Sequential)] struct SA { public int n; public IntPtr d; public int inherit; }",
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string f, uint a, uint s, ref SA sa, uint c, uint fl, IntPtr t);',
  "static bool swapped; static IntPtr saved, nul;",
  // An INHERITABLE handle to NUL (GENERIC_READ, share read|write,
  // OPEN_EXISTING): a child inherits the process's std handles, not .NET's.
  "public static void Detach() { Restore(); try { var sa = new SA(); sa.n = Marshal.SizeOf(sa); sa.inherit = 1;",
  ' var h = CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero); if (h == IntPtr.Zero || h == new IntPtr(-1)) return;',
  " nul = h; saved = GetStdHandle(-10); swapped = SetStdHandle(-10, h); } catch { } }",
  "public static void Restore() { try { if (swapped) SetStdHandle(-10, saved); if (nul != IntPtr.Zero) CloseHandle(nul); } catch { }",
  " swapped = false; saved = IntPtr.Zero; nul = IntPtr.Zero; }",
  "} }",
].join(" ");
/** Compiles the helper — once per shell, and only on Windows. A failure (constrained language mode) is silent. */
const PS_STDIN_SETUP =
  `try { if (-not ('${PS_STDIN_TYPE}' -as [type]) -and [Environment]::OSVersion.Platform -eq 'Win32NT') ` +
  `{ Add-Type -TypeDefinition '${PS_STDIN_CS}' -ErrorAction Stop } } catch { }`;
// `try` because a locked-down shell may refuse even the type lookup, and that
// must not print an error on every command.
const PS_STDIN_DETACH = `try { if ('${PS_STDIN_TYPE}' -as [type]) { [${PS_STDIN_TYPE}]::Detach() } } catch { }`;
const PS_STDIN_RESTORE = `try { if ('${PS_STDIN_TYPE}' -as [type]) { [${PS_STDIN_TYPE}]::Restore() } } catch { }`;

/**
 * The command as written to the shell, with its stdin cut off from the
 * shell's own.
 *
 * Everything core writes goes down ONE pipe: the command, its probe, then the
 * next command. A program the command started inherited that pipe as its
 * stdin, so anything that reads stdin — `cat` with no file, `ssh`, a `git`
 * credential prompt, `python` with no script, bash's `read` — ate the probe
 * and whatever came after it. The marker never printed, the run sat out its
 * whole timeout, and the agent's NEXT command arrived as that program's input
 * instead of the shell's. Nothing in Dispatch feeds a running command (a run
 * holds its shell until the marker lands, and a backgrounded shell refuses new
 * runs), so every command gets EOF instead. Background runs too: a dev server
 * that read stdin would swallow its probe, and the shell would stay wedged
 * after the server exited.
 *
 * - posix: a brace group redirected from /dev/null. Braces, not a subshell, so
 *   `cd` and `export` still persist, and `$?` after it is the command's. `:`
 *   keeps a comment-only command from being an empty group (a syntax error),
 *   the newlines before `}` let the command end in a comment or in a `\`
 *   continuation.
 * - PowerShell has no redirection for that: a native child inherits the
 *   PROCESS's standard-input handle. So the line before the command points
 *   that handle at NUL, and the probe puts it back once it has read `$?`.
 *   PowerShell's own reading of the pipe is unaffected; it keeps the reader
 *   it opened at start-up. `firstOnShell` adds the helper's compile (~250 ms,
 *   once). Where it can't compile, commands run as they always did.
 *
 * The probe stays a SEPARATE write after this one: backend plugins have told
 * the two apart by the probe's prefix since before `beforeRun` existed.
 */
export function commandWrite(command: string, flavour: ShellFlavour, firstOnShell: boolean): string {
  if (flavour === "powershell") {
    return `${firstOnShell ? `${PS_STDIN_SETUP}; ` : ""}${PS_STDIN_DETACH}\n${command}\n`;
  }
  return `{ :; ${command}\n\n} </dev/null\n`;
}

/* ---------------------------------------------------------------------- deps */

/**
 * Tree-kills a process and every descendant (Windows-safe).
 *
 * Returns a promise where the caller needs to know the tree walk has FINISHED —
 * see the ordering note in `killProc`, where not knowing that was letting a dev
 * server outlive the shell that started it. Allowed to return `void` so a test
 * fake can stay a one-liner.
 */
export type KillTreeFn = (pid: number) => void | Promise<void>;

/** Default: `tree-kill`, same primitive RunnerService and ProcessService use. */
const defaultKillTree: KillTreeFn = (pid) =>
  new Promise<void>((resolve) => treeKill(pid, "SIGTERM", () => resolve()));

/**
 * What the selection rule decided for one chat — supplied by the
 * `TerminalBackendRegistry`, narrowed here so tests can fake it.
 */
export interface TerminalBackendResolution {
  /** The id the chat → project → `local` rule produced. */
  requested: string;
  /** The registered backend `requested` names. Absent for `local` AND for a missing one. */
  backend?: TerminalBackend;
  /** `requested` names no registered backend (its plugin is uninstalled or off). */
  missing?: boolean;
  /** The project's primary checkout, handed to the backend's spawn. */
  repoPath?: string;
  /** The chat's worktree, when it has one, handed to the backend's spawn. */
  worktreePath?: string;
  /** The branch checked out at the chat's root, handed to the backend's spawn. */
  branch?: string;
  /** Core's agent-facing note for this backend (where the shell runs, what that means). */
  note?: string;
}

/** The registry, as TerminalService sees it. */
export interface TerminalBackendSource {
  /** Registered backends. */
  readonly size: number;
  /**
   * Whether this chat's shell needs resolving at all. False ⇒ the synchronous
   * local path, exactly as before backends existed. Optional so a fake can
   * leave it out, in which case `size > 0` decides.
   */
  wantsResolve?(ident: { chatId: string; projectId?: string }): boolean;
  /** `location` is the agent's per-terminal pick; absent ⇒ the chat → project → local rule. */
  resolve(ident: { chatId: string; projectId?: string }, location?: string): Promise<TerminalBackendResolution>;
}

/** How long a backend's spawn may take before the shell falls back to local. */
export const DEFAULT_BACKEND_SPAWN_TIMEOUT_MS = 120_000;
const MAX_BACKEND_SPAWN_TIMEOUT_MS = 600_000;

export interface TerminalServiceDeps {
  spawn?: SpawnShell;
  /** Which probe dialect the injected `spawn` speaks; defaults to this platform's. */
  flavour?: ShellFlavour;
  genId?: () => string;
  now?: () => number;
  killTree?: KillTreeFn;
}

export interface TerminalServiceOptions {
  bus: EventBus;
  /** Max concurrent shells per chat (default 8). */
  maxPerChat?: number;
  /** Retained output lines per terminal for reconnect scrollback (default 500). */
  scrollbackCap?: number;
  /**
   * Durable roster + transcripts. Without it the service behaves exactly as it
   * did before — in-memory only — which is what every unit test wants.
   */
  store?: Store;
  /** How long a transcript is kept before the sweep drops it (default 7 days). */
  retentionMs?: number;
  /** Write-behind flush cadence for output lines (default 1s). */
  flushIntervalMs?: number;
  /**
   * The most one command's deadline may be paused by transport stalls, in
   * total (default {@link DEFAULT_STALL_PAUSE_MAX_MS}). Past it the clock runs
   * again even while stalled, so a backend that says `stalled` and then never
   * `resumed` nor `exit` cannot hang a call forever.
   */
  stallPauseMaxMs?: number;
  /** Plugin terminal backends. Absent (or empty) ⇒ every shell is local. */
  backends?: TerminalBackendSource;
  deps?: TerminalServiceDeps;
}

/** One buffered output line (for reconnect scrollback). */
export interface TerminalLine {
  stream: "command" | "stdout" | "stderr";
  chunk: string;
  ts: number;
}

/** Arguments for a single `run`. */
export interface RunTerminalArgs {
  chatId: string;
  /** Project the chat belongs to — recorded so the catalog can scope by it. */
  projectId?: string;
  /** Who is opening this shell. Default `"agent"` (the MCP tool's caller). */
  origin?: TerminalOrigin;
  name: string;
  command: string;
  /** Default cwd for a first-time spawn of this terminal (worktree / repo). */
  cwd?: string;
  timeoutMs?: number;
  /** Cancels the wait (session abort) — the shell stays alive. */
  signal?: AbortSignal;
  /**
   * Start the command and return immediately, without waiting for it to finish.
   * For things that never finish on purpose — a dev server, a watcher, a tail.
   * Output keeps streaming into this terminal's scrollback (readable with
   * `tail()`), and the shell stays busy until the command actually exits.
   */
  background?: boolean;
  /**
   * Where a NEW shell for this name runs — `local` or a backend id — chosen by
   * the agent per terminal. Validated against the allowed list by the caller.
   * Fixed for the shell's life: a different one for a live shell is refused
   * (see {@link TerminalService.run}). Absent ⇒ the chat → project → local rule.
   */
  location?: string;
}

/** Where a run actually happened, as a result reports it. */
export interface TerminalRanOn {
  /** `local`, or the backend id serving the shell. A fallback reports `local`. */
  id: string;
  label: string;
  /** Set when the shell is local only because `label`'s backend could not serve it. */
  fallbackFrom?: string;
}

/** Result surfaced to the agent (and logged). */
export interface RunTerminalResult {
  output: string;
  exitCode: number | null;
  cwd: string;
  /** Set when the run could not complete (cap hit / timeout / cancelled). */
  error?: string;
  timedOut?: boolean;
  /** True when this returned early because `background` was requested. */
  backgrounded?: boolean;
  /**
   * Said ONCE per shell, on the first result after it opened: where it runs
   * (a backend's note) or why it is not running where the chat asked (a
   * fallback) — and, when it replaced a shell of the same name that ended,
   * that its cwd and environment started over.
   */
  notice?: string;
  /**
   * The shell ended under this command, with the reason its backend gave. A
   * `transport-lost` or `killed` reason also sets `error`: the command's
   * outcome is unknown, or it did not finish.
   */
  shellExit?: TerminalExitReason;
  /**
   * Where this run happened. Set whenever a backend is in play for the chat
   * (one is registered, or the shell asked for one), so on an install with no
   * backend plugin a result is exactly what it always was.
   */
  ranOn?: TerminalRanOn;
  /**
   * The serving backend's `beforeRun` refused the command, so it was never
   * written to the shell; `error` says why.
   */
  refused?: boolean;
  /**
   * Lines about this run for the agent: the serving backend's `beforeRun` /
   * `afterRun` notices in that order, and core's own (a stall it waited out).
   */
  notices?: string[];
}

/* ------------------------------------------------------------------- markers */

/** A distinctive prefix + a per-run nonce → a marker that can't collide with
 *  real command output. The marker line the shell prints after each command is
 *  `<prefix><nonce>|<exit>|<ok>|<cwd>` (cwd last; a path may itself contain `|`). */
const SENTINEL_PREFIX = "CMTERMSENTINEL_";

/**
 * How long, in total, transport stalls may pause one command's deadline. A
 * stall is "not given up yet", and a backend whose half-open connection never
 * resolves would otherwise leave the call waiting forever (review on #476).
 */
export const DEFAULT_STALL_PAUSE_MAX_MS = 600_000;

/** Default per-command timeout (10 min) — a runaway build shouldn't wedge a run. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** How long a terminal's transcript is kept before the sweep drops it. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * How core stopped waiting on a command it meant to write. `backgrounded` is
 * the early return; `not-written` never reached the shell (a dead stdin, a
 * caller that had already cancelled).
 */
interface RunEnd {
  result: RunTerminalResult;
  outcome: TerminalAfterRunInfo["outcome"] | "backgrounded" | "not-written";
  durationMs: number;
}

/** How a run hook ended, as {@link TerminalService.callHook} reports it. */
type HookOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "threw"; message: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "exited" };

/** A hook's notices, minus anything that is not a non-empty string. */
function cleanNotices(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trimEnd());
}

/**
 * What `afterRun` leaves for the result. The command already ran, so a hook
 * that fails is a NOTICE, never a failed run — but it is said, because it
 * usually means changes the command made over there did not come back.
 */
function afterNotices(o: HookOutcome<unknown>, label: string, ms: number): string[] {
  switch (o.kind) {
    case "done":
      return cleanNotices((o.value as { notices?: unknown } | undefined)?.notices);
    case "threw":
      return [`${label} failed after the command ran: ${o.message}`];
    case "timeout":
      return [`${label} did not finish its after-run step within ${Math.round(ms / 1000)}s.`];
    default:
      return [];
  }
}

/** Shorten a command for a one-line error message. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/* ------------------------------------------------------------- internal state */

interface Terminal {
  id: string;
  /** Filename-safe id for this shell's persisted transcript. */
  logId: string;
  chatId: string;
  projectId?: string;
  origin: TerminalOrigin;
  name: string;
  cwd: string;
  status: "live" | "exited";
  busy: boolean;
  lastCommand?: string;
  lastExitCode: number | null;
  createdAt: number;
  updatedAt: number;
  /** Last output/command touch — what `since` filters and the sweep read. */
  lastActivityAt: number;
  /** Retained transcript size, counting what's already on disk. */
  lines: number;
  bytes: number;
  /** Output lines written but not yet flushed to the transcript. */
  unflushed: TerminalLineRecord[];
  proc: ShellProcess;
  /** Partial line buffers per stream (chunks split mid-line). */
  stdoutBuf: string;
  stderrBuf: string;
  scrollback: TerminalLine[];
  /** Serializes runs on this terminal (each waits for the previous marker). */
  queue: Promise<unknown>;
  /** The in-flight run's marker resolver, if any. `exited`: the shell died under it. */
  pending?: {
    marker: string;
    resolve: (r: { exitCode: number | null; cwd: string; exited?: boolean }) => void;
    output: string[];
    /** Stop / restart the command's deadline while the transport is stalled. */
    pause?: () => void;
    resume?: () => void;
  };
  /** Set while the backend's transport is stalled (its handle's `stalled` event). */
  stall?: { since: number; detail?: string };
  /** Why the shell ended, when its backend said. */
  exitReason?: TerminalExitReason;
  /**
   * Set on a shell opened in place of one of the same name that had ENDED —
   * the agent's cwd and env did not survive, and nothing else tells it.
   * Delivered (with `notice`) on the next result, then cleared.
   */
  respawnNotice?: string;
  /** Stops waiting on an in-flight `beforeRun` when the shell goes away under it. */
  hookStop?: () => void;
  /** Set while a `background` command holds this shell (see `run`). */
  background?: { command: string; since: number };
  /** The probe dialect THIS shell speaks — a backend's bash under a Windows host. */
  flavour: ShellFlavour;
  /** A command has been written, so a PowerShell has compiled its stdin helper (see `commandWrite`). */
  wroteCommand?: boolean;
  /** Where it runs, when a backend was involved (see {@link TerminalLocation}). */
  location?: TerminalLocation;
  /** The registered backend actually serving this shell (not set on a fallback). */
  backendId?: string;
  /** That backend, for its per-run hooks. */
  backend?: TerminalBackend;
  /**
   * The location this shell was opened FOR — the agent's `location`, else what
   * the chat → project → local rule resolved to. Unset only while a shell with
   * no explicit location is still resolving. What a later `location` is
   * compared against; a fallback keeps the id it asked for, so asking for the
   * same place again is not "a different location".
   */
  placement?: string;
  /** Delivered with the next run result, then cleared. */
  notice?: string;
}

/**
 * Stands in for a shell whose backend is still provisioning. Nothing is ever
 * written to it — runs queue behind the connect — so all it has to do is
 * notice being killed, and tell the backend to give up via the signal.
 */
class ConnectingShell implements ShellProcess {
  readonly abort = new AbortController();
  killed = false;
  readonly stdin = {
    write: (): void => {
      throw new Error("Terminal is still connecting.");
    },
  };
  readonly stdout = { on: (): void => {} };
  readonly stderr = { on: (): void => {} };
  kill(): void {
    this.killed = true;
    this.abort.abort();
  }
  on(): void {}
}

/* =============================================================== TerminalService */

export class TerminalService {
  private readonly bus: EventBus;
  private readonly spawn: SpawnShell;
  private readonly flavour: ShellFlavour;
  private readonly genId: () => string;
  private readonly now: () => number;
  private readonly maxPerChat: number;
  private readonly scrollbackCap: number;
  private readonly killTree: KillTreeFn;

  private readonly store?: Store;
  private readonly backends?: TerminalBackendSource;
  private readonly retentionMs: number;
  private readonly flushIntervalMs: number;
  private readonly stallPauseMaxMs: number;

  private readonly terminals = new Map<string, Terminal>();
  /**
   * Rows whose shell this process does not own — restored at boot, or left
   * behind by a shell that has since exited. Readable, not runnable.
   */
  private readonly archived = new Map<string, TerminalRecord>();
  private flushTimer?: ReturnType<typeof setInterval>;
  /**
   * Writes started but not awaited — the row a shell writes when it opens, and
   * the archive a `kill` fires and forgets.
   *
   * Tracked so {@link flush} is a real BARRIER rather than "everything I knew
   * about a tick ago". Without it, "the transcript survived the kill" was true
   * only if you looked late enough, and teardown had no way to wait for the
   * tail of a dying shell to reach disk before the process went away.
   */
  private readonly pendingWrites = new Set<Promise<unknown>>();
  /** In-flight tree-kills, so {@link reap} can prove the trees actually went. */
  private readonly pendingKills = new Set<Promise<unknown>>();

  constructor(opts: TerminalServiceOptions) {
    this.bus = opts.bus;
    this.spawn = opts.deps?.spawn ?? defaultSpawnShell;
    this.flavour = opts.deps?.flavour ?? shellFlavour;
    this.genId = opts.deps?.genId ?? (() => nanoid());
    this.now = opts.deps?.now ?? (() => Date.now());
    this.killTree = opts.deps?.killTree ?? defaultKillTree;
    this.maxPerChat = Math.max(1, opts.maxPerChat ?? 8);
    this.scrollbackCap = Math.max(1, opts.scrollbackCap ?? 500);
    this.store = opts.store;
    this.backends = opts.backends;
    this.retentionMs = Math.max(60_000, opts.retentionMs ?? DEFAULT_RETENTION_MS);
    this.flushIntervalMs = Math.max(100, opts.flushIntervalMs ?? 1_000);
    this.stallPauseMaxMs = Math.max(0, opts.stallPauseMaxMs ?? DEFAULT_STALL_PAUSE_MAX_MS);
  }

  private static key(chatId: string, name: string): string {
    return `${chatId}::${name}`;
  }

  /* --------------------------------------------------------------- run */

  /**
   * Run `command` in the named persistent shell for `chatId`, spawning it lazily.
   * Resolves with the command's captured output, exit code, and the shell's cwd
   * AFTER the command (so `cd` is reflected and persists to the next call).
   */
  async run(args: RunTerminalArgs): Promise<RunTerminalResult> {
    const name = args.name.trim() || "main";
    const key = TerminalService.key(args.chatId, name);
    let term = this.terminals.get(key);

    if (!term || term.status === "exited") {
      // Enforce the cap whenever this is about to make a shell LIVE — which
      // includes reviving an exited one. `atCap` counts only live shells, so an
      // exited record is not occupying a slot; spawning into it while already at
      // cap is what puts the chat over. Guarding on `!term` alone let a chat
      // exceed `maxPerChat` by reopening exited names (review caught this).
      if (this.atCap(args.chatId)) {
        return {
          output: "",
          exitCode: null,
          cwd: args.cwd ?? "",
          error: this.capMessage(),
        };
      }
      // Reopening a name is NOT carrying on in the same shell: whatever the
      // agent `cd`'d into and exported went with the old one. Until this was
      // said, a shell that died between calls (a dropped connection, above all)
      // came back silently and the agent's next relative path ran in the wrong
      // directory.
      const replaced = term
        ? this.endedHow(term)
        : this.archived.has(key)
          ? "was closed, or Dispatch restarted"
          : undefined;
      term = this.open(key, name, args.cwd ?? process.cwd(), args);
      if (replaced) {
        term.respawnNotice =
          `Terminal '${name}' is a NEW shell: the one before it under this name ${replaced}. ` +
          `Nothing carried over — it starts in its default directory with a fresh environment, ` +
          `so \`cd\` and set any variables again.`;
      }
    } else {
      const moved = this.locationConflict(term, name, args.location);
      if (moved) return moved;
    }

    // A background command owns its shell until it exits. Queueing behind it
    // would silently hang the caller for as long as the dev server lives, so
    // refuse immediately and say which name is occupied — the agent's next move
    // is another terminal, not a ten-minute wait for a timeout.
    const held = this.backgroundBusy(term, name);
    if (held) return held;

    // Serialize behind any in-flight run on this terminal…
    const gate = term.queue.catch(() => {});
    // …and re-check AFTER the gate. Two calls can arrive before either has run:
    // the second passes the check above (the first hasn't written its command
    // yet, so `background` is still unset), then waits, and the first — which
    // resolves as soon as it is written — leaves the shell held. Without this
    // second look the queued caller falls into `exec` behind a dev server and
    // hangs for the full timeout, which is the exact failure this guards.
    //
    // The location is re-checked here too: a shell opened with no `location`
    // only learns where it runs once it has resolved, which is this gate.
    const run = gate.then(
      () =>
        this.locationConflict(term!, name, args.location) ??
        this.backgroundBusy(term!, name) ??
        this.exec(term!, args),
    );
    term.queue = run.catch(() => {});
    return run;
  }

  /** The refusal for a shell a background command holds, or null if it's free. */
  private backgroundBusy(term: Terminal, name: string): RunTerminalResult | null {
    if (!term.background) return null;
    return {
      output: "",
      exitCode: null,
      cwd: term.cwd,
      error:
        `Terminal '${name}' is busy running a background command ` +
        `(${truncate(term.background.command, 60)}). Use a different terminal name, ` +
        `read this one with terminal_output, or stop it from the Terminals tab.`,
    };
  }

  /**
   * The refusal for a `location` that differs from where this live shell runs,
   * or null. Refused rather than honoured by respawning (that would kill
   * whatever the shell holds — a cwd, an env, a dev server) or ignored (the
   * agent would believe the command ran where it asked).
   */
  private locationConflict(term: Terminal, name: string, location: string | undefined): RunTerminalResult | null {
    if (!location || term.status !== "live" || term.placement === undefined) return null;
    if (term.placement === location) return null;
    // A fallback keeps the id it ASKED for as its placement, but its commands
    // run here — naming the backend would tell the agent a falsehood about
    // where its last commands ran (review on #452).
    const where =
      term.location?.state === "fallback"
        ? `this machine (a fallback — ${term.location.label} could not start it)`
        : (term.location?.label ?? (term.placement === LOCAL_TERMINAL_BACKEND ? "this machine" : term.placement));
    return {
      output: "",
      exitCode: null,
      cwd: term.cwd,
      error:
        `Terminal '${name}' already runs on ${where} (\`${term.placement}\`); a terminal's location is ` +
        `fixed for its life. Use a different terminal name to run on \`${location}\`, or omit \`location\` ` +
        `to keep using this one.`,
    };
  }

  /** True when this chat already holds `maxPerChat` LIVE shells. */
  private atCap(chatId: string): boolean {
    const live = [...this.terminals.values()].filter(
      (t) => t.chatId === chatId && t.status === "live",
    ).length;
    return live >= this.maxPerChat;
  }

  private capMessage(): string {
    return `Terminal cap reached (${this.maxPerChat} shells for this chat). Reuse an existing terminal name.`;
  }

  /**
   * Open a named shell with NOTHING in it, and hand back its snapshot.
   *
   * `run()` already spawns lazily, which is all `mcp__dispatch-workspace__terminal` ever
   * needed — the agent always arrives with a command. A human pressing "New
   * shell" does not, and until this existed the only way to get a terminal at
   * all was to ask an agent for one, so the Terminals tab was permanently empty
   * for anyone who never had. Re-opening a name that is already live returns the
   * existing shell rather than a second one, so a double-click can't strand a
   * powershell process the UI has no handle on.
   */
  create(
    chatId: string,
    name: string,
    cwd: string,
    opts: { projectId?: string; origin?: TerminalOrigin } = {},
  ): { terminal?: TerminalInfo; error?: string } {
    const trimmed = name.trim() || "main";
    const key = TerminalService.key(chatId, trimmed);
    const existing = this.terminals.get(key);
    if (existing?.status === "live") return { terminal: this.view(existing) };
    // Same rule as `run()`: reviving an EXITED name still spawns a live shell,
    // so it has to clear the cap too — `atCap` counts live only.
    if (this.atCap(chatId)) return { error: this.capMessage() };
    return {
      terminal: this.view(
        this.open(key, trimmed, cwd, {
          chatId,
          projectId: opts.projectId,
          origin: opts.origin ?? "ui",
        }),
      ),
    };
  }

  /** Spawn + register a shell for `key`. */
  private open(
    key: string,
    name: string,
    cwd: string,
    ident: { chatId: string; projectId?: string; origin?: TerminalOrigin; location?: string },
  ): Terminal {
    // A registered backend, or a pin to one that is not registered right now,
    // means this chat MIGHT run elsewhere — and finding out is async (the pin
    // is on disk). Otherwise spawn here and now, exactly as before backends
    // existed. Checking `size` alone let a chat pinned to the only backend
    // plugin, while it was off, get a local shell with no warning at all.
    //
    // An explicit `location` decides on its own: `local` is a plain local shell
    // even in a chat pinned elsewhere, and anything else must be resolved even
    // when the chat itself has no pin the sync cache would know about.
    const backends = this.backends;
    const location = ident.location || undefined;
    const resolveFirst = !backends
      ? false
      : location
        ? location !== LOCAL_TERMINAL_BACKEND
        : (backends.wantsResolve?.({ chatId: ident.chatId, projectId: ident.projectId }) ?? backends.size > 0);
    const connecting = resolveFirst ? new ConnectingShell() : undefined;
    const proc = connecting ?? this.spawn(cwd);
    const now = this.now();
    // Re-opening a name whose transcript we still hold keeps writing to the SAME
    // log: a shell that died and was restarted under one name is one story, and
    // splitting it in two would lose exactly the "what happened before it died?"
    // the persistence is for.
    const prior = this.archived.get(key);
    const term: Terminal = {
      id: key,
      logId: prior?.logId ?? this.genId(),
      chatId: ident.chatId,
      projectId: ident.projectId ?? prior?.projectId,
      origin: ident.origin ?? "agent",
      name,
      cwd,
      status: "live",
      busy: false,
      lastExitCode: null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      lastActivityAt: now,
      lines: prior?.lines ?? 0,
      bytes: prior?.bytes ?? 0,
      unflushed: [],
      proc,
      stdoutBuf: "",
      stderrBuf: "",
      scrollback: [],
      queue: Promise.resolve(),
      flavour: this.flavour,
      // Known up front for a local spawn or an explicit pick; otherwise learned
      // when `connect` resolves.
      placement: location ?? (connecting ? undefined : LOCAL_TERMINAL_BACKEND),
    };
    this.archived.delete(key);
    this.terminals.set(key, term);
    this.track(this.persist(term));

    if (connecting) {
      // The run queue STARTS on the connect, so `run()` — which chains onto
      // `term.queue` — writes nothing until there is a real shell to write to.
      // `connect` never rejects.
      term.queue = this.connect(term, connecting, ident, cwd, location);
    } else {
      this.attach(term, proc);
    }

    this.publishUpdate(term);
    return term;
  }

  /** Wire a live shell's streams into this terminal. */
  private attach(term: Terminal, proc: ShellProcess): void {
    term.proc = proc;
    proc.stdout.on("data", (c) => this.onData(term, "stdout", c.toString()));
    proc.stderr.on("data", (c) => this.onData(term, "stderr", c.toString()));
    // On a BACKEND's handle an error is the transport failing, and it usually
    // arrives BEFORE the `exit` that would have said so — first one wins in
    // `onExit`, so without a reason here a dropped connection still read as a
    // quiet `exit=n/a` (review on #476). A local shell keeps the old meaning.
    const lost = (err: unknown): TerminalExitReason | undefined =>
      term.backend
        ? { kind: "transport-lost", detail: err instanceof Error && err.message ? err.message : "the connection failed" }
        : undefined;
    proc.on("error", (err) => this.onExit(term, lost(err)));
    proc.on("exit", (_code, reason) => this.onExit(term, exitReasonOf(reason)));
    // Only a backend handle emits these; a local child never does, so a local
    // shell's behaviour is untouched by listening.
    proc.on("stalled", (info) => this.onStall(term, info));
    proc.on("resumed", () => this.onResume(term));
    // stdin is its own emitter: writing to a shell that has already died raises
    // EPIPE/ERR_STREAM_DESTROYED ASYNCHRONOUSLY, which the try/catch around the
    // `.write()` calls in `run` cannot see. Unlistened, that 'error' event is an
    // uncaught exception — a dead terminal would have taken the server with it.
    proc.stdin.on?.("error", (err) => this.onExit(term, lost(err)));
  }

  /**
   * Resolve which backend this chat's shell belongs on and bring it up there,
   * falling back to a local shell — loudly — when that is not possible.
   * Never rejects: it IS the terminal's run queue.
   */
  private async connect(
    term: Terminal,
    placeholder: ConnectingShell,
    ident: { chatId: string; projectId?: string },
    cwd: string,
    location?: string,
  ): Promise<void> {
    // Closed while connecting: `kill()` already took it off the map. Detached
    // (its backend went away) leaves it ON the map, and that one must end as an
    // exited shell rather than sit forever behind a placeholder.
    const abandoned = (): boolean => {
      if (!placeholder.killed) return false;
      if (this.terminals.get(term.id) === term) this.onExit(term);
      return true;
    };
    let res: TerminalBackendResolution;
    try {
      res = location
        ? await this.backends!.resolve(ident, location)
        : await this.backends!.resolve(ident);
    } catch {
      // The selection could not even be read (a corrupt chat row). That is not
      // a backend failing, and there is no backend to name — plain local.
      res = { requested: location ?? LOCAL_TERMINAL_BACKEND };
    }
    if (abandoned()) return;
    term.placement = res.requested;

    if (!res.backend) {
      if (res.missing) {
        this.fallBack(
          term,
          cwd,
          res.requested,
          res.requested,
          `the terminal backend "${res.requested}" is not installed, or its plugin is switched off`,
        );
      } else {
        this.attach(term, this.spawn(cwd));
      }
      return;
    }

    const backend = res.backend;
    term.location = { backend: backend.id, label: backend.label, state: "connecting" };
    this.record(term, "stderr", `[dispatch] Starting a shell on ${backend.label}…`);
    this.publishUpdate(term);

    const timeoutMs = Math.min(
      MAX_BACKEND_SPAWN_TIMEOUT_MS,
      Math.max(1_000, backend.spawnTimeoutMs ?? DEFAULT_BACKEND_SPAWN_TIMEOUT_MS),
    );
    let handle: ShellProcess;
    let remoteCwd: string | undefined;
    try {
      const spawned = Promise.resolve().then(
        () =>
          backend.spawn({
            chatId: ident.chatId,
            projectId: ident.projectId,
            name: term.name,
            cwd,
            repoPath: res.repoPath,
            ...(res.worktreePath ? { worktreePath: res.worktreePath } : {}),
            ...(res.branch ? { branch: res.branch } : {}),
            signal: placeholder.abort.signal,
          }) as Promise<ShellProcess>,
      );
      const raw = await settleWithin(spawned, timeoutMs, placeholder.abort);
      const declared = (raw as { cwd?: unknown }).cwd;
      remoteCwd = typeof declared === "string" && declared ? declared : undefined;
      handle = withoutPid(raw);
    } catch (err) {
      if (abandoned()) return;
      const why = err instanceof Error ? err.message : String(err);
      this.fallBack(term, cwd, backend.id, backend.label, `${backend.label} could not start a shell: ${why}`);
      return;
    }
    if (abandoned()) {
      try {
        handle.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    term.flavour = backend.shell === "powershell" ? "powershell" : "posix";
    term.backendId = backend.id;
    term.backend = backend;
    if (remoteCwd) term.cwd = remoteCwd;
    term.location = { backend: backend.id, label: backend.label, state: "ready" };
    term.notice = res.note;
    this.attach(term, handle);
    this.publishUpdate(term);
  }

  /** Bring up a LOCAL shell in place of the backend the chat asked for, and say so everywhere. */
  private fallBack(term: Terminal, cwd: string, backendId: string, label: string, reason: string): void {
    const text = `${capitalize(reason)}. This shell is running LOCALLY on the Dispatch host instead.`;
    term.flavour = this.flavour;
    term.location = { backend: backendId, label, state: "fallback", fallback: reason };
    term.notice =
      `WARNING: ${text} Commands in terminal '${term.name}' run on this machine, not on ${label}; ` +
      `close it and open a new one to retry.`;
    this.record(term, "stderr", `[dispatch] ${text}`);
    this.bus.publish({
      type: "notice",
      chatId: term.chatId,
      level: "warn",
      text: `Terminal '${term.name}': ${text}`,
    });
    this.attach(term, this.spawn(cwd));
    this.publishUpdate(term);
  }

  /**
   * End every shell a backend is serving — its plugin is going away, and with
   * it whatever was carrying the stdio. Each says so in its transcript and ends
   * as an exited shell, so the next command on that name re-resolves (local,
   * or wherever the chat points now) instead of writing into a dead channel.
   * Returns how many it ended.
   */
  detachBackend(backendId: string, reason = "its plugin was switched off"): number {
    let n = 0;
    for (const term of [...this.terminals.values()]) {
      if (term.status !== "live") continue;
      const connectingThere =
        term.location?.backend === backendId && term.location.state === "connecting";
      if (term.backendId !== backendId && !connectingThere) continue;
      n += 1;
      // A placeholder's kill only flags it — `connect` ends it. A live handle
      // whose plugin is gone may never emit `exit`, so end it here, and FIRST:
      // a handle that does emit on `kill()` would otherwise end it with no
      // reason. Whatever was running went with the transport, so its outcome
      // is unknown.
      const proc = term.proc;
      if (proc instanceof ConnectingShell) {
        this.record(term, "stderr", `[dispatch] The terminal backend "${backendId}" went away (${reason}); this shell has ended.`);
      } else {
        this.onExit(term, { kind: "transport-lost", detail: `the terminal backend "${backendId}" went away: ${reason}` });
      }
      try {
        proc.kill();
      } catch {
        /* the backend may already have torn its transport down */
      }
    }
    return n;
  }

  /** Write one command + its sentinel probe, and resolve when the marker lands. */
  private exec(term: Terminal, args: RunTerminalArgs): Promise<RunTerminalResult> {
    // Taken here, at the run that will actually report back — not when the
    // shell opened, which for a UI-opened terminal may be long before any
    // agent ran anything in it.
    const notice = [term.notice, term.respawnNotice].filter(Boolean).join("\n\n") || undefined;
    term.notice = undefined;
    term.respawnNotice = undefined;
    const run = this.execInner(term, args);
    const ranOn = this.ranOn(term);
    return notice || ranOn
      ? run.then((r) => ({ ...r, ...(notice ? { notice } : {}), ...(ranOn ? { ranOn } : {}) }))
      : run;
  }

  /**
   * Where this shell's commands run, for the result — or undefined on an
   * install where no backend is in play, so those results stay byte-identical.
   */
  private ranOn(term: Terminal): TerminalRanOn | undefined {
    const loc = term.location;
    if (!loc) {
      if (!this.backends?.size) return undefined;
      return { id: LOCAL_TERMINAL_BACKEND, label: "this machine" };
    }
    if (loc.state === "fallback") {
      return { id: LOCAL_TERMINAL_BACKEND, label: "this machine", fallbackFrom: loc.label };
    }
    return { id: loc.backend, label: loc.label };
  }

  private execInner(term: Terminal, args: RunTerminalArgs): Promise<RunTerminalResult> {
    if (term.status === "exited") {
      return Promise.resolve({
        output: "",
        exitCode: null,
        cwd: term.cwd,
        error: "Terminal has exited.",
      });
    }
    // Only a shell a backend is SERVING has hooks — never a fallback, never a
    // local shell — and a backend that declares neither takes the very path
    // every shell took before hooks existed.
    const backend = term.backend;
    if (backend?.beforeRun || backend?.afterRun) return this.execHooked(term, args, backend);
    this.beginRun(term, args.command);
    return this.writeAndWait(term, args).then((end) => end.result);
  }

  /** Mark the shell busy with `command` and echo it into the read-only stream. */
  private beginRun(term: Terminal, command: string): void {
    term.busy = true;
    term.lastCommand = command;
    term.updatedAt = this.now();
    this.publishUpdate(term);
    // Echo the command into the read-only stream (piped shells don't echo input).
    this.record(term, "command", command);
  }

  /**
   * A run on a shell whose backend has `beforeRun` / `afterRun`.
   *
   * `beforeRun` is awaited BEFORE the command is written and its time is not
   * charged to the command's timeout — the timer in `writeAndWait` only starts
   * at the write. That is the whole point of the hook over the stdin sniffing a
   * backend had to do before it existed: a sync that takes a minute used to eat
   * the command's own deadline, and a sync that FAILED could only print a
   * warning and let the command run against a stale checkout. Here a refusal
   * means the command never reaches the shell.
   */
  private async execHooked(term: Terminal, args: RunTerminalArgs, backend: TerminalBackend): Promise<RunTerminalResult> {
    const command = args.command;
    const label = backend.label;
    const hookMs = Math.min(
      TERMINAL_RUN_HOOK_MAX_TIMEOUT_MS,
      Math.max(1_000, backend.runHookTimeoutMs ?? TERMINAL_RUN_HOOK_TIMEOUT_MS),
    );
    const base = {
      chatId: term.chatId,
      ...(term.projectId ? { projectId: term.projectId } : {}),
      terminal: term.name,
      command,
      cwd: term.cwd,
      background: Boolean(args.background),
    };
    // Before-hook lines, then whatever core said about the run itself (a
    // stall), then after-hook lines — the order things happened in.
    const notices: string[] = [];
    const afterLines: string[] = [];
    const withNotices = (r: RunTerminalResult): RunTerminalResult => {
      const all = [...notices, ...(r.notices ?? []), ...afterLines];
      return all.length ? { ...r, notices: all } : r;
    };
    this.beginRun(term, command);

    if (backend.beforeRun) {
      const before = await this.callHook(term, args.signal, hookMs, true, (signal) =>
        backend.beforeRun!({ ...base, signal }),
      );
      let refusal: string | undefined;
      if (before.kind === "done") {
        notices.push(...cleanNotices(before.value?.notices));
        if (typeof before.value?.refuse === "string") {
          refusal = before.value.refuse.trim() || `${label} refused to run this command.`;
        }
      } else if (before.kind === "threw") {
        refusal = `${label} could not prepare this command, so it was not run: ${before.message}`;
      } else if (before.kind === "timeout") {
        refusal = `${label} did not finish preparing this command within ${Math.round(hookMs / 1000)}s, so it was not run.`;
      } else {
        // Nobody is waiting (a session interrupt) or there is no shell left to
        // write to — the same answers a run gives for those without a hook.
        this.endRun(term, null);
        return withNotices({
          output: "",
          exitCode: null,
          cwd: term.cwd,
          error: before.kind === "cancelled" ? "Cancelled (session interrupted)." : "Terminal has exited.",
        });
      }
      this.recordNotices(term, label, notices);
      if (refusal !== undefined) {
        this.record(term, "stderr", `[dispatch] Not run: ${refusal}`);
        this.endRun(term, null);
        return withNotices({ output: "", exitCode: null, cwd: term.cwd, error: refusal, refused: true });
      }
    }

    const after = backend.afterRun
      ? (end: RunEnd, callerSignal: AbortSignal | undefined): Promise<string[]> =>
          this.callHook(term, callerSignal, hookMs, false, (signal) =>
            backend.afterRun!({
              ...base,
              exitCode: end.result.exitCode,
              durationMs: end.durationMs,
              outcome: end.outcome as TerminalAfterRunInfo["outcome"],
              ...(end.outcome === "shell-exited" && end.result.shellExit
                ? { exitReason: end.result.shellExit }
                : {}),
              signal,
            }),
          ).then((o) => afterNotices(o, label, hookMs))
      : undefined;
    // The tail of a run nobody is waiting on any more — a backgrounded command
    // ending long after its result went back, or a cancelled one. Its notices
    // can only go to the transcript.
    const detached = (end: RunEnd): void => {
      if (!after) return;
      void after(end, undefined).then((lines) => this.recordNotices(term, label, lines));
    };

    const end = await this.writeAndWait(term, args, { holdBusy: Boolean(after), onLateEnd: detached });
    if (!after || end.outcome === "backgrounded" || end.outcome === "not-written") return withNotices(end.result);
    if (end.outcome === "cancelled") {
      detached(end);
      return withNotices(end.result);
    }
    const lines = await after(end, args.signal);
    this.recordNotices(term, label, lines);
    afterLines.push(...lines);
    if (term.status === "live") this.endRun(term, end.result.exitCode);
    return withNotices(end.result);
  }

  /** Free the shell after a hooked run that `writeAndWait` did not free itself. */
  private endRun(term: Terminal, exitCode: number | null): void {
    term.busy = false;
    term.lastExitCode = exitCode;
    term.updatedAt = this.now();
    // A shell closed while its hook ran has already told the panel it is gone;
    // an update now would bring the row back.
    if (this.terminals.get(term.id) === term) this.publishUpdate(term);
  }

  /** A backend's notices, into the transcript a human reads in the Terminals panel. */
  private recordNotices(term: Terminal, label: string, lines: readonly string[]): void {
    for (const line of lines) this.record(term, "stderr", `[${label}] ${line}`);
  }

  /**
   * Call a run hook and wait for it — but never past `ms`, a cancelled caller,
   * or (with `stopOnExit`) the shell dying under it. Never rejects. The hook's
   * signal is aborted whenever core stops waiting for any reason but the hook
   * settling, so a well-behaved hook stops too.
   */
  private callHook<T>(
    term: Terminal,
    callerSignal: AbortSignal | undefined,
    ms: number,
    stopOnExit: boolean,
    fn: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<HookOutcome<T>> {
    const ctl = new AbortController();
    return new Promise<HookOutcome<T>>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onCancel = (): void => settle({ kind: "cancelled" });
      const stop = (): void => settle({ kind: "exited" });
      const settle = (o: HookOutcome<T>): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCancel);
        if (term.hookStop === stop) term.hookStop = undefined;
        if (o.kind !== "done" && o.kind !== "threw") ctl.abort();
        resolve(o);
      };
      if (callerSignal?.aborted) return settle({ kind: "cancelled" });
      if (stopOnExit && term.status === "exited") return settle({ kind: "exited" });
      timer = setTimeout(() => settle({ kind: "timeout" }), ms);
      timer.unref?.();
      callerSignal?.addEventListener("abort", onCancel);
      if (stopOnExit) term.hookStop = stop;
      Promise.resolve()
        .then(() => fn(ctl.signal))
        .then(
          (value) => settle({ kind: "done", value }),
          (err: unknown) => settle({ kind: "threw", message: err instanceof Error ? err.message : String(err) }),
        );
    });
  }

  /**
   * Write one command + its sentinel probe, and settle when the marker lands
   * (or the deadline, a cancel, or the shell's exit says to stop waiting).
   *
   * The deadline starts HERE, at the write — anything that ran before it (a
   * backend's `beforeRun`) is not the command's time. `hooked` is only passed
   * for a shell whose backend has run hooks: `holdBusy` keeps the shell busy
   * past the marker while `afterRun` is still to come, and `onLateEnd` hears
   * when a BACKGROUNDED command finally ends.
   */
  private writeAndWait(
    term: Terminal,
    args: RunTerminalArgs,
    hooked?: { holdBusy: boolean; onLateEnd: (end: RunEnd) => void },
  ): Promise<RunEnd> {
    const command = args.command;
    const marker = `${SENTINEL_PREFIX}${this.genId()}`;
    let writtenAt = this.now();

    return new Promise<RunEnd>((resolve) => {
      let settled = false;
      let returnedEarly = false;
      const cleanups: (() => void)[] = [];
      // Time this command spent with its transport stalled — paused out of
      // its deadline, and said in the result so a slow run is explained.
      let stalledMs = 0;
      let stalledFrom: number | undefined;
      // Fires when the pause budget runs out mid-stall: the clock restarts.
      let stallCap: ReturnType<typeof setTimeout> | undefined;
      let capped = false;
      const finish = (res: RunTerminalResult, outcome: RunEnd["outcome"]): void => {
        if (settled) return;
        settled = true;
        for (const c of cleanups) c();
        if (stalledFrom !== undefined) stalledMs += Date.now() - stalledFrom;
        stalledFrom = undefined;
        const r =
          stalledMs > 0 && outcome !== "not-written"
            ? { ...res, notices: [...(res.notices ?? []), stallNotice(term, stalledMs, capped)] }
            : res;
        term.pending = undefined;
        term.background = undefined;
        // Still busy while `afterRun` has yet to report on a command that is
        // over (or overran) — the caller frees it once that hook settles.
        term.busy = Boolean(
          hooked?.holdBusy && !returnedEarly && (outcome === "finished" || outcome === "timed-out"),
        );
        if (typeof r.exitCode === "number" || r.exitCode === null) {
          term.lastExitCode = r.exitCode;
        }
        term.updatedAt = this.now();
        this.publishUpdate(term);
        const end: RunEnd = { result: r, outcome, durationMs: this.now() - writtenAt };
        if (returnedEarly) {
          if (outcome !== "not-written") hooked?.onLateEnd(end);
          return;
        }
        resolve(end);
      };

      const output: string[] = [];
      term.pending = {
        marker,
        output,
        resolve: ({ exitCode, cwd, exited }) => {
          term.cwd = cwd || term.cwd;
          // A shell that ended under the command, with the reason its backend
          // gave. Without one this is what it always was — no exit code, no
          // error — because a local shell that ran `exit` is not a failure.
          const reason = exited ? term.exitReason : undefined;
          finish(
            {
              output: output.join("\n"),
              exitCode,
              cwd: term.cwd,
              ...(reason ? { shellExit: reason } : {}),
              ...(reason && reason.kind !== "exited" ? { error: lostRunText(term, reason) } : {}),
            },
            exited ? "shell-exited" : "finished",
          );
        },
        pause: () => {
          if (stalledFrom !== undefined || settled || capped) return;
          stalledFrom = Date.now();
          disarm();
          stallCap = setTimeout(spendBudget, Math.max(0, this.stallPauseMaxMs - stalledMs));
          stallCap.unref?.();
        },
        resume: () => {
          if (stalledFrom === undefined || settled) return;
          if (stallCap) clearTimeout(stallCap);
          stallCap = undefined;
          stalledMs += Date.now() - stalledFrom;
          stalledFrom = undefined;
          arm();
        },
      };
      // The pause budget is spent while still stalled: count the stall up to
      // here and let the deadline run again. Any later stall no longer pauses.
      const spendBudget = (): void => {
        stallCap = undefined;
        if (stalledFrom === undefined || settled) return;
        stalledMs += Date.now() - stalledFrom;
        stalledFrom = undefined;
        capped = true;
        arm();
      };

      // Timeout: report partial output but keep the shell alive. A background
      // command has no deadline — never finishing is the point — and both the
      // timeout and the abort path below would clear `pending`/`background`,
      // marking the shell free while a dev server is still holding it.
      //
      // The deadline PAUSES while the backend's transport is stalled: a remote
      // blip is not the command being slow, and spending its deadline on one
      // turned a Wi-Fi hiccup into a "timed out" build that was still fine.
      const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      let remaining = timeoutMs;
      let armedAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (args.background || timer || settled) return;
        armedAt = Date.now();
        timer = setTimeout(() => {
          timer = undefined;
          finish(
            {
              output: output.join("\n"),
              exitCode: null,
              cwd: term.cwd,
              timedOut: true,
              error: `Command timed out after ${timeoutMs}ms (still running in the background).`,
            },
            "timed-out",
          );
        }, remaining);
      };
      const disarm = (): void => {
        if (!timer) return;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - armedAt));
      };
      cleanups.push(disarm, () => {
        if (stallCap) clearTimeout(stallCap);
      });
      // Already stalled when it starts: the clock waits for `resumed` (or the
      // pause budget).
      if (term.stall) term.pending?.pause?.();
      else arm();

      // Session abort → stop waiting (shell survives for the next turn).
      const sig = args.background ? undefined : args.signal;
      if (sig) {
        const cancelled = (): RunTerminalResult => ({
          output: output.join("\n"),
          exitCode: null,
          cwd: term.cwd,
          error: "Cancelled (session interrupted).",
        });
        if (sig.aborted) {
          finish(cancelled(), "not-written");
          return;
        }
        const onAbort = (): void => finish(cancelled(), "cancelled");
        sig.addEventListener("abort", onAbort);
        cleanups.push(() => sig.removeEventListener("abort", onAbort));
      }

      // The probe: the marker line `<marker>|<exit>|<ok>|<cwd>`, in whichever
      // dialect the shell under this terminal speaks.
      const probe = probeLine(marker, term.flavour);
      writtenAt = this.now();
      try {
        term.proc.stdin.write(commandWrite(command, term.flavour, !term.wroteCommand));
        term.wroteCommand = true;
        term.proc.stdin.write(probe + "\n");
      } catch (err) {
        finish(
          {
            output: output.join("\n"),
            exitCode: null,
            cwd: term.cwd,
            error: err instanceof Error ? err.message : String(err),
          },
          "not-written",
        );
        return;
      }

      // Backgrounded: hand the caller back the shell NOW. `pending` deliberately
      // stays armed — when the command does eventually exit, its marker lands,
      // `finish` runs, and the terminal reports itself free again.
      if (args.background) {
        term.background = { command, since: this.now() };
        this.publishUpdate(term);
        returnedEarly = true;
        resolve({
          result: { output: "", exitCode: null, cwd: term.cwd, backgrounded: true },
          outcome: "backgrounded",
          durationMs: 0,
        });
      }
    });
  }

  /* ------------------------------------------------------- stream handling */

  /** Buffer a stream chunk into whole lines; the marker line resolves the run. */
  private onData(term: Terminal, stream: "stdout" | "stderr", chunk: string): void {
    const bufKey = stream === "stdout" ? "stdoutBuf" : "stderrBuf";
    let buf = term[bufKey] + chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      this.onLine(term, stream, line);
      nl = buf.indexOf("\n");
    }
    term[bufKey] = buf;
  }

  private onLine(term: Terminal, stream: "stdout" | "stderr", line: string): void {
    const pending = term.pending;
    if (pending && stream === "stdout") {
      const at = line.indexOf(pending.marker);
      if (at >= 0) {
        // Everything before the marker on this line is still real output.
        const pre = line.slice(0, at);
        if (pre) {
          pending.output.push(pre);
          this.record(term, "stdout", pre);
        }
        const rest = line.slice(at + pending.marker.length);
        // rest == "|<exit>|<ok>|<cwd…>"
        const parts = rest.split("|");
        // parts[0] === "" (leading pipe), [1]=exit, [2]=ok, [3..]=cwd
        const exitRaw = parts[1] ?? "";
        const exitCode = exitRaw === "" ? null : Number.parseInt(exitRaw, 10);
        const cwd = parts.slice(3).join("|").trim();
        pending.resolve({
          exitCode: Number.isFinite(exitCode as number) ? (exitCode as number) : null,
          cwd,
        });
        return;
      }
      pending.output.push(line);
    }
    this.record(term, stream, line);
  }

  /** Append to scrollback, queue it for the transcript, fan out the event. */
  private record(term: Terminal, stream: TerminalLine["stream"], chunk: string): void {
    const ts = this.now();
    term.scrollback.push({ stream, chunk, ts });
    if (term.scrollback.length > this.scrollbackCap) {
      term.scrollback.splice(0, term.scrollback.length - this.scrollbackCap);
    }
    term.lastActivityAt = ts;
    term.lines += 1;
    term.bytes += chunk.length;
    // Write-behind. A dev server can emit hundreds of lines a second and an
    // fsync per line would make the shell the slowest thing in the app; the
    // in-memory scrollback is what the UI reads live, so the transcript only has
    // to be eventually right.
    if (this.store) {
      term.unflushed.push({ stream, chunk, ts });
      // Only for a shell we still hold. `flush()` walks `this.terminals`, so a
      // killed one's buffer is drained by its own `archiveOnClose` instead —
      // arming the ticker for it would start a timer that can never empty this
      // particular buffer, and could re-arm the one `reap()` just cleared.
      if (this.terminals.has(term.id)) this.ensureFlushTimer();
    }
    this.bus.publish({
      type: "terminal-output",
      terminalId: term.id,
      chatId: term.chatId,
      stream,
      chunk,
      ts,
    });
  }

  /* --------------------------------------------------------- persistence */

  /** Start the write-behind timer on first output. `unref` — never holds the process open. */
  private ensureFlushTimer(): void {
    if (this.flushTimer || !this.store) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** Remember a fire-and-forget write so {@link flush} can wait for it. */
  private track(p: Promise<unknown>): void {
    const done = p.catch(() => {});
    this.pendingWrites.add(done);
    void done.finally(() => this.pendingWrites.delete(done));
  }

  /**
   * Drain every terminal's queued output to its transcript and refresh its row,
   * then wait for the writes nobody awaited.
   *
   * Public so teardown and the tests can force a settled state — and it has to
   * be a real barrier for either to mean anything: teardown flushes so the tail
   * of a dying dev server reaches disk before the process exits.
   */
  async flush(): Promise<void> {
    if (!this.store) return;
    for (const term of this.terminals.values()) {
      if (term.unflushed.length === 0) continue;
      const batch = term.unflushed;
      term.unflushed = [];
      try {
        await this.store.appendTerminalLines(term.logId, batch);
        await this.persist(term);
      } catch {
        /* a transcript we couldn't write is not worth failing a command over */
      }
    }
    // Kills too, not just writes: a kill ends in an `archiveOnClose`, so a
    // `flush()` that ignored them would return before the row it is responsible
    // for had been written. Looped, not a single await, because tracked work
    // can start more of it (a kill queues an archive; a purge kills then
    // deletes) and settling the set captured on entry would miss that.
    while (this.pendingWrites.size > 0 || this.pendingKills.size > 0) {
      await Promise.allSettled([...this.pendingWrites, ...this.pendingKills]);
    }
  }

  /** Write this terminal's row. Best-effort; the shell is unaffected either way. */
  private async persist(term: Terminal): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.saveTerminalRecord({
        id: term.id,
        logId: term.logId,
        chatId: term.chatId,
        projectId: term.projectId,
        name: term.name,
        cwd: term.cwd,
        origin: term.origin,
        lastCommand: term.lastCommand,
        lastExitCode: term.lastExitCode,
        createdAt: term.createdAt,
        updatedAt: term.updatedAt,
        lastActivityAt: term.lastActivityAt,
        lines: term.lines,
        bytes: term.bytes,
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Adopt the persisted roster at boot.
   *
   * Every row loads as ARCHIVED: this process owns no shells yet, and a pid from
   * a previous run is somebody else's process now. The transcripts are readable
   * immediately, which is the point — a build that failed before a restart is
   * still there to read. Same swallow-everything posture as
   * `RunnerService.reconcile`: a corrupt roster must never block boot.
   */
  async reconcile(): Promise<void> {
    if (!this.store) return;
    try {
      for (const rec of await this.store.listTerminalRecords()) {
        if (this.terminals.has(rec.id)) continue;
        this.archived.set(rec.id, rec);
      }
    } catch {
      /* no roster, or an unreadable one — start empty */
    }
  }

  /**
   * Drop transcript lines past the retention window, and forget rows whose whole
   * transcript has aged out. A LIVE shell keeps its row however old it is —
   * retention is about output nobody will read again, not about closing shells
   * out from under their owner.
   */
  async sweep(nowMs = this.now()): Promise<{ pruned: number; dropped: number }> {
    if (!this.store) return { pruned: 0, dropped: 0 };
    const cutoff = nowMs - this.retentionMs;
    let pruned = 0;
    let dropped = 0;
    let records: TerminalRecord[];
    try {
      records = await this.store.listTerminalRecords();
    } catch {
      return { pruned: 0, dropped: 0 };
    }
    for (const rec of records) {
      const live = this.terminals.get(rec.id);
      if (!live && rec.lastActivityAt < cutoff) {
        await this.store.deleteTerminalRecord(rec.id).catch(() => null);
        this.archived.delete(rec.id);
        this.bus.publish({
          type: "terminal-closed",
          terminalId: rec.id,
          chatId: rec.chatId,
        });
        dropped += 1;
        continue;
      }
      const { lines, bytes } = await this.store
        .pruneTerminalLog(rec.logId, cutoff)
        .catch(() => ({ lines: rec.lines, bytes: rec.bytes }));
      if (lines === rec.lines) continue;
      pruned += rec.lines - lines;
      if (live) {
        live.lines = lines;
        live.bytes = bytes;
        await this.persist(live);
      } else {
        const next = { ...rec, lines, bytes };
        this.archived.set(rec.id, next);
        await this.store.saveTerminalRecord(next).catch(() => null);
      }
    }
    return { pruned, dropped };
  }

  /**
   * The backend's transport went quiet. The shell is NOT ended — the command
   * may well still be running over there — so core waits, with the running
   * command's deadline paused, and shows the shell as stalled.
   */
  private onStall(term: Terminal, info?: TerminalStallInfo): void {
    if (term.status !== "live") return;
    const raw = (info as { detail?: unknown } | undefined)?.detail;
    const detail = typeof raw === "string" && raw.trim() ? raw.trim() : term.stall?.detail;
    const first = !term.stall;
    term.stall = { since: term.stall?.since ?? this.now(), ...(detail ? { detail } : {}) };
    if (term.location && (term.location.state === "ready" || term.location.state === "stalled")) {
      term.location = {
        ...unstalled(term.location),
        state: "stalled",
        stalledSince: term.stall.since,
        ...(detail ? { stalled: detail } : {}),
      };
    }
    if (first) {
      this.record(
        term,
        "stderr",
        `[dispatch] ${labelOf(term)} stopped answering${detail ? ` (${detail})` : ""}; waiting for it. ` +
          `A running command's timeout is paused meanwhile.`,
      );
      term.pending?.pause?.();
    }
    this.publishUpdate(term);
  }

  /** The transport answers again after a stall. */
  private onResume(term: Terminal): void {
    const stall = term.stall;
    if (!stall || term.status !== "live") return;
    term.stall = undefined;
    if (term.location?.state === "stalled") term.location = unstalled(term.location);
    this.record(term, "stderr", `[dispatch] ${labelOf(term)} is answering again, after ${seconds(this.now() - stall.since)}.`);
    term.pending?.resume?.();
    this.publishUpdate(term);
  }

  /** How the shell a reopened name replaces ended, for the respawn notice. */
  private endedHow(term: Terminal): string {
    return term.exitReason ? endedPhrase(term, term.exitReason) : "exited";
  }

  private onExit(term: Terminal, reason?: TerminalExitReason): void {
    if (term.status === "exited") {
      // A reason that arrives after something else already ended the shell
      // (a handle that errors, THEN exits with why) can no longer change a
      // result that has resolved, but the respawn notice and the panel should
      // still tell the truth.
      if (reason && !term.exitReason) {
        term.exitReason = reason;
        if (this.terminals.get(term.id) === term) this.publishUpdate(term);
      }
      return;
    }
    term.status = "exited";
    term.busy = false;
    term.updatedAt = this.now();
    if (reason) term.exitReason = reason;
    // An exited shell is not "stalled" any more, whatever it was a moment ago.
    if (term.stall) {
      term.stall = undefined;
      if (term.location?.state === "stalled") term.location = unstalled(term.location);
    }
    // Said in the transcript too: the human watching the panel otherwise sees
    // a shell that simply stopped.
    if (reason && reason.kind !== "exited") {
      this.record(term, "stderr", `[dispatch] This shell ${endedPhrase(term, reason)}. The next command starts a new one.`);
    }
    // Resolve any in-flight run so a caller never hangs on a dead shell — or on
    // a `beforeRun` preparing a command for a shell that is no longer there.
    if (term.pending) {
      term.pending.resolve({ exitCode: null, cwd: term.cwd, exited: true });
    }
    term.hookStop?.();
    this.publishUpdate(term);
    void this.flush().catch(() => {});
  }

  /* ----------------------------------------------------------- teardown */

  /**
   * Kill + forget ONE shell. `killChat` is chat-wide teardown; this is the
   * single-shell door a human needs, because a person who can open shells from
   * the UI can also reach the per-chat cap, and without this the only way back
   * under it would be to delete the chat.
   */
  kill(terminalId: string): boolean {
    const term = this.terminals.get(terminalId);
    if (!term) return false;
    this.terminals.delete(terminalId);
    // A command still in `beforeRun` must not be written to a shell being
    // closed; its caller hears "Terminal has exited." now, not after the kill.
    term.hookStop?.();
    // Killing the shell does NOT discard what it printed. The row moves to the
    // archive and the transcript stays readable until retention takes it —
    // "close the terminal" and "forget what the build said" are different asks,
    // and conflating them is what made a failed run unrecoverable.
    //
    // Archived AFTER the process is actually dead, not alongside the kill. The
    // shell is off `this.terminals` from the line above and `flush()` only
    // walks the terminals it still holds, so anything the shell prints while
    // the tree-kill is in flight lands in a `term.unflushed` nothing else will
    // ever drain. Waiting means those lines are in the batch instead — and
    // they are the interesting ones, since they are what it said on the way
    // out.
    this.trackKill(this.killProc(term).then(() => this.archiveOnClose(term)));
    this.bus.publish({ type: "terminal-closed", terminalId: term.id, chatId: term.chatId });
    return true;
  }

  /** Flush a closed shell's tail and keep its row as an archived one. */
  private async archiveOnClose(term: Terminal): Promise<void> {
    if (!this.store) return;
    const batch = term.unflushed;
    term.unflushed = [];
    try {
      if (batch.length) await this.store.appendTerminalLines(term.logId, batch);
      const rec: TerminalRecord = {
        id: term.id,
        logId: term.logId,
        chatId: term.chatId,
        projectId: term.projectId,
        name: term.name,
        cwd: term.cwd,
        origin: term.origin,
        lastCommand: term.lastCommand,
        lastExitCode: term.lastExitCode,
        createdAt: term.createdAt,
        updatedAt: this.now(),
        lastActivityAt: term.lastActivityAt,
        lines: term.lines,
        bytes: term.bytes,
      };
      this.archived.set(rec.id, rec);
      await this.store.saveTerminalRecord(rec);
    } catch {
      /* best-effort */
    }
  }

  /** Forget a shell AND its transcript outright (an explicit "delete this"). */
  async purge(terminalId: string): Promise<void> {
    this.kill(terminalId);
    this.archived.delete(terminalId);
    await this.store?.deleteTerminalRecord(terminalId).catch(() => null);
  }

  /** Kill + forget every terminal owned by a chat (chat deleted / teardown). */
  killChat(chatId: string): void {
    for (const [key, term] of [...this.terminals.entries()]) {
      if (term.chatId === chatId) this.kill(key);
    }
  }

  /**
   * REAP: get the tail of every shell onto disk, then kill every one of them.
   *
   * This is the awaitable form of {@link dispose}, and the one every stop path
   * should use. Two things it guarantees that `dispose()` cannot:
   *
   *   1. THE TAIL LANDS. Output is written behind a 1s timer, so a shell that
   *      printed the reason it is dying — the port conflict, the stack trace —
   *      loses exactly that in a fire-and-forget teardown. `flush()` is a real
   *      barrier, so awaiting this means the transcript agrees with what was on
   *      screen.
   *   2. THE ROWS ARCHIVE. `kill()` keeps each transcript readable rather than
   *      dropping the shell on the floor; reaping is about PROCESSES, never
   *      about forgetting output.
   *
   * Idempotent — a second call finds nothing to do — so the belt-and-braces
   * callers on the shutdown path can't double-charge for it.
   */
  async reap(): Promise<number> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    // BEFORE the kills: a killed shell's stdout never arrives, so anything not
    // yet buffered is gone either way — but everything already buffered has to
    // get out while there is still a process to write it.
    await this.flush().catch(() => {});
    const ids = [...this.terminals.keys()];
    for (const id of ids) this.kill(id);
    // Wait for the tree walks to COMPLETE. `taskkill /T` is a spawned process,
    // so returning before it has run means returning before anything died —
    // and the caller's next move is usually to exit, taking the pending walk
    // with it. This is what makes "the port is free" true on return.
    while (this.pendingKills.size > 0) {
      await Promise.allSettled([...this.pendingKills]);
    }
    // The kills queued their own archive writes. Wait for those too, or the
    // process can exit between "row archived in memory" and "row on disk".
    await this.flush().catch(() => {});
    return ids.length;
  }

  /**
   * Kill every terminal, synchronously (process teardown).
   *
   * Kept for the callers that genuinely cannot await — Fastify's `onClose` runs
   * behind three slower awaits and a grace timer that can cut it off, which is
   * why {@link reap} exists and runs FIRST. This stays as the backstop for a
   * teardown that reached here anyway.
   */
  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    // Fire-and-forget: teardown can't await, but the queued tail is usually the
    // most interesting part of the transcript — it's what was on screen when
    // whatever prompted the shutdown happened.
    void this.flush().catch(() => {});
    // `killProc` never rejects (see its docblock), so floating it here is safe —
    // and floating is all a synchronous teardown can do. `reap()` is the caller
    // that gets to wait for the trees to actually go.
    for (const term of this.terminals.values()) void this.killProc(term);
    this.terminals.clear();
  }

  /**
   * Kill a shell AND everything it started.
   *
   * `proc.kill()` alone only reaps the powershell: a shell that launched a dev
   * server leaves that server holding its port, which is precisely the orphan
   * the Ports & processes panel was built to clean up after. So tree-kill by
   * pid (same primitive RunnerService uses), and keep `proc.kill()` as the
   * fallback for a shell with no pid — every test fake, and any spawn that
   * failed before the OS gave it one.
   *
   * ── The ORDER is the whole thing ────────────────────────────────────────────
   * These two used to run back to back, tree-kill first: `tree-kill` SPAWNS
   * `taskkill /pid <pid> /T /F` and reports through a callback, so it had not
   * even started when the `proc.kill()` on the next line ran `TerminateProcess`
   * on the shell. Windows then reparents the shell's children, and a `/T` walk
   * that arrives at a dead parent finds nothing to descend into. The dev server
   * survived every kill, every dispose and every shutdown.
   *
   * Measured 2026-08-17: a background shell started `node …listen(4455)`; after
   * a clean `POST /api/shutdown` the powershell was gone and node was still
   * listening on 4455. So the direct kill now waits for the tree walk to
   * finish, and is belt-and-braces rather than a race against it.
   */
  private killProc(term: Terminal): Promise<void> {
    const hardKill = (): void => {
      try {
        term.proc.kill();
      } catch {
        /* already dead */
      }
    };
    const pid = term.proc.pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        // Never rejects: both arms of `then` are `hardKill`, so a killTree that
        // fails still gets the direct kill and still settles. Callers can
        // therefore chain onto it without a second error path.
        return Promise.resolve(this.killTree(pid)).then(hardKill, hardKill);
      } catch {
        /* a killTree that threw synchronously — fall through */
      }
    }
    hardKill();
    return Promise.resolve();
  }

  /** Remember an in-flight tree-kill so {@link reap} can wait for it. */
  private trackKill(p: Promise<unknown>): void {
    const done = p.catch(() => {});
    this.pendingKills.add(done);
    void done.finally(() => this.pendingKills.delete(done));
  }

  /* -------------------------------------------------------- introspection */

  /** Shells this process owns. Live-only — `catalog()` is the fuller view. */
  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => this.view(t));
  }

  listChat(chatId: string): TerminalInfo[] {
    return this.list().filter((t) => t.chatId === chatId);
  }

  /**
   * The CATALOG: this process's shells plus every archived row, filtered by the
   * shared registry predicate — the same one the REST route parses and the
   * Workspace view drives its controls from, so "what the modal shows" and "what
   * an agent's `list` returns" cannot disagree.
   *
   * Ordering is the query's now (default: most-recently-active first) rather
   * than a `.sort()` bolted on here, so the caller can ask for something else
   * and get it.
   */
  catalog(query: RegistryQuery): TerminalInfo[] {
    const all = [
      ...this.list(),
      ...[...this.archived.values()]
        .filter((r) => !this.terminals.has(r.id))
        .map((r) => this.archivedView(r)),
    ];
    return applyRegistryQuery(all, query, {
      text: (t) => [t.name, t.cwd, t.lastCommand],
      touchedAt: (t) => t.lastActivityAt ?? t.updatedAt ?? t.createdAt,
      createdAt: (t) => t.createdAt,
      name: (t) => t.name,
      origin: (t) => t.origin,
      facets: {
        // Deliberately the same bar as `isActiveTerminal` in
        // packages/client/src/stores/terminals.ts, and narrower than "live":
        // a shell stays live for the rest of the chat after its one `npm
        // install` finished, so filtering on liveness returns mostly idle
        // prompts. If that definition changes, change it in both places.
        active: (t) => t.status === "live" && Boolean(t.busy || t.background),
        archived: (t) => Boolean(t.archived),
      },
    });
  }

  /**
   * Kill every LIVE shell the query selects, and report what went.
   *
   * The selection runs through `catalog()`, so this reaps exactly the rows the
   * Workspace view is showing when a human presses the button — including its
   * scope invariants: `scope: "chat"` with no `chatId` selects nothing rather
   * than quietly widening to every shell on the machine, which is the one
   * mistake a bulk kill must not make.
   *
   * `kill()`, never `purge()`: each row archives and its transcript stays
   * readable. Reclaiming a port and forgetting what the dev server printed on
   * its way out are different asks.
   */
  killMatching(query: RegistryQuery): { killed: number; ids: string[] } {
    const ids = this.catalog(query)
      .filter((t) => t.status === "live" && !t.archived)
      .map((t) => t.id);
    const killed = ids.filter((id) => this.kill(id));
    return { killed: killed.length, ids: killed };
  }

  /**
   * Retained scrollback for a terminal (reconnect hydration).
   *
   * In-memory for a live shell — that buffer is the freshest and is capped for a
   * reason. For an archived one it comes off disk, which is the whole point of
   * persisting it: a shell whose process is long gone can still be read.
   */
  async scrollback(
    terminalId: string,
    opts: { tail?: number; since?: number; q?: string; stream?: TerminalLine["stream"] } = {},
  ): Promise<TerminalLine[]> {
    const live = this.terminals.get(terminalId);
    if (live) return filterLines(live.scrollback, opts);
    const rec = this.archived.get(terminalId);
    if (!rec || !this.store) return [];
    try {
      return await this.store.readTerminalLines(rec.logId, opts);
    } catch {
      return [];
    }
  }

  /**
   * The last `lines` of a named shell's output — how the agent reads a command
   * it backgrounded. Without this a background start would be write-only: the
   * output goes to the Terminals tab, which the agent cannot see.
   *
   * `grep`/`since`/`stream` exist because a watcher's tail is mostly noise: the
   * question is almost always "did it print an error since I last looked", and
   * answering it by returning 50 lines and hoping wastes a turn.
   */
  async tail(
    chatId: string,
    name: string,
    lines = 50,
    opts: { q?: string; since?: number; stream?: TerminalLine["stream"] } = {},
  ): Promise<{ output: string; found: boolean }> {
    const id = TerminalService.key(chatId, name.trim() || "main");
    if (!this.terminals.has(id) && !this.archived.has(id)) {
      return { output: "", found: false };
    }
    const n = Math.max(1, Math.min(lines, this.scrollbackCap));
    // Window AFTER dropping the echoed commands, so `lines: 50` means fifty
    // lines of OUTPUT rather than fifty rows of which some are the input.
    const rows = (await this.scrollback(id, opts)).filter((l) => l.stream !== "command");
    return {
      output: rows.slice(-n).map((l) => l.chunk).join("\n"),
      found: true,
    };
  }

  /**
   * Live shell pids, with the chat that owns them — the roots `ProcessService`
   * walks DOWN from to attribute a listener on any port to a chat. A shell whose
   * spawn never got a pid is simply absent (nothing to attribute through).
   */
  livePids(): { chatId: string; name: string; terminalId: string; pid: number }[] {
    const out: { chatId: string; name: string; terminalId: string; pid: number }[] = [];
    for (const t of this.terminals.values()) {
      const pid = t.proc.pid;
      if (t.status === "live" && typeof pid === "number" && pid > 0) {
        out.push({ chatId: t.chatId, name: t.name, terminalId: t.id, pid });
      }
    }
    return out;
  }

  private view(t: Terminal): TerminalInfo {
    return {
      id: t.id,
      chatId: t.chatId,
      projectId: t.projectId,
      origin: t.origin,
      name: t.name,
      cwd: t.cwd,
      status: t.status,
      busy: t.busy,
      lastCommand: t.lastCommand,
      lastExitCode: t.lastExitCode,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastActivityAt: t.lastActivityAt,
      lines: t.lines,
      bytes: t.bytes,
      ...(t.background ? { background: t.background } : {}),
      ...(typeof t.proc.pid === "number" ? { pid: t.proc.pid } : {}),
      ...(t.location ? { location: t.location } : {}),
      ...(t.exitReason ? { exitReason: t.exitReason } : {}),
    };
  }

  /** A row with no process behind it: readable, marked, never `busy`. */
  private archivedView(r: TerminalRecord): TerminalInfo {
    return {
      id: r.id,
      chatId: r.chatId,
      projectId: r.projectId,
      origin: r.origin,
      name: r.name,
      cwd: r.cwd,
      status: "exited",
      archived: true,
      lastCommand: r.lastCommand,
      lastExitCode: r.lastExitCode,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastActivityAt: r.lastActivityAt,
      lines: r.lines,
      bytes: r.bytes,
    };
  }

  private publishUpdate(term: Terminal): void {
    this.bus.publish({ type: "terminal-update", terminal: this.view(term) });
  }
}

/** Apply the same line filters in memory that the store applies on disk. */
function filterLines(
  lines: TerminalLine[],
  opts: { tail?: number; since?: number; q?: string; stream?: TerminalLine["stream"] },
): TerminalLine[] {
  let out = lines;
  if (opts.since !== undefined) out = out.filter((l) => l.ts >= opts.since!);
  if (opts.stream) out = out.filter((l) => l.stream === opts.stream);
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    out = out.filter((l) => l.chunk.toLowerCase().includes(needle));
  }
  return opts.tail && opts.tail > 0 ? out.slice(-opts.tail) : out.slice();
}

/** First letter up — reasons are phrased to sit mid-sentence elsewhere. */
function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * The handle's `exit` reason, if it gave one. Only an object with a known
 * `kind` counts: a real ChildProcess passes the SIGNAL NAME there ("SIGTERM"),
 * and reading that as a reason would turn every local shell's death into a
 * failed command.
 */
function exitReasonOf(raw: unknown): TerminalExitReason | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { kind, detail } = raw as { kind?: unknown; detail?: unknown };
  if (kind !== "exited" && kind !== "transport-lost" && kind !== "killed") return undefined;
  return typeof detail === "string" && detail.trim() ? { kind, detail: detail.trim() } : { kind };
}

/** What core's own lines call the place a shell runs. */
function labelOf(term: Terminal): string {
  return term.location?.label ?? "this machine";
}

/** How a shell ended, to sit after "This shell …" / "the one before it …". */
function endedPhrase(term: Terminal, reason: TerminalExitReason): string {
  const detail = reason.detail ? ` (${reason.detail})` : "";
  if (reason.kind === "transport-lost") return `lost its connection to ${labelOf(term)}${detail}`;
  if (reason.kind === "killed") return `was stopped on ${labelOf(term)}${detail}`;
  return `exited${detail}`;
}

/**
 * The error for a command whose shell ended under it with a reason that
 * matters. "Outcome unknown" is the whole point for a lost transport: the
 * command may have finished, half-finished or still be running over there,
 * and an agent told nothing re-runs a migration twice.
 */
function lostRunText(term: Terminal, reason: TerminalExitReason): string {
  if (reason.kind === "transport-lost") {
    return (
      `This shell ${endedPhrase(term, reason)} while the command was running. Whether it finished — ` +
      `and what it changed there — is unknown: check before repeating anything that is not safe to ` +
      `run twice. The next command starts a new shell.`
    );
  }
  return (
    `This shell ${endedPhrase(term, reason)} while the command was running, so the command did not ` +
    `finish. The next command starts a new shell.`
  );
}

/** Core's line for a run that waited out a stalled transport. */
function stallNotice(term: Terminal, ms: number, capped: boolean): string {
  return (
    `The connection to ${labelOf(term)} stalled for ${seconds(ms)} during this command; its timeout was paused meanwhile` +
    (capped ? ` — up to the limit, after which the clock ran again.` : `.`)
  );
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/** A location with its stall cleared — back to `ready`. */
function unstalled(loc: TerminalLocation): TerminalLocation {
  return {
    backend: loc.backend,
    label: loc.label,
    state: loc.state === "stalled" ? "ready" : loc.state,
    ...(loc.fallback ? { fallback: loc.fallback } : {}),
  };
}

/**
 * A backend handle re-shaped so it CANNOT carry a pid. Core reads `pid` as a
 * local process it may tree-kill and walk the process table under; a remote
 * shell's number would name some unrelated process on this machine.
 */
function withoutPid(h: ShellProcess): ShellProcess {
  return {
    stdin: h.stdin,
    stdout: h.stdout,
    stderr: h.stderr,
    kill: (signal?: string) => h.kill(signal),
    // Every event passes through — `stalled` / `resumed` included, which a
    // backend's handle emits through this same `on`.
    on: ((event: "exit" | "error" | "stalled" | "resumed", listener: (...args: never[]) => void) => {
      h.on(event as "exit", listener as (code: number | null) => void);
    }) as ShellProcess["on"],
  };
}

/**
 * `p`, or a rejection once `ms` passes or `abort` fires. Either way the
 * signal is aborted so the backend can stop provisioning, and a handle that
 * arrives LATE is killed rather than leaked — the terminal has already moved
 * on to a local shell and nothing else holds a reference to it.
 */
function settleWithin(
  p: Promise<ShellProcess>,
  ms: number,
  abort: AbortController,
): Promise<ShellProcess> {
  return new Promise<ShellProcess>((resolve, reject) => {
    let done = false;
    const giveUp = (why: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", onAbort);
      if (!abort.signal.aborted) abort.abort();
      reject(new Error(why));
    };
    const onAbort = (): void => giveUp("the terminal was closed while connecting");
    const timer = setTimeout(() => giveUp(`no shell after ${Math.round(ms / 1000)}s`), ms);
    timer.unref?.();
    abort.signal.addEventListener("abort", onAbort);
    p.then(
      (h) => {
        if (done) {
          try {
            h.kill();
          } catch {
            /* nothing to leak */
          }
          return;
        }
        done = true;
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", onAbort);
        resolve(h);
      },
      (err: unknown) => giveUp(err instanceof Error ? err.message : String(err)),
    );
  });
}