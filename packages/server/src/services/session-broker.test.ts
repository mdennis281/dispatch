import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { WsServerEvent, Chat, Project } from "@dispatch/shared";
import {
  SessionBroker,
  EFFORT_THINKING_TOKENS,
  type QueryFn,
} from "./session-broker.js";
import { MemoryService } from "./memory.js";
import { ProjectConfigService } from "./project-config.js";

/* ------------------------------------------------------------------ fixtures */

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let brokers: SessionBroker[];
/** Extra temp dirs (e.g. managed-repo `.dispatch/` roots) to clean up. */
let tempDirs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-broker-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  brokers = [];
  tempDirs = [];
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
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
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
    applyFlagSettings: Record<string, unknown>[];
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
/** A tool_result whose content carries an inline base64 image block (the shape
 *  a Claude-in-Chrome screenshot / any image-returning MCP produces). */
function toolResultImageMsg(
  toolUseId: string,
  data: string,
  mediaType = "image/png",
  extraText = "screenshot captured",
) {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "sess-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: false,
          content: [
            { type: "text", text: extraText },
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
          ],
        },
      ],
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
/** A subagent's partial stream event — tagged with the spawning Task id. The
 *  broker must NOT forward these as top-level `message-chunk`s (they'd clobber
 *  the single main-loop stream slot). */
function subStreamStart(parentToolUseId = "toolu_sub1") {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    uuid: "se-sub-start",
    session_id: "sess-1",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
  };
}
function subStreamTextDelta(text: string, parentToolUseId = "toolu_sub1") {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    uuid: "se-sub-text",
    session_id: "sess-1",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}
