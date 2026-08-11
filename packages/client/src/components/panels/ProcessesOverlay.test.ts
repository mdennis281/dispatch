import { describe, it, expect } from "vitest";
import type { TerminalInfo } from "@dispatch/shared";
import type { ProjectProcess } from "../../lib/api.js";
import { groupProcesses } from "./ProcessesOverlay.js";

const shell = (over: Partial<TerminalInfo> & { chatId: string; name: string }): TerminalInfo => ({
  id: `${over.chatId}::${over.name}`,
  cwd: "C:\\repo",
  status: "live",
  createdAt: 1,
  ...over,
});

const port = (over: Partial<ProjectProcess> & { port: number; pid: number }): ProjectProcess => ({
  tracked: false,
  source: "orphan",
  ...over,
});

const titles: Record<string, string> = { c1: "Perf regression", c2: "Docs pass" };
const title = (id: string) => titles[id];

describe("groupProcesses", () => {
  it("puts a chat's shells and its listeners in one group", () => {
    const groups = groupProcesses(
      [
        port({
          port: 47820,
          pid: 900,
          tracked: true,
          source: "terminal",
          chatId: "c1",
          terminalId: "c1::server",
          terminalName: "server",
        }),
      ],
      [shell({ chatId: "c1", name: "server", pid: 500 })],
      title,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("Perf regression");
    expect(groups[0]?.rows.map((r) => r.kind)).toEqual(["shell", "port"]);
    expect(groups[0]?.pids).toEqual([500, 900]);
  });

  it("keeps a shell that holds no port — it is still something that chat is running", () => {
    const groups = groupProcesses([], [shell({ chatId: "c1", name: "build", pid: 500 })], title);
    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[0]?.pids).toEqual([500]);
  });

  it("drops an exited shell", () => {
    const groups = groupProcesses(
      [],
      [shell({ chatId: "c1", name: "build", pid: 500, status: "exited" })],
      title,
    );
    expect(groups).toEqual([]);
  });

  it("buckets runners and orphans separately, and sorts them after the chats", () => {
    const groups = groupProcesses(
      [
        port({ port: 5175, pid: 300 }),
        port({ port: 5173, pid: 100, tracked: true, source: "runner", subAppId: "game" }),
        port({
          port: 47820,
          pid: 900,
          tracked: true,
          source: "terminal",
          chatId: "c1",
          terminalName: "server",
        }),
      ],
      [],
      title,
    );
    expect(groups.map((g) => g.id)).toEqual(["chat:c1", "runners", "orphans"]);
    expect(groups[1]?.title).toBe("App runners");
    expect(groups[2]?.title).toBe("Unaccounted for");
  });

  it("orders chats by how much they are running, then by title", () => {
    const groups = groupProcesses(
      [
        port({ port: 1, pid: 1, source: "terminal", chatId: "c2", tracked: true }),
        port({ port: 2, pid: 2, source: "terminal", chatId: "c1", tracked: true }),
        port({ port: 3, pid: 3, source: "terminal", chatId: "c1", tracked: true }),
      ],
      [],
      title,
    );
    expect(groups.map((g) => g.chatId)).toEqual(["c1", "c2"]);
  });

  it("dedupes pids so a kill doesn't ask for the same process twice", () => {
    // A shell that IS the listener (its command replaced the shell) reports one
    // pid from both sources.
    const groups = groupProcesses(
      [port({ port: 47820, pid: 500, source: "terminal", chatId: "c1", tracked: true })],
      [shell({ chatId: "c1", name: "server", pid: 500 })],
      title,
    );
    expect(groups[0]?.pids).toEqual([500]);
  });

  it("falls back to a placeholder for a chat it can't name", () => {
    const groups = groupProcesses([], [shell({ chatId: "gone", name: "s", pid: 1 })], title);
    expect(groups[0]?.title).toBe("Untitled chat");
  });
});
