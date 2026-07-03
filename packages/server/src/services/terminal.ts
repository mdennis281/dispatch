/**
 * TerminalService — named, PERSISTENT shells for the agent.
 *
 * The Bash tool resets cwd/env every call. This service gives a chat a set of
 * long-lived shells (keyed by name) whose cwd + environment survive across
 * commands, exposed to the agent as `mcp__manager__terminal` and mirrored
 * read-only in the UI.
 *
 * ── Backend chosen: long-lived `powershell.exe -Command -` child process ──────
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
 * serialized so output attribution stays clean.
 *
 * The shell spawn is injected (`deps.spawn`) so tests drive a scripted fake
 * process — no real PowerShell, fully deterministic.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { nanoid } from "nanoid";
import type { TerminalInfo } from "@cm/shared";
import type { EventBus } from "../bus.js";

/* ------------------------------------------------------------------ spawn seam */

/** The minimal writable-stdin stream surface we drive. */
export interface ShellStdin {
  write(chunk: string): void;
  end?(): void;
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
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

/** Factory for a shell process rooted at `cwd`. Defaults to piped PowerShell. */
export type SpawnShell = (cwd: string) => ShellProcess;

/** Default shell: a persistent, stdin-piped PowerShell (see file header). */
export const defaultSpawnShell: SpawnShell = (cwd) =>
  nodeSpawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", "-"],
    { cwd, windowsHide: true, env: process.env },
  ) as unknown as ShellProcess;

/* ---------------------------------------------------------------------- deps */

export interface TerminalServiceDeps {
  spawn?: SpawnShell;
  genId?: () => string;
  now?: () => number;
}

export interface TerminalServiceOptions {
  bus: EventBus;
  /** Max concurrent shells per chat (default 8). */
  maxPerChat?: number;
  /** Retained output lines per terminal for reconnect scrollback (default 500). */
  scrollbackCap?: number;
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
  name: string;
  command: string;
  /** Default cwd for a first-time spawn of this terminal (worktree / repo). */
  cwd?: string;
  timeoutMs?: number;
  /** Cancels the wait (session abort) — the shell stays alive. */
  signal?: AbortSignal;
}

/** Result surfaced to the agent (and logged). */
export interface RunTerminalResult {
  output: string;
  exitCode: number | null;
  cwd: string;
  /** Set when the run could not complete (cap hit / timeout / cancelled). */
  error?: string;
  timedOut?: boolean;
}

/* ------------------------------------------------------------------- markers */

/** A distinctive prefix + a per-run nonce → a marker that can't collide with
 *  real command output. The marker line the shell prints after each command is
 *  `<prefix><nonce>|<exit>|<ok>|<cwd>` (cwd last; a path may itself contain `|`). */
const SENTINEL_PREFIX = "CMTERMSENTINEL_";

/** Default per-command timeout (10 min) — a runaway build shouldn't wedge a run. */
const DEFAULT_TIMEOUT_MS = 600_000;

/* ------------------------------------------------------------- internal state */

interface Terminal {
  id: string;
  chatId: string;
  name: string;
  cwd: string;
  status: "live" | "exited";
  busy: boolean;
  lastCommand?: string;
  lastExitCode: number | null;
  createdAt: number;
  updatedAt: number;
  proc: ShellProcess;
  /** Partial line buffers per stream (chunks split mid-line). */
  stdoutBuf: string;
  stderrBuf: string;
  scrollback: TerminalLine[];
  /** Serializes runs on this terminal (each waits for the previous marker). */
  queue: Promise<unknown>;
  /** The in-flight run's marker resolver, if any. */
  pending?: {
    marker: string;
    resolve: (r: { exitCode: number | null; cwd: string }) => void;
    output: string[];
  };
}

/* =============================================================== TerminalService */

