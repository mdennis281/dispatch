/**
 * RunnerService — the per-worktree subApp process manager.
 *
 * One RunnerService drives many `RunnerInstance`s. For each start it:
 *   1. allocates a free port per declared `subApp.ports` entry (offset upward from
 *      the declared base if it's in use), setting the primary as `PORT` in env;
 *   2. if the subApp declares a `dockerCompose` file, runs `docker compose up -d`
 *      in that file's directory FIRST;
 *   3. spawns `subApp.dev` (via a shell) in `worktreePath/subApp.path` with `PORT`
 *      injected, registering a `RunnerInstance` in `runners.json`;
 *   4. streams stdout/stderr line-by-line as `runner-log` bus events and keeps a
 *      bounded in-memory ring for `logs(id)`.
 *
 * stop() tree-kills the process (Windows-safe via tree-kill) and, if docker was
 * used, runs `docker compose down`. reconcile() runs at boot and terminates every
 * runner left over from a previous server process — reaping the ones whose pid is
 * somehow still alive, since this process can no longer manage them.
 *
 * All process/port/kill/docker primitives are injectable so tests never touch a
 * real docker daemon; the default wiring uses execa + get-port + tree-kill.
 */
import { dirname, basename, resolve } from "node:path";
import { execa } from "execa";
import getPort, { portNumbers } from "get-port";
import treeKill from "tree-kill";
import { nanoid } from "nanoid";
import type {
  RunnerInstance,
  RunnerStatus,
  SubApp,
  WsServerEvent,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";

/* ----------------------------------------------------------- injectable seams */

/** Minimal shape of a spawned child we depend on (execa subprocess satisfies it). */
export interface ChildLike {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  cwd: string;
  /** Extra env overlaid on the parent env (e.g. `PORT`). */
  env: Record<string, string>;
}

/** Spawns the long-running dev command (a full shell command string). */
export type SpawnFn = (command: string, opts: SpawnOptions) => ChildLike;

export interface RunOnceResult {
  exitCode?: number | undefined;
}

/** Runs a one-shot command to completion (docker compose up/down). */
export type RunOnceFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<RunOnceResult>;

/** Allocates a free port, preferring `preferred` and offsetting upward if taken. */
export type GetPortFn = (preferred?: number) => Promise<number>;

/** Tree-kills a process (all descendants) — Windows-safe. */
export type KillTreeFn = (pid: number) => Promise<void>;

export interface RunnerDeps {
  store: Store;
  bus: EventBus;
  spawn?: SpawnFn;
  runOnce?: RunOnceFn;
  getPort?: GetPortFn;
  killTree?: KillTreeFn;
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  genId?: () => string;
  /** Max stdout/stderr lines retained per runner for `logs()`. */
  maxLogLines?: number;
}

/** One captured output line, returned by `logs()`. */
export interface RunnerLogLine {
  stream: "stdout" | "stderr";
  line: string;
  ts: number;
}

/* -------------------------------------------------------------- default wiring */

const defaultSpawn: SpawnFn = (command, opts) => {
  const child = execa(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    buffer: false,
    reject: false,
    // `ignore`, NOT the execa default `pipe`: a long-running dev server never
    // reads stdin, but an OPEN (never-closing, never-EOF) stdin pipe makes some
    // tools block on startup — notably Vite/esbuild, which crawled to a ~13s
    // "ready" (vs ~0.5s) so the app looked dead. EOF'd stdin fixes it.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Never let the subprocess promise reject unhandled (reject:false already guards).
  void (child as unknown as Promise<unknown>).catch(() => {});
  return child as unknown as ChildLike;
};

const defaultRunOnce: RunOnceFn = async (file, args, opts) => {
  const res = await execa(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    reject: false,
    buffer: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: res.exitCode };
};

/**
 * How far above a declared base port the allocator will look for a free one.
 * `ProcessService` scans the same distance when hunting orphans — a narrower
 * scan there would blind the reaper to exactly the runaway ladders it exists to
 * clean up, so both sides read this constant.
 */
export const PORT_SCAN_RANGE = 100;

const defaultGetPort: GetPortFn = (preferred) => {
  if (preferred === undefined) return getPort();
  if (preferred >= 1024 && preferred < 65535) {
    return getPort({
      port: portNumbers(preferred, Math.min(preferred + PORT_SCAN_RANGE, 65535)),
    });
  }
  return getPort({ port: preferred });
};

const defaultKillTree: KillTreeFn = (pid) =>
  new Promise((res) => treeKill(pid, "SIGTERM", () => res()));

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = process exists but we can't signal it → still alive.
    return (e as { code?: string }).code === "EPERM";
  }
}

