/**
 * manager-mcp — INTEGRATION tests.
 *
 * The sibling `manager-mcp.test.ts` proves each tool's contract against narrow
 * FAKES (a scripted broker / an in-memory memory / a stub terminal runner). This
 * file wires the tools to the REAL backing services exactly as
 * `SessionBroker.buildOptions` does, so the end-to-end path an agent actually
 * exercises is proven WITHOUT an LLM:
 *
 *   - `wait`          — its `setTimeout` is torn down on both abort AND normal
 *                       completion (no leaked timer → a stalled poll can't strand).
 *   - `wait_for_chat` — resolves off a REAL `SessionBroker`'s live `chat-status`
 *                       stream when a (fake-SDK) session goes idle; unknown chatId
 *                       is an informative error through the real `broker.has`.
 *   - `terminal`      — two sequential commands to the same name share cwd via a
 *                       REAL `TerminalService`; `killChat` tears the shell down.
 *   - memory tools    — `remember`→`recall`→`forget` round-trip a REAL
 *                       `MemoryService` on disk AND the broker's start-of-session
 *                       injection (`buildOptions` → `buildInjection`) reflects the
 *                       tool's write, then clears after `forget`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { win32 as pathWin32 } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Chat, WsServerEvent } from "@cm/shared";
import { EventBus } from "../../bus.js";
import { Store } from "../../store/index.js";
import { SessionBroker, type QueryFn } from "../session-broker.js";
import { TerminalService, type ShellProcess, type SpawnShell } from "../terminal.js";
import { MemoryService } from "../memory.js";
import {
  createManagerTools,
  type ManagerMcpBroker,
} from "./manager-mcp.js";

/* ------------------------------------------------------------------ fixtures */

function resultText(res: CallToolResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

/** A never-registered broker for the tool tests that don't exercise the broker. */
const nullBroker: ManagerMcpBroker = { has: () => false, getStatus: () => undefined };

function chatFor(id: string, projectId = "p1"): Chat {
  return {
    id,
    projectId,
    title: "Untitled",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 1,
  };
}

/* -------------------------------------------------- wait: timer hygiene */

describe("manager-mcp integration — wait timer hygiene (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms exactly one timer and clears it synchronously on abort", async () => {
    const bus = new EventBus();
    const ac = new AbortController();
    const { wait } = createManagerTools({
      chatId: "c1",
      bus,
      broker: nullBroker,
      signal: ac.signal,
    });

    // A 100s wait would outlive any test if the timer leaked.
    const p = wait.handler({ seconds: 100, reason: "CI" }, {});
    expect(vi.getTimerCount()).toBe(1); // the sleep timer is armed

    ac.abort();
    // AbortController dispatches synchronously → finish() runs its cleanups now.
    expect(vi.getTimerCount()).toBe(0); // torn down, no leaked timer

    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });

  it("clears its timer on normal completion", async () => {
    const bus = new EventBus();
    const { wait } = createManagerTools({ chatId: "c1", bus, broker: nullBroker });

    const p = wait.handler({ seconds: 2, reason: undefined }, {});
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(resultText(res)).toContain("Waited 2s");
    expect(vi.getTimerCount()).toBe(0); // no dangling timer after it resolves
  });
});

/* -------------------------------------------------- wait_for_chat: real broker */

/** A fake SDK `query` whose single turn BLOCKS on `gate` before it finishes, so a
 *  session can be observed in `running` and then released to `idle`. */
function gatedFakeQuery(gate: Promise<void>): QueryFn {
  return ({ prompt }) => {
    async function* gen(): AsyncGenerator<unknown, void> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "sess-int",
        model: "claude-test",
        tools: [],
        mcp_servers: [],
        permissionMode: "default",
      };
      for await (const _um of prompt as AsyncIterable<unknown>) {
        void _um;
        await gate;
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          total_cost_usd: 0,
          result: "ok",
        };
      }
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {};
    g.setPermissionMode = async () => {};
    g.setModel = async () => {};
    g.setMaxThinkingTokens = async () => {};
    return g as unknown as ReturnType<QueryFn>;
  };
}

