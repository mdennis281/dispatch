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
import { AuthoredConfigService } from "./authored-config.js";
import { SessionBroker } from "./session-broker.js";

let transfers: unknown[][] = [];
let transferResult: Promise<boolean> = Promise.resolve(false);
let specs: HarnessSessionSpec[];

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
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
  let bus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-harness-broker-"));
    store = new Store(dir);
    await store.init();
    session = new FakeHarnessSession();
    specs = [];
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
      createSession: (spec: HarnessSessionSpec) => { specs.push(spec); return session; },
      transferSession: (...args) => {
        transfers.push(args);
        return transferResult;
      },
    };
    transfers = [];
    transferResult = Promise.resolve(false);
    broker = new SessionBroker({
      store,
      bus: (bus = new EventBus()),
      harnesses: new HarnessRegistry({ harnesses: { codex } }),
      authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
      deps: { stopTimeoutMs: 5 },
    });
  });

  afterEach(async () => {
    await broker.dispose();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("injects the selected persona for Codex and keeps it through provider switching", async () => {
    const chat = await store.saveChat({ id: "persona", projectId: "p1", title: "PO", modeId: "plan", effort: "low", harness: "codex", personaId: "product-owner", worktrees: [], prs: [], createdAt: 1 });
    broker.create(chat);
    await broker.sendMessage(chat.id, "verify requirements");
    await broker.waitFor(chat.id, "idle");
    expect(specs[0]!.systemPromptAppends.join("\n")).toContain("principal-level product owner");
    expect(specs[0]!.agent).toBeUndefined();
    await broker.setHarness(chat.id, "claude");
    expect((await store.getChat(chat.id))!.personaId).toBe("product-owner");
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
    // Poll for the row rather than sleeping a fixed 20ms. The handler awaits an
    // image-persist and a store append before the row exists, and on a loaded CI
    // runner that window expired first — the assertion below then read a
    // transcript missing `tool_result` and reddened main on a commit whose own
    // PR had gone green.
    await waitUntil(async () =>
      (await store.readMessages(chat.id)).some((row) => row.kind === "tool_result"),
    );
    // A revive would be the status write immediately AFTER that row, so let one
    // more turn of the loop run before asserting it never came.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(broker.getStatus(chat.id)).toBe("failed");
    expect((await store.getChat(chat.id))?.status).toBe("failed");
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

  describe("switching login accounts", () => {
    async function withAccounts() {
      await store.saveSettings({
        theme: "dark",
        subscriptions: [
          { id: "codex1", name: "Codex one", provider: "codex" },
          { id: "codex2", name: "Codex two", provider: "codex", configDir: join(dir, "codex2") },
          { id: "claude2", name: "Claude two", provider: "claude", configDir: join(dir, "claude2") },
        ],
      });
    }

    async function pinned(subscriptionId: string | undefined, sessionId?: string) {
      const chat = await store.saveChat({
        id: `acct-${subscriptionId ?? "none"}`,
        projectId: "project-1",
        title: "Accounts",
        modeId: "plan",
        effort: "low",
        harness: "codex",
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      return chat;
    }

    it("runs a chat under its account's config dir, and the default account with no overlay", async () => {
      await withAccounts();
      const second = await pinned("codex2");
      await broker.sendMessage(second.id, "hi");
      await broker.waitFor(second.id, "idle");
      expect(specs[0]!.account).toMatchObject({
        subscriptionId: "codex2",
        env: { CODEX_HOME: join(dir, "codex2") },
      });

      session = new FakeHarnessSession();
      const first = await pinned("codex1");
      await broker.sendMessage(first.id, "hi");
      await broker.waitFor(first.id, "idle");
      // Empty, so a default-account spawn is exactly what it was before accounts.
      expect(specs[1]!.account).toMatchObject({ subscriptionId: "codex1", env: {} });
    });

    it("keeps the native session when the provider carries it across", async () => {
      await withAccounts();
      transferResult = Promise.resolve(true);
      const chat = await pinned("codex1", "thread-1");
      await broker.setSubscription(chat.id, "codex2");

      expect(transfers[0]![0]).toBe("thread-1");
      expect(transfers[0]![2]).toMatchObject({ configDir: join(dir, "codex2") });
      const saved = await store.getChat(chat.id);
      expect(saved).toMatchObject({ subscriptionId: "codex2", sessionId: "thread-1" });
      expect(saved?.harnessHandoff).toBeUndefined();
    });

    it("falls back to a transcript handoff when it can't", async () => {
      await withAccounts();
      const chat = await pinned("codex1", "thread-1");
      await broker.setSubscription(chat.id, "codex2");

      const saved = await store.getChat(chat.id);
      // The old id is only resumable from the old account's directory.
      expect(saved?.sessionId).toBeUndefined();
      expect(saved).toMatchObject({
        subscriptionId: "codex2",
        harnessHandoff: {
          from: "codex",
          to: "codex",
          fromSubscription: "codex1",
          toSubscription: "codex2",
        },
      });
    });

    it("moves provider when the account belongs to another one", async () => {
      await withAccounts();
      const chat = await pinned("codex1", "thread-1");
      await broker.setSubscription(chat.id, "claude2");

      const saved = await store.getChat(chat.id);
      expect(saved).toMatchObject({
        harness: "claude",
        subscriptionId: "claude2",
        harnessHandoff: { from: "codex", to: "claude" },
      });
      expect(transfers).toHaveLength(0);
    });
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

  describe("an answer to a card whose tool call the agent already gave up on", () => {
    const REVIEW = "mcp__dispatch-confirm__request_human_review";
    const ASK = "mcp__dispatch-confirm__ask_user";
    const review = {
      title: "Jellyfish drift",
      summary: "Jellyfish tip sideways with the current.",
      screenshots: [],
      prUrl: "https://github.com/o/r/pull/1",
    };

    async function codexChat(id: string) {
      session = new FakeHarnessSession(true);
      const chat = await store.saveChat({
        id,
        projectId: "project-1",
        title: "Codex review",
        modeId: "auto",
        effort: "low",
        harness: "codex",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "build it and ask me to review");
      session.emit({ type: "init", sessionId: `thread-${id}`, model: "gpt-test" });
      return chat.id;
    }

    function nextCard(): Promise<string> {
      return new Promise((resolve) => {
        const off = bus.on("permission-request", (e) => {
          off();
          resolve(e.request.id);
        });
      });
    }

    async function briefs(chatId: string) {
      return (await store.readMessages(chatId)).flatMap((row) =>
        row.kind === "user" ? (row.parts ?? []).filter((p) => p.kind === "brief") : [],
      );
    }

    it("delivers the verdict as a message, and leaves the chat's other cards open", async () => {
      const chatId = await codexChat("chat-late-review");
      session.emit({ type: "tool-use", toolUseId: "review-1", name: REVIEW, input: review });
      const reviewCard = nextCard();
      const verdict = broker.requestHumanReview(chatId, review);
      const reviewId = await reviewCard;
      // An unrelated question the delivery must NOT dismiss on the human's behalf.
      const askCard = nextCard();
      void broker.askUser(chatId, [
        { header: "Other", question: "Keep the old sliders?", options: [{ label: "Yes" }, { label: "No" }] },
      ]);
      const askId = await askCard;

      // Codex drops the call at its deadline and reports the call failed. The
      // bridge hears nothing, so the card is still up.
      session.emit({
        type: "tool-result",
        toolUseId: "review-1",
        ok: false,
        content: "timed out awaiting tools/call after 300s",
      });
      await waitUntil(async () =>
        (await store.readMessages(chatId)).some((row) => row.kind === "tool_result"),
      );

      expect(
        broker.answerQuestion(reviewId, {
          answer: "Keep iterating",
          notes: "they are bundled together too tightly",
        }),
      ).toBe(true);
      await expect(verdict).resolves.toMatchObject({ status: "reviewed", verdict: "iterate" });

      await waitUntil(async () => (await briefs(chatId)).length > 0);
      const [late] = await briefs(chatId);
      expect(late).toMatchObject({ label: "Late review verdict" });
      expect(late!.text).toContain("KEEP ITERATING");
      expect(late!.text).toContain("they are bundled together too tightly");
      // …and it reached the agent, not just the transcript.
      expect(session.sent.some((input) => input.text.includes("KEEP ITERATING"))).toBe(true);
      // The other card is still answerable.
      expect(broker.answerQuestion(askId, { answer: "Yes" })).toBe(true);
    });

    it("sends nothing extra when the call was still waiting for the answer", async () => {
      const chatId = await codexChat("chat-live-review");
      session.emit({ type: "tool-use", toolUseId: "review-2", name: REVIEW, input: review });
      const reviewCard = nextCard();
      const verdict = broker.requestHumanReview(chatId, review);
      broker.answerQuestion(await reviewCard, { answer: "Approve" });
      await expect(verdict).resolves.toMatchObject({ status: "reviewed", verdict: "approve" });
      session.emit({ type: "tool-result", toolUseId: "review-2", ok: true, content: "approved" });
      await waitUntil(async () =>
        (await store.readMessages(chatId)).some((row) => row.kind === "tool_result"),
      );

      expect(await briefs(chatId)).toEqual([]);
    });

    it("does not blame a live card for a call that failed without ever opening one", async () => {
      const chatId = await codexChat("chat-parallel-fail");
      // Two calls in one message: A is valid and puts its card up; B fails its
      // schema before any card exists.
      session.emit(
        { type: "tool-use", toolUseId: "ask-a", name: ASK, input: {} },
        { type: "tool-use", toolUseId: "ask-b", name: ASK, input: {} },
      );
      await waitUntil(async () =>
        (await store.readMessages(chatId)).filter((row) => row.kind === "tool_use").length === 2,
      );
      const card = nextCard();
      const answer = broker.askUser(chatId, [
        { header: "Scope", question: "Which species first?", options: [{ label: "Jellyfish" }, { label: "Skate" }] },
      ]);
      const cardId = await card;
      session.emit({ type: "tool-result", toolUseId: "ask-b", ok: false, content: "invalid arguments" });
      await waitUntil(async () =>
        (await store.readMessages(chatId)).some((row) => row.kind === "tool_result"),
      );

      broker.answerQuestion(cardId, { answer: "Skate" });
      await expect(answer).resolves.toMatchObject({ status: "answered" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A's live call got the answer; a second copy calling it "late" would be false.
      expect(await briefs(chatId)).toEqual([]);
    });

    it("delivers a late ask_user answer the same way", async () => {
      const chatId = await codexChat("chat-late-ask");
      session.emit({ type: "tool-use", toolUseId: "ask-1", name: ASK, input: {} });
      const card = nextCard();
      const answer = broker.askUser(chatId, [
        { header: "Scope", question: "Which species first?", options: [{ label: "Jellyfish" }, { label: "Skate" }] },
      ]);
      const cardId = await card;
      session.emit({ type: "tool-result", toolUseId: "ask-1", ok: false, content: "timed out" });
      await waitUntil(async () =>
        (await store.readMessages(chatId)).some((row) => row.kind === "tool_result"),
      );

      broker.answerQuestion(cardId, { answer: "Skate" });
      await expect(answer).resolves.toEqual({
        status: "answered",
        answers: { "Which species first?": "Skate" },
      });
      await waitUntil(async () => (await briefs(chatId)).length > 0);
      const [late] = await briefs(chatId);
      expect(late).toMatchObject({ label: "Late answer" });
      expect(late!.text).toContain("Which species first?");
      expect(late!.text).toContain("Skate");
    });
  });
});
