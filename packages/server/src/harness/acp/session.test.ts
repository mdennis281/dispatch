import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { AcpConnection, type AcpProcess } from "./rpc.js";
import { AcpSession, toAcpMcpServers, toSlashCommands, splitPermissionTitle } from "./session.js";
import type { HarnessEvent, HarnessSessionSpec } from "../types.js";

/**
 * A scripted ACP agent.
 *
 * Replies to `initialize`, `session/new` and `session/set_mode` the way goose
 * 1.51.0 really does, and lets a test drive everything else — so these tests
 * exercise the adapter's own logic without spawning a 268MB binary or needing a
 * GPU on the CI runner.
 */
class FakeAgent {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every frame the adapter sent us, parsed. */
  readonly sent: Record<string, unknown>[] = [];
  killed = false;
  /** Called for each request the adapter makes; return a result or undefined. */
  onRequest?: (method: string, params: Record<string, unknown>, id: number | string) => unknown;

  readonly proc: AcpProcess;

  constructor() {
    const self = this;
    this.proc = {
      pid: 4242,
      stdin: {
        write(chunk: string): void {
          for (const line of chunk.split("\n")) {
            if (!line.trim()) continue;
            const frame = JSON.parse(line) as Record<string, unknown>;
            self.sent.push(frame);
            self.autoReply(frame);
          }
        },
        end(): void {},
      },
      stdout: this.stdout,
      stderr: this.stderr,
      kill(): void {
        self.killed = true;
      },
      on(): void {},
    };
  }

  private autoReply(frame: Record<string, unknown>): void {
    const { id, method } = frame as { id?: number | string; method?: string };
    if (id === undefined || !method) return;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    let result = this.onRequest?.(method, params, id);
    if (result === undefined) {
      if (method === "initialize") {
        result = {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: false },
          },
          agentInfo: { name: "goose", version: "1.51.0" },
        };
      } else if (method === "session/new") {
        result = { sessionId: "20260923_1", modes: { currentModeId: "auto" } };
      } else if (method === "session/load") {
        result = {};
      } else if (method === "session/set_mode") {
        result = {};
      } else {
        return; // the test will answer this one itself
      }
    }
    this.reply(id, result);
  }

  reply(id: number | string, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  /** Push a `session/update` notification. */
  update(update: Record<string, unknown>, sessionId = "20260923_1"): void {
    this.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }) +
        "\n",
    );
  }

  /** Push an agent→client request. */
  ask(id: string, method: string, params: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }

  /** The first frame this agent received for `method`. */
  frameFor(method: string): Record<string, unknown> | undefined {
    return this.sent.find((f) => f.method === method);
  }
}

function spec(over: Partial<HarnessSessionSpec> = {}): HarnessSessionSpec {
  return {
    cwd: "/work",
    permissionMode: "default",
    effort: "medium",
    systemPromptAppends: [],
    mcpServers: {},
    skills: [],
    ...over,
  };
}

function build(over: Partial<HarnessSessionSpec> = {}): {
  agent: FakeAgent;
  session: AcpSession;
  events: HarnessEvent[];
  drain: () => Promise<void>;
} {
  const agent = new FakeAgent();
  const conn = new AcpConnection({
    exePath: "goose",
    args: ["acp"],
    spawnProcess: () => agent.proc,
  });
  let n = 0;
  const session = new AcpSession({ spec: spec(over), conn, genId: () => `id${++n}` });
  const events: HarnessEvent[] = [];
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  const drain = async (): Promise<void> => {
    // Let the queued microtasks and stream writes settle.
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 2));
  };
  return { agent, session, events, drain };
}

