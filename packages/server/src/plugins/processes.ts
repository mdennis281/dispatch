/**
 * Plugin-managed PROCESSES — `contributes.processes` and `ctx.processes`.
 *
 * Nothing here spawns. Every process goes through `RunnerService` as a
 * sub-app would, with the plugin directory standing in for the worktree and
 * `owner: "plugin:<id>"` in place of a project and chat. That is what buys a
 * plugin the things a hand-rolled `child_process.spawn` in `activate` would
 * not have: the port allocator, the persisted log ring, the `runner-update`
 * events the Ports & processes panel renders, the manager-env quarantine
 * (a plugin process inheriting `DISPATCH_DATA_DIR` would boot a second
 * Dispatch on this instance's state — the incident `scrubManagerEnv` exists
 * for), and `stopAll()` at shutdown.
 *
 * SINGLETONS. Stable and dev share `config/`, so both load every plugin, and a
 * process that cannot run twice (one that owns a device, a model, a fixed
 * port) would be started twice. A `singleton: true` process declares a port,
 * and the second instance to activate probes that port: busy means ADOPT — a
 * `running` record with no pid, pointing at the port — rather than spawn on
 * the next free one. The port is the only identity the two instances can see
 * of each other: port leases, runner rows and kv all live in per-instance
 * `data/`. Deviation from the spec's wording ("by its port lease") for exactly
 * that reason — there is no shared lease table to adopt from.
 */
import { resolve } from "node:path";
import type { RunnerInstance, SubApp, PluginProcess, PluginContext } from "@dispatch/shared";
import type { RunnerLaunchContext } from "../services/runner.js";
import { isPortFree } from "../services/mcp-session.js";
import { pluginProcessOwner } from "./contributions.js";

/** The slice of `RunnerService` this needs — narrow so tests can fake it. */
export interface PluginProcessRunner {
  start(worktreePath: string, subApp: SubApp, ctx: RunnerLaunchContext): Promise<RunnerInstance>;
  adopt(worktreePath: string, subApp: SubApp, ctx: RunnerLaunchContext, port: number): Promise<RunnerInstance>;
  stop(instanceId: string): Promise<void>;
  list(): Promise<RunnerInstance[]>;
}

export interface PluginProcessHostDeps {
  runner: PluginProcessRunner;
  /** Injected for the singleton tests; defaults to a real bind probe. */
  portFree?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
}

const ACTIVE = new Set<RunnerInstance["status"]>(["starting", "running", "stopping"]);

/** The host for every plugin's processes; `for(pluginId)` narrows it to one. */
export class PluginProcessHost {
  private readonly runner: PluginProcessRunner;
  private readonly portFree: (port: number) => Promise<boolean>;
  private readonly log: (line: string) => void;
  private readonly specs = new Map<string, { dir: string; processes: PluginProcess[] }>();

  constructor(deps: PluginProcessHostDeps) {
    this.runner = deps.runner;
    this.portFree = deps.portFree ?? isPortFree;
    this.log = deps.log ?? (() => {});
  }

  /** (Re)declare a plugin's processes. Replaces any earlier declaration. */
  register(pluginId: string, dir: string, processes: PluginProcess[]): void {
    this.specs.set(pluginId, { dir, processes });
  }

  /** Forget a plugin's declarations (after its processes are stopped). */
  unregister(pluginId: string): void {
    this.specs.delete(pluginId);
  }

  declared(pluginId: string): PluginProcess[] {
    return this.specs.get(pluginId)?.processes ?? [];
  }

  private spec(pluginId: string, id: string): { dir: string; spec: PluginProcess } {
    const entry = this.specs.get(pluginId);
    const spec = entry?.processes.find((p) => p.id === id);
    if (!entry || !spec) {
      throw new Error(`plugin "${pluginId}" declares no process "${id}" under contributes.processes`);
    }
    return { dir: entry.dir, spec };
  }

