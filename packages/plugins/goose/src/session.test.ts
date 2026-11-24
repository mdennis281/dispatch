import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { AcpConnection, type AcpProcess } from "./rpc.js";
import { AcpSession, toAcpMcpServers, toSlashCommands, splitPermissionTitle } from "./session.js";
import { toEnvironmentBlock } from "./options.js";
import type { HarnessEvent, HarnessSessionSpec } from "@dispatch/shared";

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

  /** The most recent one — for anything the session re-sends on a change. */
  lastFrameFor(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((f) => f.method === method);
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

  it("downgrades a non-asking posture to per-call approval when the mode gates tools", async () => {
    // `bypassPermissions` alone is `auto` — no permission requests at all,
    // and therefore no interception point, so the denylist would be advisory
    // on this runtime and enforced on every other one.
    const { agent, session, drain } = build({
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash"],
    });
    session.send({ text: "hi" });
    await drain();
    expect(agent.frameFor("session/set_mode")?.params).toMatchObject({ modeId: "approve" });
  });

  it("tightens on a mid-session switch INTO a gated mode, without a rebuild", async () => {
    // The broker deliberately does not rebuild the runtime mid-turn, so a
    // `restricted` snapshotted at construction would leave this session in
    // `auto` — no permission requests, and therefore nothing for the guard
    // the broker just tightened to act on.
    const { agent, session, drain } = build({ permissionMode: "bypassPermissions" });
    session.send({ text: "hi" });
    await drain();
    expect(agent.frameFor("session/set_mode")?.params).toMatchObject({ modeId: "auto" });

    await session.setPermissionMode("bypassPermissions", { disallowedTools: ["Bash"] });
    expect(agent.lastFrameFor("session/set_mode")?.params).toMatchObject({ modeId: "approve" });

    // And loosens again on the way out.
    await session.setPermissionMode("bypassPermissions", {});
    expect(agent.lastFrameFor("session/set_mode")?.params).toMatchObject({ modeId: "auto" });

    // A caller that says nothing about the policy must not be read as "no
    // policy" — that would silently unrestrict on an unrelated switch.
    await session.setPermissionMode("bypassPermissions", { allowedTools: [] });
    await session.setPermissionMode("bypassPermissions");
    expect(agent.lastFrameFor("session/set_mode")?.params).toMatchObject({ modeId: "approve" });
  });

  it("resumes an existing session rather than starting a new one", async () => {
    const { agent, session, drain } = build({ resumeSessionId: "20260101_9" });
    session.send({ text: "again" });
    await drain();
    expect(agent.frameFor("session/load")?.params).toMatchObject({ sessionId: "20260101_9" });
    expect(agent.frameFor("session/new")).toBeUndefined();
  });

  it("swallows the conversation replay goose streams during session/load", async () => {
    // ACP makes the agent replay the whole history as `session/update`s before
    // it answers `session/load`. Decoded, every resume re-persisted all earlier
    // messages and tool calls — a daily scheduled chat grew by its entire
    // history each day.
    const sid = "20260101_9";
    const { agent, session, events, drain } = build({ resumeSessionId: sid });
    const text = (t: string) => ({ type: "text", text: t });
    agent.onRequest = (method, _p, id) => {
      if (method === "session/load") {
        agent.update({ sessionUpdate: "user_message_chunk", content: text("old ask") }, sid);
        agent.update(
          { sessionUpdate: "agent_message_chunk", messageId: "chatcmpl-380", content: text("old reply") },
          sid,
        );
        agent.update({ sessionUpdate: "agent_thought_chunk", content: text("old thought") }, sid);
        agent.update(
          { sessionUpdate: "tool_call", toolCallId: "t1", title: "shell", rawInput: { command: "ls" } },
          sid,
        );
        agent.update(
          { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [] },
          sid,
        );
        agent.update({ sessionUpdate: "plan", entries: [{ content: "old step", status: "completed" }] }, sid);
        // State, not history — these must still land.
        agent.update(
          { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] },
          sid,
        );
        agent.update({ sessionUpdate: "usage_update", used: 1234, size: 32768 }, sid);
        // Returned, so the fake answers the load AFTER the replay — the order
        // the spec requires.
        return {};
      }
      if (method === "session/prompt") {
        agent.update({ sessionUpdate: "agent_message_chunk", content: text("new reply") }, sid);
        setTimeout(() => agent.reply(id, { stopReason: "end_turn" }), 1);
      }
      return undefined;
    };
    session.send({ text: "again" });
    await drain();

    const rows = events.filter(
      (e) => e.type === "tool-use" || e.type === "tool-result" || e.type === "assistant",
    );
    // The only row is today's reply, and none of the replayed text leaked into
    // it through the decoder's message buffer.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "assistant", text: "new reply" });
    expect(events.some((e) => e.type === "delta" && /old/.test(e.delta))).toBe(false);
    // The replay is dropped; the state updates are not.
    expect(events.find((e) => e.type === "usage")).toMatchObject({ contextTokens: 1234 });
    expect((await session.slashCommands()).map((c) => c.name)).toEqual(["compact"]);
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
    // The environment block leads, because it is the frame the policy is read
    // in — "run the suite" means something different on a box with no `grep`.
    expect(first.map((b) => b.text)).toEqual([
      toEnvironmentBlock(process.platform, "/work"),
      "POLICY",
      "one",
    ]);
    // Re-sending either every turn would re-pay their tokens on a context
    // window a local model can ill afford.
    expect(second.map((b) => b.text)).toEqual(["two"]);
    expect(prompts).toBe(2);
  });

  it("tells the agent what machine it is on, even with no project instructions", async () => {
    // The gap this closes: Claude Code and Codex CLI each build their own
    // system prompt and put the OS in it. An ACP agent gets only what we send,
    // and we sent nothing — so on Windows a goose chat ran `grep` three times,
    // was told "'grep' is not recognized" three times, and gave up on the task.
    // A session with no `systemPromptAppends` is the common case, so the block
    // must not be conditional on there being any.
    const { agent, session, drain } = build({ systemPromptAppends: [] });
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => agent.reply(id, { stopReason: "end_turn" }), 1);
      return undefined;
    };
    session.send({ text: "go" });
    await drain();

    const prompt = (agent.frameFor("session/prompt")!.params as { prompt: { text: string }[] })
      .prompt;
    expect(prompt[0]!.text).toBe(toEnvironmentBlock(process.platform, "/work"));
    expect(prompt.map((b) => b.text)).toContain("go");
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

  it("declines a guard-forbidden call at the protocol level, with no card", async () => {
    // This adapter advertises `preToolGuard: true`. Until the guard was wired
    // in here that was a lie: a call the host forbids arrived as an ordinary
    // approval prompt, so a mode's denylist became something a human could
    // click through — for the global posture, the whole thing undone by one
    // "Allow". The agent is blocked on this RPC, so it is declined rather
    // than silently not shown.
    const { agent, session, events, drain } = build({
      toolGuard: async (name) => (name === "Bash" ? "not available in Global mode" : null),
    });
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => {
        agent.ask("perm-g", "session/request_permission", {
          sessionId: "20260923_1",
          toolCall: {
            toolCallId: "t1",
            kind: "other",
            status: "pending",
            title: "shell · rm -rf /",
            rawInput: { command: "rm -rf /" },
          },
          options: [
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "reject_once", kind: "reject_once" },
          ],
        });
        setTimeout(() => agent.reply(id, { stopReason: "end_turn" }), 20);
      }, 1);
      return undefined;
    };
    session.send({ text: "go" });
    await drain();

    // No card was ever offered…
    expect(events.find((e) => e.type === "permission-request")).toBeUndefined();
    // …the refusal is reported…
    expect(events.find((e) => e.type === "guard-blocked")).toMatchObject({
      toolName: "Bash",
      reason: "not available in Global mode",
    });
    // …and the agent got a real answer rather than being left hanging.
    expect(agent.sent.find((f) => f.id === "perm-g")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
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

describe("AcpSession compaction", () => {
  /** Answer each `session/prompt` after `reply` streams, like goose 1.51.0. */
  function answerPrompts(agent: FakeAgent, reply: (text: string) => string | undefined): void {
    agent.onRequest = (method, params, id) => {
      if (method !== "session/prompt") return undefined;
      const blocks = params.prompt as { text?: string }[];
      const text = reply(blocks.map((b) => b.text ?? "").join(""));
      setTimeout(() => {
        if (text) {
          agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        }
        agent.reply(id, { stopReason: "end_turn" });
      }, 1);
      return undefined;
    };
  }

  /** Push one of goose's `_goose/unstable/session/update` notifications. */
  function gooseUpdate(agent: FakeAgent, update: Record<string, unknown>): void {
    agent.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_goose/unstable/session/update",
        params: { sessionId: "20260923_1", update },
      }) + "\n",
    );
  }

  it("opts into goose's own notifications, the only place auto-compaction is reported", async () => {
    const { agent, session, drain } = build();
    session.send({ text: "hi" });
    await drain();
    const caps = (agent.frameFor("initialize")?.params as Record<string, unknown>)
      .clientCapabilities as Record<string, unknown>;
    expect(caps._meta).toEqual({ goose: { customNotifications: true } });
  });

  it("sends a lone `/compact` and turns goose's reply into one compacted row", async () => {
    const { agent, session, events, drain } = build({ systemPromptAppends: ["POLICY"] });
    agent.onRequest = (method, params, id) => {
      if (method !== "session/prompt") return undefined;
      const blocks = params.prompt as { text?: string }[];
      const isCompact = blocks.length === 1 && blocks[0]!.text === "/compact";
      setTimeout(() => {
        if (isCompact) {
          // goose 1.51.0 sends the shrunken reading BEFORE the turn's result.
          agent.update({ sessionUpdate: "usage_update", used: 219, size: 8000 });
          agent.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Compaction complete" },
          });
        } else {
          agent.update({ sessionUpdate: "usage_update", used: 2250, size: 8000 });
        }
        agent.reply(id, { stopReason: "end_turn" });
      }, 1);
      return undefined;
    };
    session.send({ text: "hi" });
    await drain();
    const before = events.length;
    await session.compact("keep the API changes");
    await drain();
    const after = events.slice(before);

    // ALONE: goose matches the message text exactly, so the first-prompt
    // instruction blocks riding along would make it an ordinary question.
    const prompt = (agent.lastFrameFor("session/prompt")?.params as { prompt: unknown[] }).prompt;
    expect(prompt).toEqual([{ type: "text", text: "/compact" }]);
    // goose's "Compaction complete" is not the model talking.
    expect(after.some((e) => e.type === "assistant")).toBe(false);
    // Both sizes from the adapter: by the time the turn ends, the host's last
    // reading is already the post-compaction one.
    expect(after.filter((e) => e.type === "compacted")).toEqual([
      { type: "compacted", trigger: "manual", preTokens: 2250, postTokens: 219 },
    ]);
    expect(after.at(-1)).toMatchObject({ type: "turn-end", ok: true });
  });

  it("keeps the first-prompt instructions for a real message when `/compact` comes first", async () => {
    const { agent, session, drain } = build({ systemPromptAppends: ["POLICY"] });
    answerPrompts(agent, (t) => (t === "/compact" ? "Compaction complete" : undefined));
    await session.compact();
    await drain();
    expect((agent.frameFor("session/prompt")?.params as { prompt: unknown[] }).prompt).toEqual([
      { type: "text", text: "/compact" },
    ]);
    // Not spent on the command — they go with the next real message.
    session.send({ text: "go on" });
    await drain();
    const next = (agent.lastFrameFor("session/prompt")?.params as { prompt: { text: string }[] })
      .prompt;
    expect(next.map((b) => b.text)).toContain("POLICY");
  });

  it("surfaces a failed compaction as an error, not as the model's reply", async () => {
    // goose catches its own compaction error and returns it as assistant text.
    const { agent, session, events, drain } = build();
    answerPrompts(agent, () => "Ran into this error trying to compact: boom.");
    await session.compact();
    await drain();
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(events).toContainEqual({
      type: "notice",
      level: "error",
      text: "Ran into this error trying to compact: boom.",
    });
  });

  it("runs a compaction ahead of messages already waiting", async () => {
    const { agent, session, drain } = build();
    const order: string[] = [];
    let release: (() => void) | undefined;
    agent.onRequest = (method, params, id) => {
      if (method !== "session/prompt") return undefined;
      const blocks = params.prompt as { text?: string }[];
      order.push(blocks.at(-1)?.text ?? "");
      release = () => agent.reply(id, { stopReason: "end_turn" });
      return undefined;
    };
    session.send({ text: "first" });
    await drain();
    session.send({ text: "second" });
    await session.compact();
    for (let i = 0; i < 3; i++) {
      release?.();
      await drain();
    }
    expect(order).toEqual(["first", "/compact", "second"]);
  });

  it("clears in place with goose's `/clear`, without a row of goose's own", async () => {
    const { agent, session, events, drain } = build();
    answerPrompts(agent, (t) => (t === "/clear" ? "Conversation cleared" : undefined));
    await session.clear();
    await drain();
    expect(
      (agent.frameFor("session/prompt")?.params as { prompt: unknown[] }).prompt,
    ).toEqual([{ type: "text", text: "/clear" }]);
    expect(events.some((e) => e.type === "assistant" || e.type === "notice")).toBe(false);
  });

  it("reports goose's own auto-compaction once, when it completes", async () => {
    const { agent, session, events, drain } = build();
    agent.onRequest = (method, _p, id) => {
      if (method !== "session/prompt") return undefined;
      setTimeout(() => {
        agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } });
        // The three frames goose 1.51.0 really sends, captured live.
        gooseUpdate(agent, {
          sessionUpdate: "status_message",
          status: {
            type: "notice",
            message: "Exceeded auto-compact threshold of 27%. Performing auto-compaction...",
          },
        });
        gooseUpdate(agent, {
          sessionUpdate: "status_message",
          status: { type: "progress", message: "goose is compacting the conversation..." },
        });
        gooseUpdate(agent, {
          sessionUpdate: "status_message",
          status: { type: "notice", message: "Compaction complete" },
        });
        // goose's duplicate usage frame must not become a second reading.
        gooseUpdate(agent, { sessionUpdate: "usage_update", used: 900, contextLimit: 8000 });
        agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } });
        agent.reply(id, { stopReason: "end_turn" });
      }, 1);
      return undefined;
    };
    session.send({ text: "go" });
    await drain();

    const shown = events
      .filter((e) => e.type === "assistant" || e.type === "compacted" || e.type === "usage")
      .map((e) => (e.type === "assistant" ? e.text : e.type));
    expect(shown).toEqual(["before", "compacted", "after"]);
    expect(events.find((e) => e.type === "compacted")).toEqual({
      type: "compacted",
      trigger: "auto",
    });
  });

  it("keeps the process for a limit goose would not notice, and refuses one it would", async () => {
    const { session } = build({ contextWindow: 32_768, contextTokenLimit: 40_000 });
    // Both at or past the window: goose runs on its default either way.
    await expect(session.setContextTokenLimit(64_000)).resolves.toBeUndefined();
    await expect(session.setContextTokenLimit(undefined)).resolves.toBeUndefined();
    // A real ratio is fixed at spawn — the host must respawn for it.
    await expect(session.setContextTokenLimit(16_384)).rejects.toThrow(/threshold/);
  });
});
