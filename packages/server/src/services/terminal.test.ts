import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";
import type { WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import {
  TerminalService,
  type ShellProcess,
  type SpawnShell,
} from "./terminal.js";

/* ------------------------------------------------------------------ fixtures */

let bus: EventBus;
let events: WsServerEvent[];
/** Every service `makeService` built this test, so it can be torn down. */
let liveServices: TerminalService[] = [];

afterEach(async () => {
  for (const svc of liveServices) {
    await svc.flush().catch(() => {});
    svc.dispose();
  }
  liveServices = [];
});

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
 *   - `hang`          → swallow the next marker, i.e. a command that never
 *                       returns (a dev server) — what `background` exists for
 * When a write contains the service's sentinel marker, it echoes the marker line
 * `<marker>|<exit>|<ok>|<cwd>` (exactly what TerminalService parses).
 */
class FakeShell extends EventEmitter implements ShellProcess {
  cwd: string;
  killed = false;
  /** Set by tests that exercise pid-based behaviour (tree-kill, attribution). */
  pid?: number;
  private hanging = false;
  private seenMarker = "";
  private pendingExit: number | null = null;
  private pendingOk = "True";

  /** The marker of the most recent command — lets a test replay a swallowed one. */
  lastMarker(): string {
    return this.seenMarker;
  }
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
      if (line === "hang") {
        this.hanging = true;
        continue;
      }
      // `serve TEXT` — prints TEXT and then never returns, i.e. a dev server
      // announcing its port and settling in.
      const serve = line.match(/^serve\s+(.+)$/);
      if (serve) {
        this.hanging = true;
        this.stdout.emit("data", Buffer.from(serve[1] + "\n"));
        continue;
      }
      const marker = line.match(/CMTERM[A-Za-z0-9_-]+/);
      if (marker) {
        this.seenMarker = marker[0];
        // A command that never returns never reaches its probe, so the marker
        // for it never prints. Swallow exactly one to model that.
        if (this.hanging) {
          this.hanging = false;
          continue;
        }
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

function makeService(
  over: {
    maxPerChat?: number;
    spawn?: SpawnShell;
    killTree?: (pid: number) => void;
    store?: Store;
    retentionMs?: number;
    now?: () => number;
  } = {},
) {
  let n = 0;
  const { spawn, shells } = over.spawn
    ? { spawn: over.spawn, shells: [] as FakeShell[] }
    : fakeSpawn();
  const svc = new TerminalService({
    bus,
    maxPerChat: over.maxPerChat,
    store: over.store,
    retentionMs: over.retentionMs,
    deps: {
      spawn,
      genId: () => `t${++n}`,
      now: over.now ?? (() => 1000),
      killTree: over.killTree,
    },
  });
  // Tracked so `afterEach` can stop the write-behind timer. Left running, it
  // keeps writing into the temp dir the next `rm` is trying to delete — which
  // surfaces as a bare ENOTEMPTY with no hint of where it came from.
  liveServices.push(svc);
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

/* --------------------------------------------------- background + teardown */

describe("TerminalService — background commands", () => {
  it("returns immediately for a command that never finishes", async () => {
    const { svc } = makeService();
    const res = await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve listening on 47820",
      cwd: "C:\\repo",
      background: true,
    });
    expect(res.backgrounded).toBe(true);
    expect(res.error).toBeUndefined();
    // The shell is still held by the command — that is the whole point.
    expect(svc.listChat("c1")[0].background?.command).toBe("serve listening on 47820");
  });

  it("keeps streaming that command's output into the tail", async () => {
    const { svc } = makeService();
    await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve listening on 47820",
      cwd: "C:\\repo",
      background: true,
    });
    const tail = await svc.tail("c1", "server");
    expect(tail.found).toBe(true);
    expect(tail.output).toContain("listening on 47820");
  });

  it("tail reports a name that was never opened", async () => {
    const { svc } = makeService();
    expect(await svc.tail("c1", "nope")).toEqual({ output: "", found: false });
  });

  it("refuses a second command on a shell a background one holds", async () => {
    const { svc } = makeService();
    await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve up",
      cwd: "C:\\repo",
      background: true,
    });
    // Queueing behind a dev server would hang until the 10-minute timeout, so
    // this has to come back NOW, naming the occupied shell.
    const res = await svc.run({
      chatId: "c1",
      name: "server",
      command: "printout hi",
      cwd: "C:\\repo",
    });
    expect(res.error).toMatch(/busy running a background command/i);
    expect(res.error).toContain("serve up");
  });

  it("refuses a command that was already QUEUED when the background one started", async () => {
    const { svc } = makeService();
    // Both calls are made before either has written anything, so the second
    // passes the pre-queue check and only finds the shell held after the gate.
    // Falling through to exec here would hang it behind the server for the full
    // 10-minute timeout — the very thing this feature exists to avoid.
    const [, second] = await Promise.all([
      svc.run({
        chatId: "c1",
        name: "server",
        command: "serve up",
        cwd: "C:\\repo",
        background: true,
      }),
      svc.run({ chatId: "c1", name: "server", command: "printout hi", cwd: "C:\\repo" }),
    ]);
    expect(second.error).toMatch(/busy running a background command/i);
  });

  it("frees the shell when the background command finally exits", async () => {
    const { svc, shells } = makeService();
    await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve up",
      cwd: "C:\\repo",
      background: true,
    });
    // The real marker lands late — when the server is stopped. Replay it.
    const marker = shells[0].lastMarker();
    shells[0].stdout.emit("data", Buffer.from(`${marker}|0|True|C:\\repo\n`));
    await new Promise((r) => setImmediate(r));

    expect(svc.listChat("c1")[0].background).toBeUndefined();
    const res = await svc.run({
      chatId: "c1",
      name: "server",
      command: "printout hi",
      cwd: "C:\\repo",
    });
    expect(res.output).toBe("hi");
  });

  it("a foreground run is unaffected (no background flag, no early return)", async () => {
    const { svc } = makeService();
    const res = await svc.run({
      chatId: "c1",
      name: "main",
      command: "printout hello",
      cwd: "C:\\repo",
    });
    expect(res.backgrounded).toBeUndefined();
    expect(res.output).toBe("hello");
  });
});

