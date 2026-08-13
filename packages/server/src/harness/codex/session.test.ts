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
  let notify: ((f: RpcFrame) => void) | undefined;
  let onReq: ((r: ServerRequest) => void) | undefined;
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
    onThread: (_id: string, l: (f: RpcFrame) => void) => {
      notify = l;
      return () => (notify = undefined);
    },
    onRequest: (_id: string, h: (r: ServerRequest) => void) => {
      onReq = h;
      return () => (onReq = undefined);
    },
    respond: (id: number | string, result: unknown) => responses.push({ id, result }),
    respondError: (id: number | string, error: string) => responses.push({ id, error }),
  } as unknown as CodexConnection;

  return {
    conn,
    calls,
    responses,
    reply: (method: string, value: unknown) => replies.set(method, value),
    push: (method: string, params: Record<string, unknown>) => notify?.({ method, params }),
    request: (r: ServerRequest) => onReq?.(r),
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
        url: "http://127.0.0.1:4319/api/mcp/manager",
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
            manager: {
              url: "http://127.0.0.1:4319/api/mcp/manager",
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
      type: "notice",
      level: "warn",
      text: "Blocked: pushes to trunk are not allowed",
    });
    // The human is never asked about something policy already refused.
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });

  it("interrupts a forbidden command that started without an approval prompt", async () => {
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
      item: { type: "commandExecution", id: "c1", command: "git push origin main" },
    });
    await fake.tick();

    expect(events).toContainEqual({ type: "notice", level: "warn", text: "Blocked: not allowed here" });
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
});
