import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent, HarnessSessionSpec } from "@dispatch/shared";
import { ClaudeSession } from "./session.js";

const SPEC: HarnessSessionSpec = {
  permissionMode: "bypassPermissions",
  effort: "low",
  systemPromptAppends: [],
  mcpServers: {},
  skills: [],
};

describe("ClaudeSession workflow guard", () => {
  it("reports a native PreToolUse denial as an in-place continuation", async () => {
    const session = new ClaudeSession({
      spec: {
        ...SPEC,
        toolGuard: async (_name, input, ctx) =>
          input.command === "git push origin main" && ctx.cwd === "/repo" ? "use create_pr" : null,
      },
      genId: () => "id-1",
    });
    const hook = (
      session as unknown as {
        guardHook(): (input: unknown) => Promise<Record<string, unknown>>;
      }
    ).guardHook();

    const output = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      cwd: "/repo",
    });
    const event = await session.events[Symbol.asyncIterator]().next();

    expect(output).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "use create_pr",
      },
    });
    expect(event.value as HarnessEvent).toEqual({
      type: "guard-blocked",
      toolName: "Bash",
      // The cwd reached the guard through its context, not the input.
      input: { command: "git push origin main" },
      reason: "use create_pr",
      continuation: "in-place",
    });
    await session.dispose();
  });
});

describe("ClaudeSession compaction window", () => {
  const settingsFor = (spec: Partial<HarnessSessionSpec>) =>
    (
      new ClaudeSession({ spec: { ...SPEC, ...spec }, genId: () => "id" }) as unknown as {
        buildOptions(): { settings?: Record<string, unknown> };
      }
    ).buildOptions().settings;

  it("derives the CLI's window from the neutral limit so its own trigger lands on it", () => {
    expect(settingsFor({ contextTokenLimit: 100_000 })).toMatchObject({ autoCompactWindow: 133_000 });
  });

  it("leaves the window to the CLI with no limit, and ignores a value it would drop", () => {
    expect(settingsFor({})?.autoCompactWindow).toBeUndefined();
    expect(settingsFor({ autoCompactWindow: 20_000 })?.autoCompactWindow).toBeUndefined();
    expect(settingsFor({ autoCompactWindow: 400_000 })).toMatchObject({ autoCompactWindow: 400_000 });
  });
});

/* ------------------------------------------- parity with the direct loop (#427) */

type QueryOpt = ConstructorParameters<typeof ClaudeSession>[0]["query"];

interface FakeQuery {
  options: Record<string, unknown>;
  /** User messages the session pushed, in order. */
  inputs: Record<string, unknown>[];
  /** Feed the session one SDK message. */
  push(msg: Record<string, unknown>): void;
  /** Make the stream throw, as a dead subprocess does. */
  crash(err: Error): void;
  calls: Record<string, unknown[]>;
  usage: Record<string, unknown> | undefined;
  live: Record<string, unknown>;
}

/**
 * A scripted SDK `query`: records what it was started with and every message
 * the session pushes, and yields only what the test feeds it.
 */
function fakeQuery(): { fn: QueryOpt; q: () => FakeQuery } {
  let current: FakeQuery | undefined;
  const fn = ((params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    const out: Record<string, unknown>[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    const calls: Record<string, unknown[]> = {};
    const record = (name: string) => async (arg?: unknown) => {
      (calls[name] ??= []).push(arg);
    };
    async function* stream() {
      for (;;) {
        while (!out.length && !failure) await new Promise<void>((r) => (wake = r));
        if (failure) throw failure;
        yield out.shift();
      }
    }
    const it = stream();
    const live: Record<string, unknown> = {
      [Symbol.asyncIterator]: () => it,
      next: () => it.next(),
      interrupt: record("interrupt"),
      setModel: record("setModel"),
      setPermissionMode: record("setPermissionMode"),
      setMaxThinkingTokens: record("setMaxThinkingTokens"),
      applyFlagSettings: record("applyFlagSettings"),
      getContextUsage: async () => fq.usage ?? { totalTokens: 0, maxTokens: 0 },
    };
    const fq: FakeQuery = {
      options: params.options ?? {},
      inputs: [],
      push: (msg) => {
        out.push(msg);
        wake?.();
      },
      crash: (err) => {
        failure = err;
        wake?.();
      },
      calls,
      usage: undefined,
      live,
    };
    current = fq;
    void (async () => {
      for await (const m of params.prompt) fq.inputs.push(m as Record<string, unknown>);
    })();
    return live;
  }) as unknown as QueryOpt;
  return { fn, q: () => current! };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Drain a session's events in the background, keeping what it saw and how it ended. */
function reader(session: ClaudeSession) {
  const it = session.events[Symbol.asyncIterator]();
  const seen: HarnessEvent[] = [];
  let error: unknown;
  void (async () => {
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        seen.push(n.value);
      }
    } catch (err) {
      error = err;
    }
  })();
  return { seen, error: () => error };
}

