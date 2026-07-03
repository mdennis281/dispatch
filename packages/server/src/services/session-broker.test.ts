import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { WsServerEvent, Chat } from "@cm/shared";
import {
  SessionBroker,
  EFFORT_THINKING_TOKENS,
  type QueryFn,
} from "./session-broker.js";

/* ------------------------------------------------------------------ fixtures */

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let brokers: SessionBroker[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-broker-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  brokers = [];
  bus.subscribe((e) => events.push(e));
});
afterEach(async () => {
  // Dispose every broker BEFORE removing the temp dir. A still-live session keeps
  // issuing fire-and-forget store writes (patchChat / appendMessage) that race
  // the rm below — surfacing as flaky ENOENT/EPERM/ENOTEMPTY and, before the bus
  // fix, a process-killing unhandled rejection. dispose() closes the inputs and
  // awaits each run loop; the retrying rm absorbs any last straggler on Windows.
  await Promise.all(brokers.map((b) => b.dispose().catch(() => {})));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

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

function makeBroker(fn: QueryFn, cap = 6): SessionBroker {
  let idc = 0;
  let clock = 1000;
  const broker = new SessionBroker({
    store,
    bus,
    maxActiveSessions: cap,
    deps: { query: fn, genId: () => `id-${++idc}`, now: () => ++clock },
  });
  brokers.push(broker);
  return broker;
}

/* --------------------------------------------------------- scripted fake SDK */

interface FakeCtl {
  canUseTool?: (
    n: string,
    i: Record<string, unknown>,
    o: Record<string, unknown>,
  ) => Promise<{ behavior: string; [k: string]: unknown }>;
  options?: Record<string, unknown>;
  pushed: string[];
  calls: {
    interrupt: number;
    setPermissionMode: string[];
    setModel: unknown[];
    setMaxThinkingTokens: unknown[];
  };
}

type PerTurn = (
  text: string,
  ctl: FakeCtl,
) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

function extractText(um: unknown): string {
  const content = (um as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b) => b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => (b as { text: string }).text)
      .join("");
  }
  return "";
}

function initMsg(sessionId: string, options?: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-test",
    apiKeySource: "none",
    tools: [],
    mcp_servers: [],
    permissionMode: options?.permissionMode ?? "default",
    uuid: "init-uuid",
  };
}
function assistantText(text: string) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "a-uuid",
    session_id: "sess-1",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}
function toolUseMsg(name: string, input: Record<string, unknown>, id = "tool-1") {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "t-uuid",
    session_id: "sess-1",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}
function toolResultMsg(toolUseId: string, content: unknown, isError = false) {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "sess-1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}
function streamStart() {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "se-start",
    session_id: "sess-1",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
  };
}
function streamTextDelta(text: string) {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "se-text",
    session_id: "sess-1",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}
function resultMsg(subtype = "success") {
  return {
    type: "result",
    subtype,
    is_error: false,
    num_turns: 1,
    result: "ok",
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: {},
    session_id: "sess-1",
    uuid: "r-uuid",
  };
}

