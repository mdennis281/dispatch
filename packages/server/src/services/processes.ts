/**
 * ProcessService — OS-level visibility into what's ACTUALLY listening on a
 * project's ports, and a kill switch for it.
 *
 * The RunnerService tracks the processes IT spawned (by their shell pid), but a
 * dev server is usually a grandchild (`cmd.exe → pnpm → node → vite`), and a
 * server restart or a half-killed tree can leave that grandchild orphaned — still
 * holding port 5173/2567, invisible to the runner records, blocking the next
 * launch. This service closes that gap: it scans the OS for the pid LISTENING on
 * each of a project's declared/allocated ports, cross-references the active
 * runners, and flags anything untracked as an orphan. `killPids()` tree-kills by
 * pid so you can reap orphans the runner never knew about.
 *
 * The scan/describe/kill primitives are injectable so tests never shell out; the
 * default wiring parses `netstat -ano` (Windows) or `lsof` (POSIX) via execa.
 */
import { execa } from "execa";
import treeKill from "tree-kill";
import type { Store } from "../store/index.js";
import { PORT_SCAN_RANGE } from "./runner.js";

/** A port and the pid LISTENING on it (as reported by the OS). */
export interface PortListener {
  port: number;
  pid: number;
}

/** One row of the project process view. */
export interface ProjectProcess {
  port: number;
  pid: number;
  /** Process image name (e.g. `node.exe`), best-effort. */
  name?: string;
  /** True when this port belongs to an active Dispatch runner. */
  tracked: boolean;
  runnerId?: string;
  subAppId?: string;
  branch?: string;
  worktreePath?: string;
}

/** Result of a bulk kill: one entry per requested pid. */
export interface KillResult {
  pid: number;
  ok: boolean;
  error?: string;
}

/** Enumerates every LISTENING TCP port → pid on the host. */
export type ScanFn = () => Promise<PortListener[]>;
/** Resolves pids to image names (best-effort; missing pids simply absent). */
export type DescribeFn = (pids: number[]) => Promise<Map<number, string>>;
/** Tree-kills a process (all descendants) — Windows-safe. */
export type KillTreeFn = (pid: number) => Promise<void>;

export interface ProcessDeps {
  store: Store;
  scan?: ScanFn;
  describe?: DescribeFn;
  killTree?: KillTreeFn;
  /**
   * How far above each declared base port to look for a listener a tool may have
   * hopped to (Vite/Colyseus scan upward off a busy base). Defaults to the
   * allocator's own scan range (`PORT_SCAN_RANGE`) — anything narrower would hide
   * the far end of a runaway ladder from the very panel meant to reap it.
   */
  portWindow?: number;
}

const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);

/* -------------------------------------------------------------- default wiring */

