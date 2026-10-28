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

/** `[a-z0-9][a-z0-9-]{0,47}` — a backend id is persisted on chats and in `project.yaml`. */
export const TERMINAL_BACKEND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Which dialect the shell on the far end speaks. It picks the sentinel probe
 * line core appends after every command, so it must be what actually reads
 * the stdin — a `bash` reading PowerShell would never print the marker.
 */
export type TerminalBackendShell = "bash" | "powershell";

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
  /** Aborted when the terminal is closed (or the spawn timed out) while still connecting. */
  signal: HostAbortSignal;
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
  on(event: "exit", listener: (code: number | null) => void): unknown;
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
  /** Matches {@link TERMINAL_BACKEND_ID_PATTERN}; never `local`. */
  id: string;
  /** What the picker, the location badge and the agent note call it. */
  label: string;
  shell: TerminalBackendShell;
  /**
   * Start one shell. Async because provisioning takes time (cloning a
   * container, waiting for its address). Rejecting — or not settling within
   * {@link spawnTimeoutMs} — makes core start a LOCAL shell instead and say why,
   * in the terminal, in the chat, and in the next tool result.
   */
  spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle>;
  /** How long core waits on `spawn` before falling back. Default 120 s, capped at 10 min. */
  spawnTimeoutMs?: number;
  /**
   * Backend-specific lines for the agent, appended to core's own note about
   * where its terminal runs. Say what the agent cannot infer: how its local
   * edits reach the far side, what is NOT shared (installed dependencies, build
   * output), how to reach a server it starts there.
   */
  agentNote?(info: { chatId: string; projectId?: string }): string | undefined;
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

/** A registered backend, as the REST surface and the SPA see it. */
export const TerminalBackendInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  shell: z.enum(["bash", "powershell"]),
  /** The plugin that registered it. */
  pluginId: z.string().optional(),
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
  /** `connecting` while `spawn` is in flight; `ready` once the shell is up. */
  state: z.enum(["connecting", "ready", "fallback"]),
  /**
   * Set when the requested backend could not supply a shell and this one is
   * running LOCALLY instead — the reason, verbatim, for the badge's tooltip.
   */
  fallback: z.string().optional(),
});
export type TerminalLocation = z.infer<typeof TerminalLocationSchema>;

/** Where the chosen backend id came from. `terminal` = the agent named it for that one shell. */
export type TerminalBackendSource = "terminal" | "chat" | "project" | "default";

/** The allowed-locations list: backend ids (`local` included) an agent may pick per terminal. */
export const TerminalLocationsSchema = z.array(z.string().regex(TERMINAL_BACKEND_ID_PATTERN));

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
 * is what the agent gets by saying nothing), so choice is only REAL when the
 * list adds a second registered location — see the registry's `locations()`.
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
}

/** The agent's choice for one chat, resolved against what is actually registered. */
export interface TerminalLocationChoices {
  /** Where a terminal goes without `location` (may be an unregistered pin — it falls back). */
  defaultId: string;
  /** Selectable now: the default (when it can run) plus every allowed AND registered id. */
  options: TerminalLocationOption[];
  /** Allowed by config but not registered right now (plugin off or uninstalled). */
  unavailable: string[];
  /** True when there is a real choice — two or more options. */
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
