/**
 * The loop monitor's contract with the people who read it afterwards: a quiet
 * window writes nothing, a stalled window writes one line naming the spawns
 * on the loop at the time, and the health probe can always see the current
 * window.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERF_LOG_NAME,
  flushPerfLog,
  formatStallLine,
  perfSnapshot,
  rollPerfWindowForTest,
  startPerfMonitor,
  stopPerfMonitor,
} from "./perf.js";

afterEach(() => stopPerfMonitor());

describe("perf monitor", () => {
  it("reports nothing until started, then the current window", () => {
    expect(perfSnapshot()).toBeUndefined();
    startPerfMonitor();
    const snap = perfSnapshot();
    expect(snap).toBeDefined();
    expect(snap!.loop.since).toBeLessThanOrEqual(Date.now());
    expect(snap!.exec).toEqual([]);
    expect(snap!.lastStall).toBeUndefined();
  });

  it("is idempotent: a second start keeps the running histogram", () => {
    startPerfMonitor();
    const since = perfSnapshot()!.loop.since;
    startPerfMonitor({ dataDir: "/nowhere" });
    expect(perfSnapshot()!.loop.since).toBe(since);
  });

  it("writes no perf.log for a quiet window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-perf-"));
    try {
      startPerfMonitor({ dataDir: dir });
      rollPerfWindowForTest();
      await flushPerfLog();
      await expect(readFile(join(dir, PERF_LOG_NAME), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const quiet = { waitMs: 0, maxWaitMs: 0, maxQueue: 1, coalesced: 0, subs: {} };

  it("names the stall and the spawns in one line", () => {
    const line = formatStallLine(
      { since: 1_000_000, p50Ms: 3, p99Ms: 812, maxMs: 2_140 },
      [
        { ...quiet, file: "gh", count: 40, syncMs: 6_120, wallMs: 20_000, maxSyncMs: 480 },
        { ...quiet, file: "git", count: 62, syncMs: 3_010, wallMs: 9_000, maxSyncMs: 220 },
      ],
      1_060_000,
    );
    expect(line).toContain("p99=812ms");
    expect(line).toContain("max=2140ms");
    expect(line).toContain("over 60s");
    expect(line).toContain("gh×40 sync=6120ms max=480ms wall=20000ms");
    expect(line).toContain("git×62");
    // A gate that held nothing up adds nothing to the line.
    expect(line).not.toContain("queue=");
    expect(line).not.toContain("coalesced=");
    expect(line.startsWith("[1970-01-01T00:17:40.000Z]")).toBe(true);
  });

  it("names queueing, coalescing and the top subcommands when the gate engaged", () => {
    const line = formatStallLine(
      { since: 0, p50Ms: 3, p99Ms: 812, maxMs: 2_140 },
      [
        {
          file: "git",
          count: 120,
          syncMs: 3_010,
          wallMs: 9_000,
          maxSyncMs: 220,
          waitMs: 4_200,
          maxWaitMs: 900,
          maxQueue: 14,
          coalesced: 31,
          subs: { status: 50, "worktree list": 40, "rev-parse": 20, "for-each-ref": 9, log: 1 },
        },
      ],
      60_000,
    );
    expect(line).toContain("queue=14 wait=4200ms maxWait=900ms coalesced=31");
    // Top four only, busiest first.
    expect(line).toContain("[status×50, worktree list×40, rev-parse×20, for-each-ref×9]");
    expect(line).not.toContain("log×1");
  });

  it("says so when a stall had no spawns to blame", () => {
    const line = formatStallLine({ since: 0, p50Ms: 1, p99Ms: 900, maxMs: 900 }, []);
    expect(line).toContain("no spawns in window");
  });
});