export class TerminalService {
  private readonly bus: EventBus;
  private readonly spawn: SpawnShell;
  private readonly genId: () => string;
  private readonly now: () => number;
  private readonly maxPerChat: number;
  private readonly scrollbackCap: number;

  private readonly terminals = new Map<string, Terminal>();

  constructor(opts: TerminalServiceOptions) {
    this.bus = opts.bus;
    this.spawn = opts.deps?.spawn ?? defaultSpawnShell;
    this.genId = opts.deps?.genId ?? (() => nanoid());
    this.now = opts.deps?.now ?? (() => Date.now());
    this.maxPerChat = Math.max(1, opts.maxPerChat ?? 8);
    this.scrollbackCap = Math.max(1, opts.scrollbackCap ?? 500);
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
      // Enforce the per-chat cap only when creating a NEW live shell.
      if (!term) {
        const live = [...this.terminals.values()].filter(
          (t) => t.chatId === args.chatId && t.status === "live",
        ).length;
        if (live >= this.maxPerChat) {
          return {
            output: "",
            exitCode: null,
            cwd: args.cwd ?? "",
            error: `Terminal cap reached (${this.maxPerChat} shells for this chat). Reuse an existing terminal name.`,
          };
        }
      }
      term = this.open(key, args.chatId, name, args.cwd ?? process.cwd());
    }

