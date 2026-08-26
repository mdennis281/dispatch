import { describe, it, expect } from "vitest";
import { CodexSession } from "./session.js";
import type { CodexConnection, RpcFrame, ServerRequest } from "./rpc.js";
import type { HarnessEvent, HarnessSessionSpec } from "../types.js";

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

  const conn = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
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
            },
            "dispatch-github": {
              url: "http://127.0.0.1:4319/api/mcp/manager/github",
              http_headers: { Authorization: "Bearer secret" },
            },
          },
        },
      },
    });
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
      toolGuard: (name, input) =>
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

  it("marks an unprompted forbidden command for turn restart before interrupting", async () => {
    // The `never` posture path: nothing is submitted for approval, so the guard
    // can only catch it once the item is already running.
    const { session, fake } = makeSession({
      permissionMode: "bypassPermissions",
      toolGuard: () => "not allowed here",
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
      input: { command: "git push origin main", cwd: "/repo/worktree" },
      reason: "not allowed here",
      continuation: "restart-turn",
    });
    expect(fake.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
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