  /** The live instance for one declared process, if this host has one. */
  private async running(pluginId: string, id: string): Promise<RunnerInstance | undefined> {
    const owner = pluginProcessOwner(pluginId);
    return (await this.runner.list()).find(
      (r) => r.owner === owner && r.subAppId === id && ACTIVE.has(r.status),
    );
  }

  /**
   * Start one process. Idempotent: an instance already running is returned
   * rather than doubled, so a plugin may call this from every `activate` and
   * from a route without bookkeeping.
   */
  async start(pluginId: string, id: string): Promise<RunnerInstance> {
    const existing = await this.running(pluginId, id);
    if (existing) return existing;
    const { dir, spec } = this.spec(pluginId, id);
    const ctx: RunnerLaunchContext = { owner: pluginProcessOwner(pluginId) };
    const subApp = toSubApp(spec);
    const worktree = spec.cwd ? resolve(dir, spec.cwd) : dir;
    if (spec.singleton) {
      const port = spec.ports![0]!;
      if (!(await this.portFree(port))) {
        this.log(`[plugin:${pluginId}] process "${id}" is already listening on :${port} — adopting it`);
        return this.runner.adopt(worktree, subApp, ctx, port);
      }
    }
    return this.runner.start(worktree, subApp, ctx);
  }

  /** Stop one process. A no-op when it is not running. */
  async stop(pluginId: string, id: string): Promise<void> {
    this.spec(pluginId, id);
    const live = await this.running(pluginId, id);
    if (live) await this.runner.stop(live.id);
  }

  /** Every declared process with its current state — what `ctx.processes.list()` returns. */
  async list(pluginId: string): Promise<Array<{ id: string; status: string; ports?: number[]; url?: string }>> {
    const owner = pluginProcessOwner(pluginId);
    const rows = await this.runner.list();
    return this.declared(pluginId).map((spec) => {
      const live = rows.find((r) => r.owner === owner && r.subAppId === spec.id && ACTIVE.has(r.status));
      return {
        id: spec.id,
        status: live?.status ?? "stopped",
        ...(live?.ports ? { ports: live.ports } : {}),
        ...(live?.url ? { url: live.url } : {}),
      };
    });
  }

  /** Start every `autostart: true` process. One failure never blocks the next. */
  async autostart(pluginId: string, onError: (id: string, err: unknown) => void): Promise<void> {
    for (const spec of this.declared(pluginId)) {
      if (!spec.autostart) continue;
      try {
        await this.start(pluginId, spec.id);
      } catch (err) {
        onError(spec.id, err);
      }
    }
  }

  /** Stop everything this plugin has running — deactivate and dispose. */
  async stopAll(pluginId: string): Promise<void> {
    const owner = pluginProcessOwner(pluginId);
    const rows = (await this.runner.list()).filter((r) => r.owner === owner && ACTIVE.has(r.status));
    await Promise.all(rows.map((r) => this.runner.stop(r.id).catch(() => {})));
  }

  /** The `ctx.processes` member for one plugin. */
  for(pluginId: string): NonNullable<PluginContext["processes"]> {
    return {
      start: async (id) => {
        await this.start(pluginId, id);
      },
      stop: (id) => this.stop(pluginId, id),
      list: () => this.list(pluginId),
    };
  }
}

/**
 * A declared process as the sub-app shape the runner launches. `command` and
 * `args` become ONE shell line because the runner spawns through a shell (the
 * only way a `.cmd` shim like `pnpm` starts on Windows since the
 * CVE-2024-27980 fix); quoting is minimal and POSIX/cmd-compatible — an
 * argument with whitespace or a quote is double-quoted with inner quotes
 * escaped, anything else passes through so `{port}` placeholders survive.
 */
export function toSubApp(spec: PluginProcess): SubApp {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    path: ".",
    dev: [spec.command, ...(spec.args ?? [])].map(shellWord).join(" "),
    ...(spec.ports ? { ports: spec.ports } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.url ? { url: spec.url } : {}),
  };
}

function shellWord(w: string): string {
  return /[\s"']/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w;
}
