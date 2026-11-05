import { describe, expect, it } from "vitest";
import { reapIdleShells, type IdleShellSource } from "./idle-shell-reaper.js";
import { childMap, type ProcessSnapshot } from "./process-tracker.js";
import type { ProcRow } from "./processes.js";

function snapshot(rows: ProcRow[]): ProcessSnapshot {
  return {
    rows,
    byPid: new Map(rows.map((r) => [r.pid, r])),
    children: childMap(rows),
    at: 0,
    cpuByPid: new Map(),
    windowMs: 0,
    owners: new Map(),
  };
}

function terminals(idle: number[]): IdleShellSource & { killed: string[]; lastCutoff?: number } {
  const killed: string[] = [];
  const src = {
    killed,
    lastCutoff: undefined as number | undefined,
    idleShells(cutoff: number) {
      src.lastCutoff = cutoff;
      return idle.map((pid) => ({ terminalId: `t-${pid}`, chatId: "c", name: `s${pid}`, pid }));
    },
    kill(id: string) {
      killed.push(id);
      return true;
    },
  };
  return src;
}

describe("reapIdleShells", () => {
  it("retires an idle shell with nothing but its console host under it", () => {
    const t = terminals([10]);
    const snap = snapshot([
      { pid: 10, ppid: 1, name: "powershell.exe" },
      { pid: 11, ppid: 10, name: "conhost.exe" },
    ]);
    expect(reapIdleShells(snap, t, 30, 10_000_000)).toEqual(["t-10"]);
  });

  it("keeps an 'idle' shell that still has a process running under it", () => {
    // `Start-Process node server.js` returns at once — the terminal sees an
    // empty prompt while a dev server lives beneath it.
    const t = terminals([10]);
    const snap = snapshot([
      { pid: 10, ppid: 1, name: "powershell.exe" },
      { pid: 11, ppid: 10, name: "conhost.exe" },
      { pid: 12, ppid: 10, name: "node.exe" },
    ]);
    expect(reapIdleShells(snap, t, 30, 10_000_000)).toEqual([]);
  });

  it("does not judge a shell the table does not list", () => {
    const t = terminals([10]);
    expect(reapIdleShells(snapshot([{ pid: 1, ppid: 0 }]), t, 30, 10_000_000)).toEqual([]);
  });

  it("is off when the idle window is 0, like the session sweep", () => {
    const t = terminals([10]);
    expect(reapIdleShells(snapshot([{ pid: 10, ppid: 1 }]), t, 0, 10_000_000)).toEqual([]);
    expect(t.killed).toEqual([]);
  });

  it("asks for shells idle since the window's start", () => {
    const t = terminals([]);
    reapIdleShells(snapshot([]), t, 30, 10_000_000);
    expect(t.lastCutoff).toBe(10_000_000 - 30 * 60_000);
  });
});
