import { describe, it, expect, vi } from "vitest";
import { ChatProcessService } from "./chat-processes.js";
import { ProcessTracker } from "./process-tracker.js";
import type { ProcRow } from "./processes.js";

/**
 * A process table shaped like the real one: the session subprocess hangs off the
 * server, and every MCP server hangs off the session.
 *
 *   1 server
 *   ├── 10 claude (chat-a)   ├── 11 playwright  ├── 12 ssh-mcp
 *   ├── 20 claude (chat-b)   └── 21 ssh-mcp
 *   └── 30 powershell (chat-a's background shell) └── 31 node (its dev server)
 */
const TABLE: ProcRow[] = [
  { pid: 1, ppid: 0, name: "node.exe" },
  { pid: 10, ppid: 1, name: "claude.exe", startedAt: 100 },
  { pid: 11, ppid: 10, name: "node.exe", startedAt: 110 },
  { pid: 12, ppid: 10, name: "node.exe", startedAt: 120 },
  { pid: 20, ppid: 1, name: "claude.exe", startedAt: 200 },
  { pid: 21, ppid: 20, name: "node.exe", startedAt: 210 },
  { pid: 30, ppid: 1, name: "powershell.exe", startedAt: 300 },
  { pid: 31, ppid: 30, name: "node.exe", startedAt: 310 },
];

/**
 * A fake machine: a process table plus a set of pids that are alive. Stopping a
 * session or killing a shell removes its whole subtree, the way a real
 * tree-kill does — unless the test marks a pid as surviving it.
 */
function machine(opts: { survivors?: number[] } = {}) {
  let table = [...TABLE];
  const live = new Set(table.map((r) => r.pid));
  const survivors = new Set(opts.survivors ?? []);
  let sessions = new Map([
    ["chat-a", 10],
    ["chat-b", 20],
  ]);
  let shells = [{ chatId: "chat-a", pid: 30, name: "server", terminalId: "t-30" }];
  let reads = 0;
  let failReads = false;
  const killSubtree = (root: number) => {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      for (const r of table) if (r.ppid === pid) stack.push(r.pid);
      if (!survivors.has(pid)) live.delete(pid);
    }
    table = table.filter((r) => live.has(r.pid));
  };
  const tracker = new ProcessTracker({
    read: async () => {
      reads += 1;
      // A failed read (CIM timeout, dead worker) comes back empty.
      if (failReads) return [];
      return table.filter((r) => live.has(r.pid));
    },
    sessionPids: () => sessions,
    terminals: { livePids: () => shells },
    alive: (pid) => live.has(pid),
    intervalMs: 0,
  });
  const killPids = vi.fn(async (pids: number[]) => {
    for (const pid of pids) {
      live.delete(pid);
      table = table.filter((r) => r.pid !== pid);
    }
    return pids.map((pid) => ({ pid, ok: true }));
  });
  const svc = new ChatProcessService({
    tracker,
    killShells: async (chatId) => {
      for (const s of shells.filter((s) => s.chatId === chatId)) killSubtree(s.pid);
      shells = shells.filter((s) => s.chatId !== chatId);
    },
    killPids,
    alive: (pid) => live.has(pid),
  });
  const stop = vi.fn(async (chatId: string) => {
    const pid = sessions.get(chatId);
    if (pid) killSubtree(pid);
    sessions = new Map([...sessions].filter(([id]) => id !== chatId));
  });
  return {
    svc,
    tracker,
    stop,
    killPids,
    reads: () => reads,
    /** Make every table read from now on fail. */
    failReads: () => (failReads = true),
    /** Swap a pid for an unrelated process — what Windows does with a freed id. */
    recycle: (pid: number) => {
      table = table.map((r) => (r.pid === pid ? { pid, ppid: 1, name: "explorer.exe", startedAt: 9_999_999 } : r));
    },
  };
}

describe("ChatProcessService.counts", () => {
  it("splits a chat into its session tree and its shells", async () => {
    const m = machine();
    expect((await m.svc.counts()).byChat).toEqual({
      "chat-a": { session: 3, shells: 2 },
      "chat-b": { session: 2, shells: 0 },
    });
  });

  it("reads the tracker's latest sweep instead of scanning per call", async () => {
    const m = machine();
    await m.svc.counts();
    await m.svc.counts();
    expect(m.reads()).toBe(1);
  });
});

describe("ChatProcessService.release", () => {
  it("stops the session, kills the shells, and scans NOTHING when nothing survives", async () => {
    const m = machine();
    await m.tracker.sweep();
    const before = m.reads();
    const res = await m.svc.release(["chat-a"], m.stop);
    expect(m.stop).toHaveBeenCalledWith("chat-a");
    expect(res).toEqual({ freed: 5, orphans: 0 });
    // The whole point: no process-table read on the happy path.
    expect(m.reads()).toBe(before);
    expect(m.killPids).not.toHaveBeenCalled();
  });

  it("drops the reaped pids from the snapshot at once, so the next count shows it", async () => {
    const m = machine();
    await m.tracker.sweep();
    await m.svc.release(["chat-a"], m.stop);
    expect((await m.svc.counts()).byChat).toEqual({ "chat-b": { session: 2, shells: 0 } });
  });

  it("kills an orphan that outlived the session stop, after one fresh sweep", async () => {
    // 11 (an MCP server) escaped the session's teardown.
    const m = machine({ survivors: [11] });
    await m.tracker.sweep();
    const before = m.reads();
    const res = await m.svc.release(["chat-a"], m.stop);
    expect(m.reads()).toBe(before + 1);
    expect(m.killPids).toHaveBeenCalledWith([11]);
    expect(res).toEqual({ freed: 5, orphans: 1 });
  });

  it("never kills a pid that was recycled onto another process since the snapshot", async () => {
    const m = machine({ survivors: [11] });
    await m.tracker.sweep();
    m.recycle(11);
    const res = await m.svc.release(["chat-a"], m.stop);
    expect(m.killPids).not.toHaveBeenCalled();
    expect(res.orphans).toBe(0);
  });

  it("kills NO orphan when the fresh sweep's read failed — the old snapshot proves nothing", async () => {
    // The failed sweep hands back the previous snapshot; matching a captured
    // row against the snapshot it was captured from would pass a recycled pid.
    const m = machine({ survivors: [11] });
    await m.tracker.sweep();
    m.recycle(11);
    m.failReads();
    const res = await m.svc.release(["chat-a"], m.stop);
    expect(m.killPids).not.toHaveBeenCalled();
    expect(res.orphans).toBe(0);
  });

  it("releases every chat in a branch, and one failing stop does not spare the rest", async () => {
    const m = machine();
    await m.tracker.sweep();
    m.stop.mockImplementationOnce(async () => {
      throw new Error("wedged");
    });
    await m.svc.release(["chat-a", "chat-b"], m.stop);
    expect(m.stop).toHaveBeenCalledTimes(2);
    expect((await m.svc.counts()).byChat["chat-b"]).toBeUndefined();
  });

  it("takes a first sweep when none has landed yet", async () => {
    const m = machine();
    const res = await m.svc.release(["chat-b"], m.stop);
    expect(res.freed).toBe(2);
  });
});
