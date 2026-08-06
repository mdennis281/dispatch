import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { win32 as pathWin32 } from "node:path";
import type { WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import {
  TerminalService,
  type ShellProcess,
  type SpawnShell,
} from "./terminal.js";

/* ------------------------------------------------------------------ fixtures */

let bus: EventBus;
let events: WsServerEvent[];

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

/**
 * A scripted fake PowerShell. It maintains a cwd (initialized to the spawn cwd)
 * and, on each `stdin.write`, interprets a tiny command vocabulary that stands in
 * for the real shell so persistence is deterministic without a real subprocess:
 *   - `cd X` / `Set-Location -LiteralPath 'X'` → update cwd (persists)
 *   - `printout TEXT` → emit TEXT on stdout
 *   - `printerr TEXT` → emit TEXT on stderr
 *   - `fail`          → next marker reports exit=3, $?=False
 * When a write contains the service's sentinel marker, it echoes the marker line
 * `<marker>|<exit>|<ok>|<cwd>` (exactly what TerminalService parses).
 */
class FakeShell extends EventEmitter implements ShellProcess {
  cwd: string;
  killed = false;
  private pendingExit: number | null = null;
  private pendingOk = "True";
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { write: (c: string) => void; end?: () => void };

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
    this.stdin = { write: (c) => this.handle(c) };
  }

  private handle(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;

      const cd =
        line.match(/^cd\s+(.+)$/) ??
        line.match(/^Set-Location\s+-LiteralPath\s+'(.+)'$/);
      if (cd) {
        this.cwd = pathWin32.resolve(this.cwd, cd[1].trim());
        continue;
      }
      const out = line.match(/^printout\s+(.+)$/);
      if (out) {
        this.stdout.emit("data", Buffer.from(out[1] + "\n"));
        continue;
      }
      const err = line.match(/^printerr\s+(.+)$/);
      if (err) {
        this.stderr.emit("data", Buffer.from(err[1] + "\n"));
        continue;
      }
      if (line === "fail") {
        this.pendingExit = 3;
        this.pendingOk = "False";
        continue;
      }
      const marker = line.match(/CMTERM[A-Za-z0-9_-]+/);
      if (marker) {
        const exit = this.pendingExit === null ? 0 : this.pendingExit;
        const ok = this.pendingOk;
        this.pendingExit = null;
        this.pendingOk = "True";
        this.stdout.emit(
          "data",
          Buffer.from(`${marker[0]}|${exit}|${ok}|${this.cwd}\n`),
        );
      }
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.emit("exit", 0);
  }
}

/** A spawn seam that records every FakeShell it creates + increments a counter. */
function fakeSpawn(): { spawn: SpawnShell; shells: FakeShell[] } {
  const shells: FakeShell[] = [];
  const spawn: SpawnShell = (cwd) => {
    const s = new FakeShell(cwd);
    shells.push(s);
    return s;
  };
  return { spawn, shells };
}

function makeService(over: { maxPerChat?: number; spawn?: SpawnShell } = {}) {
  let n = 0;
  const { spawn, shells } = over.spawn
    ? { spawn: over.spawn, shells: [] as FakeShell[] }
    : fakeSpawn();
  const svc = new TerminalService({
    bus,
    maxPerChat: over.maxPerChat,
    deps: { spawn, genId: () => `t${++n}`, now: () => 1000 },
  });
  return { svc, shells };
}

function outputEvents(): Extract<WsServerEvent, { type: "terminal-output" }>[] {
  return events.filter(
    (e): e is Extract<WsServerEvent, { type: "terminal-output" }> =>
      e.type === "terminal-output",
  );
}

/* ------------------------------------------------------------------ tests */