/** A subagent's finalized assistant message (nested under a Task tool_use). */
function subAssistantText(text: string, parentToolUseId = "toolu_sub1") {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    subagent_type: "Explore",
    uuid: "a-sub-uuid",
    session_id: "sess-1",
    message: { role: "assistant", content: [{ type: "text", text }] },
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

function makeFakeQuery(
  perTurn: PerTurn,
  sessionId = "sess-1",
  opts: { noFlagSettings?: boolean } = {},
) {
  const controllers: FakeCtl[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const ctl: FakeCtl = {
      canUseTool: (options as { canUseTool?: FakeCtl["canUseTool"] } | undefined)?.canUseTool,
      options: options as unknown as Record<string, unknown>,
      pushed: [],
      calls: {
        interrupt: 0,
        setPermissionMode: [],
        setModel: [],
        setMaxThinkingTokens: [],
        applyFlagSettings: [],
      },
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
    // Omitted on request, to stand in for a runtime that predates the control.
    if (!opts.noFlagSettings) {
      g.applyFlagSettings = async (settings: Record<string, unknown>) => {
        ctl.calls.applyFlagSettings.push(settings);
      };
    }
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

  it("interleaved subagent partials don't clobber the main-loop stream (no orphaned buffer)", async () => {
    // A subagent's `message_start` lands mid-stream, between the main loop's own
    // start and its finalize. Regression: honoring it overwrote the single stream
    // slot, so the main row finalized under a fresh id ≠ its chunk id — stranding
    // the buffer as a stuck ●●● StreamingRow (a duplicate of the finalized text).
    const { fn } = makeFakeQuery((text) => [
      streamStart(),
      streamTextDelta("Main "),
      subStreamStart(), // interleaved subagent partial — must be ignored
      subStreamTextDelta("subagent chatter"),
      streamTextDelta(text),
      subAssistantText("subagent done"), // subagent finalizes mid-turn
      assistantText(`Main ${text}`),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "reply");
    await idleP;

    // (a) only the MAIN loop's deltas are forwarded — subagent chatter is not.
    const chunks = events.filter(
      (e): e is Extract<WsServerEvent, { type: "message-chunk" }> => e.type === "message-chunk",
    );
    expect(chunks.map((c) => c.delta)).toEqual(["Main ", "reply"]);
    const chunkIds = new Set(chunks.map((c) => c.messageId));
    expect(chunkIds.size).toBe(1);

    // (b) the finalized MAIN row reuses that same streamed id (client prunes the
    // buffer in place — no orphaned StreamingRow), and both rows persist distinctly.
    const rows = await store.readMessages("c1");
    const asst = rows.filter((r) => r.kind === "assistant");
    const main = asst.find((r) => "text" in r && r.text === "Main reply");
    const sub = asst.find((r) => "text" in r && r.text === "subagent done");
    expect(main?.id).toBe([...chunkIds][0]);
    expect(sub).toBeDefined();
    expect(sub?.id).not.toBe(main?.id);
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

  it("folds per-question notes INTO the answer string (the only channel the CLI reads)", async () => {
    // The CLI tool reads `updatedInput.answers` and nothing else, so notes that
    // rode their own field would be silently dropped — the user would watch the
    // model ignore instructions it never received.
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
      return [assistantText("ok"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "ask");
    const reqId = await reqP;

    broker.answerQuestion(reqId, {
      answers: [
        {
          questionIndex: 0,
          optionId: "TypeScript",
          answer: "TypeScript",
          notes: "strict mode, no any",
        },
        // A question with no notes keeps its bare value.
        { questionIndex: 1, optionId: "US", answer: "US" },
      ],
    });
    await idleP;

    expect(permResult).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: {
          "Which language do you prefer?":
            "TypeScript — additional instructions: strict mode, no any",
          "Which region should I deploy to?": "US",
        },
      },
    });
  });

  it("carries notes on the single-question shape too", async () => {
    const input = {
      questions: [
        {
          question: "Ship it?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    let permResult: unknown;
    const { fn } = makeFakeQuery(async (_text, ctl) => {
      permResult = await ctl.canUseTool!("AskUserQuestion", input, {});
      return [assistantText("ok"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const reqP = nextPermissionId();
    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "ask");
    const reqId = await reqP;

    broker.answerQuestion(reqId, {
      optionId: "Yes",
      answer: "Yes",
      notes: "but tag it first",
    });
    await idleP;

    expect(permResult).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "Ship it?": "Yes — additional instructions: but tag it first" },
      },
    });
    // The persisted row's summary shows the note too, so the card doesn't lie
    // about what was sent.
    const rows = await store.readMessages("c1");
    const perm = rows.find((r) => r.kind === "permission");
    expect(perm && "message" in perm ? perm.message : "").toBe(
      "Yes — additional instructions: but tag it first",
    );
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
    // The live effort lever is the flag-settings layer, NOT a thinking budget.
    expect(ctl.calls.applyFlagSettings).toContainEqual({ effortLevel: "max" });
    expect(ctl.calls.setMaxThinkingTokens).toHaveLength(0);
    expect(ctl.calls.interrupt).toBe(1);

    gate.resolve();
    await broker.waitFor("c1", "idle");
    expect(broker.getSession("c1")?.effort).toBe("max");
  });

  it("starts the query at the chat's effort as a level, not a thinking budget", async () => {
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

    const ctl = controllers[0]!;
    expect(ctl.options?.effort).toBe("medium");
    expect(ctl.options?.thinking).toBeUndefined();

    gate.resolve();
    await broker.waitFor("c1", "idle");
  });

  it("falls back to the thinking budget when the runtime has no flag-settings control", async () => {
    const gate = deferred();
    const { fn, controllers } = makeFakeQuery(
      async () => {
        await gate.promise;
        return [assistantText("x"), resultMsg()];
      },
      "sess-1",
      { noFlagSettings: true },
    );
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    await broker.sendMessage("c1", "go");
    await until(() => controllers.length === 1);

    await broker.setEffort("c1", "max");
    const ctl = controllers[0]!;
    await until(() => ctl.calls.setMaxThinkingTokens.length > 0);
    expect(ctl.calls.setMaxThinkingTokens).toContain(EFFORT_THINKING_TOKENS.max);

    gate.resolve();
    await broker.waitFor("c1", "idle");
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

describe("SessionBroker — tool_result images (screenshot-to-UI)", () => {
  // A 1x1 transparent PNG, base64 — stand-in for a screenshot an MCP returns.
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("persists a tool_result image to the chat assets + emits a render event with an ImageRef", async () => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("mcp__claude-in-chrome__computer", { action: "screenshot" }, "tool-1"),
      toolResultImageMsg("tool-1", PNG_1PX),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "take a screenshot");
    await idleP;

    // A `chat-message` render event carrying the tool_result row with an ImageRef.
    const resultEvt = events.find(
      (e): e is Extract<WsServerEvent, { type: "chat-message" }> =>
        e.type === "chat-message" &&
        e.chatId === "c1" &&
        e.message.kind === "tool_result",
    );
    expect(resultEvt).toBeDefined();
    const row = resultEvt!.message;
    if (row.kind !== "tool_result") throw new Error("expected tool_result row");
    expect(row.images).toBeDefined();
    expect(row.images).toHaveLength(1);
    const ref = row.images![0]!;
    expect(ref.mimeType).toBe("image/png");
    expect(ref.path.startsWith("assets/")).toBe(true);

    // The bytes were actually written to the assets store and round-trip.
    const name = ref.path.split("/").pop()!;
    const buf = await store.readChatAsset("c1", name);
    expect(buf).not.toBeNull();
    expect(buf!.equals(Buffer.from(PNG_1PX, "base64"))).toBe(true);

    // The bulky base64 is stripped from the persisted content (lightweight ref).
    const stripped = JSON.stringify(row.content);
    expect(stripped).not.toContain(PNG_1PX);
    expect(stripped).toContain("assets/");

    // The persisted transcript row also carries the ImageRef (survives reload).
    const rows = await store.readMessages("c1");
    const persisted = rows.find((r) => r.kind === "tool_result");
    expect(persisted && "images" in persisted ? persisted.images?.length : 0).toBe(1);
  });

  it.each([
    [
      "a direct Codex MCP image block",
      [{ type: "image", data: PNG_1PX, mimeType: "image/png" }],
    ],
    [
      "a Codex CallToolResult serialized into text",
      [{ type: "text", text: JSON.stringify({ content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }] }) }],
    ],
  ])("persists %s instead of displaying its base64", async (_label, content) => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("mcp__sim__sim_render", { format: "png" }, "tool-1"),
      toolResultMsg("tool-1", content),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "render the scene");
    await idleP;

    const rows = await store.readMessages("c1");
    const row = rows.find((r) => r.kind === "tool_result");
    if (!row || row.kind !== "tool_result") throw new Error("expected tool_result row");
    expect(row.images).toHaveLength(1);
    expect(row.images![0]!.mimeType).toBe("image/png");
    expect(JSON.stringify(row.content)).not.toContain(PNG_1PX);
  });

  it("leaves an image-free tool_result untouched (no images key)", async () => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("Bash", { command: "ls" }, "tool-1"),
      toolResultMsg("tool-1", "file-a\nfile-b"),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "list");
    await idleP;

    const rows = await store.readMessages("c1");
    const row = rows.find((r) => r.kind === "tool_result");
    expect(row && "images" in row ? row.images : undefined).toBeUndefined();
  });
});

describe("SessionBroker — subagent nesting", () => {
  // A subagent (spawned via the Task tool) tags every message it emits with the
  // spawning tool_use id (`parent_tool_use_id`) + its own `subagent_type`.
  function subAssistant(text: string, parentId: string, subagentType: string) {
    return {
      type: "assistant",
      parent_tool_use_id: parentId,
      subagent_type: subagentType,
      uuid: "sa-uuid",
      session_id: "sess-1",
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  }
  function subToolUse(
    name: string,
    input: Record<string, unknown>,
    id: string,
    parentId: string,
    subagentType: string,
  ) {
    return {
      type: "assistant",
      parent_tool_use_id: parentId,
      subagent_type: subagentType,
      uuid: "st-uuid",
      session_id: "sess-1",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    };
  }
  function subToolResult(
    toolUseId: string,
    content: unknown,
    parentId: string,
    subagentType: string,
  ) {
    return {
      type: "user",
      parent_tool_use_id: parentId,
      subagent_type: subagentType,
      session_id: "sess-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: false }],
      },
    };
  }

  it("tags subagent rows with parentToolUseId + subagentType and routes them to the spawning Task", async () => {
    const { fn } = makeFakeQuery((_text) => [
      // The in-chat agent spawns a subagent via the Task tool (top-level).
      toolUseMsg("Task", { subagent_type: "code-reviewer", description: "Review the diff" }, "task-1"),
      // The subagent's own transcript — every row tagged with parent_tool_use_id "task-1".
      subAssistant("Looking at the changes…", "task-1", "code-reviewer"),
      subToolUse("Read", { file_path: "a.ts" }, "sub-tool-1", "task-1", "code-reviewer"),
      subToolResult("sub-tool-1", "file contents", "task-1", "code-reviewer"),
      // The Task tool's own result closes the subagent (top-level, parent null).
      toolResultMsg("task-1", "Review complete."),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "review it");
    await idleP;

    const rows = await store.readMessages("c1");

    // The spawning Task tool_use is a ROOT (no parent) — the nest anchor.
    const task = rows.find((r) => r.kind === "tool_use" && r.name === "Task");
    expect(task && "parentToolUseId" in task ? task.parentToolUseId : "x").toBeFalsy();
    const taskId = task && "toolUseId" in task ? task.toolUseId : "";
    expect(taskId).toBe("task-1");

    // The subagent's assistant row is tagged with the parent + its type.
    const subAsst = rows.find(
      (r) => r.kind === "assistant" && r.text === "Looking at the changes…",
    );
    expect(subAsst && "parentToolUseId" in subAsst ? subAsst.parentToolUseId : null).toBe("task-1");
    expect(subAsst && "subagentType" in subAsst ? subAsst.subagentType : null).toBe("code-reviewer");

    // The subagent's tool_use + tool_result carry the same nesting key.
    const subTool = rows.find((r) => r.kind === "tool_use" && r.name === "Read");
    expect(subTool && "parentToolUseId" in subTool ? subTool.parentToolUseId : null).toBe("task-1");
    expect(subTool && "subagentType" in subTool ? subTool.subagentType : null).toBe("code-reviewer");
    const subRes = rows.find(
      (r) => r.kind === "tool_result" && r.toolUseId === "sub-tool-1",
    );
    expect(subRes && "parentToolUseId" in subRes ? subRes.parentToolUseId : null).toBe("task-1");
    expect(subRes && "subagentType" in subRes ? subRes.subagentType : null).toBe("code-reviewer");

    // The Task's own result is a ROOT (parent null) — it belongs to the parent turn.
    const taskResult = rows.find(
      (r) => r.kind === "tool_result" && r.toolUseId === "task-1",
    );
    expect(taskResult && "parentToolUseId" in taskResult ? taskResult.parentToolUseId : "x").toBeFalsy();

    // Grouping (the client's nest): every row whose parentToolUseId === the Task id
    // is one subagent group; the Task tool_use itself + its result are roots.
    const grouped = rows.filter(
      (r) => "parentToolUseId" in r && r.parentToolUseId === taskId,
    );
    expect(grouped.map((r) => r.kind)).toEqual(["assistant", "tool_use", "tool_result"]);
  });

  it("leaves a top-level (non-subagent) tool_use with a null parentToolUseId", async () => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("Bash", { command: "ls" }, "tool-1"),
      toolResultMsg("tool-1", "ok"),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "list");
    await idleP;

    const rows = await store.readMessages("c1");
    const tool = rows.find((r) => r.kind === "tool_use");
    // A plain tool never nests: its parentToolUseId is null (falsy) so it's a root.
    expect(tool && "parentToolUseId" in tool ? tool.parentToolUseId : "x").toBeFalsy();
    const res = rows.find((r) => r.kind === "tool_result");
    expect(res && "subagentType" in res ? res.subagentType : undefined).toBeUndefined();
  });

  it("persists a background task's settle notification as a task_status row", async () => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("Agent", { subagent_type: "Explore", description: "look around" }, "task-1"),
      // The async spawn answers immediately with a launch ack…
      toolResultMsg("task-1", "Async agent launched. agentId: a730258b58505d274"),
      // …and the only word on how it actually went arrives later, out of band.
      {
        type: "system",
        subtype: "task_notification",
        task_id: "a730258b58505d274",
        tool_use_id: "task-1",
        status: "completed",
        output_file: "/tmp/out.jsonl",
        summary: "Mapped the zone system.",
        usage: { total_tokens: 4200, tool_uses: 7, duration_ms: 91000 },
        session_id: "sess-1",
      },
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "explore");
    await idleP;

    const rows = await store.readMessages("c1");
    const row = rows.find((r) => r.kind === "task_status");
    expect(row).toMatchObject({
      kind: "task_status",
      taskId: "a730258b58505d274",
      toolUseId: "task-1",
      status: "completed",
      summary: "Mapped the zone system.",
      totalTokens: 4200,
      toolUses: 7,
      durationMs: 91000,
    });
  });

  it("keeps a failed/stopped verdict as itself and tolerates a missing tool_use_id", async () => {
    const { fn } = makeFakeQuery((_t) => [
      toolUseMsg("Agent", { subagent_type: "Explore" }, "task-1"),
      toolResultMsg("task-1", "Async agent launched. agentId: zzz999888"),
      {
        type: "system",
        subtype: "task_notification",
        task_id: "zzz999888",
        status: "stopped",
        output_file: "/tmp/out.jsonl",
        summary: "Stopped by the user.",
        session_id: "sess-1",
      },
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "explore");
    await idleP;

    const row = (await store.readMessages("c1")).find((r) => r.kind === "task_status");
    expect(row).toMatchObject({ taskId: "zzz999888", status: "stopped" });
    expect(row && "toolUseId" in row ? row.toolUseId : undefined).toBeUndefined();
  });
});