describe("TerminalService — kill reaps the whole tree", () => {
  it("tree-kills by pid, not just the shell", () => {
    const killed: number[] = [];
    const { svc, shells } = makeService({ killTree: (pid) => killed.push(pid) });
    svc.create("c1", "server", "C:\\repo");
    shells[0].pid = 4242;

    svc.kill("c1::server");
    // Without this the shell dies and the dev server it started keeps the port.
    expect(killed).toEqual([4242]);
    expect(shells[0].killed).toBe(true);
  });

  it("still kills a shell that never got a pid", () => {
    const killed: number[] = [];
    const { svc, shells } = makeService({ killTree: (pid) => killed.push(pid) });
    svc.create("c1", "server", "C:\\repo");
    svc.kill("c1::server");
    expect(killed).toEqual([]);
    expect(shells[0].killed).toBe(true);
  });

  it("dispose tree-kills every shell", () => {
    const killed: number[] = [];
    const { svc, shells } = makeService({ killTree: (pid) => killed.push(pid) });
    svc.create("c1", "a", "C:\\repo");
    svc.create("c2", "b", "C:\\repo");
    shells[0].pid = 11;
    shells[1].pid = 22;
    svc.dispose();
    expect(killed.sort((a, b) => a - b)).toEqual([11, 22]);
  });
});

describe("TerminalService — livePids", () => {
  it("reports live shells with their chat, and drops the dead", () => {
    const { svc, shells } = makeService();
    svc.create("c1", "server", "C:\\repo");
    svc.create("c2", "build", "C:\\repo");
    shells[0].pid = 100;
    shells[1].pid = 200;

    expect(svc.livePids()).toEqual([
      { chatId: "c1", name: "server", terminalId: "c1::server", pid: 100 },
      { chatId: "c2", name: "build", terminalId: "c2::build", pid: 200 },
    ]);

    shells[1].kill();
    expect(svc.livePids().map((p) => p.pid)).toEqual([100]);
  });

  it("omits a shell with no pid — there is nothing to attribute through", () => {
    const { svc } = makeService();
    svc.create("c1", "server", "C:\\repo");
    expect(svc.livePids()).toEqual([]);
  });
});

/* ------------------------------------------------- durability + retention */