describe("manager-mcp integration — wait_for_chat over a real SessionBroker", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let broker: SessionBroker | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mcp-int-wfc-"));
    store = new Store(dir);
    await store.init();
    bus = new EventBus();
    broker = undefined;
  });
  afterEach(async () => {
    await broker?.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("resolves when the target chat transitions to idle on the live bus", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let idc = 0;
    let clock = 1000;
    broker = new SessionBroker({
      store,
      bus,
      deps: { query: gatedFakeQuery(gate), genId: () => `id-${++idc}`, now: () => ++clock },
    });
    await store.saveChat(chatFor("target"));
    broker.create(chatFor("target"));

    // Drive the target into `running` and hold it there behind the gate.
    const runningP = broker.waitFor("target", "running");
    await broker.sendMessage("target", "go");
    await runningP;
    expect(broker.getStatus("target")).toBe("running");

    // A DIFFERENT chat waits on the target through the real broker + bus.
    const { waitForChat } = createManagerTools({ chatId: "waiter", bus, broker });
    const toolP = waitForChat.handler({ chatId: "target", timeoutSeconds: 5 }, {});

    // Release the target: result → onTurnEnd → chat-status "idle" fans out.
    release();
    const res = await toolP;

    expect(resultText(res)).toContain('Chat target reached state "idle"');
    expect(resultText(res)).toContain('"timedOut":false');
  });

  it("returns an informative error for an unknown chatId through broker.has", async () => {
    let idc = 0;
    let clock = 1000;
    broker = new SessionBroker({
      store,
      bus,
      deps: { query: gatedFakeQuery(Promise.resolve()), genId: () => `id-${++idc}`, now: () => ++clock },
    });
    const { waitForChat } = createManagerTools({ chatId: "waiter", bus, broker });
    const res = await waitForChat.handler({ chatId: "ghost", timeoutSeconds: 1 }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown chatId "ghost"');
  });
});

/* -------------------------------------------------- terminal: real TerminalService */

/**
 * A minimal scripted PowerShell stand-in (mirrors terminal.test.ts's FakeShell):
 *   - `cd X` updates the persisted cwd
 *   - `printout TEXT` emits TEXT on stdout
 *   - a line containing the sentinel marker echoes `<marker>|0|True|<cwd>`
 */
class FakeShell extends EventEmitter implements ShellProcess {
  cwd: string;
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { write: (c: string) => void };

  constructor(cwd: string) {
    super();
    this.cwd = cwd;
    this.stdin = { write: (c) => this.handle(c) };
  }

  private handle(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const cd = line.match(/^cd\s+(.+)$/);
      if (cd) {
        this.cwd = pathWin32.resolve(this.cwd, cd[1]!.trim());
        continue;
      }
      const out = line.match(/^printout\s+(.+)$/);
      if (out) {
        this.stdout.emit("data", Buffer.from(out[1]! + "\n"));
        continue;
      }
      const marker = line.match(/CMTERM[A-Za-z0-9_-]+/);
      if (marker) {
        this.stdout.emit("data", Buffer.from(`${marker[0]}|0|True|${this.cwd}\n`));
      }
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.emit("exit", 0);
  }
}

describe("manager-mcp integration — terminal over a real TerminalService", () => {
  let bus: EventBus;
  let events: WsServerEvent[];
  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
  });

  it("persists cwd across two calls to the same name, then killChat tears it down", async () => {
    const shells: FakeShell[] = [];
    let n = 0;
    const spawn: SpawnShell = (cwd) => {
      const s = new FakeShell(cwd);
      shells.push(s);
      return s;
    };
    const svc = new TerminalService({
      bus,
      deps: { spawn, genId: () => `t${++n}`, now: () => 1000 },
    });

    // Bind the runner exactly as SessionBroker does (chat + default cwd baked in).
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: nullBroker,
      terminals: { run: (a) => svc.run({ chatId: "c1", cwd: "C:\\start", ...a }) },
    });

    const r1 = await terminal.handler(
      { name: "build", command: "cd C:\\Windows", timeoutMs: undefined },
      {},
    );
    expect(r1.isError).toBeFalsy();
    expect(resultText(r1)).toContain("cwd=C:\\Windows");

    // Second command to the SAME name reuses the one shell — cwd persisted.
    const r2 = await terminal.handler(
      { name: "build", command: "printout here", timeoutMs: undefined },
      {},
    );
    expect(resultText(r2)).toContain("cwd=C:\\Windows");
    expect(resultText(r2)).toContain("here");
    expect(shells.length).toBe(1);

    // Teardown (chat delete / dispose) kills the shell, forgets it, and fans out
    // a terminal-closed event so open UIs drop the read-only mirror.
    svc.killChat("c1");
    expect(shells[0]!.killed).toBe(true);
    expect(svc.listChat("c1").length).toBe(0);
    expect(
      events.some((e) => e.type === "terminal-closed" && e.chatId === "c1"),
    ).toBe(true);
  });
});