describe("SessionBroker — project memory injection", () => {
  /** Build a broker wired to a MemoryService (kept out of the shared makeBroker). */
  function makeMemoryBroker(fn: QueryFn, memory: MemoryService): SessionBroker {
    let idc = 0;
    let clock = 1000;
    const broker = new SessionBroker({
      store,
      bus,
      memory,
      deps: { query: fn, genId: () => `id-${++idc}`, now: () => ++clock },
    });
    brokers.push(broker);
    return broker;
  }

  it("injects the project's memory index (index + descriptions) into the system prompt append", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const memory = new MemoryService({ store, bus });
    await memory.write("p1", {
      name: "deploy-runbook",
      description: "how we ship to prod",
      type: "project",
      body: "run pnpm ship, the bot merges",
    });
    const broker = makeMemoryBroker(fn, memory);
    await store.saveChat(chatFor("c1", "p1"));
    broker.create(chatFor("c1", "p1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as { systemPrompt?: { append?: string } };
    expect(opts.systemPrompt?.append).toBeDefined();
    const append = opts.systemPrompt!.append!;
    expect(append).toContain("Project memory");
    expect(append).toContain("deploy-runbook");
    expect(append).toContain("how we ship to prod");
    // Bounded — the full body is not injected.
    expect(append).not.toContain("the bot merges");
  });

  it("injects nothing for a project with no memories", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const memory = new MemoryService({ store, bus });
    const broker = makeMemoryBroker(fn, memory);
    await store.saveChat(chatFor("c1", "p1"));
    broker.create(chatFor("c1", "p1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    // No mode instructions + no memories → the append is JUST the always-on
    // manager-tools directive, with no injected memory section.
    const opts = controllers[0]!.options as { systemPrompt?: { append?: string } };
    const append = opts.systemPrompt?.append ?? "";
    expect(append).toContain("# Manager tools");
    expect(append).not.toContain("Project memory");
  });

  it("auto-surfaces a relevant memory body into the SDK message (not the transcript), once per session", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const memory = new MemoryService({ store, bus });
    await memory.write("p1", {
      name: "deploy-runbook",
      description: "how we ship to prod",
      type: "project",
      body: "run pnpm ship, the bot merges",
    });
    const broker = makeMemoryBroker(fn, memory);
    await store.saveChat(chatFor("c1", "p1"));
    broker.create(chatFor("c1", "p1"));

    // Capture the visible transcript rows for user turns.
    const userTexts: string[] = [];
    const off = bus.subscribe((e) => {
      if (e.type === "chat-message" && e.message.kind === "user") userTexts.push(e.message.text ?? "");
    });

    const idle1 = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "how do we deploy to prod?");
    await idle1;

    // The SDK saw the full memory body prepended as a system-reminder…
    expect(controllers[0]!.pushed[0]).toContain("<system-reminder>");
    expect(controllers[0]!.pushed[0]).toContain("run pnpm ship, the bot merges");
    expect(controllers[0]!.pushed[0]).toContain("how do we deploy to prod?");
    // …but the visible transcript row is just the user's text.
    expect(userTexts[0]).toBe("how do we deploy to prod?");
    expect(userTexts[0]).not.toContain("system-reminder");

    // Same memory, second matching turn → not pushed again (once per session).
    const idle2 = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "remind me how to deploy?");
    await idle2;
    expect(controllers[0]!.pushed[1]).not.toContain("run pnpm ship, the bot merges");
    off();
  });
});

