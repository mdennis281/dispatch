import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  checkoutKey,
  substituteMcpTokens,
  resolveMcpServer,
  resolveMcpServers,
  McpPortLeaseService,
  type McpPortStore,
  type McpSessionContext,
} from "./mcp-session.js";
import type { McpPortLease, McpServerConfig } from "@dispatch/shared";

/**
 * Absolute-path fixtures root from the PLATFORM, never a literal "C:/…": on the
 * Linux CI runner that string is a RELATIVE path, so every path assertion here
 * would quietly test something else.
 */
const ROOT = process.platform === "win32" ? "C:/repo" : "/repo";
const WT = `${ROOT}/.worktrees/feat-a`;

const ctx = (over: Partial<McpSessionContext> = {}): McpSessionContext => ({
  projectId: "p1",
  cwd: WT,
  repoRoot: ROOT,
  chatId: "chat1",
  ...over,
});

/** In-memory stand-in for the store's whole-file lease map. */
function fakeStore(initial: McpPortLease[] = []): McpPortStore & { rows: McpPortLease[] } {
  const state = { rows: [...initial] };
  return {
    get rows() {
      return state.rows;
    },
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

describe("checkoutKey", () => {
  it("folds case only where the filesystem does", () => {
    expect(checkoutKey("C:\\Repo\\A", "win32")).toBe("c:/repo/a");
    expect(checkoutKey("/srv/A", "darwin")).toBe("/srv/a");
    // On Linux /srv/A and /srv/a are DIFFERENT checkouts — folding them would
    // put two trees on one port, the exact bug leases exist to prevent.
    expect(checkoutKey("/srv/A", "linux")).toBe("/srv/A");
    expect(checkoutKey("/srv/a", "linux")).toBe("/srv/a");
  });

  it("normalizes separators and trailing slashes so one tree is one key", () => {
    expect(checkoutKey("/srv/a/", "linux")).toBe(checkoutKey("/srv/a", "linux"));
    expect(checkoutKey("C:\\r\\", "win32")).toBe(checkoutKey("C:/r", "win32"));
  });
});

describe("substituteMcpTokens", () => {
  it("substitutes ports 1-indexed, with {mcpPort} == {mcpPort1}", () => {
    expect(substituteMcpTokens("{mcpPort}", ctx(), [5401, 5402])).toBe("5401");
    expect(substituteMcpTokens("{mcpPort1}:{mcpPort2}", ctx(), [5401, 5402])).toBe("5401:5402");
  });

  it("leaves an unknown or out-of-range placeholder ALONE rather than blanking it", () => {
    // A blank reads to the server as "unset" and it silently falls back to a
    // default port — which is the collision we're here to stop. Left literal,
    // the server complains and the config error is traceable.
    expect(substituteMcpTokens("{mcpPort3}", ctx(), [5401])).toBe("{mcpPort3}");
    expect(substituteMcpTokens("{nope}", ctx(), [5401])).toBe("{nope}");
  });

  it("substitutes the path tokens", () => {
    const out = substituteMcpTokens("{worktree}|{repoRoot}|{chatId}", ctx());
    expect(out).toBe(`${WT}|${ROOT}|chat1`);
  });

  it("falls back to the directory name when no branch is known", () => {
    expect(substituteMcpTokens("{worktreeName}", ctx())).toBe("feat-a");
    expect(substituteMcpTokens("{worktreeName}", ctx({ branch: "feat/a" }))).toBe("feat/a");
  });
});

describe("resolveMcpServer", () => {
  const base: McpServerConfig = {
    type: "stdio",
    command: "node",
    args: ["./tools/sim-mcp/index.mjs"],
    env: { SIM_PORT: "{mcpPort}", SIM_ROOT: "{worktree}" },
    ports: 1,
    prewarm: "npm run dev",
  };

  it("strips Dispatch-only keys so they never reach a harness SDK", () => {
    const out = resolveMcpServer({ ...base }, ctx(), [5401]);
    expect(out).not.toHaveProperty("ports");
    expect(out).not.toHaveProperty("portRange");
    expect(out).not.toHaveProperty("prewarm");
  });

  it("defaults cwd to the chat's directory — this IS the per-worktree isolation", () => {
    expect(resolveMcpServer({ ...base }, ctx(), [5401]).cwd).toBe(WT);
  });

  it("honors an explicit cwd as the documented opt-out", () => {
    const out = resolveMcpServer({ ...base, cwd: ROOT }, ctx(), [5401]);
    expect(out.cwd).toBe(resolve(ROOT));
  });

  it("resolves a RELATIVE explicit cwd against the chat's directory", () => {
    const out = resolveMcpServer({ ...base, cwd: "sub" }, ctx(), [5401]);
    expect(out.cwd).toBe(resolve(WT, "sub"));
  });

  it("substitutes env and args", () => {
    const out = resolveMcpServer({ ...base }, ctx(), [5401]);
    expect(out.env).toEqual({ SIM_PORT: "5401", SIM_ROOT: WT });
  });

  it("leaves an http server without a cwd", () => {
    const out = resolveMcpServer({ type: "http", url: "http://x/{chatId}" }, ctx());
    expect(out.cwd).toBeUndefined();
    expect(out.url).toBe("http://x/chat1");
  });
});

describe("McpPortLeaseService", () => {
  const allFree = async () => true;
  const alwaysExists = () => true;

  it("gives the SAME checkout the SAME ports across calls", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    const a = await svc.lease("p1", "sim", WT, 1, [5400, 5410]);
    const b = await svc.lease("p1", "sim", WT, 1, [5400, 5410]);
    expect(a).toEqual(b);
  });

  it("never hands two checkouts the same port", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    const a = await svc.lease("p1", "sim", `${ROOT}/.worktrees/one`, 1, [5400, 5410]);
    const b = await svc.lease("p1", "sim", `${ROOT}/.worktrees/two`, 1, [5400, 5410]);
    expect(a[0]).not.toBe(b[0]);
  });

  it("treats differently-cased spellings of one checkout as one lease on win32", async () => {
    if (process.platform !== "win32") return;
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    const a = await svc.lease("p1", "sim", "C:/Repo/WT", 1, [5400, 5410]);
    const b = await svc.lease("p1", "sim", "c:/repo/wt", 1, [5400, 5410]);
    expect(a).toEqual(b);
    expect(store.rows).toHaveLength(1);
  });

  it("skips a port that is occupied even when unleased", async () => {
    const store = fakeStore();
    const busy = async (p: number) => p !== 5400;
    const svc = new McpPortLeaseService(store, busy, alwaysExists, () => 1);
    expect(await svc.lease("p1", "sim", WT, 1, [5400, 5410])).toEqual([5401]);
  });

  it("leases several ports at once", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    expect(await svc.lease("p1", "sim", WT, 3, [5400, 5410])).toEqual([5400, 5401, 5402]);
  });

  it("reclaims leases whose checkout no longer exists on disk", async () => {
    const store = fakeStore([
      { projectId: "p1", server: "sim", checkout: checkoutKey(`${ROOT}/gone`), ports: [5400], leasedAt: 1 },
    ]);
    // Only the surviving worktree is on disk; the dead one's port must come back
    // or the band silently fills up over weeks of worktree churn.
    const exists = (p: string) => p === checkoutKey(WT);
    const svc = new McpPortLeaseService(store, allFree, exists, () => 2);
    expect(await svc.lease("p1", "sim", WT, 1, [5400, 5410])).toEqual([5400]);
    expect(store.rows).toHaveLength(1);
  });

  it("throws rather than hand back a colliding port when the band is full", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    await svc.lease("p1", "sim", `${ROOT}/a`, 1, [5400, 5400]);
    await expect(svc.lease("p1", "sim", `${ROOT}/b`, 1, [5400, 5400])).rejects.toThrow(
      /no free port/,
    );
  });

  it("releases a checkout's leases", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    await svc.lease("p1", "sim", WT, 1, [5400, 5410]);
    await svc.releaseCheckout(WT);
    expect(store.rows).toHaveLength(0);
  });

  it("re-leases when the requested port COUNT changes", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, allFree, alwaysExists, () => 1);
    await svc.lease("p1", "sim", WT, 1, [5400, 5410]);
    expect(await svc.lease("p1", "sim", WT, 2, [5400, 5410])).toHaveLength(2);
    expect(store.rows).toHaveLength(1);
  });
});

