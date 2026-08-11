import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import {
  ProcessService,
  parseNetstat,
  parseLsof,
  parseTasklist,
  parseProcCsv,
  parsePsTable,
  defaultAlive,
  type PortListener,
} from "./processes.js";

describe("parseNetstat", () => {
  it("extracts LISTENING port→pid pairs across IPv4/IPv6", () => {
    const out = parseNetstat(
      [
        "",
        "Active Connections",
        "  Proto  Local Address          Foreign Address        State           PID",
        "  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       12345",
        "  TCP    [::]:5173              [::]:0                 LISTENING       12345",
        "  TCP    127.0.0.1:2567         0.0.0.0:0              LISTENING       6789",
        "  TCP    10.0.0.2:54000         10.0.0.3:443           ESTABLISHED     999",
      ].join("\r\n"),
    );
    expect(out).toEqual([
      { port: 5173, pid: 12345 },
      { port: 5173, pid: 12345 },
      { port: 2567, pid: 6789 },
    ]);
  });
});

describe("parseLsof", () => {
  it("extracts port→pid from the NAME column", () => {
    const out = parseLsof(
      [
        "COMMAND   PID   USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME",
        "node    12345 mike   23u  IPv4 0x1234      0t0  TCP *:5173 (LISTEN)".replace(
          " (LISTEN)",
          "",
        ),
        "node     6789 mike   25u  IPv6 0x5678      0t0  TCP [::1]:2567",
      ].join("\n"),
    );
    expect(out).toEqual([
      { port: 5173, pid: 12345 },
      { port: 2567, pid: 6789 },
    ]);
  });
});

describe("parseTasklist", () => {
  it("maps pid→image name from CSV", () => {
    const map = parseTasklist(
      [
        '"node.exe","12345","Console","1","120,000 K"',
        '"com.docker.backend.exe","6789","Console","1","80,000 K"',
      ].join("\r\n"),
    );
    expect(map.get(12345)).toBe("node.exe");
    expect(map.get(6789)).toBe("com.docker.backend.exe");
  });
});

describe("defaultAlive (the real probe)", () => {
  it("says this process is alive", () => {
    expect(defaultAlive(process.pid)).toBe(true);
  });

  it("says a pid that cannot exist is not", () => {
    // 2^31-ish: above every platform's pid_max, so it is never assigned.
    expect(defaultAlive(2_147_483_600)).toBe(false);
  });

  it("treats EPERM as ALIVE — the process exists, we just may not signal it", () => {
    // pid 1 is init/System: present on every platform, and not ours to signal.
    // Whatever the OS says, the answer must not be "dead" (that would turn a
    // failed kill into a reported success). On Windows pid 1 doesn't resolve, so
    // only assert the EPERM branch where it actually applies.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(defaultAlive(1)).toBe(true);
    }
  });
});

describe("parseProcCsv", () => {
  it("reads pid/ppid/name and skips the header", () => {
    const rows = parseProcCsv(
      [
        '"ProcessId","ParentProcessId","Name"',
        '"900","800","node.exe"',
        '"800","500","cmd.exe"',
      ].join("\r\n"),
    );
    expect(rows).toEqual([
      { pid: 900, ppid: 800, name: "node.exe" },
      { pid: 800, ppid: 500, name: "cmd.exe" },
    ]);
  });

  it("skips rows that aren't numeric pids rather than emitting NaN parents", () => {
    // A NaN ppid would silently join the children map under one bogus key and
    // attribute unrelated processes to whatever else landed there.
    expect(parseProcCsv('"x","y","z"\n"1","0","init"')).toEqual([
      { pid: 1, ppid: 0, name: "init" },
    ]);
  });
});

describe("parsePsTable", () => {
  it("reads `ps -e -o pid=,ppid=,comm=` output", () => {
    expect(parsePsTable(["  900   800 node", "  800     1 sh", "garbage"].join("\n"))).toEqual([
      { pid: 900, ppid: 800, name: "node" },
      { pid: 800, ppid: 1, name: "sh" },
    ]);
  });
});