/* -------------------------------------------------- memory: real MemoryService */

/** A capturing fake `query` that records each turn's Options for injection asserts. */
function capturingFakeQuery(): { fn: QueryFn; options: Record<string, unknown>[] } {
  const options: Record<string, unknown>[] = [];
  const fn: QueryFn = ({ prompt, options: o }) => {
    options.push(o as unknown as Record<string, unknown>);
    async function* gen(): AsyncGenerator<unknown, void> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "sess-mem",
        model: "claude-test",
        tools: [],
        mcp_servers: [],
        permissionMode: "default",
      };
      for await (const _um of prompt as AsyncIterable<unknown>) {
        void _um;
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          total_cost_usd: 0,
          result: "ok",
        };
      }
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {};
    g.setPermissionMode = async () => {};
    g.setModel = async () => {};
    g.setMaxThinkingTokens = async () => {};
    return g as unknown as ReturnType<QueryFn>;
  };
  return { fn, options };
}

describe("manager-mcp integration — memory tools over a real MemoryService", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let events: WsServerEvent[];
  let memory: MemoryService;
  let broker: SessionBroker | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-mcp-int-mem-"));
    store = new Store(dir);
    await store.init();
    bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    let clock = 1000;
    memory = new MemoryService({ store, bus, now: () => ++clock });
    broker = undefined;
  });
  afterEach(async () => {
    await broker?.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("remember→recall→forget round-trips on disk AND drives the broker start-injection", async () => {
    const { fn, options } = capturingFakeQuery();
    let idc = 0;
    let clock = 1000;
    broker = new SessionBroker({
      store,
      bus,
      memory,
      deps: { query: fn, genId: () => `id-${++idc}`, now: () => ++clock },
    });

    // Bind the memory runner to project "p1", exactly as buildOptions does.
    const { remember, recall, forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker,
      memory: {
        remember: (input) => memory.write("p1", input),
        recall: (query) => memory.recall("p1", query),
        forget: (name) => memory.delete("p1", name),
      },
    });

    // (1) remember → a real file + a memory-update event.
    const rem = await remember.handler(
      {
        name: "mcp-smoke",
        description: "deterministic integration marker",
        type: "project",
        body: "BODY-DETAIL that must not leak into the bounded injection",
      },
      {},
    );
    expect(rem.isError).toBeFalsy();
    expect(resultText(rem)).toContain("mcp-smoke");
    expect(
      events.some((e) => e.type === "memory-update" && e.memory.name === "mcp-smoke"),
    ).toBe(true);
    expect((await memory.list("p1")).map((m) => m.name)).toEqual(["mcp-smoke"]);

    // (2) recall (query) returns the FULL body; recall (no query) lists the index.
    const hit = await recall.handler({ query: "smoke" }, {});
    expect(resultText(hit)).toContain("BODY-DETAIL");
    const idx = await recall.handler({ query: undefined }, {});
    expect(resultText(idx)).toContain("[mcp-smoke](mcp-smoke.md)");

    // (3) the broker's start-of-session injection reflects the tool's write —
    //     this is the exact buildInjection buildOptions appends to systemPrompt.
    await store.saveChat(chatFor("c1", "p1"));
    broker.create(chatFor("c1", "p1"));
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = options[0] as { systemPrompt?: { append?: string } };
    expect(opts.systemPrompt?.append).toBeDefined();
    const append = opts.systemPrompt!.append!;
    expect(append).toContain("Project memory");
    expect(append).toContain("mcp-smoke");
    expect(append).toContain("deterministic integration marker");
    // Bounded — the body is never injected wholesale.
    expect(append).not.toContain("BODY-DETAIL");

    // (4) forget removes it (event + on disk) and the injection goes empty.
    const gone = await forget.handler({ name: "mcp-smoke" }, {});
    expect(gone.isError).toBeFalsy();
    expect(resultText(gone)).toContain("Forgot");
    expect(
      events.some((e) => e.type === "memory-deleted" && e.name === "mcp-smoke"),
    ).toBe(true);
    expect(await memory.list("p1")).toHaveLength(0);
    expect(await memory.buildInjection("p1")).toBeNull();
  });
});
