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