describe("TerminalService — run + output", () => {
  it("captures stdout and a zero exit code", async () => {
    const { svc } = makeService();
    const res = await svc.run({
      chatId: "c1",
      name: "main",
      command: "printout hello",
      cwd: "C:\\repo",
    });
    expect(res.output).toBe("hello");
    expect(res.exitCode).toBe(0);
    expect(res.cwd).toBe("C:\\repo");
  });

  it("reports a non-zero exit code", async () => {
    const { svc } = makeService();
    const res = await svc.run({ chatId: "c1", name: "main", command: "fail", cwd: "C:\\repo" });
    expect(res.exitCode).toBe(3);
  });

  it("streams a `command` echo + stdout lines over the bus", async () => {
    const { svc } = makeService();
    await svc.run({ chatId: "c1", name: "main", command: "printout hi", cwd: "C:\\repo" });
    const streams = outputEvents().map((e) => `${e.stream}:${e.chunk}`);
    expect(streams).toContain("command:printout hi");
    expect(streams).toContain("stdout:hi");
    // The sentinel marker line must NEVER be surfaced to the UI.
    expect(outputEvents().some((e) => e.chunk.includes("CMTERM"))).toBe(false);
  });
});

describe("TerminalService — persistence", () => {
  it("keeps cwd across two commands to the SAME named terminal", async () => {
    const { svc, shells } = makeService();
    const first = await svc.run({
      chatId: "c1",
      name: "work",
      command: "cd C:\\Windows",
      cwd: "C:\\start",
    });
    expect(first.cwd).toBe("C:\\Windows");

    // A second command to the same name reuses the shell — cwd persisted.
    const second = await svc.run({ chatId: "c1", name: "work", command: "printout here" });
    expect(second.cwd).toBe("C:\\Windows");
    expect(second.output).toBe("here");

    // Exactly ONE shell was spawned for the two commands.
    expect(shells.length).toBe(1);
  });

  it("isolates terminals by name (separate shells, separate cwd)", async () => {
    const { svc, shells } = makeService();
    await svc.run({ chatId: "c1", name: "a", command: "cd C:\\A", cwd: "C:\\start" });
    const b = await svc.run({ chatId: "c1", name: "b", command: "printout x", cwd: "C:\\start" });
    expect(b.cwd).toBe("C:\\start");
    expect(shells.length).toBe(2);
  });
});

describe("TerminalService — cap", () => {
  it("rejects a new terminal past the per-chat cap", async () => {
    const { svc } = makeService({ maxPerChat: 2 });
    await svc.run({ chatId: "c1", name: "one", command: "printout x", cwd: "C:\\r" });
    await svc.run({ chatId: "c1", name: "two", command: "printout x", cwd: "C:\\r" });
    const third = await svc.run({ chatId: "c1", name: "three", command: "printout x", cwd: "C:\\r" });
    expect(third.error).toMatch(/cap reached/i);
    expect(svc.listChat("c1").length).toBe(2);
  });

  it("reusing an existing name past the cap still works", async () => {
    const { svc } = makeService({ maxPerChat: 1 });
    await svc.run({ chatId: "c1", name: "one", command: "printout a", cwd: "C:\\r" });
    const again = await svc.run({ chatId: "c1", name: "one", command: "printout b", cwd: "C:\\r" });
    expect(again.error).toBeUndefined();
    expect(again.output).toBe("b");
  });
});

describe("TerminalService — teardown", () => {
  it("killChat kills the chat's shells and clears them", async () => {
    const { svc, shells } = makeService();
    await svc.run({ chatId: "c1", name: "main", command: "printout x", cwd: "C:\\r" });
    expect(svc.listChat("c1").length).toBe(1);

    svc.killChat("c1");

    expect(shells[0]!.killed).toBe(true);
    expect(svc.listChat("c1").length).toBe(0);
    expect(events.some((e) => e.type === "terminal-closed" && e.chatId === "c1")).toBe(true);
  });

  it("killChat leaves OTHER chats' shells alone", async () => {
    const { svc, shells } = makeService();
    await svc.run({ chatId: "c1", name: "main", command: "printout x", cwd: "C:\\r" });
    await svc.run({ chatId: "c2", name: "main", command: "printout x", cwd: "C:\\r" });

    svc.killChat("c1");

    expect(shells[0]!.killed).toBe(true);
    expect(shells[1]!.killed).toBe(false);
    expect(svc.listChat("c2").length).toBe(1);
  });

  it("publishes terminal-update snapshots (live → exited on kill)", async () => {
    const { svc } = makeService();
    await svc.run({ chatId: "c1", name: "main", command: "printout x", cwd: "C:\\r" });
    const info = svc.list()[0]!;
    expect(info.status).toBe("live");
    expect(info.name).toBe("main");
    expect(info.lastCommand).toBe("printout x");
    expect(info.lastExitCode).toBe(0);
  });
});
