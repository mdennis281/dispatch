/**
 * Terminal backends — where a chat's managed shells RUN.
 *
 * By default every shell behind `mcp__dispatch-workspace__terminal` and the
 * Terminals panel is a local `powershell`/`bash` child of the server. A plugin
 * declaring the `terminals` capability can register another place to run them
 * (a container, a VM, a remote box) with `ctx.terminals.registerBackend`.
 * Which one a chat uses is a choice — the chat's own `terminalBackend`, else
 * its project's `defaults.terminalBackend`, else `local` — resolved by
 * {@link resolveTerminalBackend} so the server and the SPA agree on it.
 *
 * The contract a backend implements is deliberately the SAME stdio shape
 * TerminalService already drives for a local shell (piped stdin, stdout and
 * stderr streams, `kill`, `exit`): the sentinel protocol, scrollback,
 * background runs and transcripts are core's and work unchanged over any
 * transport that can carry a line of text each way. A backend owns only
 * "get me a shell over there".
 *
 * PURE TYPES + zod for the wire half. No server imports — this file is
 * re-exported to plugin authors by `@dispatch/plugin-sdk`.
 */
import { z } from "zod";
import type { HostAbortSignal } from "./harness.js";
import { resolveLayered, type Layered } from "./layered.js";

/** The id that always means "a local shell on the Dispatch host". Never registrable. */
export const LOCAL_TERMINAL_BACKEND = "local";

/**
 * The ids THIS version registers, and so the only ones it can resolve:
 * `[a-z0-9][a-z0-9-]{0,47}`, optionally QUALIFIED by the registering plugin's
 * id — `<pluginId>/<name>`, e.g. `remote-host/cvx-mac`.
 *
 * A qualified id cannot collide with another plugin's backend: one plugin
 * that registers a backend per machine the human pairs would otherwise race
 * every other plugin for bare names like `mac`. The registry refuses a prefix
 * that is not the registering plugin's id. Unqualified ids stay valid — the
 * published proxmox-terminal plugin registers `proxmox`.
 */
export const TERMINAL_BACKEND_ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,47}$/;

