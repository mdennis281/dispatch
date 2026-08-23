/**
 * TerminalService — named, PERSISTENT shells for the agent.
 *
 * The Bash tool resets cwd/env every call. This service gives a chat a set of
 * long-lived shells (keyed by name) whose cwd + environment survive across
 * commands, exposed to the agent as `mcp__dispatch-workspace__terminal` and mirrored
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
import treeKill from "tree-kill";
import { nanoid } from "nanoid";
import {
  applyRegistryQuery,
  type RegistryQuery,
  type TerminalInfo,
  type TerminalLineRecord,
  type TerminalOrigin,
  type TerminalRecord,
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
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
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

/** Default shell: a persistent, stdin-piped PowerShell (see file header). */
export const defaultSpawnShell: SpawnShell = (cwd) =>
  nodeSpawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", "-"],
    { cwd, windowsHide: true, env: process.env },
  ) as unknown as ShellProcess;

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

export interface TerminalServiceDeps {
  spawn?: SpawnShell;
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
}

/* ------------------------------------------------------------------- markers */

/** A distinctive prefix + a per-run nonce → a marker that can't collide with
 *  real command output. The marker line the shell prints after each command is
 *  `<prefix><nonce>|<exit>|<ok>|<cwd>` (cwd last; a path may itself contain `|`). */
const SENTINEL_PREFIX = "CMTERMSENTINEL_";

/** Default per-command timeout (10 min) — a runaway build shouldn't wedge a run. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** How long a terminal's transcript is kept before the sweep drops it. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
  /** The in-flight run's marker resolver, if any. */
  pending?: {
    marker: string;
    resolve: (r: { exitCode: number | null; cwd: string }) => void;
    output: string[];
  };
  /** Set while a `background` command holds this shell (see `run`). */
  background?: { command: string; since: number };
}

/* =============================================================== TerminalService */

export class TerminalService {
  private readonly bus: EventBus;
  private readonly spawn: SpawnShell;
  private readonly genId: () => string;
  private readonly now: () => number;
  private readonly maxPerChat: number;
  private readonly scrollbackCap: number;
  private readonly killTree: KillTreeFn;

  private readonly store?: Store;
  private readonly retentionMs: number;
  private readonly flushIntervalMs: number;

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
    this.genId = opts.deps?.genId ?? (() => nanoid());
    this.now = opts.deps?.now ?? (() => Date.now());
    this.killTree = opts.deps?.killTree ?? defaultKillTree;
    this.maxPerChat = Math.max(1, opts.maxPerChat ?? 8);
    this.scrollbackCap = Math.max(1, opts.scrollbackCap ?? 500);
    this.store = opts.store;
    this.retentionMs = Math.max(60_000, opts.retentionMs ?? DEFAULT_RETENTION_MS);
    this.flushIntervalMs = Math.max(100, opts.flushIntervalMs ?? 1_000);
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
      term = this.open(key, name, args.cwd ?? process.cwd(), args);
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
    const run = gate.then(() => this.backgroundBusy(term!, name) ?? this.exec(term!, args));
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
    ident: { chatId: string; projectId?: string; origin?: TerminalOrigin },
  ): Terminal {
    const proc = this.spawn(cwd);
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
    };
    this.archived.delete(key);
    this.terminals.set(key, term);
    this.track(this.persist(term));

    proc.stdout.on("data", (c) => this.onData(term, "stdout", c.toString()));
    proc.stderr.on("data", (c) => this.onData(term, "stderr", c.toString()));
    proc.on("error", () => this.onExit(term));
    proc.on("exit", () => this.onExit(term));
    // stdin is its own emitter: writing to a shell that has already died raises
    // EPIPE/ERR_STREAM_DESTROYED ASYNCHRONOUSLY, which the try/catch around the
    // `.write()` calls in `run` cannot see. Unlistened, that 'error' event is an
    // uncaught exception — a dead terminal would have taken the server with it.
    proc.stdin.on?.("error", () => this.onExit(term));

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
        term.background = undefined;
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

      // Timeout: report partial output but keep the shell alive. A background
      // command has no deadline — never finishing is the point — and both the
      // timeout and the abort path below would clear `pending`/`background`,
      // marking the shell free while a dev server is still holding it.
      const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
      if (!args.background) {
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
      }

      // Session abort → stop waiting (shell survives for the next turn).
      const sig = args.background ? undefined : args.signal;
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
        return;
      }

      // Backgrounded: hand the caller back the shell NOW. `pending` deliberately
      // stays armed — when the command does eventually exit, its marker lands,
      // `finish` runs, and the terminal reports itself free again.
      if (args.background) {
        term.background = { command, since: this.now() };
        this.publishUpdate(term);
        resolve({
          output: "",
          exitCode: null,
          cwd: term.cwd,
          backgrounded: true,
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