/**
 * Substitute `{port}` / `{portN}` placeholders (1-indexed; `{port}` == `{port1}`)
 * with the allocated ports. An out-of-range placeholder is left as-is. Used for
 * both the dev command string and each `subApp.env` value, so a tool that ignores
 * the injected `PORT` still receives its port under the name it actually reads.
 */
export function substitutePorts(input: string, ports: number[]): string {
  return input.replace(/\{port(\d*)\}/g, (m, n: string) => {
    const idx = n === "" ? 0 : Number(n) - 1;
    const p = ports[idx];
    return p !== undefined ? String(p) : m;
  });
}

/**
 * Detect the port a dev server ACTUALLY bound from a log line it printed — e.g.
 * Vite's `➜  Local:   http://localhost:5175/`. Returns the port when the line
 * carries a localhost/loopback URL with an explicit port, else null. This is how
 * we reconcile the recorded URL to reality when the tool self-increments off the
 * allocated port (Vite's default `strictPort:false`).
 */
const BOUND_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/i;
export function detectBoundPort(line: string): number | null {
  const m = BOUND_URL_RE.exec(line);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Per-instance live handle (not persisted). */
interface LiveRunner {
  child?: ChildLike;
  usedDocker: boolean;
  composeDir?: string;
  composeFile?: string;
  stopping: boolean;
  logs: RunnerLogLine[];
  /** `subApp.url` template (for rebuilding the URL after port detection). */
  urlTemplate?: string;
  /** Port parsed from the child's own output (reconciled once, then latched). */
  detectedPort?: number;
}

const TERMINAL: ReadonlySet<RunnerStatus> = new Set<RunnerStatus>([
  "stopped",
  "crashed",
  "exited",
]);

/* -------------------------------------------------------------- the service */

export class RunnerService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly spawn: SpawnFn;
  private readonly runOnce: RunOnceFn;
  private readonly getPort: GetPortFn;
  private readonly killTree: KillTreeFn;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly maxLogLines: number;

  private readonly live = new Map<string, LiveRunner>();

  constructor(deps: RunnerDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.runOnce = deps.runOnce ?? defaultRunOnce;
    this.getPort = deps.getPort ?? defaultGetPort;
    this.killTree = deps.killTree ?? defaultKillTree;
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => nanoid());
    this.maxLogLines = deps.maxLogLines ?? 2000;
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Boot reconciliation: every persisted runner that was still "live" is
   * terminated, because none of them belong to THIS process.
   *
   * `this.live` is empty at boot, so a non-terminal runner is one of two things:
   * its pid is gone (the owning server died and took the tree with it), or its
   * pid is still alive — a process from the PREVIOUS server instance, with no
   * child handle, no stdout/stderr wiring and no exit event on this side. That
   * second kind can never be logged, stopped by `stopAll()` (which only walks
   * `this.live`), or attributed again; leaving it `running` strands it forever
   * while the port allocator quietly hands the next launch a port one higher.
   * Since we can't re-adopt a child's streams, reaping is the honest option:
   * tree-kill it, mark it stopped, and let the operator press Start again.
   */
  async reconcile(): Promise<void> {
    const runners = await this.store.listRunners();
    for (const r of runners) {
      if (TERMINAL.has(r.status)) continue;
      // Orphan from the previous server process — unmanageable, so reap it.
      if (r.pid !== undefined && this.isPidAlive(r.pid)) {
        await this.killTree(r.pid).catch(() => {});
      }
      // A docker stack was started detached, so it almost certainly survived the
      // restart — bring it down (from the PERSISTED compose paths, since the live
      // map is empty at boot) so containers don't leak and the UI stops showing a
      // phantom "running".
      if (r.usedDocker) {
        await this.dockerDown(r.id, r.composeDir, r.composeFile);
      }
      await this.saveAndEmit({ ...r, status: "stopped" });
    }
  }

  /**
   * Start a subApp in a worktree. Returns the registered RunnerInstance (its
   * status is `running` on success, or `crashed` if docker/spawn failed).
   */
  async start(
    worktreePath: string,
    subApp: SubApp,
    ctx: { projectId?: string; chatId?: string; branch?: string } = {},
  ): Promise<RunnerInstance> {
    const hasDev = !!subApp.dev;
    const usedDocker = !!subApp.dockerCompose;
    if (!hasDev && !usedDocker) {
      throw new Error(`subApp "${subApp.id}" declares neither dev nor dockerCompose`);
    }

    const id = this.genId();

    // Port allocation: one free port per declared base (offset upward if taken).
    const bases = subApp.ports && subApp.ports.length ? subApp.ports : [];
    const ports: number[] = [];
    for (const base of bases) ports.push(await this.getPort(base));
    if (ports.length === 0 && hasDev) ports.push(await this.getPort());
    const primary = ports[0];

    const url = subApp.url
      ? subApp.url.replace("{port}", String(primary ?? ""))
      : primary !== undefined
        ? `http://localhost:${primary}`
        : undefined;

    const live: LiveRunner = {
      usedDocker,
      stopping: false,
      logs: [],
      urlTemplate: subApp.url,
    };
    this.live.set(id, live);

    // Resolve + persist the compose location up front so stop()/reconcile() can
    // tear the stack down later (even after a restart) without the live map.
    let composeDir: string | undefined;
    let composeFile: string | undefined;
    if (usedDocker) {
      const composePath = resolve(worktreePath, subApp.dockerCompose!);
      composeDir = dirname(composePath);
      composeFile = basename(composePath);
      live.composeDir = composeDir;
      live.composeFile = composeFile;
    }

    let runner: RunnerInstance = {
      id,
      projectId: ctx.projectId,
      chatId: ctx.chatId,
      worktreePath,
      branch: ctx.branch,
      subAppId: subApp.id,
      kind: hasDev ? "process" : "docker",
      port: primary,
      ports: ports.length ? ports : undefined,
      url,
      usedDocker: usedDocker || undefined,
      composeDir,
      composeFile,
      status: "starting",
      startedAt: this.now(),
    };
    runner = await this.saveAndEmit(runner);

    // `PORT` is injected for tools that honor it; `subApp.env` (with `{port}`
    // placeholders substituted) is overlaid on top so a tool that reads a
    // differently-named var — Vite's `CLIENT_PORT`, a server's `SERVER_PORT` —
    // gets its port too, and can even override `PORT`.
    const portEnv: Record<string, string> =
      primary !== undefined ? { PORT: String(primary) } : {};
    for (const [key, value] of Object.entries(subApp.env ?? {})) {
      portEnv[key] = substitutePorts(value, ports);
    }

    // 1) docker compose up -d (in the compose file's directory), if declared.
    if (usedDocker && composeDir && composeFile) {
      this.pushLog(id, "stdout", `$ docker compose -f ${composeFile} up -d`);
      const res = await this.runOnce(
        "docker",
        ["compose", "-f", composeFile, "up", "-d"],
        { cwd: composeDir, env: portEnv },
      );
      // exitCode is `undefined` for a signal-killed process — treat that as a
      // failure too (only exit 0 counts as "up").
      if ((res.exitCode ?? 1) !== 0) {
        this.pushLog(id, "stderr", `docker compose up failed (exit ${res.exitCode})`);
        runner = await this.saveAndEmit({
          ...runner,
          status: "crashed",
          exitCode: res.exitCode ?? null,
        });
        this.live.delete(id);
        return runner;
      }
      // A stop() can land during the multi-second `up` await. Don't spawn the dev
      // process or report "running"; ensure the stack is down and finalize.
      if (live.stopping) {
        await this.dockerDown(id, composeDir, composeFile);
        return this.finalizeStopped(id, runner);
      }
    }

    // 2) spawn the long-running dev process (if any).
    if (hasDev) {
      const child = this.spawn(substitutePorts(subApp.dev!, ports), {
        cwd: resolve(worktreePath, subApp.path),
        env: portEnv,
      });
      live.child = child;
      this.wireChild(id, child);
      // A stop() during startup would otherwise orphan this freshly-spawned child
      // and leave a bogus "running" record. Kill it now and finalize as stopped.
      if (live.stopping) {
        if (child.pid !== undefined) await this.killTree(child.pid);
        else child.kill();
        return this.finalizeStopped(id, { ...runner, pid: child.pid });
      }
      runner = await this.saveAndEmit({ ...runner, pid: child.pid, status: "running" });
    } else {
      // docker-only stack: it's up (a mid-startup stop was handled above).
      runner = await this.saveAndEmit({ ...runner, status: "running" });
    }

    return runner;
  }

  /** Stop a runner: tree-kill its process, `docker compose down` if it used docker. */
  async stop(instanceId: string): Promise<void> {
    const live = this.live.get(instanceId);
    const runner = await this.store.getRunner(instanceId);
    if (!runner) return;
    if (live) live.stopping = true;

    if (!TERMINAL.has(runner.status)) {
      await this.saveAndEmit({ ...runner, status: "stopping" });
    }

    // Kill the process tree (Windows-safe). The 'exit' handler flips a process
    // runner to `stopped`; for docker-only runners we finalize below.
    const pid = runner.pid ?? live?.child?.pid;
    if (pid !== undefined) {
      await this.killTree(pid);
    } else if (live?.child) {
      live.child.kill();
    }

    // Tear docker down from the PERSISTED record so this still works when the live
    // map was pruned (process already exited) or lost (server restart).
    const usedDocker = runner.usedDocker ?? live?.usedDocker ?? false;
    if (usedDocker) {
      await this.dockerDown(
        instanceId,
        runner.composeDir ?? live?.composeDir,
        runner.composeFile ?? live?.composeFile,
      );
    }

    // Finalize when there is no live child to emit an 'exit' (docker-only, or the
    // process had already exited before stop was called). Prune the live entry so
    // its log ring doesn't leak and stopAll() never re-stops a terminated runner.
    if (!live?.child) {
      const after = await this.store.getRunner(instanceId);
      if (after && !TERMINAL.has(after.status)) {
        await this.saveAndEmit({ ...after, status: "stopped" });
      }
      this.live.delete(instanceId);
    }
  }

  /** Stop every live runner (server teardown / test cleanup). */
  async stopAll(): Promise<void> {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.stop(id).catch(() => {})));
  }

  /** All persisted runner instances. */
  list(): Promise<RunnerInstance[]> {
    return this.store.listRunners();
  }

  /** The retained (bounded) output lines for a runner, oldest-first. */
  logs(instanceId: string): RunnerLogLine[] {
    return this.live.get(instanceId)?.logs.slice() ?? [];
  }

  /* ----------------------------------------------------------------- internals */

  private wireChild(id: string, child: ChildLike): void {
    const out = this.makeLineSplitter(id, "stdout");
    const err = this.makeLineSplitter(id, "stderr");
    child.stdout?.on("data", out.onData);
    child.stderr?.on("data", err.onData);

    child.once("exit", (...args: unknown[]) => {
      out.flush();
      err.flush();
      const code = args[0];
      // `.catch` because `onExit` reads `runners.json` through a Zod parse that
      // THROWS on a torn/contended file — and a rejection raised from a child
      // process event handler has no caller to catch it, so it killed the server.
      void this.onExit(id, typeof code === "number" ? code : null, false).catch(() => {});
    });
    child.once("error", (...args: unknown[]) => {
      const e = args[0] as Error | undefined;
      this.pushLog(id, "stderr", `spawn error: ${e?.message ?? String(e)}`);
      out.flush();
      err.flush();
      void this.onExit(id, null, true).catch(() => {});
    });
  }

  /** Buffers a stream into whole `\n`-delimited lines. */
  private makeLineSplitter(id: string, stream: "stdout" | "stderr") {
    let buf = "";
    return {
      onData: (chunk: Buffer | string) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          this.pushLog(id, stream, line);
          this.maybeDetectPort(id, line);
        }
      },
      flush: () => {
        if (buf.length) {
          const line = buf.replace(/\r$/, "");
          this.pushLog(id, stream, line);
          this.maybeDetectPort(id, line);
          buf = "";
        }
      },
    };
  }

  /**
   * Reconcile the recorded port/URL to whatever the child actually bound, parsed
   * from its own output. Latched to the first detected port so a server that
   * re-prints its URL (or a proxy line) can't thrash the record. A no-op when the
   * detected port already matches, when the runner is gone/terminal, or when this
   * runner has no port to reconcile (a docker-only stack).
   */
  private maybeDetectPort(id: string, line: string): void {
    const live = this.live.get(id);
    if (!live || live.detectedPort !== undefined) return;
    const port = detectBoundPort(line);
    if (port === null) return;
    live.detectedPort = port; // latch: only reconcile once
    // Same reason as `onExit` above — called from a stdout data handler, so a
    // rejection would surface as an unhandled one rather than to any caller.
    void this.reconcilePort(id, port, live.urlTemplate).catch(() => {});
  }

  private async reconcilePort(
    id: string,
    port: number,
    urlTemplate: string | undefined,
  ): Promise<void> {
    const runner = await this.store.getRunner(id);
    if (!runner || TERMINAL.has(runner.status)) return;
    if (runner.port === port) return; // allocation already matched reality
    const ports = runner.ports ? [...runner.ports] : [];
    if (ports.length) ports[0] = port;
    const url = urlTemplate
      ? urlTemplate.replace("{port}", String(port))
      : `http://localhost:${port}`;
    await this.saveAndEmit({
      ...runner,
      port,
      ports: ports.length ? ports : [port],
      url,
    });
  }

  private async onExit(
    id: string,
    code: number | null,
    errored: boolean,
  ): Promise<void> {
    const live = this.live.get(id);
    if (live) live.child = undefined;
    const runner = await this.store.getRunner(id);
    if (!runner || TERMINAL.has(runner.status)) {
      this.live.delete(id); // don't retain a terminated runner's log ring
      return;
    }
    const status: RunnerStatus = live?.stopping
      ? "stopped"
      : errored || (code !== null && code !== 0)
        ? "crashed"
        : "exited";
    await this.saveAndEmit({ ...runner, status, exitCode: code });
    this.live.delete(id);
  }

  /** `docker compose down` for a stack (best-effort; no-op without both paths). */
  private async dockerDown(
    id: string,
    composeDir?: string,
    composeFile?: string,
  ): Promise<void> {
    if (!composeDir || !composeFile) return;
    this.pushLog(id, "stdout", `$ docker compose -f ${composeFile} down`);
    try {
      await this.runOnce("docker", ["compose", "-f", composeFile, "down"], {
        cwd: composeDir,
      });
    } catch {
      /* best-effort teardown: a missing docker daemon must not throw here */
    }
  }

  /** Persist a terminal `stopped` (unless already terminal) and prune the live entry. */
  private async finalizeStopped(
    id: string,
    fallback: RunnerInstance,
  ): Promise<RunnerInstance> {
    const after = (await this.store.getRunner(id)) ?? fallback;
    const saved = TERMINAL.has(after.status)
      ? after
      : await this.saveAndEmit({ ...after, status: "stopped" });
    this.live.delete(id);
    return saved;
  }

  private pushLog(id: string, stream: "stdout" | "stderr", line: string): void {
    const ts = this.now();
    const live = this.live.get(id);
    if (live) {
      live.logs.push({ stream, line, ts });
      if (live.logs.length > this.maxLogLines) live.logs.shift();
    }
    this.emit({ type: "runner-log", runnerId: id, stream, line, ts });
  }

  private async saveAndEmit(runner: RunnerInstance): Promise<RunnerInstance> {
    const saved = await this.store.saveRunner(runner);
    this.emit({ type: "runner-update", runner: saved });
    return saved;
  }

  private emit(evt: WsServerEvent): void {
    this.bus.publish(evt);
  }
}
