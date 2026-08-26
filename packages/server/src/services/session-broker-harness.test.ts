import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Harness,
  HarnessEvent,
  HarnessInput,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "../harness/types.js";
import { HarnessRegistry } from "../harness/index.js";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { SessionBroker } from "./session-broker.js";

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

class FakeHarnessSession implements HarnessSession {
  private queue: HarnessEvent[] = [];
  private wake?: () => void;
  private ended = false;
  private initialized = false;
  private failure?: Error;
  readonly sent: HarnessInput[] = [];

  constructor(
    private readonly manual = false,
    private readonly endOnDispose = true,
  ) {}

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<HarnessEvent>> => {
          while (!this.queue.length && !this.ended && !this.failure) {
            await new Promise<void>((resolve) => (this.wake = resolve));
          }
          if (this.failure) throw this.failure;
          const value = this.queue.shift();
          return value ? { value, done: false } : { value: undefined as never, done: true };
        },
      }),
    };
  }

  send(input: HarnessInput): void {
    this.sent.push(input);
    if (this.manual) return;
    if (!this.initialized) {
      this.initialized = true;
      this.emit({ type: "init", sessionId: "codex-thread-1", model: "gpt-test" });
    }
    this.emit(
      { type: "delta", id: "assistant-1", channel: "text", delta: "hello" },
      { type: "assistant", id: "assistant-1", text: "hello", model: "gpt-test" },
      { type: "usage", contextTokens: 42, contextWindow: 1_000 },
      { type: "turn-end", ok: true, subtype: "success", result: "hello" },
    );
  }

  emit(...events: HarnessEvent[]) {
    this.queue.push(...events);
    this.wake?.();
    this.wake = undefined;
  }

  fail(error: Error) {
    this.failure = error;
    this.wake?.();
    this.wake = undefined;
  }

  pending() { return 0; }
  async interrupt() {}
  async setPermissionMode() {}
  async setModel() {}
  async setEffort() {}
  async compact() {}
  resolvePermission(_id: string, _resolution: HarnessPermissionResolution) {}
  resolveQuestion(_id: string, _answers: HarnessQuestionAnswer[]) {}
  async contextWindow() { return 1_000; }
  async dispose() {
    if (!this.endOnDispose) return;
    this.ended = true;
    this.wake?.();
  }
}

