/**
 * `ctx.runner` (E10/E26) — which local ports are whose, for a plugin that
 * binds or exposes ports on this machine.
 *
 * WHY A PLUGIN NEEDS IT. remote-host forwards a listener on a paired Mac to the
 * SAME port number here when that port is free, so OAuth redirects and CORS
 * origins survive. "Free" was the only test, and it is the wrong one twice:
 *
 * - A port can be free only because its owner is not running YET. A forward
 *   parked on 4319 while `pnpm dev` is down stops the dev instance from
 *   starting — or, Windows being Windows, lets it bind the same port and
 *   answer half the requests (see `dev-instance-port-collisions-are-real`).
 *   A sub-app's or plugin process's declared port is the same story.
 * - A reverse forward (the Mac reaching a port here, opt-in, design doc §2.8)
 *   of a Dispatch port is an API that creates chats and runs commands on this
 *   machine, handed to every process on the other one.
 *
 * So the deny-list is about what is RESERVED, not only what is bound, and it
 * is built from config and declarations rather than a port scan.
 */
import type {
  PluginProcess,
  PluginReservedPort,
  PluginRunnerProcess,
  PluginRunnerView,
  RunnerInstance,
} from "@dispatch/shared";

/** A port Dispatch itself owns, with why. */
export interface DispatchPort {
  port: number;
  reason: string;
}

export interface RunnerViewDeps {
  /** Every runner row (sub-apps and plugin processes), live or not. */
  runner: { list(): Promise<RunnerInstance[]> };
  /** Every installed plugin's declared processes — enabled or not: a disabled plugin's port is still its own. */
  declared: () => Iterable<{ pluginId: string; processes: readonly PluginProcess[] }>;
  /** Dispatch's own ports (see {@link dispatchPorts}). */
  dispatchPorts: () => Promise<DispatchPort[]>;
}

const LIVE = new Set<RunnerInstance["status"]>(["starting", "running", "stopping"]);

/** `plugin:<id>` → `<id>`; anything else → undefined. Mirrors `pluginProcessOwner`. */
function pluginOf(owner: string | undefined): string | undefined {
  return owner?.startsWith("plugin:") ? owner.slice("plugin:".length) : undefined;
}

function portsOf(r: RunnerInstance): number[] {
  const all = [...(r.ports ?? []), ...(r.port !== undefined ? [r.port] : [])];
  return [...new Set(all)].sort((a, b) => a - b);
}

export function createRunnerView(deps: RunnerViewDeps): PluginRunnerView {
  return {
    async list(): Promise<PluginRunnerProcess[]> {
      const rows = (await deps.runner.list()).filter((r) => LIVE.has(r.status));
      return rows.map((r): PluginRunnerProcess => {
        const plugin = pluginOf(r.owner);
        return {
          id: r.id,
          owner: plugin
            ? { kind: "plugin", pluginId: plugin, processId: r.subAppId }
            : {
                kind: "sub-app",
                subAppId: r.subAppId,
                ...(r.projectId ? { projectId: r.projectId } : {}),
                ...(r.chatId ? { chatId: r.chatId } : {}),
                ...(r.branch ? { branch: r.branch } : {}),
              },
          status: r.status as PluginRunnerProcess["status"],
          ports: portsOf(r),
          ...(r.url ? { url: r.url } : {}),
          ...(r.adopted ? { adopted: true } : {}),
        };
      });
    },

    async reservedPorts(): Promise<PluginReservedPort[]> {
      // First reason wins per port, and Dispatch's own go first: a plugin that
      // declares 4319 does not make 4319 any less Dispatch's.
      const out = new Map<number, PluginReservedPort>();
      const add = (port: number, owner: string, reason: string) => {
        if (Number.isInteger(port) && port > 0 && !out.has(port)) out.set(port, { port, owner, reason });
      };
      for (const p of await deps.dispatchPorts()) add(p.port, "dispatch", p.reason);
      for (const { pluginId, processes } of deps.declared()) {
        for (const proc of processes) {
          for (const port of proc.ports ?? []) {
            add(port, `plugin:${pluginId}`, `declared by plugin "${pluginId}" for its process "${proc.id}"`);
          }
        }
      }
      // What a plugin's process actually holds can differ from what it
      // declared: the allocator moves to the next free port when the declared
      // one is busy.
      for (const r of await deps.runner.list()) {
        const plugin = pluginOf(r.owner);
        if (!plugin || !LIVE.has(r.status)) continue;
        for (const port of portsOf(r)) {
          add(port, `plugin:${plugin}`, `held by plugin "${plugin}"'s process "${r.subAppId}"`);
        }
      }
      return [...out.values()].sort((a, b) => a.port - b.port);
    },
  };
}

/** The two instances' default ports. Kept beside the reasons a refusal would print. */
export const STABLE_DEFAULT_PORT = 4318;
export const DEV_DEFAULT_PORT = 4319;
/** Vite's live-reload socket in a dev instance (`dev-vite.ts` pins it). */
export const DEV_HMR_PORT = 24678;

/**
 * Dispatch's own ports, as this instance knows them.
 *
 * `stablePort` is read from the installed deployment's `runtime.json` when one
 * is running: the launcher scans upward from 4318 when that is taken, so the
 * default alone can miss the real one.
 */
export function dispatchPorts(opts: { ownPort?: number; stablePort?: number }): DispatchPort[] {
  return [
    ...(opts.ownPort ? [{ port: opts.ownPort, reason: "this Dispatch instance" }] : []),
    ...(opts.stablePort ? [{ port: opts.stablePort, reason: "the installed (stable) Dispatch instance" }] : []),
    { port: STABLE_DEFAULT_PORT, reason: "the installed Dispatch instance's default port" },
    { port: DEV_DEFAULT_PORT, reason: "the development Dispatch instance's default port" },
    { port: DEV_HMR_PORT, reason: "a development Dispatch instance's live-reload socket" },
  ];
}
