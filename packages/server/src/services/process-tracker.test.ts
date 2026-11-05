import { describe, expect, it } from "vitest";
import { ProcessTracker, sameProcess } from "./process-tracker.js";
import type { ProcRow } from "./processes.js";

/** A clock the test drives by hand, so windows are exact rather than flaky. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function harness(
  rows: ProcRow[],
  opts: {
    sessionPids?: Map<string, number>;
    shells?: { chatId: string; pid: number }[];
    alive?: (pid: number) => boolean;
  } = {},
) {
  const c = clock();
  let table = rows;
  let reads = 0;
  let gate: Promise<void> | undefined;
  const tracker = new ProcessTracker({
    read: async () => {
      reads += 1;
      if (gate) await gate;
      return table;
    },
    sessionPids: () => opts.sessionPids ?? new Map(),
    terminals: {
      livePids: () =>
        (opts.shells ?? []).map((s) => ({ ...s, name: "main", terminalId: `${s.chatId}::main` })),
    },
    now: c.now,
    alive: opts.alive ?? (() => true),
    // Tests sweep by hand; no timer.
    intervalMs: 0,
  });
  return {
    tracker,
    advance: c.advance,
    setTable: (r: ProcRow[]) => (table = r),
    reads: () => reads,
    /** Hold every read until the returned release is called. */
    hold: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe("ProcessTracker ownership", () => {
  it("attributes a session subtree and a shell subtree to their chat, split by kind", async () => {
    const h = harness(
      [
        { pid: 1, ppid: 0, name: "node" },
        { pid: 10, ppid: 1, name: "claude" },
        { pid: 11, ppid: 10, name: "mcp" },
        { pid: 20, ppid: 1, name: "powershell.exe" },
        { pid: 21, ppid: 20, name: "vite" },
      ],
      { sessionPids: new Map([["a", 10]]), shells: [{ chatId: "a", pid: 20 }] },
    );
    const snap = await h.tracker.sweep();
    expect([...snap.owners.get("a")!.session].sort()).toEqual([10, 11]);
    expect([...snap.owners.get("a")!.shells].sort()).toEqual([20, 21]);
  });

  it("counts a shell the session itself started once, on the session side", async () => {
    const h = harness(
      [
        { pid: 10, ppid: 1, name: "claude" },
        { pid: 11, ppid: 10, name: "powershell.exe" },
      ],
      { sessionPids: new Map([["a", 10]]), shells: [{ chatId: "a", pid: 11 }] },
    );
    const own = (await h.tracker.sweep()).owners.get("a")!;
    expect(own.session.size).toBe(2);
    expect(own.shells.size).toBe(0);
  });

  it("does not count a root the table no longer lists", async () => {
    const h = harness([{ pid: 1, ppid: 0 }], { sessionPids: new Map([["a", 999]]) });
    expect((await h.tracker.sweep()).owners.has("a")).toBe(false);
  });

  it("attributes a Codex browser MCP by its per-chat marker, even with no session", async () => {
    const h = harness([
      { pid: 50, ppid: 1, name: "node", commandLine: "node shim.js C:\\tmp\\dispatch-browser-mcp\\chat-7\\out" },
      { pid: 51, ppid: 50, name: "chrome.exe" },
    ]);
    const own = (await h.tracker.sweep()).owners.get("chat-7")!;
    expect([...own.session].sort()).toEqual([50, 51]);
  });

  it("ignores another instance's browser MCP marker", async () => {
    // The marker dir is in the OS temp dir, shared by every Dispatch on the box.
    const tracker = new ProcessTracker({
      read: async () => [
        { pid: 50, ppid: 1, name: "node", commandLine: "node shim.js /tmp/dispatch-browser-mcp/theirs/out" },
        { pid: 60, ppid: 1, name: "node", commandLine: "node shim.js /tmp/dispatch-browser-mcp/mine/out" },
      ],
      sessionPids: () => new Map(),
      ownsChat: (id) => id === "mine",
      intervalMs: 0,
    });
    const snap = await tracker.sweep();
    expect([...snap.owners.keys()]).toEqual(["mine"]);
  });

  it("survives a root source that throws or returns nothing — a sweep must never crash the server", async () => {
    // Seen in CI: containers built with a fake broker made every background
    // sweep an unhandled rejection.
    const tracker = new ProcessTracker({
      read: async () => [{ pid: 20, ppid: 1 }],
      sessionPids: () => undefined as never,
      terminals: {
        livePids: () => {
          throw new Error("terminal service torn down");
        },
      },
      intervalMs: 0,
    });
    const snap = await tracker.sweep();
    expect(snap.rows).toHaveLength(1);
    expect(snap.owners.size).toBe(0);
  });

  it("keeps the last real table when a read comes back empty", async () => {
    const h = harness([{ pid: 10, ppid: 1 }], { sessionPids: new Map([["a", 10]]) });
    await h.tracker.sweep();
    h.setTable([]);
    const snap = await h.tracker.sweep();
    expect(snap.owners.get("a")?.session.size).toBe(1);
  });
});