describe("AcpSession", () => {
  it("opens a session, applies the asked-for posture, and announces init", async () => {
    const { agent, session, events, drain } = build({ permissionMode: "plan" });
    session.send({ text: "hi" });
    await drain();

    expect(agent.frameFor("initialize")).toBeTruthy();
    expect(agent.frameFor("session/new")?.params).toMatchObject({ cwd: "/work" });
    // plan must reach the agent as its hard no-tools mode, not be left at the
    // agent's own default of `auto`.
    expect(agent.frameFor("session/set_mode")?.params).toMatchObject({ modeId: "chat" });

    const init = events.find((e) => e.type === "init");
    expect(init).toMatchObject({ type: "init", sessionId: "20260923_1", permissionMode: "plan" });
  });

  it("resumes an existing session rather than starting a new one", async () => {
    const { agent, session, drain } = build({ resumeSessionId: "20260101_9" });
    session.send({ text: "again" });
    await drain();
    expect(agent.frameFor("session/load")?.params).toMatchObject({ sessionId: "20260101_9" });
    expect(agent.frameFor("session/new")).toBeUndefined();
  });

  it("carries the system-prompt appends on the first prompt only", async () => {
    const { agent, session, drain } = build({ systemPromptAppends: ["POLICY"] });
    let prompts = 0;
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      prompts += 1;
      setTimeout(() => agent.reply(id, { stopReason: "end_turn" }), 1);
      return undefined;
    };
    session.send({ text: "one" });
    await drain();
    session.send({ text: "two" });
    await drain();

    const sentPrompts = agent.sent.filter((f) => f.method === "session/prompt");
    expect(sentPrompts).toHaveLength(2);
    const first = (sentPrompts[0]!.params as { prompt: { text: string }[] }).prompt;
    const second = (sentPrompts[1]!.params as { prompt: { text: string }[] }).prompt;
    expect(first.map((b) => b.text)).toEqual(["POLICY", "one"]);
    // Re-sending the policy every turn would re-pay its tokens on a context
    // window a local model can ill afford.
    expect(second.map((b) => b.text)).toEqual(["two"]);
    expect(prompts).toBe(2);
  });

  it("turns a streamed turn into transcript events ending in turn-end", async () => {
    const { agent, session, events, drain } = build();
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => {
        agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, messageId: "m1" });
        agent.update({ sessionUpdate: "usage_update", used: 120, size: 128000 });
        agent.reply(id, { stopReason: "end_turn", usage: { totalTokens: 120 } });
      }, 1);
      return undefined;
    };
    session.send({ text: "yo" });
    await drain();

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("delta");
    expect(kinds).toContain("usage");
    // The buffered assistant message must be flushed before the turn ends.
    expect(kinds.indexOf("assistant")).toBeLessThan(kinds.indexOf("turn-end"));
    expect(events.at(-1)).toMatchObject({
      type: "turn-end",
      ok: true,
      subtype: "success",
      contextTokens: 120,
      contextWindow: 128000,
    });
  });

  it("raises a permission request and answers it with the once option", async () => {
    const { agent, session, events, drain } = build();
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => {
        agent.ask("perm-1", "session/request_permission", {
          sessionId: "20260923_1",
          toolCall: {
            toolCallId: "t1",
            kind: "other",
            status: "pending",
            title: "shell · rm -rf /",
            rawInput: { command: "rm -rf /" },
          },
          options: [
            { optionId: "allow_always", kind: "allow_always" },
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "reject_once", kind: "reject_once" },
            { optionId: "reject_always", kind: "reject_always" },
          ],
        });
        setTimeout(() => agent.reply(id, { stopReason: "end_turn" }), 20);
      }, 1);
      return undefined;
    };
    session.send({ text: "go" });
    await drain();

    const ask = events.find((e) => e.type === "permission-request");
    // The name must survive the title, since the permission request carries no
    // _meta the way a tool_call update does.
    expect(ask).toMatchObject({
      type: "permission-request",
      toolName: "Bash",
      target: "rm -rf /",
      input: { command: "rm -rf /" },
    });

    session.resolvePermission((ask as { requestId: string }).requestId, { decision: "deny" });
    await drain();

    const answer = agent.sent.find((f) => f.id === "perm-1");
    // reject_once, never reject_always: a standing denial would outlive the
    // decision the human actually made.
    expect(answer?.result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });

  it("refuses an unimplemented agent request instead of hanging the turn", async () => {
    // The spike's worst bug: an unanswered request pins the turn forever with
    // no error, no timeout and nothing on stderr.
    const { agent, session, drain } = build();
    session.send({ text: "go" });
    await drain();
    agent.ask("term-1", "terminal/create", { sessionId: "20260923_1", command: "ls" });
    await drain();

    const answer = agent.sent.find((f) => f.id === "term-1");
    expect(answer).toBeTruthy();
    expect((answer as { error?: { message?: string } }).error?.message).toContain("terminal/create");
  });

  it("cancels a turn through session/cancel", async () => {
    const { agent, session, drain } = build();
    agent.onRequest = (method) => (method === "session/prompt" ? undefined : undefined);
    session.send({ text: "go" });
    await drain();
    await session.interrupt();
    await drain();
    expect(agent.frameFor("session/cancel")?.params).toMatchObject({ sessionId: "20260923_1" });
  });

  it("exposes the agent pid so the chat's process tree can be killed", async () => {
    const { session, drain } = build();
    session.send({ text: "go" });
    await drain();
    expect(session.pid()).toBe(4242);
  });

  it("cancels outstanding permission asks on dispose", async () => {
    const { agent, session, events, drain } = build();
    agent.onRequest = (method, _p, _id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => {
        agent.ask("perm-9", "session/request_permission", {
          sessionId: "20260923_1",
          toolCall: { toolCallId: "t9", title: "shell · sleep 999", rawInput: {} },
          options: [{ optionId: "allow_once", kind: "allow_once" }],
        });
      }, 1);
      return undefined;
    };
    session.send({ text: "go" });
    await drain();
    expect(events.some((e) => e.type === "permission-request")).toBe(true);

    await session.dispose();
    await drain();
    // A request left waiting would pin the agent while it dies.
    expect(agent.sent.find((f) => f.id === "perm-9")?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(agent.killed).toBe(true);
  });
});

