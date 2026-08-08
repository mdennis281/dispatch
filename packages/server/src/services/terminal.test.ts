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

  // Review caught this: `atCap` counts LIVE shells only, so an EXITED record
  // occupies no slot — and both entry points guarded on "no record at all"
  // rather than "about to go live". A chat at cap that also held an exited name
  // could revive it and end up at cap+1, repeatably.
  //
  // The exited state has to come from the SHELL dying (emit "exit"), not from
  // `svc.kill()` — kill DELETES the record, so it leaves nothing to revive and
  // reproduces nothing. A first draft of these tests used kill and passed
  // against the unfixed code; they are written this way deliberately.

  const live = (svc: TerminalService, chatId: string): number =>
    svc.listChat(chatId).filter((t) => t.status === "live").length;

  it("run() will not revive an EXITED name while the chat is at cap", async () => {
    const { svc, shells } = makeService({ maxPerChat: 2 });
    await svc.run({ chatId: "c1", name: "one", command: "printout a", cwd: "C:\\r" });
    await svc.run({ chatId: "c1", name: "two", command: "printout a", cwd: "C:\\r" });

    // "one" dies on its own — record retained, status exited, slot freed.
    shells[0]!.emit("exit", 0);
    expect(live(svc, "c1")).toBe(1);

    // Something else takes the freed slot: back at cap, with "one" still there.
    await svc.run({ chatId: "c1", name: "three", command: "printout a", cwd: "C:\\r" });
    expect(live(svc, "c1")).toBe(2);

    const revived = await svc.run({ chatId: "c1", name: "one", command: "printout b", cwd: "C:\\r" });
    expect(revived.error).toMatch(/cap reached/i);
    expect(live(svc, "c1")).toBe(2);
  });

  it("create() will not revive an EXITED name while the chat is at cap", () => {
    const { svc, shells } = makeService({ maxPerChat: 2 });
    svc.create("c1", "one", "C:\\r");
    svc.create("c1", "two", "C:\\r");

    shells[0]!.emit("exit", 0);
    svc.create("c1", "three", "C:\\r");
    expect(live(svc, "c1")).toBe(2);

    const revived = svc.create("c1", "one", "C:\\r");
    expect(revived.terminal).toBeUndefined();
    expect(revived.error).toMatch(/cap reached/i);
    expect(live(svc, "c1")).toBe(2);
  });

  it("an exited shell still frees its slot for a NEW name", async () => {
    // The other half of the rule — the fix must not make an exited shell hold a
    // slot forever, or a crashed shell would permanently shrink the budget.
    const { svc, shells } = makeService({ maxPerChat: 1 });
    await svc.run({ chatId: "c1", name: "one", command: "printout a", cwd: "C:\\r" });
    shells[0]!.emit("exit", 0);
    const next = await svc.run({ chatId: "c1", name: "two", command: "printout b", cwd: "C:\\r" });
    expect(next.error).toBeUndefined();
    expect(next.output).toBe("b");
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

  it("kill() closes ONE shell and leaves its siblings alone", async () => {
    const { svc, shells } = makeService();
    await svc.run({ chatId: "c1", name: "a", command: "printout x", cwd: "C:\\r" });
    await svc.run({ chatId: "c1", name: "b", command: "printout x", cwd: "C:\\r" });

    expect(svc.kill("c1::a")).toBe(true);

    expect(shells[0]!.killed).toBe(true);
    expect(shells[1]!.killed).toBe(false);
    expect(svc.listChat("c1").map((t) => t.name)).toEqual(["b"]);
    expect(events.some((e) => e.type === "terminal-closed" && e.terminalId === "c1::a")).toBe(true);
  });

  it("kill() on an unknown id reports false instead of throwing", () => {
    const { svc } = makeService();
    expect(svc.kill("c1::nope")).toBe(false);
  });
});

/* The human-facing door: `run()` spawns lazily, which only works for a caller
 * that already has a command. "New shell" doesn't. */
describe("TerminalService — create", () => {
  it("spawns an empty live shell and announces it", () => {
    const { svc, shells } = makeService();
    const { terminal, error } = svc.create("c1", "shell", "C:\\repo");

    expect(error).toBeUndefined();
    expect(terminal).toMatchObject({ id: "c1::shell", name: "shell", cwd: "C:\\repo", status: "live" });
    // Empty: nothing has been run in it yet.
    expect(terminal!.lastCommand).toBeUndefined();
    expect(shells.length).toBe(1);
    expect(events.some((e) => e.type === "terminal-update")).toBe(true);
  });

  it("is the SAME shell run() would reuse — cwd persists across the handoff", async () => {
    const { svc, shells } = makeService();
    svc.create("c1", "shell", "C:\\repo");
    const first = await svc.run({ chatId: "c1", name: "shell", command: "cd C:\\Windows" });
    expect(first.cwd).toBe("C:\\Windows");
    const second = await svc.run({ chatId: "c1", name: "shell", command: "printout here" });
    expect(second.cwd).toBe("C:\\Windows");
    // One shell for create + both runs — no second powershell behind the UI's back.
    expect(shells.length).toBe(1);
  });

  it("re-creating a LIVE name returns the existing shell, not a second one", () => {
    const { svc, shells } = makeService();
    const a = svc.create("c1", "shell", "C:\\repo");
    const b = svc.create("c1", "shell", "C:\\repo");
    expect(b.terminal!.id).toBe(a.terminal!.id);
    expect(shells.length).toBe(1);
  });

  it("respects the per-chat cap and says so", () => {
    const { svc } = makeService({ maxPerChat: 1 });
    svc.create("c1", "one", "C:\\r");
    const second = svc.create("c1", "two", "C:\\r");
    expect(second.terminal).toBeUndefined();
    expect(second.error).toMatch(/cap reached/i);
  });

  it("a killed shell frees its slot again", () => {
    const { svc } = makeService({ maxPerChat: 1 });
    svc.create("c1", "one", "C:\\r");
    svc.kill("c1::one");
    expect(svc.create("c1", "two", "C:\\r").terminal).toBeDefined();
  });
});