describe("ProcessTracker CPU rates", () => {
  it("turns cumulative CPU into a rate over the window between sweeps", async () => {
    const h = harness([{ pid: 10, ppid: 1, cpuMs: 1_000 }]);
    await h.tracker.sweep();
    h.advance(10_000);
    h.setTable([{ pid: 10, ppid: 1, cpuMs: 6_000 }]);
    const snap = await h.tracker.sweep();
    expect(snap.windowMs).toBe(10_000);
    expect(snap.cpuByPid.get(10)).toBeCloseTo(50);
  });

  it("does not charge a new process its lifetime CPU", async () => {
    const h = harness([{ pid: 1, ppid: 0, cpuMs: 0 }]);
    await h.tracker.sweep();
    h.advance(10_000);
    h.setTable([
      { pid: 1, ppid: 0, cpuMs: 0 },
      { pid: 2, ppid: 1, cpuMs: 99_000 },
    ]);
    expect((await h.tracker.sweep()).cpuByPid.has(2)).toBe(false);
  });

  it("treats a recycled pid (different start time) as new", async () => {
    const h = harness([{ pid: 7, ppid: 1, cpuMs: 1_000, startedAt: 100 }]);
    await h.tracker.sweep();
    h.advance(10_000);
    h.setTable([{ pid: 7, ppid: 1, cpuMs: 9_000, startedAt: 900_000 }]);
    expect((await h.tracker.sweep()).cpuByPid.has(7)).toBe(false);
  });

  it("serves the last rates rather than dividing by a too-short window", async () => {
    const h = harness([{ pid: 10, ppid: 1, cpuMs: 0 }]);
    await h.tracker.sweep();
    h.advance(10_000);
    h.setTable([{ pid: 10, ppid: 1, cpuMs: 5_000 }]);
    await h.tracker.sweep();
    h.advance(20);
    h.setTable([{ pid: 10, ppid: 1, cpuMs: 5_010 }]);
    const snap = await h.tracker.sweep();
    expect(snap.cpuByPid.get(10)).toBeCloseTo(50);
    expect(snap.windowMs).toBe(10_000);
  });
});

describe("ProcessTracker sweeping", () => {
  it("serves reads from the latest sweep without scanning again", async () => {
    const h = harness([{ pid: 1, ppid: 0 }]);
    await h.tracker.read();
    await h.tracker.read();
    await h.tracker.read();
    expect(h.reads()).toBe(1);
  });

  it("gives a caller who arrives mid-sweep the NEXT sweep, shared with others", async () => {
    const h = harness([{ pid: 1, ppid: 0 }]);
    const release = h.hold();
    const first = h.tracker.sweep();
    const second = h.tracker.sweep();
    const third = h.tracker.sweep();
    expect(second).toBe(third);
    release();
    await Promise.all([first, second, third]);
    // One in flight + one queued — not one per caller.
    expect(h.reads()).toBe(2);
  });

  it("drops forgotten pids at once, and a sweep that started earlier cannot bring them back", async () => {
    const h = harness(
      [
        { pid: 10, ppid: 1 },
        { pid: 11, ppid: 10 },
      ],
      { sessionPids: new Map([["a", 10]]) },
    );
    await h.tracker.sweep();
    const release = h.hold();
    const inFlight = h.tracker.sweep();
    h.advance(5);
    h.tracker.forget([10, 11]);
    expect(h.tracker.latest()!.owners.has("a")).toBe(false);
    release();
    const snap = await inFlight;
    expect(snap.byPid.has(10)).toBe(false);
    expect(snap.owners.has("a")).toBe(false);
  });

  it("lets a later sweep report a forgotten pid that really is still there", async () => {
    const h = harness([{ pid: 10, ppid: 1 }], { sessionPids: new Map([["a", 10]]) });
    await h.tracker.sweep();
    h.tracker.forget([10]);
    h.advance(1_000);
    expect((await h.tracker.sweep()).owners.get("a")?.session.size).toBe(1);
  });
});

describe("sameProcess", () => {
  it("matches the same pid, name and start time", () => {
    expect(sameProcess({ pid: 1, ppid: 0, name: "node.exe", startedAt: 5_000 }, { pid: 1, ppid: 0, name: "NODE.EXE", startedAt: 5_000 })).toBe(true);
  });
  it("rejects a recycled pid by start time or by name", () => {
    expect(sameProcess({ pid: 1, ppid: 0, name: "node", startedAt: 5_000 }, { pid: 1, ppid: 0, name: "node", startedAt: 60_000 })).toBe(false);
    expect(sameProcess({ pid: 1, ppid: 0, name: "node" }, { pid: 1, ppid: 0, name: "explorer.exe" })).toBe(false);
  });
  it("tolerates POSIX's whole-second start times", () => {
    expect(sameProcess({ pid: 1, ppid: 0, startedAt: 5_000 }, { pid: 1, ppid: 0, startedAt: 6_000 })).toBe(true);
  });
  it("is false for a pid the fresh table no longer lists", () => {
    expect(sameProcess({ pid: 1, ppid: 0 }, undefined)).toBe(false);
  });
});
