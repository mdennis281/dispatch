import { describe, it, expect } from "vitest";
import { CodexSession, MANAGER_TOOL_TIMEOUT_SEC, isNotSteerable } from "./session.js";
import {
  ASK_USER_TIMEOUT_CAP_SECONDS,
  WAIT_CAP_SECONDS,
  WATCH_PR_DEFAULT_TIMEOUT_SECONDS,
} from "@dispatch/shared";
import type { CodexConnection, RpcFrame, ServerRequest } from "./rpc.js";
import type { HarnessEvent, HarnessSessionSpec } from "@dispatch/shared";

/**
 * A scripted stand-in for {@link CodexConnection}: records every call and lets
 * a test push notifications/requests back, so the whole session loop is
 * exercised without a process.
 */
function fakeConn() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const responses: { id: number | string; result?: unknown; error?: string }[] = [];
  const notifications = new Map<string, (f: RpcFrame) => void>();
  const requests = new Map<string, (r: ServerRequest) => void>();
  const replies = new Map<string, unknown>();
  const refusals = new Map<string, unknown[]>();

  const conn = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      const refusal = refusals.get(method)?.shift();
      if (refusal) throw refusal;
      const canned = replies.get(method);
      if (canned) return canned;
      if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
        return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      }
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
    onThread: (id: string, l: (f: RpcFrame) => void) => {
      notifications.set(id, l);
      return () => notifications.delete(id);
    },
    onRequest: (id: string, h: (r: ServerRequest) => void) => {
      requests.set(id, h);
      return () => requests.delete(id);
    },
    respond: (id: number | string, result: unknown) => responses.push({ id, result }),
    respondError: (id: number | string, error: string) => responses.push({ id, error }),
  } as unknown as CodexConnection;

  return {
    conn,
    calls,
    responses,
    reply: (method: string, value: unknown) => replies.set(method, value),
    /** Make the next call to `method` reject with `err` (queued, one per call). */
    refuse: (method: string, err: unknown) => refusals.set(method, [...(refusals.get(method) ?? []), err]),
    push: (method: string, params: Record<string, unknown>) => {
      const id = typeof params.threadId === "string" ? params.threadId : "thread-1";
      notifications.get(id)?.({ method, params });
    },
    request: (r: ServerRequest) => {
      const id = typeof r.params.threadId === "string" ? r.params.threadId : "thread-1";
      requests.get(id)?.(r);
    },
    /** Let queued microtasks run. */
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

function makeSession(overrides: Partial<HarnessSessionSpec> = {}) {
  const fake = fakeConn();
  let n = 0;
  const spec: HarnessSessionSpec = {
    permissionMode: "default",
    effort: "medium",
    systemPromptAppends: [],
    mcpServers: {},
    skills: [],
    cwd: "/repo",
    ...overrides,
  };
  const session = new CodexSession({
    spec,
    conn: fake.conn,
    release: () => {},
    genId: () => `id-${++n}`,
  });
  return { session, fake };
}

/** Drain up to `count` events, or stop when the stream ends. */
async function take(session: { events: AsyncIterable<HarnessEvent> }, count: number) {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe("CodexSession lifecycle", () => {
  it("spawns nothing until the first send", async () => {
    const { fake } = makeSession();
    await fake.tick();
    expect(fake.calls).toEqual([]);
  });

  it("opens a thread with the mapped posture and instructions, then starts a turn", async () => {
    const { session, fake } = makeSession({
      permissionMode: "plan",
      systemPromptAppends: ["# Manager tools", "# Workflow"],
    });
    session.send({ text: "hello" });
    await fake.tick();

    expect(fake.calls[0]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/repo",
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        developerInstructions: "# Manager tools\n\n# Workflow",
      },
    });
    expect(fake.calls[1]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
        effort: "medium",
      },
    });
  });

  it("emits init carrying the thread id the chat will resume from", async () => {
    const { session, fake } = makeSession();
    const events = take(session, 1);
    session.send({ text: "hi" });
    await fake.tick();
    expect(await events).toEqual([
      { type: "init", sessionId: "thread-1", model: "gpt-5.6-sol", permissionMode: "default" },
    ]);
  });

  it("resumes an existing thread instead of starting one", async () => {
    const { session, fake } = makeSession({ resumeSessionId: "old-thread" });
    session.send({ text: "carry on" });
    await fake.tick();
    expect(fake.calls[0]).toMatchObject({
      method: "thread/resume",
      params: { threadId: "old-thread" },
    });
  });

  it("forks when asked, through the requested turn", async () => {
    const { session, fake } = makeSession({
      resumeSessionId: "old-thread",
      fork: true,
      forkAtId: "turn-3",
    });
    session.send({ text: "branch here" });
    await fake.tick();
    expect(fake.calls[0]).toMatchObject({
      method: "thread/fork",
      params: { threadId: "old-thread", lastTurnId: "turn-3" },
    });
  });

  it("steers the running turn rather than starting a second one", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "first" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });

    session.send({ text: "actually, also this" });
    await fake.tick();
    expect(fake.calls.at(-1)).toMatchObject({
      method: "turn/steer",
      params: { expectedTurnId: "turn-1", input: [{ type: "text", text: "actually, also this" }] },
    });
  });

  it("starts a fresh turn once the previous one completed", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "first" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });

    session.send({ text: "second" });
    await fake.tick();
    expect(fake.calls.at(-1)).toMatchObject({ method: "turn/start" });
  });

  it("folds a spawned Codex child thread into a neutral Agent run", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "delegate this" });
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "init" });

    const spawn = {
      type: "collabAgentToolCall",
      id: "spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "thread-1",
      receiverThreadIds: ["child-1"],
      prompt: "Audit the renderer in detail",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentsStates: {},
    };
    fake.push("item/started", { threadId: "thread-1", turnId: "turn-1", item: spawn });
    fake.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { ...spawn, status: "completed", agentsStates: { "child-1": { status: "running" } } },
    });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "subAgentActivity",
        id: "activity-1",
        kind: "started",
        agentThreadId: "child-1",
        agentPath: "/root/audit_renderer",
      },
    });
    fake.push("item/completed", {
      threadId: "child-1",
      turnId: "child-turn",
      item: { type: "agentMessage", id: "child-msg", text: "I found the mismatch." },
    });
    fake.push("item/started", {
      threadId: "child-1",
      turnId: "child-turn",
      item: { type: "commandExecution", id: "child-cmd", command: "git status", cwd: "/repo" },
    });
    fake.push("item/completed", {
      threadId: "child-1",
      turnId: "child-turn",
      item: {
        type: "commandExecution",
        id: "child-cmd",
        command: "git status",
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "clean",
      },
    });
    fake.push("turn/completed", {
      threadId: "child-1",
      turn: { id: "child-turn", status: "completed", items: [] },
    });

    const events: HarnessEvent[] = [];
    for (let i = 0; i < 6; i++) events.push((await iterator.next()).value!);
    expect(events[0]).toMatchObject({
      type: "tool-use",
      toolUseId: "spawn-1",
      name: "Agent",
      input: { prompt: "Audit the renderer in detail" },
    });
    expect(events[1]).toMatchObject({
      type: "tool-result",
      toolUseId: "spawn-1",
      content: expect.stringContaining("agentId: child-1"),
    });
    expect(events[2]).toMatchObject({
      type: "assistant",
      id: "child-msg",
      parentToolUseId: "spawn-1",
      subagentType: "audit_renderer",
    });
    expect(events[3]).toMatchObject({
      type: "tool-use",
      toolUseId: "child-cmd",
      parentToolUseId: "spawn-1",
    });
    expect(events[4]).toMatchObject({
      type: "tool-result",
      toolUseId: "child-cmd",
      parentToolUseId: "spawn-1",
    });
    expect(events[5]).toMatchObject({
      type: "task-notification",
      taskId: "child-1",
      toolUseId: "spawn-1",
      status: "completed",
    });
  });

  it("does not subscribe the root thread as its own child", async () => {
    const { session, fake } = makeSession();
    const events = take(session, 3);
    session.send({ text: "coordinate agents" });
    await fake.tick();

    // A structured collaboration item suppresses the legacy activity marker;
    // the marker still reaches observeCollaboration, where it must not install
    // a child decoder over the root thread's own subscription.
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "collabAgentToolCall",
        id: "wait-1",
        tool: "wait",
        status: "inProgress",
        receiverThreadIds: [],
        agentsStates: {},
      },
    });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "subAgentActivity",
        id: "root-activity",
        kind: "started",
        agentThreadId: "thread-1",
        agentPath: "/root",
      },
    });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "cmd-1", command: "git status", cwd: "/repo" },
    });
    fake.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "git status",
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "clean",
      },
    });

    const observed = await events;
    expect(observed).toEqual([
      expect.objectContaining({ type: "init", sessionId: "thread-1" }),
      expect.objectContaining({ type: "tool-use", toolUseId: "cmd-1" }),
      expect.objectContaining({ type: "tool-result", toolUseId: "cmd-1", content: "clean" }),
    ]);
    expect(observed[1]).not.toHaveProperty("parentToolUseId");
    expect(observed[2]).not.toHaveProperty("parentToolUseId");
  });

  it("folds activity-only Codex children into a neutral Agent run", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "delegate this" });
    const iterator = session.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "init" });

    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "subAgentActivity",
        id: "activity-1",
        kind: "started",
        agentThreadId: "child-legacy",
        agentPath: "/root/implement_modular_auth",
      },
    });
    fake.push("item/completed", {
      threadId: "child-legacy",
      turnId: "child-turn",
      item: { type: "agentMessage", id: "child-msg", text: "Working on auth." },
    });
    fake.push("turn/completed", {
      threadId: "child-legacy",
      turn: { id: "child-turn", status: "completed", items: [] },
    });

    expect((await iterator.next()).value).toMatchObject({
      type: "tool-use",
      toolUseId: "codex-agent:child-legacy",
      name: "Agent",
      input: { agentType: "implement_modular_auth" },
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "assistant",
      parentToolUseId: "codex-agent:child-legacy",
      subagentType: "implement_modular_auth",
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "task-notification",
      taskId: "child-legacy",
      toolUseId: "codex-agent:child-legacy",
      status: "completed",
    });
  });

  it("attaches images as the right input kind", async () => {
    const { session, fake } = makeSession();
    session.send({
      text: "look",
      images: [
        { id: "a", path: "/tmp/shot.png" },
        { id: "b", path: "https://example.com/x.png" },
      ],
    });
    await fake.tick();
    // Images lead, then the prompt — so the model has seen them by the time it
    // reads the instruction that refers to them.
    expect(fake.calls[1]!.params.input).toEqual([
      { type: "localImage", path: "/tmp/shot.png" },
      { type: "image", url: "https://example.com/x.png" },
      { type: "text", text: "look", text_elements: [] },
    ]);
  });

  it("projects MCP servers, manager auth, and context limits into thread config", async () => {
    const { session, fake } = makeSession({
      contextTokenLimit: 180_000,
      mcpServers: {
        files: { type: "stdio", command: "node", args: ["server.mjs"], env: { A: "1" } },
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Test": "yes" } },
      },
      managerMcp: {
        transport: "http",
        urls: {
          "dispatch-session": "http://127.0.0.1:4319/api/mcp/manager/session",
          "dispatch-github": "http://127.0.0.1:4319/api/mcp/manager/github",
        },
        token: "secret",
        tokenEnvVar: "DISPATCH_MANAGER_MCP_TOKEN",
      },
    });
    session.send({ text: "go" });
    await fake.tick();

    expect(fake.calls[0]).toMatchObject({
      method: "thread/start",
      params: {
        config: {
          model_auto_compact_token_limit: 180_000,
          mcp_servers: {
            files: { command: "node", args: ["server.mjs"], env: { A: "1" } },
            remote: { url: "https://example.com/mcp", http_headers: { "X-Test": "yes" } },
            // One Codex MCP server per category, all sharing the session's
            // single bearer token — the grant authorises a CHAT, not a category.
            "dispatch-session": {
              url: "http://127.0.0.1:4319/api/mcp/manager/session",
              http_headers: { Authorization: "Bearer secret" },
              tool_timeout_sec: MANAGER_TOOL_TIMEOUT_SEC,
            },
            "dispatch-github": {
              url: "http://127.0.0.1:4319/api/mcp/manager/github",
              http_headers: { Authorization: "Bearer secret" },
              tool_timeout_sec: MANAGER_TOOL_TIMEOUT_SEC,
            },
          },
        },
      },
    });
    // Project servers keep Codex's own default — only Dispatch's tools block by design.
    const servers = (fake.calls[0]!.params.config as { mcp_servers: Record<string, object> }).mcp_servers;
    expect(servers.files).not.toHaveProperty("tool_timeout_sec");
    expect(servers.remote).not.toHaveProperty("tool_timeout_sec");
  });

  it("gives Dispatch's tools a deadline just past their own longest wait, and no longer", () => {
    // Every bounded manager tool returns on its own by WAIT_CAP_SECONDS. Shrink
    // the deadline below that and Codex errors a watch_pr that was about to
    // return normally. Grow it much past, and a stuck call holds the turn for no
    // reason (a day was rejected as far too long).
    const longestOwnWait = Math.max(WAIT_CAP_SECONDS, ASK_USER_TIMEOUT_CAP_SECONDS, WATCH_PR_DEFAULT_TIMEOUT_SECONDS);
    expect(MANAGER_TOOL_TIMEOUT_SEC).toBeGreaterThan(longestOwnWait);
    expect(MANAGER_TOOL_TIMEOUT_SEC).toBeLessThanOrEqual(longestOwnWait + 5 * 60);
  });

  it("uses current thread settings RPCs for live model, effort, and posture changes", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    await session.setModel("gpt-next");
    await session.setEffort("high");
    await session.setPermissionMode("bypassPermissions");

    expect(fake.calls).toContainEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-next" },
    });
    expect(fake.calls).toContainEqual({
      method: "thread/settings/update",
      params: { threadId: "thread-1", effort: "high" },
    });
    expect(fake.calls).toContainEqual({
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
  });
});