describe("resolveMcpServers", () => {
  it("leases only for servers that asked, and isolates two worktrees", async () => {
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, async () => true, () => true, () => 1);
    const servers = {
      sim: { type: "stdio", command: "node", env: { SIM_PORT: "{mcpPort}" }, ports: 1 },
      plain: { type: "stdio", command: "node", env: { X: "1" } },
    };
    const a = await resolveMcpServers(servers, ctx({ cwd: `${ROOT}/wt-a` }), svc);
    const b = await resolveMcpServers(servers, ctx({ cwd: `${ROOT}/wt-b` }), svc);
    expect(a.sim.env?.SIM_PORT).not.toBe(b.sim.env?.SIM_PORT);
    expect(a.plain.env).toEqual({ X: "1" });
    expect(a.sim.cwd).toBe(`${ROOT}/wt-a`);
  });

  it("keeps a server whose lease failed, rather than dropping its tools", async () => {
    // Silently removing the server would look to the agent like the tools never
    // existed; leaving {mcpPort} literal makes the server itself complain.
    const store = fakeStore();
    const svc = new McpPortLeaseService(store, async () => true, () => true, () => 1);
    await svc.lease("p1", "sim", `${ROOT}/other`, 1, [5400, 5400]);
    const errs: string[] = [];
    const out = await resolveMcpServers(
      { sim: { type: "stdio", command: "node", env: { P: "{mcpPort}" }, ports: 1, portRange: [5400, 5400] } },
      ctx(),
      svc,
      (name) => errs.push(name),
    );
    expect(errs).toEqual(["sim"]);
    expect(out.sim.env?.P).toBe("{mcpPort}");
  });
});
