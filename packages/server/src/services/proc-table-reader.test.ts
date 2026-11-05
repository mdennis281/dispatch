import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PowerShellTableReader, type WorkerProcess } from "./proc-table-reader.js";

const CSV = [
  '"ProcessId","ParentProcessId","Name","StartedAt"',
  '"10","1","node.exe","1700000000000"',
  '"11","10","conhost.exe",',
].join("\r\n");

/**
 * A fake persistent PowerShell: answers each query written to stdin with the
 * CSV and the sentinel the query asked for — or stays silent, or dies.
 */
function fakeWorker(mode: "answer" | "silent" | "die" = "answer") {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  stdin.on("data", (chunk: Buffer) => {
    const sentinel = /Write-Output '([^']+)'/.exec(String(chunk))?.[1];
    if (mode === "answer" && sentinel) stdout.write(`${CSV}\r\n${sentinel}\r\n`);
    if (mode === "die") events.emit("exit");
  });
  const worker: WorkerProcess & { killed: () => boolean } = {
    stdin,
    stdout,
    pid: 4242,
    kill: () => {
      killed = true;
      events.emit("exit");
      return true;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    killed: () => killed,
  } as never;
  return worker;
}

describe("PowerShellTableReader", () => {
  it("keeps ONE worker across reads and parses each answer", async () => {
    const spawn = vi.fn(() => fakeWorker());
    const reader = new PowerShellTableReader({ spawn, fallback: async () => [] });
    const a = await reader.read();
    const b = await reader.read();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a.map((r) => r.pid)).toEqual([10, 11]);
    expect(a[0].startedAt).toBe(1_700_000_000_000);
    expect(a[1].startedAt).toBeUndefined();
    expect(b).toHaveLength(2);
    expect(reader.workerPid()).toBe(4242);
    reader.dispose();
  });

  it("abandons a wedged read at its deadline and starts a new worker next time", async () => {
    const workers = [fakeWorker("silent"), fakeWorker()];
    const spawn = vi.fn(() => workers.shift()!);
    const reader = new PowerShellTableReader({ spawn, fallback: async () => [], timeoutMs: 20 });
    expect(await reader.read()).toEqual([]);
    expect((await reader.read()).length).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(2);
    reader.dispose();
  });

  it("resolves a read at once when the worker dies under it", async () => {
    const reader = new PowerShellTableReader({
      spawn: () => fakeWorker("die"),
      fallback: async () => [],
      timeoutMs: 60_000,
    });
    expect(await reader.read()).toEqual([]);
    reader.dispose();
  });

  it("falls back to a spawn per read once the worker keeps failing", async () => {
    const fallback = vi.fn(async () => [{ pid: 1, ppid: 0 }]);
    const reader = new PowerShellTableReader({
      spawn: () => fakeWorker("die"),
      fallback,
      maxFailures: 2,
    });
    await reader.read();
    await reader.read();
    expect(await reader.read()).toEqual([{ pid: 1, ppid: 0 }]);
    expect(fallback).toHaveBeenCalledTimes(1);
    reader.dispose();
  });
});