/** What app-server 0.164 actually rejects input with during a compaction. */
const NOT_STEERABLE = Object.assign(
  new Error("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }"),
  { code: -32600 },
);

const texts = (call: { params: Record<string, unknown> } | undefined) =>
  ((call?.params.input ?? []) as { text?: string }[]).map((b) => b.text);

describe("CodexSession during a compaction turn", () => {
  /** A live thread with turn `turn-1` running. */
  async function running() {
    const s = makeSession();
    s.session.send({ text: "first" });
    await s.fake.tick();
    s.fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    return { ...s, events: s.session.events[Symbol.asyncIterator]() };
  }

  /** Read events up to and including the next turn end. */
  async function untilTurnEnd(events: AsyncIterator<HarnessEvent>) {
    for (;;) {
      const { value } = await events.next();
      if (value.type === "turn-end") return value;
    }
  }

  const completed = (id: string) => ({
    threadId: "thread-1",
    turn: { id, status: "completed", items: [] },
  });

  it("holds a message Codex refused mid-compaction and sends it as a new turn after", async () => {
    const { session, fake, events } = await running();
    fake.refuse("turn/steer", NOT_STEERABLE);

    session.send({ text: "hello" });
    await fake.tick();
    // Refused, but neither failed nor dropped.
    expect(fake.calls.at(-1)).toMatchObject({ method: "turn/steer", params: { expectedTurnId: "turn-1" } });
    expect(session.pending()).toBe(1);

    // Nothing more goes out while the compaction runs, not even another steer.
    const before = fake.calls.length;
    session.send({ text: "still there?" });
    await fake.tick();
    expect(fake.calls.length).toBe(before);
    expect(session.pending()).toBe(2);

    fake.push("turn/completed", completed("turn-1"));
    expect(await untilTurnEnd(events)).toMatchObject({ type: "turn-end", ok: true });
    // The broker reads this at that turn end to keep the chat running, so the
    // held input must still be counted, and not sent yet.
    expect(session.pending()).toBe(2);
    expect(fake.calls.length).toBe(before);

    // The host asking for the next event is what releases it.
    void events.next();
    await fake.tick();
    expect(fake.calls.at(-1)?.method).toBe("turn/start");
    expect(texts(fake.calls.at(-1))).toEqual(["hello", "still there?"]);
    expect(session.pending()).toBe(0);
  });

  it("holds input from the moment a compaction item starts, without a refused call", async () => {
    const { session, fake, events } = await running();
    fake.push("turn/completed", completed("turn-1"));
    await untilTurnEnd(events);
    // Pulled now, as the broker would; it resolves with the next event.
    const afterIdle = events.next();

    // Our own compaction, which Codex runs as a turn of its own.
    await session.compact();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "compact-1" } });
    fake.push("item/started", { threadId: "thread-1", item: { type: "contextCompaction", id: "c-1" } });
    const before = fake.calls.length;
    session.send({ text: "one" });
    session.send({ text: "two" });
    await fake.tick();
    expect(fake.calls.length).toBe(before);
    expect(session.pending()).toBe(2);

    // The item ends before its turn does. The retry is refused (it is still a
    // Compact turn) and the order survives the round trip.
    fake.refuse("turn/steer", NOT_STEERABLE);
    fake.push("item/completed", { threadId: "thread-1", item: { type: "contextCompaction", id: "c-1" } });
    await fake.tick();
    expect(fake.calls.at(-1)).toMatchObject({ method: "turn/steer", params: { expectedTurnId: "compact-1" } });
    expect(session.pending()).toBe(2);

    fake.push("turn/completed", completed("compact-1"));
    const seen: string[] = [(await afterIdle).value.type];
    for (;;) {
      const { value } = await events.next();
      seen.push(value.type);
      if (value.type === "turn-end") break;
    }
    expect(seen).toContain("compacted");
    expect(session.pending()).toBe(2);

    void events.next();
    await fake.tick();
    expect(fake.calls.at(-1)?.method).toBe("turn/start");
    expect(texts(fake.calls.at(-1))).toEqual(["one", "two"]);

    // A proper turn of its own: it runs, and the host sees it end.
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
    fake.push("turn/completed", completed("turn-2"));
    expect(await untilTurnEnd(events)).toMatchObject({ type: "turn-end", ok: true });
    expect(session.pending()).toBe(0);
  });

  it("keeps a refused batch ahead of anything sent while it was out", async () => {
    const { session, fake, events } = await running();
    fake.refuse("turn/steer", NOT_STEERABLE);
    session.send({ text: "one" });
    // Sent while "one" is still on the wire: it waits behind it.
    session.send({ text: "two" });
    await fake.tick();
    expect(fake.calls.filter((c) => c.method === "turn/steer")).toHaveLength(1);
    expect(session.pending()).toBe(2);

    fake.push("turn/completed", completed("turn-1"));
    await untilTurnEnd(events);
    void events.next();
    await fake.tick();
    expect(fake.calls.at(-1)?.method).toBe("turn/start");
    expect(texts(fake.calls.at(-1))).toEqual(["one", "two"]);
  });

  it("holds a refused turn/start too, for a compaction it hadn't seen begin", async () => {
    const { session, fake, events } = await running();
    fake.push("turn/completed", completed("turn-1"));
    await untilTurnEnd(events);
    void events.next();
    await fake.tick();

    fake.refuse("turn/start", NOT_STEERABLE);
    session.send({ text: "hello" });
    await fake.tick();
    expect(session.pending()).toBe(1);

    fake.push("turn/started", { threadId: "thread-1", turn: { id: "compact-1" } });
    fake.push("turn/completed", completed("compact-1"));
    await untilTurnEnd(events);
    void events.next();
    await fake.tick();
    expect(fake.calls.at(-1)?.method).toBe("turn/start");
    expect(texts(fake.calls.at(-1))).toEqual(["hello"]);
  });

  it("still opens a new turn when the steered turn simply ended in between", async () => {
    const { session, fake } = await running();
    fake.refuse("turn/steer", new Error("expected active turn id turn-1 but found none"));
    session.send({ text: "late" });
    await fake.tick();
    expect(fake.calls.slice(-2).map((c) => c.method)).toEqual(["turn/steer", "turn/start"]);
    expect(texts(fake.calls.at(-1))).toEqual(["late"]);
    expect(session.pending()).toBe(0);
  });

  it("still fails the turn on any other refusal", async () => {
    const { session, fake, events } = await running();
    fake.refuse("turn/steer", new Error("gone"));
    fake.refuse("turn/start", new Error("thread not found"));
    session.send({ text: "x" });
    await fake.tick();
    expect(await untilTurnEnd(events)).toMatchObject({ ok: false, result: "thread not found" });
  });

  it("recognises the refusal from structured error info as well as the message", () => {
    expect(isNotSteerable(NOT_STEERABLE)).toBe(true);
    expect(
      isNotSteerable(
        Object.assign(new Error("bad request"), {
          data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } } },
        }),
      ),
    ).toBe(true);
    expect(isNotSteerable(new Error("no active turn"))).toBe(false);
  });
});