describe("ProcessService.listForProject", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-proc-"));
    store = new Store(dir);
    await store.init();
    await store.saveProject({
      id: "p1",
      name: "P1",
      repoPath: "C:/repo",
      worktreeRoot: "C:/wt",
      subApps: [
        { id: "game", name: "game", path: "apps/client", dev: "vite", ports: [5173] },
      ],
      createdAt: 1,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags tracked vs orphan listeners within the project's port window", async () => {
    // A live runner allocated 5173 (its shell pid differs from the OS listener).
    await store.saveRunner({
      id: "r1",
      projectId: "p1",
      worktreePath: "C:/wt",
      subAppId: "game",
      kind: "process",
      pid: 1000, // shell pid
      port: 5173,
      ports: [5173],
      status: "running",
    });

    const scan = async (): Promise<PortListener[]> => [
      { port: 5173, pid: 2000 }, // vite grandchild — tracked (port matches runner)
      { port: 5178, pid: 3000 }, // hopped within window — orphan
      { port: 9999, pid: 4000 }, // outside window — excluded
    ];
    const describe = async () =>
      new Map([
        [2000, "node.exe"],
        [3000, "node.exe"],
      ]);

    const svc = new ProcessService({ store, scan, describe, portWindow: 20 });
    const rows = await svc.listForProject("p1");

    expect(rows.map((r) => r.port)).toEqual([5173, 5178]); // 9999 excluded
    const tracked = rows.find((r) => r.port === 5173)!;
    expect(tracked.tracked).toBe(true);
    expect(tracked.pid).toBe(2000);
    expect(tracked.runnerId).toBe("r1");
    expect(tracked.subAppId).toBe("game");
    expect(tracked.name).toBe("node.exe");

    const orphan = rows.find((r) => r.port === 5178)!;
    expect(orphan.tracked).toBe(false);
    expect(orphan.runnerId).toBeUndefined();
  });

  /* ------------------------------------------------- chat-shell attribution */

  /** A chat owned by `p1`, so its shells count as this project's. */
  const saveChat = (id: string, title: string, projectId = "p1") =>
    store.saveChat({
      id,
      projectId,
      title,
      modeId: "auto",
      effort: "medium",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });

  /** `pid → ppid` rows, as `procTable` returns them. */
  const table = (pairs: [number, number][]) =>
    async () => pairs.map(([pid, ppid]) => ({ pid, ppid, name: "node.exe" }));

  it("attributes a listener on an UNDECLARED port to the chat whose shell started it", async () => {
    // The `the-salesman` case: declared base is 5173, the agent's dev server is
    // on 47820. No port sweep would ever look there; ancestry finds it.
    await saveChat("chatA", "Game Performance Lag Regression");
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 47820, pid: 900 }],
      describe: async () => new Map([[900, "node.exe"]]),
      procTable: table([
        [500, 1], // the chat's shell
        [800, 500], // node wrapper
        [900, 800], // vite, the actual listener
      ]),
      terminals: {
        livePids: () => [
          { chatId: "chatA", name: "server", terminalId: "chatA::server", pid: 500 },
        ],
      },
    });

    const rows = await svc.listForProject("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      port: 47820,
      pid: 900,
      tracked: true,
      source: "terminal",
      chatId: "chatA",
      chatTitle: "Game Performance Lag Regression",
      terminalName: "server",
      terminalId: "chatA::server",
    });
  });

  it("leaves a listener that descends from nothing we own an orphan", async () => {
    await saveChat("chatA", "A");
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 5175, pid: 4000 }],
      describe: async () => new Map(),
      procTable: table([
        [500, 1],
        [4000, 1], // unrelated: parented by init, not by our shell
      ]),
      terminals: {
        livePids: () => [
          { chatId: "chatA", name: "server", terminalId: "chatA::server", pid: 500 },
        ],
      },
      portWindow: 20,
    });

    const rows = await svc.listForProject("p1");
    expect(rows).toEqual([
      expect.objectContaining({ port: 5175, tracked: false, source: "orphan" }),
    ]);
  });

  it("ignores shells belonging to ANOTHER project's chats", async () => {
    await store.saveProject({
      id: "p2",
      name: "P2",
      repoPath: "C:/other",
      worktreeRoot: "C:/otherwt",
      subApps: [],
      createdAt: 1,
    });
    await saveChat("chatB", "Elsewhere", "p2");
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 47820, pid: 900 }],
      describe: async () => new Map(),
      procTable: table([
        [500, 1],
        [900, 500],
      ]),
      terminals: {
        livePids: () => [
          { chatId: "chatB", name: "server", terminalId: "chatB::server", pid: 500 },
        ],
      },
    });
    // p2's dev server is p2's business; on p1's panel it is simply not there.
    expect(await svc.listForProject("p1")).toEqual([]);
  });

  it("prefers the runner's account of a port over shell ancestry", async () => {
    await saveChat("chatA", "A");
    await store.saveRunner({
      id: "r1",
      projectId: "p1",
      worktreePath: "C:/wt",
      subAppId: "game",
      kind: "process",
      pid: 1000,
      port: 5173,
      ports: [5173],
      status: "running",
    });
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 5173, pid: 900 }],
      describe: async () => new Map(),
      procTable: table([
        [500, 1],
        [900, 500],
      ]),
      terminals: {
        livePids: () => [
          { chatId: "chatA", name: "server", terminalId: "chatA::server", pid: 500 },
        ],
      },
    });
    const rows = await svc.listForProject("p1");
    // The runner row names the sub-app and worktree; that's the better answer.
    expect(rows[0]).toMatchObject({ source: "runner", runnerId: "r1", subAppId: "game" });
    expect(rows[0].chatId).toBeUndefined();
  });

  it("survives a cycle in the process table", async () => {
    await saveChat("chatA", "A");
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 47820, pid: 900 }],
      describe: async () => new Map(),
      // pid reuse can make a table where a descendant claims to parent its own
      // ancestor. The walk must terminate rather than hang the request.
      procTable: table([
        [500, 900],
        [900, 500],
      ]),
      terminals: {
        livePids: () => [
          { chatId: "chatA", name: "server", terminalId: "chatA::server", pid: 500 },
        ],
      },
    });
    expect((await svc.listForProject("p1"))[0]).toMatchObject({ source: "terminal" });
  });

  it("skips the process-table read entirely when no shell is live", async () => {
    let called = 0;
    const svc = new ProcessService({
      store,
      scan: async () => [{ port: 5173, pid: 900 }],
      describe: async () => new Map(),
      procTable: async () => {
        called++;
        return [];
      },
      terminals: { livePids: () => [] },
    });
    await svc.listForProject("p1");
    expect(called).toBe(0);
  });

  it("kills the requested pids and reports per-pid results", async () => {
    const killed: number[] = [];
    const svc = new ProcessService({
      store,
      killTree: async (pid) => {
        if (pid === 500) throw new Error("boom");
        killed.push(pid);
      },
      alive: () => true, // the failed kill really did leave it running
    });
    const res = await svc.killPids([100, 100, 500]); // dedup + one failure
    expect(killed).toEqual([100]);
    expect(res).toEqual([
      { pid: 100, ok: true },
      { pid: 500, ok: false, error: "boom" },
    ]);
  });

  it("never issues a kill for a pid its own ancestor's kill already covers", async () => {
    // The "kill this chat" set is a shell plus the dev server under it. Killing
    // both in parallel races — the tree-kill that lands second reports failure
    // for a process the first already reaped ("Killed 1/2", both gone).
    const killed: number[] = [];
    const svc = new ProcessService({
      store,
      killTree: async (pid) => {
        killed.push(pid);
      },
      procTable: async () => [
        { pid: 500, ppid: 1 }, // the shell
        { pid: 800, ppid: 500 }, // a wrapper
        { pid: 900, ppid: 800 }, // the listener
      ],
    });
    const res = await svc.killPids([500, 900]);
    expect(killed).toEqual([500]);
    expect(res).toEqual([
      { pid: 500, ok: true },
      { pid: 900, ok: true },
    ]);
  });

  it("kills a covered pid itself when the ancestor's kill didn't get it", async () => {
    // The ancestor kill failed (permissions, transient OS error) and the child
    // is still holding its port. Reporting ok because an ancestor was ASKED to
    // die would hide the failure from both the toast and the row.
    const killed: number[] = [];
    const svc = new ProcessService({
      store,
      killTree: async (pid) => {
        killed.push(pid);
        if (pid === 500) throw new Error("access denied");
      },
      alive: (pid) => !killed.includes(pid) || pid === 500,
      procTable: async () => [
        { pid: 500, ppid: 1 },
        { pid: 900, ppid: 500 },
      ],
    });
    const res = await svc.killPids([500, 900]);
    expect(killed).toEqual([500, 900]); // 900 retried directly
    expect(res).toEqual([
      { pid: 500, ok: false, error: "access denied" },
      { pid: 900, ok: true },
    ]);
  });

  it("still kills siblings that no other pid in the set covers", async () => {
    const killed: number[] = [];
    const svc = new ProcessService({
      store,
      killTree: async (pid) => {
        killed.push(pid);
      },
      procTable: async () => [
        { pid: 500, ppid: 1 },
        { pid: 900, ppid: 1 },
      ],
    });
    await svc.killPids([500, 900]);
    expect(killed.sort((a, b) => a - b)).toEqual([500, 900]);
  });

  it("reports a kill that errored but left nothing running as a success", async () => {
    // The process exited on its own between the scan and the click. The outcome
    // we were asked for holds, so a red error would be a lie.
    const svc = new ProcessService({
      store,
      killTree: async () => {
        throw new Error("There is no running instance of the task.");
      },
      alive: () => false,
    });
    expect(await svc.killPids([404])).toEqual([{ pid: 404, ok: true }]);
  });

  it("survives a cycle while pruning covered pids", async () => {
    const killed: number[] = [];
    const svc = new ProcessService({
      store,
      killTree: async (pid) => {
        killed.push(pid);
      },
      procTable: async () => [
        { pid: 500, ppid: 900 },
        { pid: 900, ppid: 500 },
      ],
    });
    // Mutually "descended": whichever is judged first covers the other. What
    // matters is that it terminates and kills at least one.
    const res = await svc.killPids([500, 900]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(killed.length).toBeGreaterThanOrEqual(1);
  });
});