describe("ClaudeSession parity with the broker's direct loop", () => {
  it("reads the effort the runtime applied from effort.level, per thread", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    q().push({ type: "system", subtype: "init", session_id: "s1" });
    q().push({
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "t-agent", name: "Agent", input: {} }] },
      parent_tool_use_id: null,
    });
    await settle();
    const hook = (q().options.hooks as { PreToolUse: { hooks: ((i: unknown) => Promise<unknown>)[] }[] })
      .PreToolUse[0]!.hooks[0]!;
    // The main loop, then a call inside the subagent run t-agent spawned.
    await hook({ effort: { level: "high" }, tool_use_id: "t-agent" });
    q().push({
      type: "assistant",
      message: { id: "m2", content: [{ type: "tool_use", id: "t-sub", name: "Read", input: {} }] },
      parent_tool_use_id: "t-agent",
    });
    await settle();
    await hook({ effort: { level: "low" }, agent_id: "a1", tool_use_id: "t-sub" });
    q().push({
      type: "assistant",
      message: { id: "m3", content: [{ type: "text", text: "main" }] },
      parent_tool_use_id: null,
    });
    q().push({
      type: "assistant",
      message: { id: "m4", content: [{ type: "text", text: "sub" }] },
      parent_tool_use_id: "t-agent",
    });
    await settle();
    const efforts = events.seen
      .filter((e): e is Extract<HarnessEvent, { type: "assistant" }> => e.type === "assistant")
      .map((e) => [e.text, e.effort]);
    expect(efforts).toEqual([
      ["main", "high"],
      ["sub", "low"],
    ]);
    await s.dispose();
  });

  it("changes effort live through the flag settings first", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    s.send({ text: "go" });
    await settle();
    await s.setEffort("max");
    expect(q().calls.applyFlagSettings).toEqual([{ effortLevel: "max" }]);
    expect(q().calls.setMaxThinkingTokens).toBeUndefined();
    await s.dispose();
  });

  it("falls back to the thinking budget when the flag layer refuses", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    s.send({ text: "go" });
    await settle();
    q().live.applyFlagSettings = async () => {
      throw new Error("unknown setting");
    };
    await s.setEffort("high");
    // The broker's numbers — there used to be two tables that disagreed.
    expect(q().calls.setMaxThinkingTokens).toEqual([16_000]);
    await s.dispose();
  });

  it("sends a local image as base64 bytes AFTER the text, never as a file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-session-img-"));
    await writeFile(join(dir, "shot.png"), Buffer.from("PNGDATA"));
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: { ...SPEC, cwd: dir }, query: fn, genId: () => "g" });
    s.send({
      text: "what is this",
      images: [
        { id: "1", path: join(dir, "shot.png") },
        { id: "2", path: "data:image/jpeg;base64,QUJD" },
        { id: "3", path: "https://example.com/a.gif" },
        { id: "4", path: join(dir, "missing.png") },
      ],
    });
    await settle();
    expect(q().inputs[0]).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from("PNGDATA").toString("base64"),
            },
          },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          { type: "image", source: { type: "url", url: "https://example.com/a.gif" } },
        ],
      },
    });
    await s.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a text-only message a plain string", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    s.send({ text: "hi", priority: "now" });
    await settle();
    expect(q().inputs[0]).toMatchObject({ message: { content: "hi" }, priority: "now" });
    await s.dispose();
  });

  it("puts the CLI's own wording and the asking run on the permission event", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "req-1" });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    q().push({
      type: "assistant",
      message: { id: "m", content: [{ type: "tool_use", id: "t-sub", name: "Bash", input: {} }] },
      parent_tool_use_id: "t-agent",
    });
    await settle();
    const canUseTool = q().options.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      o: Record<string, unknown>,
    ) => Promise<unknown>;
    void canUseTool("Bash", { command: "ls" }, {
      title: "Claude wants to run ls",
      displayName: "Run command",
      description: "Lists files",
      toolUseID: "t-sub",
      agentID: "a1",
    });
    await settle();
    expect(events.seen.find((e) => e.type === "permission-request")).toMatchObject({
      title: "Claude wants to run ls",
      displayName: "Run command",
      description: "Lists files",
      parentToolUseId: "t-agent",
    });
    await s.dispose();
  });

  it("starts the session for a compaction asked before anything ran", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    await s.compact("keep the plan");
    await settle();
    // Pushed straight at a channel that did not exist yet, this went nowhere.
    expect(q().inputs.map((m) => (m.message as { content: unknown }).content)).toEqual([
      "/compact keep the plan",
    ]);
    await s.clear();
    await settle();
    expect((q().inputs[1]!.message as { content: unknown }).content).toBe("/clear");
    await s.dispose();
  });

  it("takes a limit move the CLI would clamp away, and refuses one it would notice", async () => {
    const { fn } = fakeQuery();
    const s = new ClaudeSession({
      spec: { ...SPEC, contextTokenLimit: 100_000 },
      query: fn,
      genId: () => "g",
    });
    // Not started: anything goes, and the spawn reads the new value.
    await s.setContextTokenLimit(120_000);
    s.send({ text: "go" });
    await settle();
    // A window the CLI would drop derives the same window — nothing to respawn for.
    await expect(s.setContextTokenLimit(120_000, 20_000)).resolves.toBeUndefined();
    await expect(s.setContextTokenLimit(300_000)).rejects.toThrow(/compaction window/);
    await s.dispose();
  });

  it("enables the skills the host put on disk", () => {
    const opts = (spec: Partial<HarnessSessionSpec>) =>
      (
        new ClaudeSession({ spec: { ...SPEC, ...spec }, genId: () => "g" }) as unknown as {
          buildOptions(): Record<string, unknown>;
        }
      ).buildOptions();
    expect(opts({ skills: [{ name: "deploy", dir: "/r/.claude/skills/deploy" }] }).skills).toBe("all");
    expect(opts({}).skills).toBeUndefined();
  });

  it("reports the post-compaction size the CLI counts, not the summary alone", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    q().usage = { totalTokens: 29_000, maxTokens: 200_000 };
    q().push({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 3_000 },
    });
    q().push({ type: "result", subtype: "success", is_error: false });
    await settle();
    expect(events.seen.find((e) => e.type === "compacted")).toMatchObject({ postTokens: 29_000 });
    // …and the turn-end after it doesn't put the 3k back.
    expect(events.seen.find((e) => e.type === "turn-end")).toMatchObject({ contextTokens: 29_000 });
    await s.dispose();
  });

  it("learns the model's window once the process is live", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    q().usage = { totalTokens: 10_000, maxTokens: 1_000_000 };
    q().push({ type: "system", subtype: "init", session_id: "s1" });
    await settle();
    expect(events.seen).toContainEqual({ type: "usage", contextWindow: 1_000_000 });
    expect(await s.contextWindow()).toBe(1_000_000);
    expect(await s.contextUsage()).toMatchObject({ totalTokens: 10_000, maxTokens: 1_000_000 });
    await s.dispose();
  });

  it("reports a dead runtime by THROWING, not as a failed turn", async () => {
    const { fn, q } = fakeQuery();
    const s = new ClaudeSession({ spec: SPEC, query: fn, genId: () => "g" });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    q().crash(new Error("Claude Code process exited with code 1"));
    await settle();
    expect(events.seen.some((e) => e.type === "turn-end")).toBe(false);
    expect(String(events.error())).toMatch(/exited with code 1/);
  });

  it("kills the tree when the host aborts, and calls that a stop rather than a crash", async () => {
    const { fn, q } = fakeQuery();
    const host = new AbortController();
    const s = new ClaudeSession({
      spec: { ...SPEC, abortSignal: host.signal },
      query: fn,
      genId: () => "g",
    });
    const events = reader(s);
    s.send({ text: "go" });
    await settle();
    const sdkAbort = q().options.abortController as AbortController;
    expect(sdkAbort.signal.aborted).toBe(false);
    host.abort();
    await settle();
    expect(sdkAbort.signal.aborted).toBe(true);
    expect(events.error()).toBeUndefined();
  });
});