describe("CodexSession approvals", () => {
  it("surfaces a command approval as a permission request and accepts on allow", async () => {
    const { session, fake } = makeSession();
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();

    fake.request({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "rm -rf build", cwd: "/repo" },
    });
    await fake.tick();

    const ask = events.find((e) => e.type === "permission-request");
    expect(ask).toMatchObject({
      toolName: "Bash",
      input: { command: "rm -rf build", cwd: "/repo" },
      target: "rm -rf build",
    });

    session.resolvePermission((ask as { requestId: string }).requestId, { decision: "allow" });
    expect(fake.responses).toContainEqual({ id: 7, result: { decision: "accept" } });
  });

  it("declines on deny", async () => {
    const { session, fake } = makeSession();
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.request({
      id: 8,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1" },
    });
    await fake.tick();
    const ask = events.find((e) => e.type === "permission-request")!;
    session.resolvePermission((ask as { requestId: string }).requestId, { decision: "deny" });
    expect(fake.responses).toContainEqual({ id: 8, result: { decision: "decline" } });
  });

  it("auto-declines a command the workflow guard forbids, without asking the human", async () => {
    const { session, fake } = makeSession({
      toolGuard: async (name, input) =>
        name === "Bash" && String(input.command).includes("push origin main")
          ? "pushes to trunk are not allowed"
          : null,
    });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "ship it" });
    await fake.tick();

    fake.request({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "git push origin main" },
    });
    await fake.tick();

    expect(fake.responses).toContainEqual({ id: 9, result: { decision: "decline" } });
    expect(events).toContainEqual({
      type: "guard-blocked",
      toolName: "Bash",
      input: { command: "git push origin main" },
      reason: "pushes to trunk are not allowed",
      continuation: "in-place",
    });
    // The human is never asked about something policy already refused.
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });

  it("guards every mapped item type, not just the shell", async () => {
    // Any mode can carry a tool policy now, so an item type the guard does not
    // see is a policy nothing enforces. These four were each unguarded until
    // the guard started using the stream's own mapper.
    for (const [item, toolName] of [
      [{ type: "mcpToolCall", id: "m1", server: "dispatch-workspace", tool: "worktree", arguments: {} },
       "mcp__dispatch-workspace__worktree"],
      [{ type: "fileChange", id: "f1", changes: [{ path: "/repo/a.ts", diff: "" }] }, "Edit"],
      [{ type: "dynamicToolCall", id: "d1", namespace: "ns", tool: "t", arguments: {} }, "mcp__ns__t"],
      [{ type: "webSearch", id: "w1", query: "q" }, "WebSearch"],
    ] as const) {
      const { session, fake } = makeSession({
        permissionMode: "bypassPermissions",
        toolGuard: async () => "not allowed here",
      });
      const events: HarnessEvent[] = [];
      void (async () => {
        for await (const e of session.events) events.push(e);
      })();
      session.send({ text: "go" });
      await fake.tick();
      fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
      fake.push("item/started", { threadId: "thread-1", turnId: "turn-1", item });
      await fake.tick();
      expect(
        events.some((e) => e.type === "guard-blocked" && e.toolName === toolName),
      ).toBe(true);
      expect(fake.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
    }
  });

  it("marks an unprompted forbidden command for turn restart before interrupting", async () => {
    // The `never` posture path: nothing is submitted for approval, so the guard
    // can only catch it once the item is already running.
    const { session, fake } = makeSession({
      permissionMode: "bypassPermissions",
      toolGuard: async () => "not allowed here",
    });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "c1",
        command: "git push origin main",
        cwd: "/repo/worktree",
      },
    });
    await fake.tick();

    expect(events).toContainEqual({
      type: "guard-blocked",
      toolName: "Bash",
      // `description` rides along because the guard now maps the item with
      // `codexToolCall` — the same mapper the stream decoder labels rows with,
      // which is what makes every item type guarded by construction.
      input: {
        command: "git push origin main",
        cwd: "/repo/worktree",
        description: "git push origin main",
      },
      reason: "not allowed here",
      continuation: "restart-turn",
    });
    expect(fake.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
  });

  it("hands the guard the call's cwd and item id as context", async () => {
    const seen: unknown[] = [];
    const { session, fake } = makeSession({
      permissionMode: "bypassPermissions",
      toolGuard: async (_name, _input, ctx) => {
        seen.push(ctx);
        return null;
      },
    });
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "c9", command: "ls", cwd: "/repo/wt" },
    });
    await fake.tick();
    expect(seen).toEqual([{ cwd: "/repo/wt", toolUseId: "c9" }]);
  });

  it("does not ask the guard again on sighting an item it passed at the approval prompt", async () => {
    // The guard is stateful: passing a call can spend a one-shot exemption.
    // Asked a second time when the SAME item starts, it would refuse the very
    // call the human just granted — and interrupt the turn over it.
    let asked = 0;
    const { session, fake } = makeSession({
      toolGuard: async () => (++asked === 1 ? null : "the one-shot is spent"),
    });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.request({
      id: 21,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "c1", command: "git push origin main" },
    });
    await fake.tick();
    const ask = events.find((e) => e.type === "permission-request")!;
    session.resolvePermission((ask as { requestId: string }).requestId, { decision: "allow" });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "c1", command: "git push origin main" },
    });
    await fake.tick();

    expect(asked).toBe(1);
    expect(events.some((e) => e.type === "guard-blocked")).toBe(false);
    expect(fake.calls.some((c) => c.method === "turn/interrupt")).toBe(false);
  });

  it("shares one verdict when the item is sighted BEFORE its approval prompt", async () => {
    // The other order. Keyed one way only, the sighting spent the grant and
    // the approval prompt then refused the call the human had granted.
    let asked = 0;
    const { session, fake } = makeSession({
      toolGuard: async () => (++asked === 1 ? null : "the one-shot is spent"),
    });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "c1", command: "git push origin main" },
    });
    // Separate deliveries, as from the app-server: the sighting is decided
    // before the request arrives.
    await fake.tick();
    fake.request({
      id: 22,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "c1", command: "git push origin main" },
    });
    await fake.tick();

    expect(asked).toBe(1);
    expect(events.some((e) => e.type === "guard-blocked")).toBe(false);
    expect(events.some((e) => e.type === "permission-request")).toBe(true);
    expect(fake.responses.some((r) => r.id === 22)).toBe(false);
  });

  it("reports a refusal once when the sighting and the approval prompt both meet it", async () => {
    const { session, fake } = makeSession({ toolGuard: async () => "not allowed here" });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "c1", command: "git push origin main" },
    });
    // Separate deliveries, as from the app-server: the sighting is decided
    // before the request arrives.
    await fake.tick();
    fake.request({
      id: 23,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "c1", command: "git push origin main" },
    });
    await fake.tick();

    expect(events.filter((e) => e.type === "guard-blocked")).toHaveLength(1);
    expect(fake.responses).toContainEqual({ id: 23, result: { decision: "decline" } });
  });

  it("never lets a turn end overtake a guard verdict still being reached", async () => {
    // One stdout chunk can carry item/started, item/completed and
    // turn/completed, dispatched back to back. An async refusal that landed
    // after the turn end would have nothing to recover — the turn would just
    // be over, which a guard hit must never cause.
    const { session, fake } = makeSession({
      permissionMode: "bypassPermissions",
      toolGuard: () => new Promise((resolve) => setTimeout(() => resolve("not allowed here"), 5)),
    });
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    const item = { type: "commandExecution", id: "c1", command: "git push origin main" };
    fake.push("item/started", { threadId: "thread-1", turnId: "turn-1", item });
    fake.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { ...item, status: "completed", exitCode: 0, aggregatedOutput: "" },
    });
    fake.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });
    await new Promise((r) => setTimeout(r, 30));

    const blocked = events.findIndex((e) => e.type === "guard-blocked");
    const ended = events.findIndex((e) => e.type === "turn-end");
    expect(blocked).toBeGreaterThanOrEqual(0);
    expect(ended).toBeGreaterThan(blocked);
  });

  it("answers a question with the per-question payload Codex expects", async () => {
    const { session, fake } = makeSession();
    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();

    fake.request({
      id: 11,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        questions: [
          { id: "q1", header: "Approach", question: "Which?", options: [{ label: "A" }] },
          { id: "q2", header: "Scope", question: "How far?", options: [{ label: "All" }] },
        ],
      },
    });
    await fake.tick();

    const ask = events.find((e) => e.type === "question-request")!;
    expect(ask).toMatchObject({ questions: [{ id: "q1" }, { id: "q2" }] });

    session.resolveQuestion((ask as { requestId: string }).requestId, [
      { questionId: "q1", selected: ["A"] },
    ]);
    // The unanswered question still gets a key, or Codex waits on it forever.
    expect(fake.responses).toContainEqual({
      id: 11,
      result: { answers: { q1: { answers: ["A"] }, q2: { answers: [] } } },
    });
  });

  it("declines an MCP elicitation rather than leaving the thread wedged", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    fake.request({ id: 12, method: "mcpServer/elicitation/request", params: { threadId: "thread-1" } });
    expect(fake.responses).toContainEqual({ id: 12, result: { action: "decline" } });
  });

  it("answers an unmodelled server request so the agent cannot block", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    fake.request({ id: 13, method: "some/future/request", params: { threadId: "thread-1" } });
    expect(fake.responses).toContainEqual({ id: 13, result: {} });
  });

  it("declines everything still open on dispose", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    fake.request({
      id: 14,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "ls" },
    });
    await fake.tick();
    await session.dispose();
    expect(fake.responses).toContainEqual({ id: 14, result: { decision: "decline" } });
  });
});