describe("toAcpMcpServers", () => {
  it("shapes env and headers as arrays, not objects", () => {
    // The trap: ACP wants [{name, value}]. An object yields a server with no
    // environment and no error.
    const out = toAcpMcpServers(
      spec({
        mcpServers: {
          local: { command: "node", args: ["x.js"], env: { TOKEN: "t" } },
          remote: { url: "https://example.test/mcp", headers: { "X-Key": "k" } },
        },
      }),
    );
    expect(out).toContainEqual({
      name: "local",
      command: "node",
      args: ["x.js"],
      env: [{ name: "TOKEN", value: "t" }],
    });
    expect(out).toContainEqual({
      type: "http",
      name: "remote",
      url: "https://example.test/mcp",
      headers: [{ name: "X-Key", value: "k" }],
    });
  });

  it("attaches Dispatch's own tools over HTTP with one bearer grant", () => {
    const out = toAcpMcpServers(
      spec({
        managerMcp: {
          transport: "http",
          urls: { "dispatch-github": "http://127.0.0.1:4318/api/mcp/manager/github" },
          token: "secret",
          tokenEnvVar: "DISPATCH_TOKEN",
        },
      }),
    );
    expect(out).toEqual([
      {
        type: "http",
        name: "dispatch-github",
        url: "http://127.0.0.1:4318/api/mcp/manager/github",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
    ]);
  });

  it("skips a server with neither a url nor a command", () => {
    expect(toAcpMcpServers(spec({ mcpServers: { broken: {} } }))).toEqual([]);
  });
});

describe("splitPermissionTitle", () => {
  it("splits goose's '<tool> · <target>' title", () => {
    expect(splitPermissionTitle("shell · echo hi")).toEqual({
      rawName: "shell",
      target: "echo hi",
    });
  });

  it("treats a title with no separator as a bare tool name", () => {
    expect(splitPermissionTitle("tree")).toEqual({ rawName: "tree" });
  });

  it("survives an absent title", () => {
    expect(splitPermissionTitle(undefined)).toEqual({});
  });
});

describe("toSlashCommands", () => {
  it("fills the fields the catalogue requires", () => {
    expect(toSlashCommands([{ name: "plan", description: "Plan it" }])).toEqual([
      { name: "plan", description: "Plan it", source: "builtin", aliases: [] },
    ]);
  });

  it("ignores entries with no name", () => {
    expect(toSlashCommands([{ description: "x" }, null, "nope"])).toEqual([]);
    expect(toSlashCommands(undefined)).toEqual([]);
  });
});