function makeFakeQuery(perTurn: PerTurn, sessionId = "sess-1") {
  const controllers: FakeCtl[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const ctl: FakeCtl = {
      canUseTool: (options as { canUseTool?: FakeCtl["canUseTool"] } | undefined)?.canUseTool,
      options: options as unknown as Record<string, unknown>,
      pushed: [],
      calls: { interrupt: 0, setPermissionMode: [], setModel: [], setMaxThinkingTokens: [] },
    };
    controllers.push(ctl);
    async function* gen(): AsyncGenerator<unknown, void> {
      yield initMsg(sessionId, options as unknown as Record<string, unknown>);
      for await (const um of prompt as AsyncIterable<unknown>) {
        const text = extractText(um);
        ctl.pushed.push(text);
        const msgs = await perTurn(text, ctl);
        for (const msg of msgs) yield msg;
      }
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {
      ctl.calls.interrupt += 1;
    };
    g.setPermissionMode = async (m: string) => {
      ctl.calls.setPermissionMode.push(m);
    };
    g.setModel = async (m: unknown) => {
      ctl.calls.setModel.push(m);
    };
    g.setMaxThinkingTokens = async (n: unknown) => {
      ctl.calls.setMaxThinkingTokens.push(n);
    };
    g.setMcpPermissionModeOverride = async () => ({});
    return g as unknown as ReturnType<QueryFn>;
  };
  return { fn, controllers };
}

/* ----------------------------------------------------------------- utilities */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("until: condition never met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function nextPermissionId(): Promise<string> {
  return new Promise((resolve) => {
    const off = bus.on("permission-request", (e) => {
      off();
      resolve(e.request.id);
    });
  });
}

function waitForResults(chatId: string, n: number, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const off = bus.on("chat-message", (e) => {
      if (e.chatId === chatId && e.message.kind === "result") {
        count += 1;
        if (count >= n) {
          clearTimeout(t);
          off();
          resolve();
        }
      }
    });
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${n} results on ${chatId}`));
    }, ms);
  });
}

/* -------------------------------------------------------------------- tests */

describe("SessionBroker — turn lifecycle", () => {
  it("runs a turn (idle→running→idle), forwards + persists messages, captures sessionId", async () => {
    const { fn } = makeFakeQuery((text) => [assistantText(`echo:${text}`), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hello");
    await idleP;

    const statuses = events
      .filter((e): e is Extract<WsServerEvent, { type: "chat-status" }> => e.type === "chat-status")
      .filter((e) => e.chatId === "c1")
      .map((e) => e.status);
    expect(statuses).toContain("running");
    expect(statuses[statuses.length - 1]).toBe("idle");

    const rows = await store.readMessages("c1");
    expect(rows.map((r) => r.kind)).toEqual(["user", "system", "assistant", "result"]);
    const assistant = rows.find((r) => r.kind === "assistant");
    expect(assistant && "text" in assistant ? assistant.text : "").toBe("echo:hello");

    expect(broker.getSession("c1")?.sessionId).toBe("sess-1");
    expect(
      events.some((e) => e.type === "attention-add" && e.item.kind === "idle"),
    ).toBe(true);
  });

  it("stop() ends the session and emits a done AttentionItem", async () => {
    const { fn } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const doneP = broker.waitFor("c1", "done");
    await broker.stop("c1");
    await doneP;

    expect(broker.getStatus("c1")).toBe("done");
    expect(
      events.some((e) => e.type === "attention-add" && e.item.kind === "done"),
    ).toBe(true);
  });

  it("drop() forgets the session so a create→delete cycle can't leak it", async () => {
    const { fn } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));
    expect(broker.has("c1")).toBe(true);

    // stop() alone keeps the entry (rebind/resume relies on it); drop() removes it.
    await broker.stop("c1");
    expect(broker.has("c1")).toBe(true);
    expect(broker.drop("c1")).toBe(true);
    expect(broker.has("c1")).toBe(false);
    expect(broker.getSession("c1")).toBeUndefined();
    expect(broker.drop("c1")).toBe(false); // idempotent
  });
});

describe("SessionBroker — token streaming", () => {
  it("forwards stream_event deltas as message-chunk whose id matches the finalized assistant row", async () => {
    const { fn } = makeFakeQuery((text) => [
      streamStart(),
      streamTextDelta("echo:"),
      streamTextDelta(text),
      assistantText(`echo:${text}`),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    // (a) chunks published on channel 'text' with a single stable messageId.
    const chunks = events.filter(
      (e): e is Extract<WsServerEvent, { type: "message-chunk" }> => e.type === "message-chunk",
    );
    expect(chunks.map((c) => c.delta)).toEqual(["echo:", "hi"]);
    expect(chunks.every((c) => c.channel === "text")).toBe(true);
    const chunkIds = new Set(chunks.map((c) => c.messageId));
    expect(chunkIds.size).toBe(1);
    const streamedId = chunks[0]!.messageId;

    // (b) the finalized assistant chat-message uses that SAME id (client swaps
    // the streaming buffer for the persisted row in place, no duplicate).
    const rows = await store.readMessages("c1");
    const assistant = rows.find((r) => r.kind === "assistant");
    expect(assistant?.id).toBe(streamedId);
    expect(assistant && "text" in assistant ? assistant.text : "").toBe("echo:hi");
  });
});

describe("SessionBroker — permissions", () => {
  it("routes canUseTool to a permission-request, awaits, and resolves ALLOW", async () => {
    let permResult: unknown;
    const { fn } = makeFakeQuery(async (text, ctl) => {
      permResult = await ctl.canUseTool!(
        "Write",
        { file_path: "a.txt" },
        { title: "Write a.txt", displayName: "Write file" },
      );
      return [toolUseMsg("Write", { file_path: "a.txt" }), toolResultMsg("tool-1", "done"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "write");
    const reqId = await reqP;

    expect(broker.getStatus("c1")).toBe("awaiting-input");
    expect(
      events.some((e) => e.type === "attention-add" && e.item.kind === "permission"),
    ).toBe(true);

    const ok = broker.resolvePermission(reqId, {
      decision: "allow",
      updatedInput: { file_path: "b.txt" },
    });
    expect(ok).toBe(true);
    await idleP;

    expect(permResult).toEqual({ behavior: "allow", updatedInput: { file_path: "b.txt" } });
    expect(
      events.some((e) => e.type === "permission-resolved" && e.requestId === reqId),
    ).toBe(true);
    expect(events.some((e) => e.type === "attention-resolve")).toBe(true);

    const rows = await store.readMessages("c1");
    const perm = rows.find((r) => r.kind === "permission");
    expect(perm && "decision" in perm ? perm.decision : "").toBe("allow");
    // tool_use + tool_result surfaced to the transcript
    expect(rows.some((r) => r.kind === "tool_use")).toBe(true);
    expect(rows.some((r) => r.kind === "tool_result")).toBe(true);
  });

  it("resolves DENY with a message and unblocks the tool", async () => {
    let permResult: unknown;
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      permResult = await ctl.canUseTool!("Bash", { command: "rm -rf /" }, { title: "Run Bash" });
      return [assistantText("understood"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "danger");
    const reqId = await reqP;

    broker.resolvePermission(reqId, { decision: "deny", message: "Nope." });
    await idleP;

    expect(permResult).toEqual({ behavior: "deny", message: "Nope." });
  });

  it("categorizes AskUserQuestion as a 'question' attention item (not a permission)", async () => {
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      await ctl.canUseTool!(
        "AskUserQuestion",
        { question: "Which database should I use?", options: ["Postgres", "SQLite"] },
        {},
      );
      return [assistantText("ok"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "ask");
    const reqId = await reqP;

    const attn = events.find(
      (e): e is Extract<WsServerEvent, { type: "attention-add" }> =>
        e.type === "attention-add" && e.item.permissionRequestId === reqId,
    );
    expect(attn?.item.kind).toBe("question");
    expect(attn?.item.summary).toBe("Which database should I use?");
    // A real permission gate must NOT be miscreated for this request.
    expect(
      events.some(
        (e) =>
          e.type === "attention-add" &&
          e.item.permissionRequestId === reqId &&
          e.item.kind === "permission",
      ),
    ).toBe(false);

    broker.resolvePermission(reqId, { decision: "allow", updatedInput: { optionId: "Postgres" } });
    await idleP;
  });

  it("surfaces AskUserQuestion as a question card and feeds the answer back via canUseTool", async () => {
    // The real SDK nested input shape: { questions: [{ question, header, options, multiSelect }] }.
    const input = {
      questions: [
        {
          question: "Which language do you prefer?",
          header: "Language",
          options: [
            { label: "TypeScript", description: "Typed superset of JS." },
            { label: "JavaScript", description: "Dynamic scripting language." },
          ],
          multiSelect: false,
        },
      ],
    };
    let permResult: unknown;
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      // AskUserQuestion surfaces BOTH as a tool_use block AND via canUseTool
      // (verified live). The broker answers over canUseTool and must suppress
      // the redundant tool_use row.
      permResult = await ctl.canUseTool!("AskUserQuestion", input, {});
      return [
        toolUseMsg("AskUserQuestion", input, "aq-1"),
        assistantText("You chose TypeScript."),
        resultMsg(),
      ];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "ask");
    const reqId = await reqP;

    // (1) The QuestionCard-driving event: a permission-request carrying the tool
    //     name + the questions payload, plus a `question`-categorized attention item.
    const req = events.find(
      (e): e is Extract<WsServerEvent, { type: "permission-request" }> =>
        e.type === "permission-request" && e.request.id === reqId,
    );
    expect(req?.request.toolName).toBe("AskUserQuestion");
    expect(req?.request.input).toEqual(input);
    expect(
      events.some(
        (e) =>
          e.type === "attention-add" &&
          e.item.permissionRequestId === reqId &&
          e.item.kind === "question",
      ),
    ).toBe(true);

    // (2) answer-question resolves the blocked canUseTool with the answer merged
    //     into the tool input as `answers` (question text → chosen label) — the
    //     shape the CLI tool needs to hand the choice to the model.
    const ok = broker.answerQuestion(reqId, { optionId: "TypeScript", answer: "TypeScript" });
    expect(ok).toBe(true);
    await idleP;

    expect(permResult).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Which language do you prefer?": "TypeScript" },
      },
    });

    // The redundant AskUserQuestion tool_use row is suppressed (QuestionCard is
    // the sole surface); the resolved permission row records the allow + answer.
    const rows = await store.readMessages("c1");
    expect(rows.some((r) => r.kind === "tool_use")).toBe(false);
    const perm = rows.find((r) => r.kind === "permission");
    expect(perm && "decision" in perm ? perm.decision : "").toBe("allow");
    expect(perm && "toolName" in perm ? perm.toolName : "").toBe("AskUserQuestion");
    expect(perm && "message" in perm ? perm.message : "").toBe("TypeScript");
  });

  it("answers EVERY question of a multi-question AskUserQuestion (not just the first)", async () => {
    // The model can ask several question groups in one AskUserQuestion call.
    const input = {
      questions: [
        {
          question: "Which language do you prefer?",
          header: "Language",
          options: [{ label: "TypeScript" }, { label: "JavaScript" }],
          multiSelect: false,
        },
        {
          question: "Which region should I deploy to?",
          header: "Region",
          options: [{ label: "US" }, { label: "EU" }],
          multiSelect: false,
        },
      ],
    };
    let permResult: unknown;
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      permResult = await ctl.canUseTool!("AskUserQuestion", input, {});
      return [assistantText("Deploying TypeScript to US."), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "ask");
    const reqId = await reqP;

    // Answer BOTH questions, keyed by index.
    const ok = broker.answerQuestion(reqId, {
      answers: [
        { questionIndex: 0, optionId: "TypeScript", answer: "TypeScript" },
        { questionIndex: 1, optionId: "US", answer: "US" },
      ],
    });
    expect(ok).toBe(true);
    await idleP;

    // Every question's text maps to its chosen value — none dropped.
    expect(permResult).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: {
          "Which language do you prefer?": "TypeScript",
          "Which region should I deploy to?": "US",
        },
      },
    });

    // The resolved permission row summarizes both answers for the card.
    const rows = await store.readMessages("c1");
    const perm = rows.find((r) => r.kind === "permission");
    expect(perm && "message" in perm ? perm.message : "").toBe("Language: TypeScript · Region: US");
  });

  it("pendingPermissionSnapshot exposes open requests for reconnect re-materialization", async () => {
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      await ctl.canUseTool!("Write", { file_path: "a.txt" }, { title: "Write a.txt" });
      return [assistantText("ok"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    expect(broker.pendingPermissionSnapshot()).toHaveLength(0);

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "write");
    const reqId = await reqP;

    const snap = broker.pendingPermissionSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id: reqId, chatId: "c1", toolName: "Write" });

    // Once resolved it drops out of the snapshot (no longer pending).
    broker.resolvePermission(reqId, { decision: "allow" });
    await idleP;
    expect(broker.pendingPermissionSnapshot()).toHaveLength(0);
  });
});

describe("SessionBroker — steering & concurrency", () => {
  it("funnels multiple messages through one live session in FIFO order", async () => {
    const { fn, controllers } = makeFakeQuery((text) => [assistantText(text), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const resultsP = waitForResults("c1", 3);
    await broker.sendMessage("c1", "a");
    await broker.sendMessage("c1", "b");
    await broker.sendMessage("c1", "c");
    await resultsP;

    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.pushed).toEqual(["a", "b", "c"]);
  });

  it("caps active sessions and queues overflow, draining FIFO when a slot frees", async () => {
    const gate = deferred();
    const { fn, controllers } = makeFakeQuery(async () => {
      await gate.promise;
      return [assistantText("done"), resultMsg()];
    });
    const broker = makeBroker(fn, 2);
    for (const id of ["c1", "c2", "c3"]) {
      await store.saveChat(chatFor(id));
      broker.create(chatFor(id));
    }

    await broker.sendMessage("c1", "go");
    await broker.sendMessage("c2", "go");
    await broker.sendMessage("c3", "go");

    // Two queries start (both blocked on the gate); the third is parked.
    await until(() => controllers.length === 2);
    expect(broker.activeCount()).toBe(2);
    expect(broker.getStatus("c3")).toBe("queued");

    // Release: the two finish, freeing slots, and c3 is promoted + started.
    const c3running = broker.waitFor("c3", "running");
    gate.resolve();
    await c3running;
    await until(() => controllers.length === 3);

    await Promise.all(["c1", "c2", "c3"].map((id) => broker.waitFor(id, "idle").catch(() => {})));
    expect(broker.activeCount()).toBe(0);
  });
});

describe("SessionBroker — live controls", () => {
  it("applies setMode / setEffort / interrupt to the running query", async () => {
    const gate = deferred();
    const { fn, controllers } = makeFakeQuery(async () => {
      await gate.promise;
      return [assistantText("x"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    await broker.sendMessage("c1", "go");
    await until(() => controllers.length === 1);

    expect(await broker.setMode("c1", "plan")).toBe("plan");
    await broker.setEffort("c1", "max");
    expect(await broker.interrupt("c1")).toBe(true);

    const ctl = controllers[0]!;
    expect(ctl.calls.setPermissionMode).toContain("plan");
    expect(ctl.calls.setMaxThinkingTokens).toContain(EFFORT_THINKING_TOKENS.max);
    expect(ctl.calls.interrupt).toBe(1);

    gate.resolve();
    await broker.waitFor("c1", "idle");
    expect(broker.getSession("c1")?.effort).toBe("max");
  });
});

describe("SessionBroker — teardown hygiene", () => {
  it("stop() while awaiting a permission clears the card + attention item (deny)", async () => {
    let permResult: Promise<{ behavior: string }> | undefined;
    const { fn } = makeFakeQuery(async (_t, ctl) => {
      // Block the turn on a permission we never answer via resolvePermission.
      permResult = ctl.canUseTool!("Write", { file_path: "a.txt" }, { title: "Write a.txt" }) as Promise<{
        behavior: string;
      }>;
      await permResult;
      return [assistantText("ok"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    await broker.sendMessage("c1", "write");
    const reqId = await reqP;
    expect(broker.getStatus("c1")).toBe("awaiting-input");

    // Stop mid-permission: the promise must deny AND the UI state must clear.
    await broker.stop("c1");

    await expect(permResult).resolves.toMatchObject({ behavior: "deny" });
    expect(
      events.some(
        (e) => e.type === "permission-resolved" && e.requestId === reqId && e.decision === "deny",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "attention-resolve" && e.id === `att-perm-${reqId}`),
    ).toBe(true);
    // The now-cleared request can't be answered late (map was drained).
    expect(broker.resolvePermission(reqId, { decision: "allow" })).toBe(false);
  });

  it("dispose() does not emit a second 'done' for an already-finished session", async () => {
    const { fn } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const doneP = broker.waitFor("c1", "done");
    await broker.stop("c1");
    await doneP;

    const doneItems = () =>
      events.filter((e) => e.type === "attention-add" && e.item.kind === "done").length;
    expect(doneItems()).toBe(1);
    // dispose() iterates ALL sessions incl. the finished one — must not re-run onDone.
    await broker.dispose();
    expect(doneItems()).toBe(1);
  });
});