describe("CodexSession usage limits", () => {
  it("merges the account reset time into a usage-limit turn end", async () => {
    const fake = fakeConn();
    const session = new CodexSession({
      spec: {
        permissionMode: "default",
        effort: "medium",
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      },
      conn: fake.conn,
      release: () => {},
      genId: () => "id",
      // The error itself carries no reset instant — the snapshot does.
      limitsSnapshot: () => ({ primary: { resetsAt: 1_786_731_963_000 } }),
    });

    const events: HarnessEvent[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    session.send({ text: "go" });
    await fake.tick();

    fake.push("error", {
      threadId: "thread-1",
      willRetry: false,
      error: { message: "Weekly limit reached.", codexErrorInfo: "usageLimitExceeded" },
    });
    await fake.tick();

    expect(events.at(-1)).toMatchObject({
      type: "turn-end",
      ok: false,
      subtype: "usage_limit",
      limit: { reason: "Weekly limit reached.", resetsAt: 1_786_731_963_000 },
    });
  });
});

describe("CodexSession control", () => {
  it("interrupts the active turn by id", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    await session.interrupt();
    expect(fake.calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("does nothing when there is no turn to interrupt", async () => {
    const { session, fake } = makeSession();
    await session.interrupt();
    expect(fake.calls).toEqual([]);
  });

  it("applies a new effort to the next turn", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "one" });
    await fake.tick();
    fake.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });

    await session.setEffort("xhigh");
    session.send({ text: "two" });
    await fake.tick();
    expect(fake.calls.at(-1)).toMatchObject({ method: "turn/start", params: { effort: "xhigh" } });
  });

  it("compacts the thread in place", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    await session.compact();
    expect(fake.calls).toContainEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" },
    });
    // No focus → no injected note; the summarizer runs on history as-is.
    expect(fake.calls.some((c) => c.method === "thread/inject_items")).toBe(false);
  });

  it("injects a focus note into history before compacting, since compact/start takes none", async () => {
    const { session, fake } = makeSession();
    session.send({ text: "go" });
    await fake.tick();
    await session.compact("  the PR number and\n the failing test ");
    const inject = fake.calls.findIndex((c) => c.method === "thread/inject_items");
    const compact = fake.calls.findIndex((c) => c.method === "thread/compact/start");
    expect(inject).toBeGreaterThan(-1);
    expect(compact).toBeGreaterThan(inject);
    const items = fake.calls[inject]!.params.items as Array<{
      role: string;
      content: Array<{ text: string }>;
    }>;
    expect(items[0]!.role).toBe("user");
    // Whitespace collapsed, and phrased as guidance to the summary, not a task.
    expect(items[0]!.content[0]!.text).toContain("the PR number and the failing test");
    expect(items[0]!.content[0]!.text).toMatch(/not a new request/);
  });

  it("still compacts when the app-server lacks inject_items", async () => {
    const { session, fake } = makeSession();
    const underlying = fake.conn.call.bind(fake.conn);
    (fake.conn as { call: unknown }).call = async (method: string, params: unknown) => {
      if (method === "thread/inject_items") throw new Error("method not found");
      return underlying(method, params);
    };
    session.send({ text: "go" });
    await fake.tick();
    await session.compact("keep the plan");
    expect(fake.calls).toContainEqual({
      method: "thread/compact/start",
      params: { threadId: "thread-1" },
    });
  });

  it("reports a failed open as a failed turn instead of throwing", async () => {
    const fake = fakeConn();
    fake.reply("thread/start", {});
    const session = new CodexSession({
      spec: {
        permissionMode: "default",
        effort: "medium",
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      },
      conn: fake.conn,
      release: () => {},
      genId: () => "id",
    });
    const events = take(session, 1);
    session.send({ text: "go" });
    expect(await events).toEqual([
      { type: "turn-end", ok: false, subtype: "error", result: "codex returned a thread with no id" },
    ]);
  });

  it("releases its connection hold on dispose", async () => {
    let released = false;
    const fake = fakeConn();
    const session = new CodexSession({
      spec: {
        permissionMode: "default",
        effort: "medium",
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      },
      conn: fake.conn,
      release: () => (released = true),
      genId: () => "id",
    });
    await session.dispose();
    expect(released).toBe(true);
  });

  it("releases its connection hold when the app-server stops answering during dispose", async () => {
    let released = false;
    const fake = fakeConn();
    const session = new CodexSession({
      spec: {
        permissionMode: "default",
        effort: "medium",
        systemPromptAppends: [],
        mcpServers: {},
        skills: [],
      },
      conn: fake.conn,
      release: () => (released = true),
      genId: () => "id",
    });
    session.send({ text: "go" });
    await fake.tick();
    fake.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    fake.reply("turn/interrupt", new Promise(() => {}));

    await session.dispose();

    expect(fake.calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    expect(released).toBe(true);
    // The init queued before disposal remains readable, then the stream closes.
    expect((await take(session, 10)).map((event) => event.type)).toEqual(["init"]);
  });
});
