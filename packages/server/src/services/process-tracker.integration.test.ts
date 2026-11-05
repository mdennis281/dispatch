/**
 * The tracker against the REAL operating system — no fake tables.
 *
 * The unit tests prove the logic over tables a test wrote. What they cannot
 * prove is that the table this platform actually produces carries what the
 * logic needs: parent pids that form a tree, start times that survive the
 * round trip (CIM `CreationDate` on Windows, `etime` on GNU and BSD `ps`),
 * cumulative CPU that moves, and a kill that leaves nothing behind. Each of
 * those has a per-OS spelling, and a regression in any one of them ships green
 * from a Linux-only gate. So this runs on the Linux gate, in the Windows job of
 * `promote.yml`, and (through the install smoke) on macOS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ChatProcessService } from "./chat-processes.js";
import { createProcTableReader, type ProcTableReader } from "./proc-table-reader.js";
import { ProcessTracker } from "./process-tracker.js";
import { ProcessService, defaultAlive } from "./processes.js";

/**
 * A parent that starts one busy child and prints its pid, then idles — the
 * shape of a session with an MCP server under it. The child spins so the CPU
 * measurement has something to measure.
 *
 * `detached` so the child genuinely OUTLIVES its parent: on Windows a child
 * sharing the parent's console died with it, and the reap test then had no
 * orphan to find — it passed while proving nothing.
 */
const PARENT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore", detached: true, windowsHide: true });
child.unref();
console.log(String(child.pid));
setInterval(() => {}, 1000);
`;

const started: ChildProcess[] = [];
/** Detached children the parents started — not reached by killing the parent. */
const orphans: number[] = [];
let reader: ProcTableReader | undefined;

afterEach(() => {
  reader?.dispose();
  reader = undefined;
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already reaped — the point of the test */
    }
  }
  for (const proc of started.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
});

async function startTree(): Promise<{ parent: ChildProcess; childPid: number }> {
  const parent = spawn(process.execPath, ["-e", PARENT], { stdio: ["ignore", "pipe", "ignore"] });
  started.push(parent);
  const childPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent never reported its child")), 20_000);
    parent.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      const pid = Number(String(chunk).trim());
      orphans.push(pid);
      resolve(pid);
    });
  });
  return { parent, childPid };
}

async function waitDead(pid: number, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!defaultAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !defaultAlive(pid);
}

describe("ProcessTracker on the real process table", () => {
  it(
    "attributes a real tree, measures its CPU, and carries start times",
    async () => {
      const { parent, childPid } = await startTree();
      reader = createProcTableReader();
      const tracker = new ProcessTracker({
        read: reader.read,
        sessionPids: () => new Map([["chat-it", parent.pid!]]),
        intervalMs: 0,
      });

      const first = await tracker.sweep();
      const own = first.owners.get("chat-it");
      expect(own, "the tree was not attributed to its chat").toBeDefined();
      expect([...own!.session]).toEqual(expect.arrayContaining([parent.pid, childPid]));

      const row = first.byPid.get(childPid)!;
      expect(row.ppid).toBe(parent.pid);
      expect(row.startedAt, "no start time — the pid-reuse guard has nothing to compare").toBeTypeOf("number");
      // Started within the last minute, on this machine's clock.
      expect(Math.abs(Date.now() - row.startedAt!)).toBeLessThan(60_000);

      await new Promise((r) => setTimeout(r, 1_500));
      const second = await tracker.sweep();
      expect(second.windowMs).toBeGreaterThan(0);
      // A spinning loop over a second and a half: comfortably above zero on
      // any runner, however contended.
      expect(second.cpuByPid.get(childPid) ?? 0).toBeGreaterThan(5);
    },
    90_000,
  );

  it(
    "releases a chat: the session stop leaves an orphan, and the reap kills it",
    async () => {
      const { parent, childPid } = await startTree();
      reader = createProcTableReader();
      let sessions = new Map([["chat-it", parent.pid!]]);
      const tracker = new ProcessTracker({
        read: reader.read,
        sessionPids: () => sessions,
        intervalMs: 0,
      });
      const processes = new ProcessService({ store: {} as never, procTable: reader.read });
      const svc = new ChatProcessService({
        tracker,
        killShells: () => {},
        killPids: (pids) => processes.killPids(pids),
      });
      await tracker.sweep();

      // A session stop that kills ONLY the root — exactly how an MCP server
      // ends up orphaned when a runtime exits without taking its children.
      const res = await svc.release(["chat-it"], async () => {
        parent.kill("SIGKILL");
        await waitDead(parent.pid!);
        sessions = new Map();
      });

      expect(await waitDead(childPid), `orphan ${childPid} survived the reap`).toBe(true);
      expect(res.orphans).toBeGreaterThanOrEqual(1);
      expect((await tracker.read()).owners.has("chat-it")).toBe(false);
    },
    90_000,
  );
});