describe("SessionBroker — config-sourced instructions / agents / modes", () => {
  /** Write a file under a repo's `.dispatch/` dir (creating parents). */
  async function writeConfig(repoDir: string, rel: string, body: string): Promise<void> {
    const abs = join(repoDir, ".dispatch", rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }

  /**
   * Seed a managed repo with an instruction file + agent + mode, register a
   * project pointing at it, and return a loaded ProjectConfigService.
   */
  async function loadedConfig(): Promise<ProjectConfigService> {
    const repoDir = await mkdtemp(join(tmpdir(), "cm-broker-repo-"));
    tempDirs.push(repoDir);
    const project: Project = {
      id: "p1",
      name: "Seed",
      repoPath: repoDir,
      worktreeRoot: join(repoDir, "..", "wt"),
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await writeConfig(
      repoDir,
      "project.yaml",
      ["name: Configured", "instructions:", "  - file: instructions/house.md"].join("\n"),
    );
    await writeConfig(repoDir, "instructions/house.md", "Always run pnpm lint before shipping.");
    await writeConfig(
      repoDir,
      "agents/builder.md",
      ["---", "name: Builder", "permissionMode: plan", "---", "You are the CONFIG builder."].join("\n"),
    );
    // A second agent that pins its OWN reasoning effort — the frontmatter form
    // of `AgentDefinition.effort`.
    await writeConfig(
      repoDir,
      "agents/deep.md",
      ["---", "name: Deep", "effort: xhigh", "---", "Think hard."].join("\n"),
    );
    await writeConfig(repoDir, "modes/careful.yaml", ["name: Careful", "permissionMode: plan"].join("\n"));
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("p1");
    return svc;
  }

  function makeConfigBroker(fn: QueryFn, projectConfig: ProjectConfigService): SessionBroker {
    let idc = 0;
    let clock = 1000;
    const broker = new SessionBroker({
      store,
      bus,
      projectConfig,
      deps: { query: fn, genId: () => `id-${++idc}`, now: () => ++clock },
    });
    brokers.push(broker);
    return broker;
  }

  it("injects the project's authored instructions into the systemPrompt append", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const svc = await loadedConfig();
    const broker = makeConfigBroker(fn, svc);
    await store.saveChat(chatFor("c1", "p1"));
    broker.create(chatFor("c1", "p1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as { systemPrompt?: { append?: string } };
    const append = opts.systemPrompt?.append ?? "";
    expect(append).toContain("Project instructions");
    expect(append).toContain("Always run pnpm lint before shipping.");
  });

  it("uses config-sourced agent + mode, winning over identically-id'd .data entries", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const svc = await loadedConfig();
    // A colliding `.data` agent + mode with the SAME ids but different content —
    // the config (source of truth) must win.
    await store.saveAgent({
      id: "builder",
      name: "Store Builder",
      instructions: "You are the STORE builder.",
      permissionMode: "default",
      effort: undefined,
      scope: "global",
    });
    await store.saveMode({ id: "careful", name: "Store Careful", permissionMode: "acceptEdits", scope: "global" });

    const broker = makeConfigBroker(fn, svc);
    const chat = { ...chatFor("c1", "p1"), modeId: "careful", agentId: "builder" };
    await store.saveChat(chat);
    broker.create(chat);

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as {
      permissionMode?: string;
      agent?: string;
      agents?: Record<string, { prompt?: string; permissionMode?: string }>;
    };
    // Mode: the config "careful" (plan) wins over the store's acceptEdits.
    expect(opts.permissionMode).toBe("plan");
    // Agent: the config builder prompt wins over the store's.
    expect(opts.agent).toBe("builder");
    expect(opts.agents?.builder?.prompt).toBe("You are the CONFIG builder.");
    expect(opts.agents?.builder?.permissionMode).toBe("plan");
  });

  it("passes an agent's pinned effort to its AgentDefinition and onto its rows", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const svc = await loadedConfig();
    const broker = makeConfigBroker(fn, svc);
    const chat = { ...chatFor("c1", "p1"), agentId: "deep" };
    await store.saveChat(chat);
    broker.create(chat);

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as {
      effort?: string;
      agents?: Record<string, { effort?: string }>;
    };
    // The SESSION still runs at the chat's level — that is what an un-pinned
    // subagent inherits — while the agent itself is pinned higher.
    expect(opts.effort).toBe("medium");
    expect(opts.agents?.deep?.effort).toBe("xhigh");

    // …and the main loop's rows report the pinned level, not the chat's.
    const rows = await store.readMessages("c1");
    const asst = rows.find((r) => r.kind === "assistant");
    expect(asst && "effort" in asst ? asst.effort : undefined).toBe("xhigh");
  });

  it("leaves an agent without a pinned effort inheriting the chat's", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const svc = await loadedConfig();
    const broker = makeConfigBroker(fn, svc);
    const chat = { ...chatFor("c1", "p1"), agentId: "builder" };
    await store.saveChat(chat);
    broker.create(chat);

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as { agents?: Record<string, { effort?: string }> };
    expect(opts.agents?.builder?.effort).toBe("medium");
  });

  it("injects nothing for a project without a .dispatch/ config", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const svc = await loadedConfig();
    const broker = makeConfigBroker(fn, svc);
    // Chat on a DIFFERENT project that has no loaded config.
    await store.saveChat(chatFor("c2", "no-config"));
    broker.create(chatFor("c2", "no-config"));

    const idleP = broker.waitFor("c2", "idle");
    await broker.sendMessage("c2", "hi");
    await idleP;

    // The always-on manager-tools directive is still injected; only the
    // config-sourced instructions are absent for a project with no config.
    const opts = controllers[0]!.options as { systemPrompt?: { append?: string } };
    const append = opts.systemPrompt?.append ?? "";
    expect(append).toContain("# Manager tools");
    expect(append).not.toContain("Project instructions");
  });

  it("merges the config's external MCP servers into the session alongside 'manager'", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    // A managed repo whose `.dispatch/` declares an external MCP server.
    const repoDir = await mkdtemp(join(tmpdir(), "cm-broker-mcp-"));
    tempDirs.push(repoDir);
    const project: Project = {
      id: "pm",
      name: "Seed",
      repoPath: repoDir,
      worktreeRoot: join(repoDir, "..", "wt"),
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await writeConfig(
      repoDir,
      "project.yaml",
      [
        "name: Configured",
        "mcpServers:",
        "  - name: claude-in-chrome",
        "    transport: { type: sse, url: 'http://127.0.0.1:9999/sse' }",
      ].join("\n"),
    );
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("pm");
    const broker = makeConfigBroker(fn, svc);

    await store.saveChat(chatFor("c1", "pm"));
    // Pass a project record WITHOUT mcpServers so the only source of the external
    // server is the `.dispatch/` config (via projectConfig.getMcpServers).
    broker.create(chatFor("c1", "pm"), { ...project, mcpServers: undefined });

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as { mcpServers?: Record<string, unknown> };
    expect(opts.mcpServers).toBeDefined();
    // The in-process manager server is always present (never clobbered)…
    expect(opts.mcpServers!.manager).toBeDefined();
    // …and the config-declared external server passes through for the agent.
    expect(opts.mcpServers!["claude-in-chrome"]).toMatchObject({
      url: "http://127.0.0.1:9999/sse",
    });
  });

  it("materializes a `.dispatch/skills/` skill into the session cwd + enables skills:'all'", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const repoDir = await mkdtemp(join(tmpdir(), "cm-broker-skill-"));
    tempDirs.push(repoDir);
    const project: Project = {
      id: "ps",
      name: "Seed",
      repoPath: repoDir,
      worktreeRoot: join(repoDir, "..", "wt"),
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await writeConfig(repoDir, "project.yaml", "name: Configured");
    // A skill authored ONLY in `.dispatch/skills/` (the repo has no
    // `.claude/skills/<name>` of its own).
    await writeConfig(
      repoDir,
      "skills/sprite-gen/SKILL.md",
      ["---", "name: Sprite Gen", "description: make sprites", "---", "Do the sprites."].join("\n"),
    );
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("ps");
    const broker = makeConfigBroker(fn, svc);

    await store.saveChat(chatFor("c1", "ps"));
    broker.create(chatFor("c1", "ps"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    // The SDK is told to enable every discovered skill…
    const opts = controllers[0]!.options as { skills?: unknown; cwd?: string };
    expect(opts.skills).toBe("all");
    // …and the config skill was materialized into the effective `<cwd>/.claude/skills/`
    // so the SDK (settingSources project/local) discovers it.
    const materialized = join(repoDir, ".claude", "skills", "sprite-gen", "SKILL.md");
    expect(existsSync(materialized)).toBe(true);
    expect(await readFile(materialized, "utf8")).toContain("Do the sprites.");
  });

  it("materializes the manager's bundled skills even when the project authors none", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const repoDir = await mkdtemp(join(tmpdir(), "cm-broker-skill2-"));
    tempDirs.push(repoDir);
    const project: Project = {
      id: "pn",
      name: "Seed",
      repoPath: repoDir,
      worktreeRoot: join(repoDir, "..", "wt"),
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await writeConfig(repoDir, "project.yaml", "name: Configured");
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("pn");
    const broker = makeConfigBroker(fn, svc);

    await store.saveChat(chatFor("c1", "pn"));
    broker.create(chatFor("c1", "pn"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    // The manager ships its own skills (how MCP config works here, etc.), so a
    // project with no authored skills still gets them — and still enables skills.
    const opts = controllers[0]!.options as { skills?: unknown };
    expect(opts.skills).toBe("all");
    expect(existsSync(join(repoDir, ".claude", "skills", "mcp-setup", "SKILL.md"))).toBe(true);
  });

  it("never clobbers a repo's own `.claude/skills/<name>` with a bundled skill", async () => {
    const { fn } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const repoDir = await mkdtemp(join(tmpdir(), "cm-broker-skill3-"));
    tempDirs.push(repoDir);
    const project: Project = {
      id: "po",
      name: "Override",
      repoPath: repoDir,
      worktreeRoot: join(repoDir, "..", "wt"),
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await writeConfig(repoDir, "project.yaml", "name: Configured");

    // The repo ships its OWN mcp-setup skill — it must win over the bundled one,
    // and must survive session teardown (only dirs WE created are cleaned up).
    const own = join(repoDir, ".claude", "skills", "mcp-setup");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "# our own house rules", "utf8");

    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("po");
    const broker = makeConfigBroker(fn, svc);

    await store.saveChat(chatFor("c1", "po"));
    broker.create(chatFor("c1", "po"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    expect(await readFile(join(own, "SKILL.md"), "utf8")).toBe("# our own house rules");
  });
});

describe("SessionBroker — MCP passthrough", () => {
  it("merges a project's configured MCP servers into the session alongside 'manager'", async () => {
    const { fn, controllers } = makeFakeQuery((t) => [assistantText(t), resultMsg()]);
    const broker = makeBroker(fn);
    const project = {
      id: "p1",
      name: "Proj",
      repoPath: dir,
      worktreeRoot: dir,
      mcpServers: {
        "claude-in-chrome": { type: "sse", url: "http://127.0.0.1:9999/sse" },
      },
      subApps: [],
      createdAt: 1,
    };
    await store.saveProject(project);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"), project);

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "hi");
    await idleP;

    const opts = controllers[0]!.options as { mcpServers?: Record<string, unknown> };
    expect(opts.mcpServers).toBeDefined();
    // The in-process manager server is preserved (not clobbered)…
    expect(opts.mcpServers!.manager).toBeDefined();
    // …and the project's MCP server passes through for the agent to use.
    expect(opts.mcpServers!["claude-in-chrome"]).toMatchObject({
      url: "http://127.0.0.1:9999/sse",
    });
  });
});

describe("SessionBroker — effort on the transcript", () => {
  /** The observer hook the broker registers for every tool (no matcher). */
  function effortHook(ctl: FakeCtl) {
    const pre = (
      ctl.options?.hooks as
        | { PreToolUse?: { matcher?: string; hooks: ((i: unknown) => Promise<unknown>)[] }[] }
        | undefined
    )?.PreToolUse;
    const entry = pre?.find((e) => e.matcher === undefined);
    return entry!.hooks[0]!;
  }

  it("stamps the chat's effort on main-loop and subagent rows", async () => {
    const { fn } = makeFakeQuery((_t) => [
      assistantText("thinking about it"),
      toolUseMsg("Bash", { command: "ls" }, "tool-1"),
      toolResultMsg("tool-1", "ok"),
      resultMsg(),
    ]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const rows = await store.readMessages("c1");
    const asst = rows.find((r) => r.kind === "assistant");
    const tool = rows.find((r) => r.kind === "tool_use");
    expect(asst && "effort" in asst ? asst.effort : undefined).toBe("medium");
    expect(tool && "effort" in tool ? tool.effort : undefined).toBe("medium");
  });

  it("prefers the level a hook observed, per thread", async () => {
    // Turn 1 establishes the threads (a subagent tool call under Task "task-1");
    // the hooks then report what each thread REALLY ran at; turn 2's rows must
    // carry those levels rather than the chat's pick.
    const { fn, controllers } = makeFakeQuery((text) =>
      text === "go"
        ? [
            toolUseMsg("Task", { subagent_type: "Explore", description: "look" }, "task-1"),
            {
              type: "assistant",
              parent_tool_use_id: "task-1",
              subagent_type: "Explore",
              session_id: "sess-1",
              message: {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "sub-tool-1", name: "Read", input: { file_path: "a" } },
                ],
              },
            },
            resultMsg(),
          ]
        : [
            assistantText("main again"),
            {
              type: "assistant",
              parent_tool_use_id: "task-1",
              subagent_type: "Explore",
              session_id: "sess-1",
              message: { role: "assistant", content: [{ type: "text", text: "sub again" }] },
            },
            resultMsg(),
          ],
    );
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    let idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const hook = effortHook(controllers[0]!);
    // Main loop: no agent_id. Subagent: agent_id + the tool call it is gating.
    await hook({ tool_use_id: "tool-x", effort: { level: "xhigh" } });
    await hook({ agent_id: "a1", tool_use_id: "sub-tool-1", effort: { level: "low" } });

    idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "again");
    await idleP;

    const rows = await store.readMessages("c1");
    const main = rows.filter((r) => r.kind === "assistant" && !r.parentToolUseId).pop();
    const sub = rows.filter((r) => r.kind === "assistant" && r.parentToolUseId === "task-1").pop();
    expect(main && "effort" in main ? main.effort : undefined).toBe("xhigh");
    expect(sub && "effort" in sub ? sub.effort : undefined).toBe("low");
  });

  it("ignores a hook it cannot attribute to a thread", async () => {
    const { fn, controllers } = makeFakeQuery((_t) => [assistantText("hi"), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    let idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    // A subagent call whose tool id we never saw: nothing to key it to, so the
    // main loop must NOT inherit it.
    const hook = effortHook(controllers[0]!);
    await hook({ agent_id: "a1", tool_use_id: "unknown-tool", effort: { level: "low" } });

    idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "again");
    await idleP;

    const rows = await store.readMessages("c1");
    const main = rows.filter((r) => r.kind === "assistant").pop();
    expect(main && "effort" in main ? main.effort : undefined).toBe("medium");
  });
});

describe("SessionBroker — the wrong-worktree guard", () => {
  /**
   * The cwd guard is the SECOND unmatched PreToolUse entry the broker registers
   * (the effort observer is the first). Both are unmatched because both have to
   * see every call, not just the ones they act on.
   */
  function cwdHook(ctl: FakeCtl) {
    const pre = (
      ctl.options?.hooks as
        | {
            PreToolUse?: {
              matcher?: string;
              hooks: ((i: unknown) => Promise<Record<string, unknown>>)[];
            }[];
          }
        | undefined
    )?.PreToolUse;
    const unmatched = pre!.filter((e) => e.matcher === undefined);
    return unmatched[unmatched.length - 1]!.hooks[0]!;
  }

  /** Two sibling worktrees on disk, as in the 2026-08-07 incident. */
  async function twoWorktrees(): Promise<{ home: string; other: string }> {
    const base = await mkdtemp(join(tmpdir(), "cm-wt-"));
    tempDirs.push(base);
    const home = join(base, "dispatch-config-subapps");
    const other = join(base, "agent-ae028addf8d56daf9");
    for (const wt of [home, other]) {
      await mkdir(wt, { recursive: true });
      // A linked worktree's `.git` is a FILE — what makes it its own root.
      await writeFile(join(wt, ".git"), `gitdir: ${join(base, ".bare", "worktrees", "x")}`);
    }
    return { home, other };
  }

  /** Spawn a subagent ("task-1") that makes one tool call, so threads correlate. */
  const spawnScript = (_t: string) => [
    toolUseMsg("Task", { subagent_type: "general-purpose", description: "work" }, "task-1"),
    {
      type: "assistant",
      parent_tool_use_id: "task-1",
      subagent_type: "general-purpose",
      session_id: "sess-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "sub-1", name: "Edit", input: { file_path: "a" } }],
      },
    },
    resultMsg(),
  ];

  it("denies a subagent's write into a sibling worktree, and names both", async () => {
    const { home, other } = await twoWorktrees();
    const { fn, controllers } = makeFakeQuery(spawnScript);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const hook = cwdHook(controllers[0]!);
    // The subagent's first call pins it to `home`…
    await hook({
      agent_id: "a1",
      tool_use_id: "sub-1",
      tool_name: "Edit",
      cwd: home,
      tool_input: { file_path: join(home, "package.json") },
    });
    // …then the session cwd moves under it and it writes into the other tree.
    const verdict = await hook({
      agent_id: "a1",
      tool_use_id: "sub-1",
      tool_name: "Edit",
      cwd: other,
      tool_input: { file_path: join(other, "RUNNING.md") },
    });

    const out = verdict.hookSpecificOutput as
      | { permissionDecision?: string; permissionDecisionReason?: string }
      | undefined;
    expect(out?.permissionDecision).toBe("deny");
    expect(out?.permissionDecisionReason).toContain(home);
    expect(out?.permissionDecisionReason).toContain(other);
    // …and the human is told, not just the model.
    expect(
      events.some(
        (e) => e.type === "notice" && e.text.includes("different worktree") && e.level === "warn",
      ),
    ).toBe(true);
  });

  it("lets the MAIN loop move between worktrees — that is its job", async () => {
    const { home, other } = await twoWorktrees();
    const { fn, controllers } = makeFakeQuery((_t) => [assistantText("hi"), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const hook = cwdHook(controllers[0]!);
    // No `agent_id` ⇒ the main loop. It commits one agent's branch, then another.
    for (const wt of [home, other]) {
      const verdict = await hook({
        tool_name: "Write",
        cwd: wt,
        tool_input: { file_path: join(wt, ".git-commit-msg.tmp") },
      });
      expect(verdict.hookSpecificOutput).toBeUndefined();
    }
  });

  it("allows a subagent to READ around another worktree", async () => {
    const { home, other } = await twoWorktrees();
    const { fn, controllers } = makeFakeQuery(spawnScript);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const hook = cwdHook(controllers[0]!);
    await hook({
      agent_id: "a1",
      tool_use_id: "sub-1",
      tool_name: "Edit",
      cwd: home,
      tool_input: { file_path: join(home, "a.ts") },
    });
    const verdict = await hook({
      agent_id: "a1",
      tool_use_id: "sub-1",
      tool_name: "Bash",
      cwd: other,
      tool_input: { command: "git log" },
    });
    expect(verdict.hookSpecificOutput).toBeUndefined();
  });

  it("ignores a call it can't place — a guard must never block on missing information", async () => {
    const { fn, controllers } = makeFakeQuery((_t) => [assistantText("hi"), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "go");
    await idleP;

    const hook = cwdHook(controllers[0]!);
    expect(await hook({ tool_name: "Edit", tool_input: {} })).toEqual({});
    expect(await hook({ cwd: join(tmpdir(), "nowhere") })).toEqual({});
  });
});

describe("SessionBroker — spawn_chat consent", () => {
  /** A live session, so an approval request has somewhere to land. */
  async function liveSession(): Promise<SessionBroker> {
    const { fn } = makeFakeQuery(() => [assistantText("hi"), resultMsg()]);
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));
    return broker;
  }

  it("asks the human by default — and a DENY is not consent", async () => {
    const broker = await liveSession();

    const reqP = nextPermissionId();
    const consentP = broker.consentToSpawn(
      "c1",
      { prompt: "audit the migrations", reason: "long job" },
      { id: "p1", name: "Dispatch" },
    );
    const reqId = await reqP;

    // It rides the ordinary permission channel: same card, same triage entry.
    expect(
      events.some((e) => e.type === "attention-add" && e.item.permissionRequestId === reqId),
    ).toBe(true);
    const req = events.find(
      (e): e is Extract<WsServerEvent, { type: "permission-request" }> =>
        e.type === "permission-request" && e.request.id === reqId,
    );
    expect(req?.request.title).toContain("Dispatch");
    // The brief the new chat would receive is ON the card — it's the one thing
    // worth reading before saying yes.
    expect(JSON.stringify(req?.request.input)).toContain("audit the migrations");

    broker.resolvePermission(reqId, { decision: "deny", message: "not now" });
    await expect(consentP).resolves.toEqual({
      approved: false,
      auto: false,
      message: "not now",
    });
  });

  it("skips the prompt only when the human's own setting says so", async () => {
    const broker = await liveSession();
    await store.saveSettings({ theme: "dark", spawnChat: { autoApprove: true } });

    const consent = await broker.consentToSpawn(
      "c1",
      { prompt: "go" },
      { id: "p1", name: "Dispatch" },
    );

    expect(consent).toEqual({ approved: true, auto: true });
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });

  it("lets a project's manifest insist on the prompt over a permissive setting", async () => {
    const broker = await liveSession();
    await store.saveSettings({ theme: "dark", spawnChat: { autoApprove: true } });
    (broker as unknown as { projectConfig?: unknown }).projectConfig = {
      getAgent: () => null,
      getMode: () => null,
      buildInstructionsInjection: () => null,
      getMcpServers: () => ({}),
      getSkills: () => [],
      getSpawnAutoApprove: () => false,
    };

    const reqP = nextPermissionId();
    const consentP = broker.consentToSpawn(
      "c1",
      { prompt: "go" },
      { id: "p1", name: "Dispatch" },
    );
    const reqId = await reqP;
    broker.resolvePermission(reqId, { decision: "allow" });

    await expect(consentP).resolves.toMatchObject({ approved: true, auto: false });
  });

  it("does not ALSO prompt at the canUseTool layer — one decision, one prompt", async () => {
    // The tool gates itself. A second generic prompt would ask twice for one
    // decision, and a deny there would skip the handler that returns the
    // "declined — don't retry" answer entirely.
    let verdict: unknown;
    const { fn } = makeFakeQuery(async (_t, ctl) => {
      verdict = await ctl.canUseTool!("mcp__manager__spawn_chat", { prompt: "go" }, {});
      return [assistantText("hi"), resultMsg()];
    });
    const broker = makeBroker(fn);
    await store.saveChat(chatFor("c1"));
    broker.create(chatFor("c1"));

    const idleP = broker.waitFor("c1", "idle");
    await broker.sendMessage("c1", "spawn one");
    await idleP;

    expect(verdict).toEqual({ behavior: "allow", updatedInput: { prompt: "go" } });
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });

  it("refuses rather than assuming consent when there's no live session to ask", async () => {
    const broker = await liveSession();

    await expect(
      broker.consentToSpawn("nobody", { prompt: "go" }, { id: "p1", name: "Dispatch" }),
    ).resolves.toMatchObject({ approved: false, auto: false });
  });
});