describe("SessionBroker neutral harness path", () => {
  let dir: string;
  let store: Store;
  let broker: SessionBroker;
  let session: FakeHarnessSession;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-harness-broker-"));
    store = new Store(dir);
    await store.init();
    session = new FakeHarnessSession();
    const codex: Harness = {
      kind: "codex",
      capabilities: {
        toolPermissions: false,
        questions: true,
        subagents: false,
        skills: true,
        compaction: true,
        fork: true,
        usageLimits: true,
        liveModelSwitch: true,
        livePermissionSwitch: true,
        efforts: ["low", "medium", "high"],
        preToolGuard: false,
        managerTransport: "http",
      },
      runtime: () => ({ kind: "codex", source: "installed", available: true }),
      listModels: async () => [],
      readLimits: async () => null,
      generateText: async () => "title",
      createSession: (_spec: HarnessSessionSpec) => session,
    };
    broker = new SessionBroker({
      store,
      bus: new EventBus(),
      harnesses: new HarnessRegistry({ harnesses: { codex } }),
      deps: { stopTimeoutMs: 5 },
    });
  });

  afterEach(async () => {
    await broker.dispose();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists neutral Codex events and keeps the native thread id", async () => {
    const chat = await store.saveChat({
      id: "chat-1",
      projectId: "project-1",
      title: "Codex",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "say hello");
    await broker.waitFor(chat.id, "idle");

    expect(session.sent[0]).toMatchObject({ text: "say hello", effort: "low" });
    expect((await store.getChat(chat.id))?.sessionId).toBe("codex-thread-1");
    expect((await store.readMessages(chat.id)).map((row) => row.kind)).toEqual([
      "user",
      "system",
      "assistant",
      "result",
    ]);
  });

  it("does not let a late tool result revive a turn that already failed", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-late-result",
      projectId: "project-1",
      title: "Late result",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "run a tool");
    session.emit(
      { type: "init", sessionId: "thread-late", model: "gpt-test" },
      { type: "tool-use", toolUseId: "tool-1", name: "browser", input: {} },
      { type: "turn-end", ok: false, subtype: "interrupted", result: "interrupted" },
    );
    await broker.waitFor(chat.id, "failed");

    session.emit({ type: "tool-result", toolUseId: "tool-1", ok: false, content: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(broker.getStatus(chat.id)).toBe("failed");
    expect((await store.getChat(chat.id))?.status).toBe("failed");
    expect((await store.readMessages(chat.id)).map((row) => row.kind)).toContain("tool_result");
  });

  it("automatically resumes a turn interrupted by a late guard catch", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-guard-restart",
      projectId: "project-1",
      title: "Guard restart",
      modeId: "auto",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "ship it");
    session.emit(
      { type: "init", sessionId: "thread-guard", model: "gpt-test" },
      {
        type: "guard-blocked",
        toolName: "Bash",
        input: { command: "git push origin main" },
        reason: "use create_pr",
        continuation: "restart-turn",
      },
      { type: "turn-end", ok: false, subtype: "interrupted", result: "interrupted" },
    );

    await waitUntil(() => session.sent.length === 2);
    expect(broker.getStatus(chat.id)).toBe("running");
    expect(session.sent[1]?.text).toContain("Continue the task now");
    expect(session.sent[1]?.text).toContain("use create_pr");

    session.emit({ type: "turn-end", ok: true, subtype: "success", result: "done" });
    await broker.waitFor(chat.id, "idle");
    const rows = await store.readMessages(chat.id);
    expect(rows.find((row) => row.kind === "result" && row.subtype === "guard-recovered")).toMatchObject({
      isError: false,
    });
  });

  it("does not resume a guard-marked turn after the user explicitly interrupts", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-user-interrupt-after-guard",
      projectId: "project-1",
      title: "User interrupt after guard",
      modeId: "auto",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "ship it");
    await waitUntil(() => session.sent.length === 1);
    session.emit(
      { type: "init", sessionId: "thread-user-stop", model: "gpt-test" },
      {
        type: "guard-blocked",
        toolName: "Bash",
        input: { command: "git push origin main" },
        reason: "use create_pr",
        continuation: "restart-turn",
      },
    );

    expect(await broker.interrupt(chat.id)).toBe(true);
    session.emit({ type: "turn-end", ok: false, subtype: "interrupted", result: "interrupted" });

    await broker.waitFor(chat.id, "failed");
    expect(session.sent).toHaveLength(1);
    const rows = await store.readMessages(chat.id);
    expect(rows.some((row) => row.kind === "result" && row.subtype === "guard-recovered")).toBe(false);
    expect(rows.find((row) => row.kind === "result" && row.subtype === "interrupted")).toMatchObject({
      isError: true,
    });
  });

  it("does not carry a no-op Stop from a settled turn into later guard recovery", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-stale-user-interrupt",
      projectId: "project-1",
      title: "Stale user interrupt",
      modeId: "auto",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "first turn");
    await waitUntil(() => session.sent.length === 1);
    session.emit(
      { type: "init", sessionId: "thread-stale-stop", model: "gpt-test" },
      { type: "turn-end", ok: true, subtype: "success", result: "done" },
    );
    await broker.waitFor(chat.id, "idle");

    expect(await broker.interrupt(chat.id)).toBe(false);
    await broker.sendMessage(chat.id, "second turn");
    await waitUntil(() => session.sent.length === 2);
    session.emit(
      {
        type: "guard-blocked",
        toolName: "Bash",
        input: { command: "git push origin main" },
        reason: "use create_pr",
        continuation: "restart-turn",
      },
      { type: "turn-end", ok: false, subtype: "interrupted", result: "interrupted" },
    );

    await waitUntil(() => session.sent.length === 3);
    expect(session.sent[2]?.text).toContain("Continue the task now");
    session.emit({ type: "turn-end", ok: true, subtype: "success", result: "done" });
    await broker.waitFor(chat.id, "idle");
  });

  it("keeps a native pre-tool guard denial in the current turn", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-guard-in-place",
      projectId: "project-1",
      title: "Guard in place",
      modeId: "auto",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "ship it");
    session.emit(
      { type: "init", sessionId: "thread-native-guard", model: "gpt-test" },
      {
        type: "guard-blocked",
        toolName: "Bash",
        input: { command: "git push origin main" },
        reason: "use create_pr",
        continuation: "in-place",
      },
      { type: "turn-end", ok: true, subtype: "success", result: "continued" },
    );

    await broker.waitFor(chat.id, "idle");
    expect(session.sent).toHaveLength(1);
    expect((await store.readMessages(chat.id)).map((row) => row.kind)).toContain("notice");
  });

  it("forces a disposed provider out when its event iterator never closes", async () => {
    const first = new FakeHarnessSession(false, false);
    const second = new FakeHarnessSession();
    session = first;
    const chat = await store.saveChat({
      id: "chat-stuck-dispose",
      projectId: "project-1",
      title: "Stuck dispose",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "first");
    await broker.waitFor(chat.id, "idle");

    session = second;
    await broker.stop(chat.id);
    await broker.sendMessage(chat.id, "second");
    await broker.waitFor(chat.id, "idle");

    expect(first.sent.map((input) => input.text)).toEqual(["first"]);
    expect(second.sent.map((input) => input.text)).toEqual(["second"]);
  });

  it("does not carry a timed-out fork's stopping flag into the replacement provider", async () => {
    const first = new FakeHarnessSession(false, false);
    const second = new FakeHarnessSession(true);
    session = first;
    const chat = await store.saveChat({
      id: "chat-stuck-fork",
      projectId: "project-1",
      title: "Stuck fork",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "first");
    await broker.waitFor(chat.id, "idle");

    session = second;
    await broker.fork(chat.id, "turn-1");
    await broker.sendMessage(chat.id, "replacement");
    second.fail(new Error("replacement provider failed"));
    await broker.waitFor(chat.id, "error");

    expect(broker.getStatus(chat.id)).toBe("error");
  });

  it("stamps the producing provider on each row, so a later switch can't relabel it", async () => {
    const chat = await store.saveChat({
      id: "chat-stamp",
      projectId: "project-1",
      title: "Codex",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "say hello");
    await broker.waitFor(chat.id, "idle");

    const before = await store.readMessages(chat.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.map((row) => row.harness)).toEqual(before.map(() => "codex"));

    // The whole point: switching the chat to Claude must not rewrite who wrote
    // the turns Codex already produced.
    await broker.setHarness(chat.id, "claude");
    const after = await store.readMessages(chat.id);
    expect(after.map((row) => row.harness)).toEqual(before.map(() => "codex"));
  });

  it("resolves chat-relative image refs before sending them to Codex", async () => {
    const chat = await store.saveChat({
      id: "chat-image",
      projectId: "project-1",
      title: "Codex image",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    const path = await store.writeChatAsset(chat.id, "shot.png", Buffer.from("image"));

    broker.create(chat, null, join(dir, "repo"));
    await broker.sendMessage(chat.id, "inspect this", {
      images: [
        { id: "image-1", path, mimeType: "image/png" },
        { id: "image-2", path: "docs/repo-relative.png", mimeType: "image/png" },
        { id: "image-3", path: "assets/..", mimeType: "image/png" },
      ],
    });
    await broker.waitFor(chat.id, "idle");

    expect(session.sent[0]?.images).toEqual([
      {
        id: "image-1",
        path: join(store.chatAssetsDir(chat.id), "shot.png"),
        mimeType: "image/png",
      },
      { id: "image-2", path: "docs/repo-relative.png", mimeType: "image/png" },
      { id: "image-3", path: "assets/..", mimeType: "image/png" },
    ]);
  });

  it("switches providers without reusing an incompatible native session", async () => {
    const chat = await store.saveChat({
      id: "chat-2",
      projectId: "project-1",
      title: "Switch me",
      modeId: "auto",
      effort: "medium",
      harness: "codex",
      sessionId: "codex-thread-old",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.setHarness(chat.id, "claude");

    const saved = await store.getChat(chat.id);
    expect(saved).toMatchObject({
      harness: "claude",
      harnessHandoff: { from: "codex", to: "claude" },
      status: "idle",
    });
    expect(saved?.sessionId).toBeUndefined();
  });
});
