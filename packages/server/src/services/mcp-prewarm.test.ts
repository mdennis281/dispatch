import { describe, it, expect } from "vitest";
import { McpPrewarmService, type PrewarmSpawn } from "./mcp-prewarm.js";
import { McpPortLeaseService, type McpPortStore } from "./mcp-session.js";
import type { McpPortLease, McpServerConfig, Project } from "@dispatch/shared";

/** Platform-rooted: a literal "C:/…" is a RELATIVE path on the Linux CI runner. */
const ROOT = process.platform === "win32" ? "C:/repo" : "/repo";
const WT = `${ROOT}/.worktrees/feat-a`;

const project = (mcpServers: Record<string, McpServerConfig> = {}): Project =>
  ({
    id: "p1",
    name: "P",
    repoPath: ROOT,
    worktreeRoot: ".worktrees",
    mcpServers,
  }) as unknown as Project;

function fakeStore(): McpPortStore {
  const state: { rows: McpPortLease[] } = { rows: [] };
  return {
    async listMcpPortLeases() {
      return [...state.rows];
    },
    async updateMcpPortLeases(fn) {
      const { leases, result } = await fn([...state.rows]);
      state.rows = leases;
      return result;
    },
  };
}

const leases = () =>
  new McpPortLeaseService(fakeStore(), async () => true, () => true, () => 1);

interface Call {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

function recorder(
  impl: (c: Call) => { exitCode?: number; stderr?: string } = () => ({ exitCode: 0 }),
): { spawn: PrewarmSpawn; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: PrewarmSpawn = async (command, opts) => {
    const call = { command, cwd: opts.cwd, env: opts.env };
    calls.push(call);
    const r = impl(call);
    return { exitCode: r.exitCode ?? 0, stderr: r.stderr ?? "" };
  };
  return { spawn, calls };
}

describe("McpPrewarmService", () => {
  it("does nothing when no server declares a prewarm", async () => {
    const { spawn, calls } = recorder();
    const svc = new McpPrewarmService({ getMcpServers: () => ({}), spawn });
    const out = await svc.prewarm(
      project({ sim: { type: "stdio", command: "node" } }),
      WT,
    );
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("runs the command in the NEW worktree with that checkout's leased port", async () => {
    const { spawn, calls } = recorder();
    const svc = new McpPrewarmService({
      getMcpServers: () => ({}),
      leases: leases(),
      spawn,
    });
    await svc.prewarm(
      project({
        sim: {
          type: "stdio",
          command: "node",
          env: { SIM_PORT: "{mcpPort}", SIM_ROOT: "{worktree}" },
          ports: 1,
          prewarm: "npm run dev",
        },
      }),
      WT,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm run dev");
    expect(calls[0].cwd).toBe(WT);
    // The whole point: the warmed server is on the port the SESSION will use.
    expect(calls[0].env.SIM_PORT).toMatch(/^\d+$/);
    expect(calls[0].env.SIM_ROOT).toBe(WT);
  });

  it("scrubs the manager's own state vars out of the child env", async () => {
    // A prewarm that inherited DISPATCH_DATA_DIR would boot pointed at the
    // manager's store — the two-processes-one-data-dir failure.
    const { spawn, calls } = recorder();
    const svc = new McpPrewarmService({ getMcpServers: () => ({}), spawn });
    await svc.prewarm(
      project({ sim: { type: "stdio", command: "node", prewarm: "echo hi" } }),
      WT,
    );
    expect(calls[0].env.DISPATCH_DATA_DIR).toBeUndefined();
    expect(calls[0].env.DISPATCH_CONFIG_DIR).toBeUndefined();
  });

  it("reports a non-zero exit as a failure without throwing", async () => {
    const { spawn } = recorder(() => ({ exitCode: 1, stderr: "boom" }));
    const svc = new McpPrewarmService({ getMcpServers: () => ({}), spawn });
    const out = await svc.prewarm(
      project({ sim: { type: "stdio", command: "node", prewarm: "false" } }),
      WT,
    );
    expect(out).toEqual([
      { server: "sim", command: "false", ok: false, error: "boom" },
    ]);
  });

  it("reports a throwing spawn as a failure without throwing", async () => {
    const spawn: PrewarmSpawn = async () => {
      throw new Error("ENOENT");
    };
    const svc = new McpPrewarmService({ getMcpServers: () => ({}), spawn });
    const out = await svc.prewarm(
      project({ sim: { type: "stdio", command: "node", prewarm: "nope" } }),
      WT,
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toContain("ENOENT");
  });

  it("keeps warming the rest after one server fails", async () => {
    const { spawn, calls } = recorder((c) =>
      c.command === "bad" ? { exitCode: 1, stderr: "x" } : { exitCode: 0 },
    );
    const svc = new McpPrewarmService({ getMcpServers: () => ({}), spawn });
    const out = await svc.prewarm(
      project({
        a: { type: "stdio", command: "node", prewarm: "bad" },
        b: { type: "stdio", command: "node", prewarm: "good" },
      }),
      WT,
    );
    expect(calls).toHaveLength(2);
    expect(out.map((o) => o.ok)).toEqual([false, true]);
  });

  it("lets a config-sourced server override the .data record", async () => {
    const { spawn, calls } = recorder();
    const svc = new McpPrewarmService({
      getMcpServers: () => ({
        sim: { type: "stdio", command: "node", prewarm: "from-config" },
      }),
      spawn,
    });
    await svc.prewarm(
      project({ sim: { type: "stdio", command: "node", prewarm: "from-data" } }),
      WT,
    );
    expect(calls[0].command).toBe("from-config");
  });
});