/** Parse `netstat -ano -p TCP` (Windows) into LISTENING port→pid pairs. */
export function parseNetstat(output: string): PortListener[] {
  const out: PortListener[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/\bLISTENING\b/.test(line)) continue;
    const parts = line.split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>
    const local = parts[1] ?? "";
    const pid = Number(parts[parts.length - 1]);
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0) {
      out.push({ port, pid });
    }
  }
  return out;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` (POSIX) into LISTENING port→pid pairs. */
export function parseLsof(output: string): PortListener[] {
  const out: PortListener[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    // COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME(*:5173)
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    const name = parts[parts.length - 1];
    const port = Number(name.slice(name.lastIndexOf(":") + 1));
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0) {
      out.push({ port, pid });
    }
  }
  return out;
}

const defaultScan: ScanFn = async () => {
  if (process.platform === "win32") {
    const res = await execa("netstat", ["-ano", "-p", "TCP"], {
      reject: false,
      buffer: true,
    });
    return parseNetstat(res.stdout ?? "");
  }
  const res = await execa("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
    reject: false,
    buffer: true,
  });
  return parseLsof(res.stdout ?? "");
};

/** Parse `tasklist /FO CSV /NH` into a pid→image-name map. */
export function parseTasklist(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    // "node.exe","12345","Console","1","120,000 K"
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

const defaultDescribe: DescribeFn = async (pids) => {
  if (pids.length === 0) return new Map();
  if (process.platform === "win32") {
    const res = await execa("tasklist", ["/FO", "CSV", "/NH"], {
      reject: false,
      buffer: true,
    });
    const all = parseTasklist(res.stdout ?? "");
    const wanted = new Set(pids);
    return new Map([...all].filter(([pid]) => wanted.has(pid)));
  }
  const res = await execa("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], {
    reject: false,
    buffer: true,
  });
  const map = new Map<number, string>();
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
};

const defaultKillTree: KillTreeFn = (pid) =>
  new Promise((res, rej) =>
    treeKill(pid, "SIGTERM", (err) => (err ? rej(err) : res())),
  );

/* -------------------------------------------------------------- the service */

export class ProcessService {
  private readonly store: Store;
  private readonly scan: ScanFn;
  private readonly describe: DescribeFn;
  private readonly killTree: KillTreeFn;
  private readonly portWindow: number;

  constructor(deps: ProcessDeps) {
    this.store = deps.store;
    this.scan = deps.scan ?? defaultScan;
    this.describe = deps.describe ?? defaultDescribe;
    this.killTree = deps.killTree ?? defaultKillTree;
    this.portWindow = deps.portWindow ?? PORT_SCAN_RANGE;
  }

  /**
   * Every OS process LISTENING on a port that belongs to this project — its
   * sub-apps' declared bases (plus a hop window) and any port an active runner
   * allocated. Each row is flagged `tracked` (matches a live runner) or an orphan.
   */
  async listForProject(projectId: string): Promise<ProjectProcess[]> {
    const project = await this.store.getProject(projectId).catch(() => null);
    const runners = (await this.store.listRunners().catch(() => []))
      .filter((r) => r.projectId === projectId && ACTIVE_STATUSES.has(r.status));

    // Candidate ports: declared bases + hop window, plus runner-allocated ports.
    const candidates = new Set<number>();
    for (const s of project?.subApps ?? []) {
      for (const base of s.ports ?? []) {
        for (let p = base; p <= base + this.portWindow; p++) candidates.add(p);
      }
    }
    for (const r of runners) {
      for (const p of r.ports ?? (r.port !== undefined ? [r.port] : [])) {
        candidates.add(p);
      }
    }
    if (candidates.size === 0) return [];

    // Port → the active runner that allocated it (grandchild pid ≠ runner.pid, so
    // match by PORT, which is the stable identity between record and OS).
    const runnerByPort = new Map<number, (typeof runners)[number]>();
    for (const r of runners) {
      for (const p of r.ports ?? (r.port !== undefined ? [r.port] : [])) {
        if (!runnerByPort.has(p)) runnerByPort.set(p, r);
      }
    }

    const listeners = (await this.scan().catch(() => [])).filter((l) =>
      candidates.has(l.port),
    );
    // Dedup (a port can appear on both IPv4 and IPv6) keyed by port+pid.
    const seen = new Set<string>();
    const unique = listeners.filter((l) => {
      const key = `${l.port}:${l.pid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const names = await this.describe([...new Set(unique.map((l) => l.pid))]).catch(
      () => new Map<number, string>(),
    );

    return unique
      .map((l): ProjectProcess => {
        const runner = runnerByPort.get(l.port);
        return {
          port: l.port,
          pid: l.pid,
          name: names.get(l.pid),
          tracked: !!runner,
          runnerId: runner?.id,
          subAppId: runner?.subAppId,
          branch: runner?.branch,
          worktreePath: runner?.worktreePath,
        };
      })
      .sort((a, b) => a.port - b.port || a.pid - b.pid);
  }

  /** Tree-kill each pid (deduped). Best-effort per pid; never throws. */
  async killPids(pids: number[]): Promise<KillResult[]> {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    return Promise.all(
      unique.map(async (pid): Promise<KillResult> => {
        try {
          await this.killTree(pid);
          return { pid, ok: true };
        } catch (err) {
          return { pid, ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }
}