    // Serialize behind any in-flight run on this terminal.
    const gate = term.queue.catch(() => {});
    const run = gate.then(() => this.exec(term!, args));
    term.queue = run.catch(() => {});
    return run;
  }

  /** Spawn + register a shell for `key`. */
  private open(key: string, chatId: string, name: string, cwd: string): Terminal {
    const proc = this.spawn(cwd);
    const now = this.now();
    const term: Terminal = {
      id: key,
      chatId,
      name,
      cwd,
      status: "live",
      busy: false,
      lastExitCode: null,
      createdAt: now,
      updatedAt: now,
      proc,
      stdoutBuf: "",
      stderrBuf: "",
      scrollback: [],
      queue: Promise.resolve(),
    };
    this.terminals.set(key, term);

    proc.stdout.on("data", (c) => this.onData(term, "stdout", c.toString()));
    proc.stderr.on("data", (c) => this.onData(term, "stderr", c.toString()));
    proc.on("error", () => this.onExit(term));
    proc.on("exit", () => this.onExit(term));

    this.publishUpdate(term);
    return term;
  }

  /** Write one command + its sentinel probe, and resolve when the marker lands. */
  private exec(term: Terminal, args: RunTerminalArgs): Promise<RunTerminalResult> {
    if (term.status === "exited") {
      return Promise.resolve({
        output: "",
        exitCode: null,
        cwd: term.cwd,
        error: "Terminal has exited.",
      });
    }

    const command = args.command;
    const marker = `${SENTINEL_PREFIX}${this.genId()}`;
    term.busy = true;
    term.lastCommand = command;
    term.updatedAt = this.now();
    this.publishUpdate(term);

    // Echo the command into the read-only stream (piped shells don't echo input).
    this.record(term, "command", command);

    return new Promise<RunTerminalResult>((resolve) => {
      let settled = false;
      const cleanups: (() => void)[] = [];
      const finish = (r: RunTerminalResult): void => {
        if (settled) return;
        settled = true;
        for (const c of cleanups) c();
        term.pending = undefined;
        term.busy = false;
        if (typeof r.exitCode === "number" || r.exitCode === null) {
          term.lastExitCode = r.exitCode;
        }
        term.updatedAt = this.now();
        this.publishUpdate(term);
        resolve(r);
      };

      const output: string[] = [];
      term.pending = {
        marker,
        output,
        resolve: ({ exitCode, cwd }) => {
          term.cwd = cwd || term.cwd;
          finish({ output: output.join("\n"), exitCode, cwd: term.cwd });
        },
      };

      // Timeout: report partial output but keep the shell alive.
      const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        finish({
          output: output.join("\n"),
          exitCode: null,
          cwd: term.cwd,
          timedOut: true,
          error: `Command timed out after ${timeoutMs}ms (still running in the background).`,
        });
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timer));

      // Session abort → stop waiting (shell survives for the next turn).
      const sig = args.signal;
      if (sig) {
        if (sig.aborted) {
          finish({
            output: output.join("\n"),
            exitCode: null,
            cwd: term.cwd,
            error: "Cancelled (session interrupted).",
          });
          return;
        }
        const onAbort = (): void =>
          finish({
            output: output.join("\n"),
            exitCode: null,
            cwd: term.cwd,
            error: "Cancelled (session interrupted).",
          });
        sig.addEventListener("abort", onAbort);
        cleanups.push(() => sig.removeEventListener("abort", onAbort));
      }

      // The probe: capture $?/$LASTEXITCODE right after the command, then print
      // the marker line `<marker>|<exit>|<ok>|<cwd>`. `[Console]::Out.Flush` is
      // implicit for Write-Output; the piped shell flushes per line.
      const probe =
        `$__cm_ok = $?; $__cm_ec = $LASTEXITCODE; ` +
        `Write-Output ("${marker}|" + $(if ($null -ne $__cm_ec) { $__cm_ec } ` +
        `elseif ($__cm_ok) { 0 } else { 1 }) + "|" + $__cm_ok + "|" + $PWD.Path)`;
      try {
        term.proc.stdin.write(command + "\n");
        term.proc.stdin.write(probe + "\n");
      } catch (err) {
        finish({
          output: output.join("\n"),
          exitCode: null,
          cwd: term.cwd,
          error: err instanceof Error ? err.message : String(err),
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

  /** Append to scrollback + fan out a `terminal-output` event. */
  private record(term: Terminal, stream: TerminalLine["stream"], chunk: string): void {
    const ts = this.now();
    term.scrollback.push({ stream, chunk, ts });
    if (term.scrollback.length > this.scrollbackCap) {
      term.scrollback.splice(0, term.scrollback.length - this.scrollbackCap);
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

  private onExit(term: Terminal): void {
    if (term.status === "exited") return;
    term.status = "exited";
    term.busy = false;
    term.updatedAt = this.now();
    // Resolve any in-flight run so a caller never hangs on a dead shell.
    if (term.pending) {
      term.pending.resolve({ exitCode: null, cwd: term.cwd });
    }
    this.publishUpdate(term);
  }

  /* ----------------------------------------------------------- teardown */

  /** Kill + forget every terminal owned by a chat (chat deleted / teardown). */
  killChat(chatId: string): void {
    for (const [key, term] of [...this.terminals.entries()]) {
      if (term.chatId !== chatId) continue;
      this.terminals.delete(key);
      try {
        term.proc.kill();
      } catch {
        /* already dead */
      }
      this.bus.publish({ type: "terminal-closed", terminalId: term.id, chatId });
    }
  }

  /** Kill every terminal (process teardown). */
  dispose(): void {
    for (const term of this.terminals.values()) {
      try {
        term.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.terminals.clear();
  }

  /* -------------------------------------------------------- introspection */

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => this.view(t));
  }

  listChat(chatId: string): TerminalInfo[] {
    return this.list().filter((t) => t.chatId === chatId);
  }

  /** Retained scrollback for a terminal (reconnect hydration). */
  scrollback(terminalId: string): TerminalLine[] {
    return this.terminals.get(terminalId)?.scrollback.slice() ?? [];
  }

  private view(t: Terminal): TerminalInfo {
    return {
      id: t.id,
      chatId: t.chatId,
      name: t.name,
      cwd: t.cwd,
      status: t.status,
      busy: t.busy,
      lastCommand: t.lastCommand,
      lastExitCode: t.lastExitCode,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private publishUpdate(term: Terminal): void {
    this.bus.publish({ type: "terminal-update", terminal: this.view(term) });
  }
}
