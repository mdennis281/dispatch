import { describe, it, expect, vi } from "vitest";
import { ChatProcessService } from "./chat-processes.js";
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
  { pid: 10, ppid: 1, name: "claude.exe" },
  { pid: 11, ppid: 10, name: "node.exe" },
  { pid: 12, ppid: 10, name: "node.exe" },
  { pid: 20, ppid: 1, name: "claude.exe" },
  { pid: 21, ppid: 20, name: "node.exe" },
  { pid: 30, ppid: 1, name: "powershell.exe" },
  { pid: 31, ppid: 30, name: "node.exe" },
];

const shell = (chatId: string, pid: number) => ({
  chatId,
  pid,
  name: "server",
  terminalId: `t-${pid}`,
});

describe("ChatProcessService", () => {
  it("counts a session root and everything under it, inclusively", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      sessionPids: () => new Map([["chat-a", 10]]),
    });
    // The claude process itself plus its two MCP children.
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3 });
  });

  it("adds background shells, which hang off the server rather than the session", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      sessionPids: () => new Map([["chat-a", 10]]),
      terminals: { livePids: () => [shell("chat-a", 30)] },
    });
    // 10, 11, 12 + 30, 31 — the shell is a second ROOT, not a descendant.
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 5 });
  });

  it("never double-counts a pid two roots both reach", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      sessionPids: () => new Map([["chat-a", 10]]),
      // A shell that is itself under the session: reachable from both roots.
      terminals: { livePids: () => [shell("chat-a", 11)] },
    });
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3 });
  });

  it("keeps chats apart", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      sessionPids: () =>
        new Map([
          ["chat-a", 10],
          ["chat-b", 20],
        ]),
    });
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3, "chat-b": 2 });
  });

  it("omits a chat holding nothing rather than reporting a zero", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      // A pid that isn't in the table at all — the session died between the
      // broker answering and the scan running.
      sessionPids: () => new Map([["chat-a", 10], ["gone", 999]]),
    });
    const { byChat } = await svc.counts();
    // 999 is still one addressable root, so it counts itself and nothing else;
    // what must NOT appear is a chat with no roots at all.
    expect(byChat["chat-b"]).toBeUndefined();
  });

  it("caches, and coalesces concurrent callers into ONE scan", async () => {
    const procTable = vi.fn(async () => TABLE);
    let now = 1_000;
    const svc = new ChatProcessService({
      procTable,
      sessionPids: () => new Map([["chat-a", 10]]),
      now: () => now,
      ttlMs: 10_000,
    });

    // Three callers in the same tick miss the cache together; without the
    // in-flight guard that is three shell-outs.
    await Promise.all([svc.counts(), svc.counts(), svc.counts()]);
    expect(procTable).toHaveBeenCalledTimes(1);

    now += 9_000;
    await svc.counts();
    expect(procTable).toHaveBeenCalledTimes(1);

    now += 2_000; // past the TTL
    await svc.counts();
    expect(procTable).toHaveBeenCalledTimes(2);
  });

  it("re-scans immediately after invalidate, so a kill shows up", async () => {
    const procTable = vi.fn(async () => TABLE);
    const svc = new ChatProcessService({
      procTable,
      sessionPids: () => new Map([["chat-a", 10]]),
      now: () => 1_000,
    });
    await svc.counts();
    svc.invalidate();
    await svc.counts();
    expect(procTable).toHaveBeenCalledTimes(2);
  });

  it("survives a scan that fails, rather than taking the sidebar down with it", async () => {
    const svc = new ChatProcessService({
      procTable: async () => {
        throw new Error("powershell is having a day");
      },
      sessionPids: () => new Map([["chat-a", 10]]),
    });
    expect((await svc.counts()).byChat).toEqual({});
  });

  it("keeps the last real reading when a scan fails, instead of reporting 1 per chat", async () => {
    // The trap: with no table, every root still walks to itself and nothing
    // else, so each chat reads "1" — a plausible number, uniformly wrong, and
    // indistinguishable from a real one.
    let table = TABLE;
    let now = 1_000;
    const svc = new ChatProcessService({
      procTable: async () => table,
      sessionPids: () => new Map([["chat-a", 10]]),
      now: () => now,
      ttlMs: 1,
    });
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3 });

    table = [];
    now += 1_000;
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3 });

    // …and it recovers rather than serving the stale reading forever.
    table = TABLE;
    now += 1_000;
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 3 });
  });

  it("lists a chat's pids for the kill, roots included", async () => {
    const svc = new ChatProcessService({
      procTable: async () => TABLE,
      sessionPids: () => new Map([["chat-a", 10]]),
      terminals: { livePids: () => [shell("chat-a", 30)] },
    });
    expect((await svc.pidsFor("chat-a")).sort((a, b) => a - b)).toEqual([10, 11, 12, 30, 31]);
    expect(await svc.pidsFor("nobody")).toEqual([]);
  });

  it("does not spin on a self-parented row", async () => {
    // Windows reports pid 0 as its own parent; a naive walk never returns.
    const svc = new ChatProcessService({
      procTable: async () => [
        { pid: 5, ppid: 5, name: "weird.exe" },
        { pid: 6, ppid: 5, name: "child.exe" },
      ],
      sessionPids: () => new Map([["chat-a", 5]]),
    });
    expect((await svc.counts()).byChat).toEqual({ "chat-a": 2 });
  });
});
