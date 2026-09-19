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

  it("names the stall and the spawns in one line", () => {
    const line = formatStallLine(
      { since: 1_000_000, p50Ms: 3, p99Ms: 812, maxMs: 2_140 },
      [
        { file: "gh", count: 40, syncMs: 6_120, wallMs: 20_000, maxSyncMs: 480 },
        { file: "git", count: 62, syncMs: 3_010, wallMs: 9_000, maxSyncMs: 220 },
      ],
      1_060_000,
    );
    expect(line).toContain("p99=812ms");
    expect(line).toContain("max=2140ms");
    expect(line).toContain("over 60s");
    expect(line).toContain("gh×40 sync=6120ms max=480ms wall=20000ms");
    expect(line).toContain("git×62");
    expect(line.startsWith("[1970-01-01T00:17:40.000Z]")).toBe(true);
  });

  it("says so when a stall had no spawns to blame", () => {
    const line = formatStallLine({ since: 0, p50Ms: 1, p99Ms: 900, maxMs: 900 }, []);
    expect(line).toContain("no spawns in window");
  });
});
