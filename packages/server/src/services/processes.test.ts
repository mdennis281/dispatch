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
    });
    const res = await svc.killPids([100, 100, 500]); // dedup + one failure
    expect(killed).toEqual([100]);
    expect(res).toEqual([
      { pid: 100, ok: true },
      { pid: 500, ok: false, error: "boom" },
    ]);
  });
});