/** The plugin a QUALIFIED backend id names (`remote-host` for `remote-host/cvx-mac`); undefined for a bare id. */
export function terminalBackendPluginOf(id: string): string | undefined {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/**
 * What a PERSISTED backend id may look like — a chat's pin, app settings'
 * `terminalLocations`, project.yaml `defaults` — deliberately looser than
 * {@link TERMINAL_BACKEND_ID_PATTERN}.
 *
 * `config/` is shared by the stable and dev instances, and either may be the
 * newer. Read against the strict pattern, an id in a format the reader had
 * never heard of failed the WHOLE file: every app-settings read threw, a
 * project.yaml went invalid. Dropping the id instead would erase it on the
 * older instance's next save (`PUT /api/settings` replaces the file). So any
 * id-shaped string is KEPT, and one this version cannot read
 * ({@link isReadableTerminalBackendId}) is unavailable, fails closed, and is
 * flagged where a human looks. No whitespace or backtick: ids are quoted into
 * agent prompts.
 */
export const TERMINAL_BACKEND_REF_PATTERN = /^[^\s`]{1,128}$/;

/** A persisted backend id — see {@link TERMINAL_BACKEND_REF_PATTERN}. */
export const TerminalBackendRefSchema = z.string().regex(TERMINAL_BACKEND_REF_PATTERN);

/** Whether this version can use a persisted backend id: `local`, or an id it could register. */
export function isReadableTerminalBackendId(id: string): boolean {
  return id === LOCAL_TERMINAL_BACKEND || TERMINAL_BACKEND_ID_PATTERN.test(id);
}

/** Why a persisted id this version cannot read is unavailable — refusals, the agent note, config warnings. */
export const UNREADABLE_TERMINAL_BACKEND_REASON =
  "this version of Dispatch cannot read the id (a newer version probably wrote it)";

/**
 * Which dialect the shell on the far end speaks. It picks the sentinel probe
 * line core appends after every command, so it must be what actually reads
 * the stdin — a `bash` reading PowerShell would never print the marker.
 */
export type TerminalBackendShell = "bash" | "powershell";

/**
 * What core does when a backend cannot supply a shell — its spawn rejected or
 * overran, or its plugin is off.
 *
 * - `local` (the default): start a LOCAL shell instead, and say so loudly. Right
 *   for a Linux container standing in for a Linux-ish host: the command still
 *   means the same thing.
 * - `refuse`: start nothing. The run fails with the backend and the reason, and
 *   the terminal ends. Right when the far side is a different OS or toolchain —
 *   a Mac's `xcodebuild`, or a POSIX `rm -rf`, must never reach PowerShell on
 *   the Dispatch host.
 */
export type TerminalBackendFallback = "local" | "refuse";
export const TERMINAL_BACKEND_FALLBACKS = ["local", "refuse"] as const satisfies readonly TerminalBackendFallback[];

/** What a backend is told when core needs a shell from it. */
export interface TerminalSpawnInfo {
  chatId: string;
  projectId?: string;
  /** The terminal's name within the chat (`build`, `server`, …). */
  name: string;
  /**
   * The LOCAL directory the shell would have started in: the chat's worktree,
   * else the project's checkout. A remote backend maps it to its own copy.
   */
  cwd: string;
  /** The project's primary checkout, when the chat belongs to one. */
  repoPath?: string;
  /**
   * The chat's own git worktree, when it works in one — absent for a chat in
   * the primary checkout. The root a backend snapshots, which `cwd` is not
   * guaranteed to stay: it is where the shell STARTS.
   */
  worktreePath?: string;
  /**
   * The branch checked out at the chat's root (its worktree, else the primary
   * checkout) when the shell was asked for, read from git. Absent on a
   * detached HEAD or outside a repository.
   */
  branch?: string;
  /** Aborted when the terminal is closed (or the spawn timed out) while still connecting. */
  signal: HostAbortSignal;
}

/**
 * How long core waits on `beforeRun` or `afterRun` by default. A sync can be
 * slow (the first one seeds a checkout), so the bound is generous, and it is
 * spent OUTSIDE the command's own timeout.
 */
export const TERMINAL_RUN_HOOK_TIMEOUT_MS = 600_000;
/** The most a backend may ask for with `runHookTimeoutMs`. */
export const TERMINAL_RUN_HOOK_MAX_TIMEOUT_MS = 3_600_000;

/** What `beforeRun` is told about one command on a shell the backend serves. */
export interface TerminalRunInfo {
  /**
   * This run, and no other: the same value in its `beforeRun` and its
   * `afterRun`, never reused. Pair the two hooks by it. `chatId` + `terminal`
   * can't do that — a background run's `afterRun` arrives long after, and a
   * timed-out run's command may still be going when the next one starts.
   */
  runId: string;
  chatId: string;
  projectId?: string;
  /** The terminal's name within the chat — the same `name` its spawn was given. */
  terminal: string;
  /**
   * The command as the agent gave it. Core writes it to the shell WRAPPED, so
   * that it reads EOF and not the shell's own input (docs/plugins.md, "Stdin");
   * take the command from here, not from the write.
   */
  command: string;
  /** The shell's cwd ON THE FAR SIDE as core last saw it — where the command starts. */
  cwd: string;
  /** The command returns as soon as it is written (a dev server, a watcher). */
  background: boolean;
  /**
   * Aborted when core stops waiting for the hook: the caller cancelled (a
   * session interrupt), the terminal closed or its shell exited, or the hook
   * overran its bound. Core does NOT wait for a hook that ignores it — so a
   * hook that keeps working after an abort may overlap the next run's.
   */
  signal: HostAbortSignal;
}

/**
 * What `beforeRun` may answer. Nothing (or `{}`) runs the command as usual.
 */
export interface TerminalBeforeRunResult {
  /**
   * Do NOT run the command. Core never writes it; the run's result is an error
   * carrying this text verbatim, and the terminal's transcript says so too.
   * For a sync that failed, a conflict with a local edit, a checkout that is
   * not where it should be — anything that would make the command's outcome a
   * lie. Throwing does the same, with the error's message.
   */
  refuse?: string;
  /** Lines for the agent, delivered with this command's result (and in the transcript). */
  notices?: string[];
}

/** What `afterRun` is told: the same run, plus how it ended. */
export interface TerminalAfterRunInfo extends TerminalRunInfo {
  /** The command's exit code, or null when core never learned it (see `outcome`). */
  exitCode: number | null;
  /** From the write to when core stopped waiting. `beforeRun`'s time is not in it. */
  durationMs: number;
  /**
   * Why core stopped waiting. Only `finished` means the command is over:
   * after `timed-out` or `cancelled` it may still be running in the shell.
   */
  outcome: "finished" | "timed-out" | "cancelled" | "shell-exited";
  /** With `shell-exited`: the reason the handle gave, when it gave one. */
  exitReason?: TerminalExitReason;
}

/** What `afterRun` may answer. */
export interface TerminalAfterRunResult {
  /** Lines for the agent, appended to this command's result (and in the transcript). */
  notices?: string[];
}

/**
 * A chunk of shell output: a string, or a Node `Buffer` (decoded with its own
 * `toString()`, i.e. UTF-8). Spelled structurally because this package compiles
 * with no ambient Node types — it ships to the browser too.
 */
export type TerminalChunk = string | { toString(): string };

/** Minimal readable stream: `stdout`/`stderr` emit text or Buffer chunks. */
export interface TerminalBackendReadable {
  on(event: "data", listener: (chunk: TerminalChunk) => void): unknown;
}

/**
 * The handle `spawn` resolves to. A Node `ChildProcess` satisfies it, and so
 * does an ssh2 exec channel with a few lines of adapter.
 *
 * NO `pid`, on purpose: core treats a pid as a LOCAL process it may walk the
 * process table under and tree-kill. A remote shell's pid means nothing here,
 * and handing one over would let core kill an unrelated local process. So
 * `kill()` must take down the remote shell AND whatever it started — that is
 * the only teardown core can ask for.
 */
export interface TerminalBackendHandle {
  stdin: {
    write(chunk: string): unknown;
    end?(): unknown;
    on?(event: "error", listener: (err: Error) => void): unknown;
  };
  stdout: TerminalBackendReadable;
  stderr: TerminalBackendReadable;
  kill(signal?: string): void;
  /**
   * The shell ended. Pass a {@link TerminalExitReason} as the second argument
   * whenever you know WHY: without one core can only assume the shell ended on
   * its own, so a dropped connection reads as a command that finished with no
   * exit code — and the agent believes it.
   */
  on(event: "exit", listener: (code: number | null, reason?: TerminalExitReason) => void): unknown;
  /**
   * Core ALSO subscribes, through this same `on`, to two optional events — so
   * an EventEmitter-based handle just emits them:
   *
   * - `"stalled"`, with an optional {@link TerminalStallInfo}: the transport
   *   went quiet (keepalives unanswered) but is not given up on. Core pauses the
   *   running command's timeout and shows the shell as stalled until
   *   `"resumed"` (or `exit`), so a Wi-Fi blip neither eats a build's deadline
   *   nor looks like a hung command. Emitting it again updates the detail.
   *   The pause is capped (10 min of stall per command): still emit `exit`
   *   with `transport-lost` once you give up.
   * - `"resumed"`, no arguments: the transport answers again.
   *
   * They are deliberately not overloads here: a typed `"stalled"` overload
   * would break every handle adapter that casts an `"exit" | "error"` function
   * to this type, which is how published backends are written.
   */
  on(event: "error", listener: (err: Error) => void): unknown;
  /**
   * The directory the shell starts in ON THE FAR SIDE, when the backend knows
   * it. Core otherwise only learns a shell's cwd from the first command's
   * probe, so until then the terminal would show the LOCAL path it was asked
   * for — wrong for a background first command, which never reports back.
   */
  cwd?: string;
}

/**
 * Why a backend's shell ended — the second argument of its handle's `exit`.
 *
 * - `exited`: the shell itself ended (it ran `exit`, or died on its own).
 *   Treated exactly like an `exit` with no reason.
 * - `transport-lost`: the connection carrying it dropped. The far side may
 *   even still be running it, so a command in flight has an UNKNOWN outcome,
 *   and its result is an error that says so.
 * - `killed`: it was stopped on purpose — an idle stop, a container shut down,
 *   a supervisor's dead-man switch. A command in flight did not finish.
 */
export const TerminalExitReasonSchema = z.object({
  kind: z.enum(["exited", "transport-lost", "killed"]),
  /** One short line, shown to the agent and in the panel: "ssh: connection reset". */
  detail: z.string().optional(),
});
export type TerminalExitReason = z.infer<typeof TerminalExitReasonSchema>;

/** What a handle's `stalled` event may carry. */
export interface TerminalStallInfo {
  /** One short line for the panel: "no keepalive answer for 15 s". */
  detail?: string;
}

/**
 * How long core waits on `onChatIdle` / `onChatDeleted` before treating the
 * call as failed. A late success still clears a recorded retry.
 */
export const TERMINAL_CHAT_HOOK_TIMEOUT_MS = 60_000;

/** Passed to the lifecycle hooks. */
export interface TerminalChatEvent {
  chatId: string;
  projectId?: string;
}

/**
 * A terminal backend, as `ctx.terminals.registerBackend` takes it.
 *
 * Lifecycle hooks are fanned out to EVERY registered backend, whether or not
 * it ever made something for that chat — a backend keeps its own record of
 * what it owns, and a no-op for a chat it has never seen is the common case.
 */
export interface TerminalBackend {
  /**
   * Matches {@link TERMINAL_BACKEND_ID_PATTERN}; never `local`. Prefer the
   * qualified form, `<your plugin id>/<name>` — any other prefix is refused.
   * It is persisted on chats and in config, so keep it stable: rename with
   * `label`, never by changing the id.
   */
  id: string;
  /** What the picker, the location badge and the agent note call it. */
  label: string;
  shell: TerminalBackendShell;
  /**
   * Start one shell. Async because provisioning takes time (cloning a
   * container, waiting for its address). Rejecting — or not settling within
   * {@link spawnTimeoutMs} — makes core start a LOCAL shell instead and say why,
   * in the terminal, in the chat, and in the next tool result. With
   * `fallback: "refuse"` it starts nothing, and the run fails instead.
   */
  spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle>;
  /** How long core waits on `spawn` before giving up on it. Default 120 s, capped at 10 min. */
  spawnTimeoutMs?: number;
  /**
   * What happens when this backend cannot supply a shell — see
   * {@link TerminalBackendFallback}. Default `local`.
   *
   * Core remembers it per backend id (in the instance's state database), so
   * it still applies to a chat pinned here while the plugin is switched off or
   * uninstalled — exactly when nothing is registered to ask.
   */
  fallback?: TerminalBackendFallback;
  /**
   * Backend-specific lines for the agent, appended to core's own note about
   * where its terminal runs. Say what the agent cannot infer: how its local
   * edits reach the far side, what is NOT shared (installed dependencies, build
   * output), how to reach a server it starts there.
   */
  agentNote?(info: { chatId: string; projectId?: string }): string | undefined;
  /**
   * Called before EVERY command on a shell this backend serves, and awaited
   * before the command is written — the place to bring the far side up to date
   * with the local worktree, and to refuse when it cannot be (fail closed).
   * Resolve `{ refuse }` (or throw) to stop the command; `{ notices }` to tell
   * the agent something with its result.
   *
   * Its time is NOT charged to the command's timeout; it has its own bound,
   * {@link runHookTimeoutMs}, and overrunning it refuses the command. Runs on
   * one terminal are serialized, so two calls for the same terminal never
   * overlap unless one ignored its abort signal. Not called for a shell that
   * fell back to local, nor for a shell opened with no command.
   */
  beforeRun?(info: TerminalRunInfo): TerminalBeforeRunResult | void | Promise<TerminalBeforeRunResult | void>;
  /**
   * Called once core stops waiting on a command it wrote — the place to bring
   * changes the command made on the far side back, and say so. Awaited (on
   * the same bound as `beforeRun`) before the result is returned, and its
   * notices are appended to it; a throw or overrun becomes a notice, never a
   * failed run, because the command already ran.
   *
   * Two exceptions, both fire-and-forget with notices going only to the
   * transcript: a `cancelled` run (the caller has stopped listening), and a
   * `background` command, which is reported when the command finally ends —
   * long after its result went back.
   */
  afterRun?(info: TerminalAfterRunInfo): TerminalAfterRunResult | void | Promise<TerminalAfterRunResult | void>;
  /**
   * How long core waits on `beforeRun` / `afterRun`. Default
   * {@link TERMINAL_RUN_HOOK_TIMEOUT_MS}, capped at {@link TERMINAL_RUN_HOOK_MAX_TIMEOUT_MS}.
   */
  runHookTimeoutMs?: number;
  /**
   * The chat went idle — its session was retired by the idle sweep. Shells on
   * the backend are NOT killed by core; stopping (and later restarting on the
   * next spawn) is the backend's call.
   */
  onChatIdle?(e: TerminalChatEvent): void | Promise<void>;
  /**
   * The chat was deleted. Its shells are already gone; destroy what you made
   * for it.
   *
   * DURABLE: core awaits it (up to {@link TERMINAL_CHAT_HOOK_TIMEOUT_MS}) without
   * holding the delete open, and a rejection or timeout is written to the
   * state database and retried — with backoff while the server runs, and again
   * after the plugin's next `activate` + `reconcile` — until it resolves.
   * So: resolve only once the destroy is ACCEPTED (the request went through),
   * reject when it did not, and be idempotent — a retry may arrive for a chat
   * already cleaned up, or one this backend never served.
   */
  onChatDeleted?(e: TerminalChatEvent): void | Promise<void>;
  /** Called when the backend is unregistered (the plugin deactivating). */
  dispose?(): void | Promise<void>;
  /**
   * Host one long-lived stdio process over there — today, an MCP server a
   * chat's agent talks to (`mcpServers.<name>.location`, `browser.location`).
   * Optional: a backend without it is never asked, and a server set to follow
   * the terminal stays local for a chat on it.
   *
   * Core speaks newline-delimited JSON-RPC to the handle and enforces the
   * reconnect contract the agent's runtime sees (docs/plugins.md, "Hosting
   * processes"). The backend's half: keep the process alive across a dropped
   * link, emit `stalled` / `resumed` around a re-attach to the SAME process,
   * and `exit` only once it is gone or given up on.
   *
   * Rejecting fails the call that asked for it, with the message; core
   * retries on the agent's next call. It is never run locally instead.
   */
  spawnProcess?(info: TerminalProcessSpawnInfo): Promise<TerminalProcessHandle>;
}

/**
 * A server Dispatch bundles, described portably: the backend provides the
 * runtime and the package at this version on its side. The Dispatch host's
 * own resolved path to it would mean nothing over there.
 */
export interface TerminalBundledProcess {
  /** Which bundled server: `playwright`, `chrome-devtools`. */
  server: string;
  /** npm package name, e.g. `@playwright/mcp`. */
  package: string;
  /** The exact version the Dispatch host bundles — its cached tool list was taken from it. */
  version: string;
  /** The package's CLI entry within it (its `bin`), e.g. `cli.js`. */
  bin: string;
  /**
   * Flags derived from the project's `browser:` config. Path-free by
   * construction: where its output, profile and downloads go is the
   * backend's to choose — it owns the paths on its side — so a
   * Dispatch-host path is never in here.
   */
  args: string[];
  env?: Record<string, string>;
}

/** What `spawnProcess` is told. */
export interface TerminalProcessSpawnInfo {
  chatId: string;
  projectId?: string;
  /** What the process is for. Only `mcp` today. */
  purpose: "mcp";
  /** The MCP server's name in the session (`playwright`). One live process per chat + name. */
  name: string;
  /** The LOCAL directory the chat works in — map it, as for a shell. */
  cwd: string;
  /** The chat's own worktree, when it has one. */
  worktreePath?: string;
  /** Set for a server Dispatch bundles; `command` is then absent. */
  bundled?: TerminalBundledProcess;
  /** A configured server: run exactly this over there. Absent when `bundled` is set. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Aborted when core stops waiting for the spawn (the chat was deleted, the server is shutting down). */
  signal: HostAbortSignal;
}

/**
 * The handle `spawnProcess` resolves to. A `TerminalBackendHandle` minus the
 * shell bits; a Node `ChildProcess` satisfies it.
 *
 * Besides `exit` and `error`, core subscribes through this same `on` to two
 * optional events — the reconnect contract:
 *
 * - `"stalled"`, with an optional {@link TerminalStallInfo}: the link to the
 *   process dropped, the process is believed alive, and the backend is
 *   re-attaching. Core answers every request in flight with a JSON-RPC error
 *   and fails new ones at once until `resumed` — it never queues an agent's
 *   call behind a reconnect of unknown length.
 * - `"resumed"`: re-attached to the SAME process, which is still initialized.
 *   Core does NOT re-send `initialize`. Resume stdout at a line boundary; core
 *   drops any half line it held when the stall began, and any late reply to a
 *   request it already failed.
 *
 * `exit` means the process is gone, or the backend has given up on it (pass
 * `{ kind: "transport-lost" }`). Core then spawns a fresh one on the next call
 * and replays the client's `initialize` to it.
 */
export interface TerminalProcessHandle {
  stdin: {
    write(chunk: string): unknown;
    end?(): unknown;
    on?(event: "error", listener: (err: Error) => void): unknown;
  };
  stdout: TerminalBackendReadable;
  stderr?: TerminalBackendReadable;
  /** Stop the process over there, and whatever it started. */
  kill(signal?: string): void;
  on(event: "exit", listener: (code: number | null, reason?: TerminalExitReason) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * A remote listener made reachable on the Dispatch host. The backend does the
 * forwarding (it owns the transport); publishing it is what lets the agent,
 * the Terminals panel and Playwright find it.
 */
export const TerminalPortForwardSchema = z.object({
  chatId: z.string(),
  /** Backend that forwards it. */
  backend: z.string(),
  /** The port the listener holds on the far side. */
  remotePort: z.number().int().positive(),
  /** Where it answers locally — what a browser on the Dispatch host opens. */
  url: z.string(),
  label: z.string().optional(),
});
export type TerminalPortForward = z.infer<typeof TerminalPortForwardSchema>;
/** What a backend passes to `ctx.terminals.publishPort` — `backend` is filled in by the host. */
export type TerminalPortForwardInput = Omit<TerminalPortForward, "backend">;

/**
 * Whether a backend can take a shell right now, as its plugin reports it with
 * `ctx.terminals.setStatus`.
 *
 * - `online`: it can.
 * - `degraded`: it can, but something is off ("disk 95% full"). Offered as
 *   usual, labelled.
 * - `offline`: it cannot. It is not offered as a location. A shell asked of it
 *   fails AT ONCE under its `fallback` policy instead of waiting out
 *   `spawnTimeoutMs`, and a spawn already in flight is cut short.
 *
 * A backend whose plugin never reports a status is treated as online, exactly
 * as before statuses existed.
 */
export const TERMINAL_BACKEND_STATES = ["online", "offline", "degraded"] as const;
export type TerminalBackendState = (typeof TERMINAL_BACKEND_STATES)[number];

/** What a plugin passes to `ctx.terminals.setStatus`. */
export interface TerminalBackendStatusInput {
  state: TerminalBackendState;
  /** One short line for the picker and the refusal: "asleep", "ssh: connection refused". */
  detail?: string;
  /** When the backend last heard from the far side (epoch ms), if it tracks that. */
  lastSeenAt?: number;
}

/** A backend's status, as the host keeps and broadcasts it. */
export const TerminalBackendStatusSchema = z.object({
  state: z.enum(TERMINAL_BACKEND_STATES),
  detail: z.string().optional(),
  lastSeenAt: z.number().int().optional(),
  /** When `state` last CHANGED (epoch ms) — stamped by the host, not the plugin. */
  since: z.number().int(),
});
export type TerminalBackendStatus = z.infer<typeof TerminalBackendStatusSchema>;

/**
 * What `ctx.terminals.updateBackend` may change on a registered backend
 * without re-registering it, so the shells running on it are left alone. A
 * key you pass replaces that field; `agentNote: undefined` removes the note.
 * The id, shell, spawn and `fallback` policy are fixed for the registration.
 */
export interface TerminalBackendUpdate {
  label?: string;
  agentNote?: TerminalBackend["agentNote"];
}

/** A registered backend, as the REST surface and the SPA see it. */
export const TerminalBackendInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  shell: z.enum(["bash", "powershell"]),
  /** The plugin that registered it. */
  pluginId: z.string().optional(),
  /** Its {@link TerminalBackendFallback} policy; absent on a server that predates it (read as `local`). */
  fallback: z.enum(TERMINAL_BACKEND_FALLBACKS).optional(),
  /** Absent until its plugin reports one — read as online. */
  status: TerminalBackendStatusSchema.optional(),
});
export type TerminalBackendInfo = z.infer<typeof TerminalBackendInfoSchema>;

/**
 * Where ONE shell actually runs, on `TerminalInfo.location`. Absent means a
 * local shell chosen as local — every terminal on an install with no backend
 * plugin, which is how "nothing changes" stays literally true on the wire.
 */
export const TerminalLocationSchema = z.object({
  /** The backend that was asked for. */
  backend: z.string(),
  label: z.string(),
  /**
   * `connecting` while `spawn` is in flight; `ready` once the shell is up;
   * `stalled` while its transport has gone quiet (the handle's `stalled`
   * event) — back to `ready` on `resumed`. `fallback`: it is running locally
   * instead. `failed`: the backend refuses a local fallback, so nothing is
   * running — the terminal has exited.
   */
  state: z.enum(["connecting", "ready", "fallback", "stalled", "failed"]),
  /**
   * Set when the requested backend could not supply a shell and this one is
   * running LOCALLY instead — the reason, verbatim, for the badge's tooltip.
   */
  fallback: z.string().optional(),
  /** While `stalled`: since when (epoch ms), and the backend's detail if it gave one. */
  stalledSince: z.number().int().optional(),
  stalled: z.string().optional(),
  /** Set with `failed`: why the backend could not supply a shell. */
  error: z.string().optional(),
});
export type TerminalLocation = z.infer<typeof TerminalLocationSchema>;

/** Where the chosen backend id came from. `terminal` = the agent named it for that one shell. */
export type TerminalBackendSource = "terminal" | "chat" | "project" | "default";

/**
 * The allowed-locations list: backend ids (`local` included) an agent may pick
 * per terminal. Persisted, so read loosely — see {@link TERMINAL_BACKEND_REF_PATTERN}.
 */
export const TerminalLocationsSchema = z.array(TerminalBackendRefSchema);

/**
 * Which locations the AGENT may choose between, per terminal — app setting
 * `terminalLocations`, overridden whole by project.yaml `defaults.terminalLocations`.
 *
 * Absent at a layer means inherit; `[]` is a pin ("no choice here"), so a
 * project can switch off a choice the app turned on. Unset everywhere is `[]`:
 * the agent picks nothing and every shell goes where the chat → project →
 * local rule sends it, exactly as before the list existed.
 *
 * The chat's own default location is always pickable on top of this list (it
 * is what the agent gets by saying nothing), so there is a choice only when the
 * list adds a second location — see the registry's `locations()`, which tells
 * a choice the config OFFERS from one that can be made right now.
 */
export function resolveTerminalLocations(layers: {
  project?: readonly string[] | null;
  app?: readonly string[] | null;
}): Layered<string[]> {
  return resolveLayered<string[]>(
    {
      ...(layers.project ? { project: [...layers.project] } : {}),
      ...(layers.app ? { app: [...layers.app] } : {}),
    },
    [],
  );
}

/** One place the agent may send a new terminal, as the registry offers it. */
export interface TerminalLocationOption {
  id: string;
  label: string;
  /** The chat's default — where a terminal goes when `location` is omitted. */
  isDefault: boolean;
  /** Set when its backend reports `degraded`: the detail, or "degraded". It is still selectable. */
  degraded?: string;
}

/** The agent's choice for one chat, resolved against what is actually registered. */
export interface TerminalLocationChoices {
  /** Where a terminal goes without `location` (may be an unregistered pin — it falls back). */
  defaultId: string;
  /** Selectable now: the default (when it can run) plus every allowed, registered and not-offline id. */
  options: TerminalLocationOption[];
  /**
   * Allowed by config but not selectable right now: not registered (plugin off
   * or uninstalled), or registered and reporting `offline`. The DEFAULT is
   * listed here too when it is either, since a terminal sent there cannot run
   * there — so every `allowed` id is in exactly one of `options` and this.
   */
  unavailable: string[];
  /** Why each `unavailable` id is unavailable, for the refusal and the agent note. */
  reasons?: Record<string, string>;
  /**
   * Every id the agent may NAME: the default plus the configured list, in that
   * order, whether or not it can take a shell right now. An unregistered id
   * carries its remembered label, else its id. Unlike `options`, this moves
   * only when the config does.
   */
  allowed: TerminalLocationOption[];
  /**
   * True when the CONFIG gives the agent a choice — `allowed` has two or more
   * ids — however many of them can run right now. This decides whether a
   * session's terminal tool offers `location` at all: a tool's schema is fixed
   * for the session's life, so deciding on what is up at session build left a
   * host that was asleep then unpickable once it woke.
   */
  offered: boolean;
  /** True when there is a real choice RIGHT NOW — two or more `options`. */
  enabled: boolean;
}

/**
 * The selection rule, in one place: the chat's pin, else the project's
 * `defaults.terminalBackend`, else `local`. An empty string counts as unset.
 * Whether the winner is actually REGISTERED is a separate question the caller
 * answers — a pin to an uninstalled backend is still the chat's choice, and
 * core reports it as a fallback rather than silently re-reading it as local.
 */
export function resolveTerminalBackend(input: {
  /** The agent's per-terminal `location`, when it named one. Beats the chat pin. */
  terminal?: string | null;
  chat?: string | null;
  project?: string | null;
}): { id: string; source: TerminalBackendSource } {
  if (input.terminal) return { id: input.terminal, source: "terminal" };
  if (input.chat) return { id: input.chat, source: "chat" };
  if (input.project) return { id: input.project, source: "project" };
  return { id: LOCAL_TERMINAL_BACKEND, source: "default" };
}

/**
 * One command a chat's managed shell is running right now, on ANY location —
 * `ctx.terminals.runs()` / `onRun`. What a backend needs to keep a lock that
 * spans more than its own shells: two runs touching one checkout (a remote
 * sync and a local `pnpm install`, say) must not overlap, and the backend only
 * ever hears about its own runs through its hooks.
 *
 * A run is in flight from the moment the shell takes it until the shell is
 * free again. That covers time in `beforeRun`, a command the agent sent to the
 * background (until the command itself ends), and `afterRun`.
 */
export interface TerminalRunInFlight {
  /** The same id `beforeRun` / `afterRun` get for this run on a backend's own shell. */
  runId: string;
  chatId: string;
  projectId?: string;
  /** The terminal's name within its chat (`main`, `build`…). */
  terminal: string;
  /**
   * Where it runs: a registered backend's id, or `local`. A shell that FELL
   * BACK to this machine is `local` — that is where its command really runs.
   */
  backend: string;
  /** The shell's working directory when the run started. */
  cwd: string;
  /**
   * The command, only for runs on the asking plugin's OWN backends. A run
   * anywhere else is reported (so a lock can count it) but not what it runs:
   * the `terminals` capability is consent to see commands run THERE.
   */
  command?: string;
  /** The agent handed it to the background; the shell stays busy until it ends. */
  background: boolean;
  /** Epoch ms the shell took it. */
  startedAt: number;
}

/** A run starting or ending, as `ctx.terminals.onRun` reports it. */
export interface TerminalRunEvent {
  kind: "started" | "ended";
  run: TerminalRunInFlight;
  /** Epoch ms of the change. */
  at: number;
}

/** Narrow `ctx.terminals.runs()`. Every field given must match. */
export interface TerminalRunFilter {
  chatId?: string;
  projectId?: string;
  /** A backend id, or `local`. */
  backend?: string;
}