describe("TerminalService — durable roster and transcripts", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-term-"));
    store = new Store(dir);
    await store.init();
  });
  afterEach(async () => {
    // Stop the write-behind timers BEFORE removing the dir they write into —
    // hooks unwind innermost-first, so this cannot be left to the file-level one.
    for (const svc of liveServices) {
      await svc.flush().catch(() => {});
      svc.dispose();
    }
    liveServices = [];
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the row and the transcript, and outlives the process that ran it", async () => {
    const { svc } = makeService({ store });
    await svc.run({
      chatId: "c1",
      projectId: "p1",
      origin: "agent",
      name: "build",
      command: "printout compiled 3 files",
      cwd: "C:\\repo",
    });
    await svc.flush();

    const [rec] = await store.listTerminalRecords();
    expect(rec).toMatchObject({
      id: "c1::build",
      chatId: "c1",
      projectId: "p1",
      origin: "agent",
      name: "build",
      lastCommand: "printout compiled 3 files",
    });
    expect(await store.readTerminalLines(rec!.logId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: "command", chunk: "printout compiled 3 files" }),
        expect.objectContaining({ stream: "stdout", chunk: "compiled 3 files" }),
      ]),
    );

    // A brand-new service (as after a restart) adopts the row as archived, and
    // the transcript is still readable even though the shell is long gone.
    const { svc: restarted } = makeService({ store });
    await restarted.reconcile();
    const listed = restarted.catalog({ scope: "chat", chatId: "c1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "build", status: "exited", archived: true });
    const back = await restarted.scrollback("c1::build");
    expect(back.map((l) => l.chunk)).toContain("compiled 3 files");
  });

  it("keeps the transcript when a shell is killed, and drops it on purge", async () => {
    const { svc } = makeService({ store });
    await svc.run({ chatId: "c1", name: "build", command: "printout hi", cwd: "C:\\repo" });
    await svc.flush();

    svc.kill("c1::build");
    await new Promise((r) => setImmediate(r));
    expect(svc.catalog({ scope: "chat", chatId: "c1" })[0]).toMatchObject({
      archived: true,
    });
    expect((await svc.scrollback("c1::build")).map((l) => l.chunk)).toContain("hi");

    await svc.purge("c1::build");
    expect(svc.catalog({ scope: "chat", chatId: "c1" })).toEqual([]);
    expect(await store.listTerminalRecords()).toEqual([]);
  });

  it("re-opening an archived name continues the SAME transcript", async () => {
    const { svc } = makeService({ store });
    await svc.run({ chatId: "c1", name: "build", command: "printout before", cwd: "C:\\repo" });
    await svc.flush();
    svc.kill("c1::build");
    await new Promise((r) => setImmediate(r));

    await svc.run({ chatId: "c1", name: "build", command: "printout after", cwd: "C:\\repo" });
    await svc.flush();

    const [rec] = await store.listTerminalRecords();
    const chunks = (await store.readTerminalLines(rec!.logId)).map((l) => l.chunk);
    expect(chunks).toContain("before");
    expect(chunks).toContain("after");
  });

  it("the sweep prunes aged output and drops rows nothing is left of", async () => {
    let clock = 1_000;
    const { svc } = makeService({
      store,
      retentionMs: 60_000,
      now: () => clock,
    });
    await svc.run({ chatId: "c1", name: "build", command: "printout old line", cwd: "C:\\repo" });
    await svc.flush();
    svc.kill("c1::build");
    await new Promise((r) => setImmediate(r));

    // Inside the window: nothing goes.
    clock = 30_000;
    expect(await svc.sweep(clock)).toMatchObject({ dropped: 0 });
    expect(svc.catalog({ scope: "all" })).toHaveLength(1);

    // Past it: the row and its transcript go together.
    clock = 200_000;
    expect((await svc.sweep(clock)).dropped).toBe(1);
    expect(svc.catalog({ scope: "all" })).toEqual([]);
    expect(await store.listTerminalRecords()).toEqual([]);
  });

  it("a LIVE shell is never swept out from under its owner", async () => {
    let clock = 1_000;
    const { svc } = makeService({ store, retentionMs: 60_000, now: () => clock });
    await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve listening",
      cwd: "C:\\repo",
      background: true,
    });
    await svc.flush();

    clock = 10_000_000;
    await svc.sweep(clock);
    expect(svc.catalog({ scope: "all" }).map((t) => t.status)).toEqual(["live"]);
  });

  it("catalog and tail apply the shared filters", async () => {
    const { svc } = makeService({ store });
    await svc.run({
      chatId: "c1",
      projectId: "p1",
      name: "build",
      command: "printout compiled\nprinterr warning: deprecated",
      cwd: "C:\\repo",
    });
    await svc.run({
      chatId: "c2",
      projectId: "p2",
      name: "test",
      command: "printout tested",
      cwd: "C:\\other",
    });

    expect(svc.catalog({ scope: "chat", chatId: "c1" }).map((t) => t.name)).toEqual(["build"]);
    expect(svc.catalog({ scope: "project", projectId: "p2" }).map((t) => t.name)).toEqual([
      "test",
    ]);
    expect(svc.catalog({ scope: "all" })).toHaveLength(2);
    expect(svc.catalog({ scope: "all", q: "other" }).map((t) => t.name)).toEqual(["test"]);

    // stderr-only is the filter that matters: "did it print an error" shouldn't
    // cost a turn of reading 50 lines of build chatter.
    const errs = await svc.tail("c1", "build", 50, { stream: "stderr" });
    expect(errs.output).toBe("warning: deprecated");
    const grepped = await svc.tail("c1", "build", 50, { q: "compil" });
    expect(grepped.output).toBe("compiled");
  });

  it("orders by the query, newest-first by default", async () => {
    let clock = 1_000;
    const { svc } = makeService({ now: () => clock });
    await svc.run({ chatId: "c1", name: "zebra", command: "printout a", cwd: "C:\\repo" });
    clock = 2_000;
    await svc.run({ chatId: "c1", name: "alpha", command: "printout b", cwd: "C:\\repo" });

    expect(svc.catalog({ scope: "all" }).map((t) => t.name)).toEqual(["alpha", "zebra"]);
    expect(svc.catalog({ scope: "all", sort: "name" }).map((t) => t.name)).toEqual([
      "alpha",
      "zebra",
    ]);
    expect(
      svc.catalog({ scope: "all", sort: "recent", order: "asc" }).map((t) => t.name),
    ).toEqual(["zebra", "alpha"]);
  });

  it("`active` is narrower than live — an idle shell is not doing anything", async () => {
    const { svc } = makeService();
    // Finished: live, but idle. This is the row that made the old live-count
    // badge useless, and the reason the facet exists.
    await svc.run({ chatId: "c1", name: "build", command: "printout done", cwd: "C:\\repo" });
    await svc.run({
      chatId: "c1",
      name: "server",
      command: "serve forever",
      cwd: "C:\\repo",
      background: true,
    });

    expect(svc.catalog({ scope: "all" })).toHaveLength(2);
    expect(svc.catalog({ scope: "all", active: true }).map((t) => t.name)).toEqual(["server"]);
    expect(svc.catalog({ scope: "all", active: false }).map((t) => t.name)).toEqual(["build"]);
  });

  it("filters archived rows and origin", async () => {
    const { svc } = makeService({ store });
    await svc.run({ chatId: "c1", name: "build", command: "printout x", cwd: "C:\\repo" });
    await svc.run({
      chatId: "c1",
      name: "typed",
      command: "printout y",
      cwd: "C:\\repo",
      origin: "ui",
    });
    svc.kill("c1::build");
    // `flush()` is the barrier: the kill's archive write is fire-and-forget.
    await svc.flush();

    expect(svc.catalog({ scope: "all", archived: true }).map((t) => t.name)).toEqual(["build"]);
    expect(svc.catalog({ scope: "all", archived: false }).map((t) => t.name)).toEqual(["typed"]);
    expect(svc.catalog({ scope: "all", origin: "ui" }).map((t) => t.name)).toEqual(["typed"]);
    expect(svc.catalog({ scope: "all", origin: "agent" }).map((t) => t.name)).toEqual(["build"]);
  });

  it("returns nothing for a facet terminals can't answer, rather than everything", () => {
    const { svc } = makeService();
    svc.create("c1", "shell", "C:\\repo");
    expect(svc.catalog({ scope: "all" })).toHaveLength(1);
    expect(svc.catalog({ scope: "all", unmerged: true })).toEqual([]);
  });

  it("kills the live shells the query selects, and keeps their transcripts", async () => {
    const { svc, shells } = makeService({ store });
    await svc.run({
      chatId: "c1",
      projectId: "p1",
      name: "server",
      command: "printout listening on 4319",
      cwd: "C:\\repo",
    });
    await svc.run({
      chatId: "c2",
      projectId: "p2",
      name: "other",
      command: "printout untouched",
      cwd: "C:\\other",
    });

    await svc.flush();
    const { killed, ids } = svc.killMatching({ scope: "chat", chatId: "c1" });
    expect(killed).toBe(1);
    expect(ids).toEqual(["c1::server"]);
    expect(shells[0]!.killed).toBe(true);
    // The other chat's shell is untouched: a scoped kill that reached past its
    // scope would be the whole hazard of having this verb at all.
    expect(svc.catalog({ scope: "chat", chatId: "c2" }).map((t) => t.status)).toEqual(["live"]);

    // Reaping is about the PROCESS. The row survives as archived and its output
    // is still readable — "close the shell" and "forget what it said" stay
    // different asks.
    await svc.flush();
    const row = svc.catalog({ scope: "chat", chatId: "c1" })[0]!;
    expect(row).toMatchObject({ archived: true, status: "exited" });
    const lines = await svc.scrollback("c1::server");
    expect(lines.map((l) => l.chunk)).toContain("listening on 4319");
  });

  it("a narrow scope with no id kills NOTHING — never widens to the machine", async () => {
    const { svc } = makeService();
    await svc.run({ chatId: "c1", name: "server", command: "printout up", cwd: "C:\\repo" });
    expect(svc.killMatching({ scope: "chat" })).toEqual({ killed: 0, ids: [] });
    expect(svc.catalog({ scope: "all" }).map((t) => t.status)).toEqual(["live"]);
  });

  it("skips rows with no process behind them", async () => {
    const { svc } = makeService({ store });
    await svc.run({ chatId: "c1", name: "build", command: "printout done", cwd: "C:\\repo" });
    svc.kill("c1::build");
    await svc.flush();
    expect(svc.killMatching({ scope: "all" })).toEqual({ killed: 0, ids: [] });
  });
});
