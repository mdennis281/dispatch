import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
// The real descriptors, because these suites assert on what a Codex or goose
// chat gets — its efforts, skills dir and account env all come from them.
import { CODEX_PROVIDER } from "@dispatch/plugin-codex/descriptor";
import { GOOSE_PROVIDER } from "@dispatch/plugin-goose/descriptor";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { AuthoredConfigService } from "./authored-config.js";
import { SessionBroker } from "./session-broker.js";
import { ManagerMcpBridge } from "./mcp/manager-http.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GLOBAL_MODE_ID, GLOBAL_PROJECT_ID, resolveWorkflow } from "@dispatch/shared";
import type { WsServerEvent } from "@dispatch/shared";
import { EXEMPTION_ANSWERS } from "./mcp/manager-mcp.js";

let transfers: unknown[][] = [];
/**
 * The fake runtime's capabilities, mutable so a test can model a DIFFERENT
 * runtime's. The global-chat suite needs one that can veto a tool call before
 * it runs, because the broker refuses a protected posture on one that can't —
 * and the default here models Codex, which can't.
 */
let caps: { preToolGuard: boolean; guardsMcpToolNames: boolean } & Record<string, unknown>;
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
  readonly compactions: (string | undefined)[] = [];
  /** Make `compact` end a turn of its own, the way a real runtime's does. */
  compactEndsTurn = false;
  async compact(focus?: string) {
    this.compactions.push(focus);
    // No `usage` event: a compaction that had nothing to do leaves the reading
    // where it was — the Claude CLI's "Not enough messages to compact".
    if (this.compactEndsTurn) {
      this.emit({ type: "turn-end", ok: true, subtype: "success", result: "Not enough messages to compact." });
    }
  }
  readonly resolutions: [string, HarnessPermissionResolution][] = [];
  resolvePermission(id: string, resolution: HarnessPermissionResolution) {
    this.resolutions.push([id, resolution]);
  }
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
    caps = {
      toolPermissions: false,
      questions: true,
      subagents: false,
      skills: true,
      compaction: true,
      fork: true,
      usageLimits: true,
      liveModelSwitch: true,
      nativeContextLimit: true,
      livePermissionSwitch: true,
      efforts: ["low", "medium", "high"],
      preToolGuard: false,
      guardsMcpToolNames: true,
      managerTransport: "http",
    };
    const codex: Harness = {
      kind: "codex",
      capabilities: caps as unknown as Harness["capabilities"],
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
      harnesses: new HarnessRegistry({ providers: [{ harness: codex, descriptor: CODEX_PROVIDER }] }),
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

  describe("Dispatch's own tools", () => {
    // Handed over explicitly — the neutral servers and the context they close
    // over — rather than recovered off Claude-SDK config objects, which is what
    // tied a Codex or goose chat's toolbox to the Claude SDK (#423).
    let bridge: ManagerMcpBridge;

    beforeEach(async () => {
      await broker.dispose();
      bridge = new ManagerMcpBridge("http://127.0.0.1:4319");
      const codex: Harness = {
        kind: "codex",
        capabilities: caps as unknown as Harness["capabilities"],
        runtime: () => ({ kind: "codex", source: "installed", available: true }),
        listModels: async () => [],
        readLimits: async () => null,
        generateText: async () => "title",
        createSession: (spec: HarnessSessionSpec) => { specs.push(spec); return session; },
      };
      broker = new SessionBroker({
        store,
        bus,
        harnesses: new HarnessRegistry({ providers: [{ harness: codex, descriptor: CODEX_PROVIDER }] }),
        authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
        managerMcp: bridge,
        deps: { stopTimeoutMs: 5 },
      });
    });

    async function run(id: string): Promise<HarnessSessionSpec> {
      const chat = await store.saveChat({ id, projectId: "p1", title: "t", modeId: "plan", effort: "low", harness: "codex", worktrees: [], prs: [], createdAt: 1 });
      broker.create(chat);
      await broker.sendMessage(chat.id, "go");
      await broker.waitFor(chat.id, "idle");
      return specs.at(-1)!;
    }

    it("mints an HTTP grant against the session's own context, one URL per built category", async () => {
      const spec = await run("http");
      const manager = spec.managerMcp;
      if (manager?.transport !== "http") throw new Error(`expected http, got ${manager?.transport}`);
      expect(Object.keys(manager.urls)).toEqual(
        expect.arrayContaining(["dispatch-chat", "dispatch-confirm", "dispatch-session"]),
      );
      expect(manager.urls["dispatch-session"]).toBe("http://127.0.0.1:4319/api/mcp/manager/session");
      const grant = bridge.resolve(`Bearer ${manager.token}`);
      expect(grant?.chatId).toBe("http");
      expect(grant?.context().chatId).toBe("http");
    });

    it("hands an in-process runtime plain MCP-SDK servers, not Claude configs", async () => {
      caps.managerTransport = "in-process";
      const spec = await run("inproc");
      const manager = spec.managerMcp;
      if (manager?.transport !== "in-process") throw new Error(`expected in-process, got ${manager?.transport}`);
      expect(Object.keys(manager.servers)).toEqual(
        expect.arrayContaining(["dispatch-chat", "dispatch-confirm", "dispatch-session"]),
      );
      for (const server of Object.values(manager.servers)) expect(server).toBeInstanceOf(McpServer);
      // No grant: an in-process runtime never dials the bridge.
      expect(bridge.size()).toBe(0);
    });
  });

  it("falls back BEFORE building options, so an uninstalled provider's skills land where Claude reads", async () => {
    // A chat left on a provider nothing registers runs on the default. The
    // options used to be built first, against the placeholder descriptor, so
    // the skills went to `.agents/skills` and the Claude session found none.
    const repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await store.saveProject({ id: "p-ghost", name: "Ghost", repoPath: repo, worktreeRoot: join(dir, "trees"), subApps: [], createdAt: 1 });
    const claudeSpecs: HarnessSessionSpec[] = [];
    const claude: Harness = {
      kind: "claude",
      capabilities: caps as unknown as Harness["capabilities"],
      runtime: () => ({ kind: "claude", source: "installed", available: true }),
      listModels: async () => [],
      readLimits: async () => null,
      generateText: async () => "title",
      createSession: (spec: HarnessSessionSpec) => { claudeSpecs.push(spec); return new FakeHarnessSession(); },
    };
    const ghostBroker = new SessionBroker({
      store,
      bus: new EventBus(),
      harnesses: new HarnessRegistry({ harnesses: { claude } }),
      authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
      deps: { stopTimeoutMs: 5 },
    });
    try {
      const chat = await store.saveChat({ id: "ghost", projectId: "p-ghost", title: "Ghost", modeId: "plan", effort: "low", harness: "gemini", worktrees: [], prs: [], createdAt: 1 });
      ghostBroker.create(chat);
      await ghostBroker.sendMessage(chat.id, "hello");
      await ghostBroker.waitFor(chat.id, "idle");
      expect(claudeSpecs).toHaveLength(1);
      expect((await readdir(join(repo, ".claude", "skills"))).length).toBeGreaterThan(0);
      await expect(readdir(join(repo, ".agents"))).rejects.toThrow();
    } finally {
      await ghostBroker.dispose();
    }
  });

  it("waits for an installed provider plugin to activate instead of falling back", async () => {
    // Installed plugins activate in `warm()`, after listen. A chat on one that
    // starts in that window used to fall back to Claude and have `harness`
    // rewritten on its row, so it stayed on Claude once the plugin was up.
    const lateSpecs: HarnessSessionSpec[] = [];
    const late: Harness = {
      kind: "late",
      capabilities: caps as unknown as Harness["capabilities"],
      runtime: () => ({ kind: "late", source: "installed", available: true }),
      listModels: async () => [],
      readLimits: async () => null,
      generateText: async () => "title",
      createSession: (spec: HarnessSessionSpec) => { lateSpecs.push(spec); return new FakeHarnessSession(); },
    };
    const registry = new HarnessRegistry({ providers: [{ harness: { ...late, kind: "codex" }, descriptor: CODEX_PROVIDER }] });
    const lateBroker = new SessionBroker({
      store,
      bus: new EventBus(),
      harnesses: registry,
      authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
      deps: { stopTimeoutMs: 5 },
    });
    lateBroker.plugins = {
      modes: () => [],
      mcpServers: () => [],
      // Activation lands while the chat is waiting on it.
      activationSettled: async () => {
        registry.register(late, { ...CODEX_PROVIDER, id: "late", label: "Late" });
      },
    };
    try {
      const chat = await store.saveChat({ id: "late-chat", projectId: "p1", title: "Late", modeId: "plan", effort: "low", harness: "late", worktrees: [], prs: [], createdAt: 1 });
      lateBroker.create(chat);
      await lateBroker.sendMessage(chat.id, "hello");
      await lateBroker.waitFor(chat.id, "idle");
      expect(lateSpecs).toHaveLength(1);
      expect((await store.getChat(chat.id))!.harness).toBe("late");
    } finally {
      await lateBroker.dispose();
    }
  });

  it("pays off a mid-turn policy switch once the turn settles, not 'eventually'", async () => {
    // The catalogue a runtime is built with is fixed, so a policy change owes
    // it a restart — and `setMode` cannot take one on the spot, because
    // `chat_set_mode` is a tool the agent can call on its own chat and
    // `stop()` would wait on the run loop waiting on that handler. Skipping it
    // is only safe if something later actually does it: otherwise a chat
    // switched OUT of a restrictive mode keeps its newly allowed tools
    // unregistered for the rest of the runtime's life.
    session = new FakeHarnessSession(true);
    await store.saveMode({
      id: "audit",
      name: "Audit",
      permissionMode: "default",
      disallowedTools: ["Bash"],
      scope: "global",
    });
    const chat = await store.saveChat({
      id: "policy-switch",
      projectId: "p1",
      title: "Audit",
      modeId: "audit",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "look around");
    await waitUntil(() => specs.length === 1);
    expect(specs[0]!.disallowedTools).toContain("Bash");
    expect(broker.getSession(chat.id)?.status).toBe("running");

    // Mid-turn: the runtime must survive the switch rather than be torn down
    // under the turn it is serving.
    await broker.setMode(chat.id, "plan");
    expect(broker.getSession(chat.id)?.started).toBe(true);

    session.emit({ type: "turn-end", ok: true, subtype: "success", result: "done" });
    await waitUntil(() => broker.getSession(chat.id)?.started === false);
    // And the next turn is built without the denylist it was carrying.
    await broker.sendMessage(chat.id, "again");
    await waitUntil(() => specs.length === 2);
    expect(specs[1]!.disallowedTools).toBeUndefined();
  });

  /**
   * The global chat's posture, proven rather than asserted.
   *
   * These go through the real broker: a chat whose `projectId` is the reserved
   * id resolves the `global` mode through the ordinary posture chain, and the
   * session spec it produces is what any runtime receives. The guard is called
   * the way a PreToolUse hook calls it.
   */
  describe("the global chat", () => {
    // The fake runtime models Codex, which cannot veto a call before it runs
    // — and the broker refuses a protected posture there (see below, and
    // `requiresPreToolGuard` in the broker). Every other test in this suite
    // wants a runtime that CAN, so it is granted here rather than globally.
    beforeEach(() => {
      caps.preToolGuard = true;
      caps.guardsMcpToolNames = true;
    });

    const globalChat = () =>
      store.saveChat({
        id: "global-1",
        projectId: GLOBAL_PROJECT_ID,
        title: "Global",
        harness: "codex",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });

    it("lands in the global mode with nothing pinned, and refuses to leave it", async () => {
      const chat = await globalChat();
      broker.create(chat);
      // Deliberately NOT asserted after a turn: `setMode(null)` walks the same
      // posture chain `buildOptions` does, synchronously, so this proves the
      // resolution without depending on how long a fake turn takes to settle.
      await broker.setMode(chat.id, null);
      expect(broker.getSession(chat.id)?.modeId).toBe(GLOBAL_MODE_ID);
      await expect(broker.setMode(chat.id, "yolo")).rejects.toThrow(/always runs in global/);
      expect(broker.getSession(chat.id)?.modeId).toBe(GLOBAL_MODE_ID);
    });

    it("hands the runtime a denylist, so the tools are never offered at all", async () => {
      const chat = await globalChat();
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await broker.waitFor(chat.id, "idle");
      const denied = specs[0]!.disallowedTools ?? [];
      expect(denied).toContain("Bash");
      expect(denied).toContain("Edit");
      expect(denied).toContain("mcp__dispatch-workspace__worktree");
      expect(denied).toContain("mcp__dispatch-github__approve_pr");
      expect(denied).not.toContain("mcp__dispatch-chat__spawn_chat");
    });

    it("refuses a worktree, a merge and an edit at the guard — and lets a spawn through", async () => {
      const chat = await globalChat();
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await broker.waitFor(chat.id, "idle");
      const guard = specs[0]!.toolGuard!;

      // The three the posture exists to stop…
      expect(await guard("mcp__dispatch-workspace__worktree", { action: "create" }, {})).toMatch(
        /not available in Global mode/,
      );
      expect(await guard("mcp__dispatch-github__approve_pr", { number: 1 }, {})).toMatch(
        /not available in Global mode/,
      );
      expect(await guard("Edit", { file_path: "C:/x.ts" }, {})).toMatch(/not available in Global mode/);
      // …and the shell, which is otherwise all three in one command.
      expect(await guard("Bash", { command: "echo hi" }, {})).toMatch(/not available in Global mode/);

      // …and the one it exists to ENABLE.
      expect(await guard("mcp__dispatch-chat__spawn_chat", { prompt: "go" }, {})).toBeNull();
      expect(await guard("Read", { file_path: "C:/x.ts" }, {})).toBeNull();
    });

    it("ignores a mode pinned on the row, however it got there", async () => {
      // `PUT /api/chats/:id` merges its body over the row and saves directly —
      // no posture resolution, no broker — so `{ modeId: "yolo" }` lands as a
      // pin. `refreshInheritedPosture` then sees a defined pin and never
      // re-resolves: the chat would come up on `bypassPermissions` with
      // `resolveMode("yolo")` returning null, i.e. no denylist at all. A row
      // can also predate this change or be edited by hand, so the broker drops
      // the pin rather than trusting whoever wrote it.
      const chat = await store.saveChat({
        id: "global-poisoned",
        projectId: GLOBAL_PROJECT_ID,
        title: "Global",
        harness: "codex",
        modeId: "yolo",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      expect(broker.getSession(chat.id)?.modeId).toBe(GLOBAL_MODE_ID);
      await broker.sendMessage(chat.id, "hello");
      await broker.waitFor(chat.id, "idle");
      expect(specs[0]!.disallowedTools).toContain("Bash");
      expect(specs[0]!.permissionMode).not.toBe("bypassPermissions");
      expect(await specs[0]!.toolGuard!("Bash", { command: "echo hi" }, {})).toMatch(/not available/);
    });

    it("refuses a runtime that cannot name an MCP call, even if it vetoes in time", async () => {
      // The two capabilities fail independently. ACP is the real case: it
      // refuses BEFORE the call, but its permission requests carry no server
      // name, so `mcp__dispatch-workspace__worktree` never matches — and
      // nearly everything this posture denies is namespaced. In time but
      // unnamed is not enforcement.
      caps.preToolGuard = true;
      caps.guardsMcpToolNames = false;
      const chat = await globalChat();
      const errors: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "error") errors.push(`${e.message} ${e.detail ?? ""}`);
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await waitUntil(() => errors.some((m) => /which MCP tool a call is for/.test(m)));
      expect(specs).toHaveLength(0);
    });

    it("refuses to start on a runtime that can only catch a violation late", async () => {
      // The posture IS its denylist. A runtime that notices a `worktree` call
      // only once it has started notices it after the worktree exists, so
      // running there would be a posture that isn't holding — and silence
      // about that is worse than a refusal that names the fix.
      caps.preToolGuard = false;
      const chat = await globalChat();
      const errors: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "error") errors.push(`${e.message} ${e.detail ?? ""}`);
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await waitUntil(() => errors.some((m) => /cannot run on Codex/.test(m)));
      expect(specs).toHaveLength(0);
    });

    it("names the installed runtimes that CAN hold the posture, not a hard-coded Claude", async () => {
      // #422: Dispatch must work with no Claude at all, so "switch to Claude"
      // is advice the human may have no way to take.
      caps.preToolGuard = false;
      const goose: Harness = {
        kind: "goose",
        capabilities: {
          ...(caps as unknown as Harness["capabilities"]),
          preToolGuard: true,
          guardsMcpToolNames: true,
        },
        runtime: () => ({ kind: "goose", source: "installed", available: true }),
        listModels: async () => [],
        readLimits: async () => null,
        generateText: async () => "title",
        createSession: () => session,
      };
      (broker as unknown as { harnesses: HarnessRegistry }).harnesses.register(goose, GOOSE_PROVIDER);
      const chat = await globalChat();
      const errors: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "error") errors.push(`${e.message} ${e.detail ?? ""}`);
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await waitUntil(() => errors.some((m) => /cannot run on Codex/.test(m)));
      const message = errors.find((m) => /cannot run on Codex/.test(m))!;
      expect(message).toMatch(new RegExp(`runtime that can \\([^)]*${GOOSE_PROVIDER.label}`));
      expect(message).not.toMatch(/\(Claude\)/);
    });

    it("carries the project index and the posture overlay, and nothing bigger", async () => {
      await store.saveProject({
        id: "alpha",
        name: "Alpha",
        repoPath: "C:/repos/alpha",
        worktreeRoot: "C:/repos/alpha-trees",
        subApps: [],
        createdAt: 1,
      });
      const chat = await globalChat();
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await broker.waitFor(chat.id, "idle");
      const appended = specs[0]!.systemPromptAppends.join("\n\n");
      expect(appended).toContain("## Projects on this install");
      expect(appended).toContain("- Alpha `alpha` — C:/repos/alpha");
      // The pseudo-project must not offer itself as somewhere to spawn into.
      expect(appended).not.toContain(GLOBAL_PROJECT_ID);
      // And the posture explains itself in the transcript's own terms.
      expect(appended).toContain("You are the GLOBAL chat");
    });
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

    // Idle, not failed: the user stopped it, so there is no error to clear.
    await broker.waitFor(chat.id, "idle");
    expect(session.sent).toHaveLength(1);
    const rows = await store.readMessages(chat.id);
    expect(rows.some((row) => row.kind === "result" && row.subtype === "guard-recovered")).toBe(false);
    expect(rows.find((row) => row.kind === "result" && row.subtype === "interrupted")).toMatchObject({
      isError: false,
    });
  });

  it("settles a user Stop as a stopped turn, not a failure, whatever the provider calls it", async () => {
    session = new FakeHarnessSession(true);
    const chat = await store.saveChat({
      id: "chat-user-stop",
      projectId: "project-1",
      title: "User stop",
      modeId: "auto",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    broker.create(chat);
    await broker.sendMessage(chat.id, "long job");
    await waitUntil(() => session.sent.length === 1);
    session.emit({ type: "init", sessionId: "thread-stop", model: "gpt-test" });

    expect(await broker.interrupt(chat.id)).toBe(true);
    // What the Claude harness actually reports for a Stop: a failed turn with
    // no message at all, which is what used to read "Turn ended with an error".
    session.emit({ type: "turn-end", ok: false, subtype: "error_during_execution" });

    await broker.waitFor(chat.id, "idle");
    const rows = await store.readMessages(chat.id);
    expect(rows.find((row) => row.kind === "result")).toMatchObject({
      subtype: "interrupted",
      isError: false,
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

  it("hands uploaded files to the agent by path, and keeps them out of the image list", async () => {
    const chat = await store.saveChat({
      id: "chat-file",
      projectId: "project-1",
      title: "Codex file",
      modeId: "plan",
      effort: "low",
      harness: "codex",
      worktrees: [],
      prs: [],
      createdAt: 1,
    });
    const shot = await store.writeChatAsset(chat.id, "shot.png", Buffer.from("image"));
    const doc = await store.writeChatAsset(chat.id, "abc12345-report.pdf", Buffer.from("%PDF-1.7"));

    broker.create(chat, null, join(dir, "repo"));
    await broker.sendMessage(chat.id, "summarise this", {
      images: [
        { id: "image-1", path: shot, mimeType: "image/png" },
        { id: "file-1", path: doc, mimeType: "application/pdf", alt: "report.pdf" },
      ],
    });
    await broker.waitFor(chat.id, "idle");

    // A PDF can't be an image block; the model must be told where it is instead.
    expect(session.sent[0]?.images?.map((i) => i.id)).toEqual(["image-1"]);
    const text = session.sent[0]?.text ?? "";
    expect(text.startsWith("summarise this")).toBe(true);
    expect(text).toContain(
      `- report.pdf (8 B, application/pdf): ${join(store.chatAssetsDir(chat.id), "abc12345-report.pdf")}`,
    );

    // The transcript row still carries BOTH, so the human sees what they sent
    // and retention treats the file as theirs.
    const row = (await store.readMessages(chat.id)).find((r) => r.kind === "user");
    expect(row && "images" in row ? row.images?.map((i) => i.id) : []).toEqual(["image-1", "file-1"]);
  });

  /**
   * #424: every guard reaches a provider on the neutral seam.
   *
   * Before it, a Codex or goose chat got the mode policy and a hand-copied
   * workflow guard that ignored exemptions — and nothing else. Each case here
   * drives the guard the FAKE PROVIDER was actually handed in its spec, which
   * is the one function a real adapter calls.
   */
  describe("every guard, on the harness path", () => {
    type Live = {
      workflow?: ReturnType<typeof resolveWorkflow>;
      trunk?: string;
      branch?: string | null;
      inWorktree?: boolean;
    };

    async function started(id = "guarded") {
      const chat = await store.saveChat({
        id,
        projectId: "p1",
        title: "Guarded",
        harness: "codex",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "hello");
      await broker.waitFor(chat.id, "idle");
      const live = (broker as unknown as { sessions: Map<string, Live> }).sessions.get(id)!;
      return { chat, live, guard: specs[0]!.toolGuard! };
    }

    /** Wire the services a guard is gated on, the way `index.ts` would. */
    function provide(services: Record<string, unknown>) {
      Object.assign(broker as unknown as Record<string, unknown>, services);
    }

    function notices(): string[] {
      const seen: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "notice") seen.push(e.text);
      });
      return seen;
    }

    /** A `review` project the chat is sitting on the trunk of. */
    function onTrunk(live: Live) {
      live.workflow = resolveWorkflow({ workflow: { profile: "review" } });
      live.trunk = "main";
      live.branch = "main";
      live.inWorktree = false;
    }

    /** Answer the exemption card the broker raises, the way the human would. */
    async function grant(chatId: string, lifetime: "once" | "session") {
      const reqP = new Promise<string>((resolve) => {
        const off = bus.subscribe((e: WsServerEvent) => {
          if (e.type === "permission-request" && e.request.chatId === chatId) {
            off();
            resolve(e.request.id);
          }
        });
      });
      const verdictP = broker.requestExemption(chatId, {
        scope: "push-to-trunk",
        command: "git push origin main",
        reason: "create_pr is down",
      });
      const reqId = await reqP;
      const answer = EXEMPTION_ANSWERS[lifetime]!;
      broker.answerQuestion(reqId, { answers: [{ questionIndex: 0, optionId: answer, answer }] });
      return verdictP;
    }

    it("honours an exemption granted MID-CHAT — and spends a one-shot exactly once", async () => {
      // The headline bug: the harness guard never read `session.exemptions`,
      // so the human approved the card and the agent stayed stuck.
      const { chat, live, guard } = await started();
      onTrunk(live);
      const push = { command: "git push origin main" };

      expect(await guard("Bash", push, {})).toMatch(/request_exemption/);
      expect(await grant(chat.id, "once")).toMatchObject({ granted: true });

      expect(await guard("Bash", push, {})).toBeNull();
      expect(broker.listExemptions(chat.id)).toEqual([]);
      expect(await guard("Bash", push, {})).toMatch(/workflow profile/);
    });

    it("never spends a grant on a call another guard refused", async () => {
      // As parallel Claude hooks, the background-shell guard could refuse a
      // call while the workflow guard burned the one-shot on it anyway.
      const { chat, live, guard } = await started();
      provide({ terminals: {} });
      onTrunk(live);
      expect(await grant(chat.id, "once")).toMatchObject({ granted: true });

      expect(
        await guard("Bash", { command: "git push origin main", run_in_background: true }, {}),
      ).toMatch(/run_in_background/);
      expect(broker.listExemptions(chat.id)).toHaveLength(1);
    });

    it("reads the branch from the call's cwd, and falls back to the session's without one", async () => {
      const { live, guard } = await started();
      onTrunk(live);
      // goose reports no cwd: the chat's own branch (`main`) stands.
      expect(await guard("Bash", { command: "git commit -m x" }, {})).toMatch(/workflow profile/);
      // A cwd outside any repo is no evidence either way — same fallback.
      expect(await guard("Bash", { command: "git commit -m x" }, { cwd: dir })).toMatch(
        /workflow profile/,
      );
    });

    it("refuses a background shell, where there is a tracked terminal to send it to", async () => {
      const { guard } = await started();
      const bg = { command: "npm run dev", run_in_background: true };
      expect(await guard("Bash", bg, {})).toBeNull();
      provide({ terminals: {} });
      expect(await guard("Bash", bg, {})).toMatch(/mcp__dispatch-workspace__terminal/);
    });

    it("refuses a shell-cut worktree, including through Dispatch's own terminal tool", async () => {
      const { guard } = await started();
      provide({ worktrees: {} });
      const cut = { command: "git worktree add -b feat/x ../wt/x" };
      expect(await guard("Bash", cut, {})).toMatch(/mcp__dispatch-workspace__worktree/);
      expect(await guard("mcp__dispatch-workspace__terminal", cut, {})).toMatch(/worktree/);
      expect(await guard("Bash", { command: "git worktree list" }, {})).toBeNull();
    });

    it("refuses `gh issue create` where the watcher would take it, and only there", async () => {
      let watching = true;
      // Provided after the start: these stubs answer only what the guard asks,
      // and session setup asks the real services a good deal more.
      const { guard } = await started();
      provide({
        issues: { sourceFor: async () => ({ source: { repo: "Acme/API" } }) },
        projectConfig: { getConfig: () => ({ issues: { enabled: watching } }) },
      });
      expect(await guard("Bash", { command: 'gh issue create -t "x"' }, {})).toMatch(/issue_create/);
      expect(await guard("Bash", { command: 'gh issue create -R upstream/lib -t "x"' }, {})).toBeNull();
      watching = false;
      expect(await guard("Bash", { command: 'gh issue create -t "x"' }, {})).toBeNull();
    });

    it("holds a subagent to the worktree it started in, and lets the main loop roam", async () => {
      const base = await mkdtemp(join(tmpdir(), "cm-harness-wt-"));
      const home = join(base, "home");
      const other = join(base, "other");
      for (const wt of [home, other]) {
        await mkdir(wt, { recursive: true });
        await writeFile(join(wt, ".git"), `gitdir: ${join(base, ".bare", "worktrees", "x")}`);
      }
      try {
        const { guard } = await started();
        const sub = { parentToolUseId: "task-1", agentId: "child-thread" };
        expect(
          await guard("Edit", { file_path: join(home, "a.ts") }, { ...sub, cwd: home }),
        ).toBeNull();
        const refusal = await guard("Edit", { file_path: join(other, "b.ts") }, { ...sub, cwd: other });
        expect(refusal).toContain(home);
        expect(refusal).toContain(other);
        // The main loop moving between worktrees is its job.
        expect(await guard("Edit", { file_path: join(other, "c.ts") }, { cwd: other })).toBeNull();
        // No cwd from the runtime: not tracked, rather than tracked wrongly.
        expect(await guard("Edit", { file_path: join(other, "d.ts") }, { ...sub })).toBeNull();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    it("leaves refusal notices to the adapter's guard-blocked, but still publishes warnings", async () => {
      // The adapter turns every refusal into a persisted "Blocked: …" row; a
      // guard-specific notice as well would show the human each one twice.
      const { live, guard } = await started();
      provide({ terminals: {} });
      const seen = notices();
      await guard("Bash", { command: "npm run dev", run_in_background: true }, {});
      expect(seen).toEqual([]);

      live.workflow = resolveWorkflow({ workflow: { profile: "review", guard: "warn" } });
      live.trunk = "main";
      live.branch = "main";
      expect(await guard("Bash", { command: "git push origin main" }, {})).toBeNull();
      expect(seen.some((t) => t.startsWith("Workflow warning:"))).toBe(true);
    });

    it("answers a self-gated tool's permission prompt itself — one card, not two", async () => {
      const { chat } = await started();
      const cards: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "permission-request") cards.push(e.request.toolName);
      });
      session.emit({
        type: "permission-request",
        requestId: "perm-1",
        toolName: "mcp__dispatch-confirm__ask_user",
        input: { questions: [] },
      });
      await waitUntil(() => session.resolutions.length > 0);
      expect(session.resolutions).toEqual([["perm-1", { decision: "allow" }]]);
      expect(cards).toEqual([]);
      expect(broker.getSession(chat.id)?.status).not.toBe("awaiting-input");
    });
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

      // And the next turn actually RESUMES it, on the new account — keeping the
      // id on the record is worthless if the session is rebuilt without it.
      await broker.sendMessage(chat.id, "continue");
      await broker.waitFor(chat.id, "idle");
      expect(specs.at(-1)).toMatchObject({
        resumeSessionId: "thread-1",
        account: { subscriptionId: "codex2" },
      });
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

  describe("compaction", () => {
    const codexChat = (id: string, model?: string) =>
      store.saveChat({
        id,
        projectId: "project-1",
        title: "Codex",
        modeId: "plan",
        effort: "low",
        harness: "codex",
        ...(model ? { model } : {}),
        worktrees: [],
        prs: [],
        createdAt: 1,
      });

    it("hands an explicit focus to the adapter and records it in the notice", async () => {
      const chat = await codexChat("compact-focus");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      await broker.compact(chat.id, "  the PR\n number ");
      // Trimmed, but the line break survives: the adapter decides what needs
      // to be one line. The notice row, which is one line, flattens it.
      expect(session.compactions).toEqual(["the PR\n number"]);
      const notice = (await store.readMessages(chat.id)).find((r) => r.kind === "notice");
      expect(notice?.text).toBe("Compacting context — keep: the PR number");
    });

    it("falls back to the app-wide standing focus when none is given", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        autoCompact: { enabled: true, instructions: "decisions made so far" },
      });
      const chat = await codexChat("compact-default");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      await broker.compact(chat.id);
      expect(session.compactions).toEqual(["decisions made so far"]);
    });

    it("pins a per-model threshold on the Codex thread and matches it across an id suffix", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        harness: { defaultHarness: "claude", defaults: {}, contextLimits: { perChatTokens: 180_000 } },
        autoCompact: { enabled: true, perModel: { "gpt-test[1m]": 90_000 } },
      });
      const chat = await codexChat("compact-per-model", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      // The per-model row wins over the global per-chat limit.
      expect(specs[0]!.contextTokenLimit).toBe(90_000);
    });

    it("leaves the threshold at the model's max when no row is set, keeping the global limit", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        harness: { defaultHarness: "claude", defaults: {}, contextLimits: { perChatTokens: 180_000 } },
        autoCompact: { enabled: true, perModel: { "some-other-model": 90_000 } },
      });
      const chat = await codexChat("compact-unset", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      expect(specs[0]!.contextTokenLimit).toBe(180_000);
    });

    it("compacts at turn end once the context passes the model's threshold, with the standing focus", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        autoCompact: {
          enabled: true,
          perModel: { "gpt-test": 40 },
          instructions: "keep the plan",
        },
      });
      const chat = await codexChat("compact-threshold", "gpt-test");
      broker.create(chat);
      // The fake reports 42 context tokens on every turn — past a threshold of 40.
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      expect(session.compactions).toEqual(["keep the plan"]);
    });

    it("does not re-compact when the compaction's own turn leaves the reading unchanged", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        autoCompact: { enabled: true, perModel: { "gpt-test": 40 } },
      });
      session.compactEndsTurn = true;
      const chat = await codexChat("compact-noop", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await waitUntil(async () =>
        (await store.readMessages(chat.id)).filter((r) => r.kind === "result").length >= 2,
      );
      // Give a looping broker room to fire again before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(session.compactions).toHaveLength(1);
    });

    it("does not compact at turn end while under the threshold", async () => {
      await store.saveSettings({
        ...(await store.getSettings()),
        autoCompact: { enabled: true, perModel: { "gpt-test": 1_000 } },
      });
      const chat = await codexChat("compact-under", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      expect(session.compactions).toEqual([]);
    });

    async function thresholds(perModel: Record<string, number>) {
      await store.saveSettings({
        ...(await store.getSettings()),
        autoCompact: { enabled: true, perModel },
      });
    }

    it("resumes the thread with the new limit when a model switch moves it", async () => {
      // Neither shipped runtime can move the limit live, so before this the old
      // model's threshold kept firing after a switch.
      await thresholds({ "gpt-test": 400, "gpt-other": 600 });
      const chat = await codexChat("limit-switch", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      expect(specs[0]!.contextTokenLimit).toBe(400);

      await broker.setModel(chat.id, "gpt-other");
      session = new FakeHarnessSession();
      await broker.sendMessage(chat.id, "again");
      await waitUntil(() => specs.length === 2);
      expect(specs[1]).toMatchObject({ contextTokenLimit: 600, resumeSessionId: "codex-thread-1" });
    });

    it("hands a moved limit to an adapter that can take it live, without a respawn", async () => {
      await thresholds({ "gpt-test": 400 });
      const applied: (number | undefined)[] = [];
      (session as HarnessSession).setContextTokenLimit = async (limit) => {
        applied.push(limit);
      };
      const chat = await codexChat("limit-live", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");

      await thresholds({ "gpt-test": 500 });
      await broker.sendMessage(chat.id, "again");
      await waitUntil(async () =>
        (await store.readMessages(chat.id)).filter((r) => r.kind === "result").length === 2,
      );
      expect(applied).toEqual([500]);
      expect(specs).toHaveLength(1);
    });

    it("only moves the meter for a runtime that never reads the limit", async () => {
      // goose: nothing native to re-arm, and a restart can cost it its session
      // (it resumes only where the agent advertises `loadSession`). The
      // turn-end check reads Settings live, so the new limit already applies.
      (caps as { nativeContextLimit?: boolean }).nativeContextLimit = false;
      await thresholds({ "gpt-test": 400 });
      const published: (number | undefined)[] = [];
      bus.on("chat-context", (e) => published.push(e.contextWindow));
      const chat = await codexChat("limit-goose", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");

      await thresholds({ "gpt-test": 500 });
      await broker.sendMessage(chat.id, "again");
      await waitUntil(async () =>
        (await store.readMessages(chat.id)).filter((r) => r.kind === "result").length === 2,
      );
      expect(specs).toHaveLength(1);
      const result = (await store.readMessages(chat.id)).findLast((r) => r.kind === "result");
      expect(result).toMatchObject({ contextWindow: 500 });
    });

    it("keeps the thread when nothing moved the limit", async () => {
      await thresholds({ "gpt-test": 400 });
      const chat = await codexChat("limit-same", "gpt-test");
      broker.create(chat);
      for (const text of ["one", "two"]) {
        await broker.sendMessage(chat.id, text);
        await broker.waitFor(chat.id, "idle");
      }
      expect(specs).toHaveLength(1);
    });

    it("divides the meter by the limit, not the window the runtime reports", async () => {
      await thresholds({ "gpt-test": 400 });
      const published: (number | undefined)[] = [];
      bus.on("chat-context", (e) => published.push(e.contextWindow));
      const chat = await codexChat("limit-meter", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      // The fake reports a 1,000-token window.
      expect(published.at(-1)).toBe(400);
      const result = (await store.readMessages(chat.id)).findLast((r) => r.kind === "result");
      expect(result).toMatchObject({ contextWindow: 400 });
      // The spec still carries the real window — goose sizes its context from it.
      expect(specs[0]!.contextWindow).not.toBe(400);
    });

    it("fills a compaction's before-size from the last reading when the runtime gives none", async () => {
      const chat = await codexChat("compact-row", "gpt-test");
      broker.create(chat);
      await broker.sendMessage(chat.id, "hi");
      await broker.waitFor(chat.id, "idle");
      session.emit({ type: "compacted" });
      await waitUntil(async () =>
        (await store.readMessages(chat.id)).some((r) => r.kind === "system" && r.subtype === "compact"),
      );
      const row = (await store.readMessages(chat.id)).find(
        (r) => r.kind === "system" && r.subtype === "compact",
      );
      expect(row).toMatchObject({ text: "Context compacted at 42 tokens", data: { preTokens: 42 } });
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

    it("delivers the verdict as a message when the turn ended with the call still running", async () => {
      const chatId = await codexChat("chat-orphaned-review");
      session.emit({ type: "tool-use", toolUseId: "review-3", name: REVIEW, input: review });
      const reviewCard = nextCard();
      const verdict = broker.requestHumanReview(chatId, review);
      const reviewId = await reviewCard;

      // Codex's exec cell backgrounded the call; the model gave up waiting on
      // the cell and ended its turn. The call itself is still in flight, so no
      // failed result ever arrives.
      session.emit({
        type: "turn-end",
        ok: true,
        subtype: "success",
        result: "The review card is open.",
      });
      await waitUntil(async () =>
        (await store.readMessages(chatId)).some((row) => row.kind === "result"),
      );

      expect(broker.answerQuestion(reviewId, { answer: "Approve", notes: "plain but fine" })).toBe(true);
      await expect(verdict).resolves.toMatchObject({ status: "reviewed", verdict: "approve" });
      // The bridge's answer completes Codex's item — successfully, into a dead turn.
      session.emit({ type: "tool-result", toolUseId: "review-3", ok: true, content: "approved" });

      await waitUntil(async () => (await briefs(chatId)).length > 0);
      const [late] = await briefs(chatId);
      expect(late).toMatchObject({ label: "Late review verdict" });
      expect(late!.text).toContain("APPROVED");
      expect(late!.text).toContain("plain but fine");
      expect(session.sent.some((input) => input.text.includes("APPROVED"))).toBe(true);
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

  describe("model switch on a provider that cannot do it live", () => {
    /** goose-shaped: everything works except changing the model in place. */
    function noLiveSwitchHarness(): Harness {
      return {
        kind: "goose",
        capabilities: {
          toolPermissions: true,
          questions: false,
          subagents: false,
          skills: true,
          compaction: false,
          fork: false,
          usageLimits: false,
          liveModelSwitch: false,
          livePermissionSwitch: true,
          efforts: [],
          preToolGuard: true,
          guardsMcpToolNames: true,
          managerTransport: "http",
        },
        runtime: () => ({ kind: "goose", source: "installed", available: true }),
        listModels: async () => [],
        readLimits: async () => null,
        generateText: async () => "title",
        createSession: (spec: HarnessSessionSpec) => {
          specs.push(spec);
          return session;
        },
      };
    }

    it("restarts the agent, so the next turn runs on the model that was picked", async () => {
      // The bug, measured on the wire: goose reads GOOSE_MODEL when the process
      // spawns and cannot change it afterwards, so `setModel` only recorded the
      // choice — while `chat.model` was persisted and the picker showed the new
      // name. Every request after the switch still went out as the OLD model.
      broker = new SessionBroker({
        store,
        bus: (bus = new EventBus()),
        harnesses: new HarnessRegistry({ providers: [{ harness: noLiveSwitchHarness(), descriptor: GOOSE_PROVIDER }] }),
        authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
        deps: { stopTimeoutMs: 5 },
      });
      const chat = await store.saveChat({
        id: "chat-model-switch",
        projectId: "project-1",
        title: "Switch",
        modeId: "plan",
        effort: "low",
        harness: "goose",
        model: "qwen3-coder:30b",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "one");
      await broker.waitFor(chat.id, "idle");
      expect(specs).toHaveLength(1);
      expect(specs[0]!.model).toBe("qwen3-coder:30b");

      await broker.setModel(chat.id, "llama3.1:8b");
      await broker.sendMessage(chat.id, "two");
      await broker.waitFor(chat.id, "idle");

      // A SECOND spawn, carrying the new model — not a reused process still
      // holding the old GOOSE_MODEL.
      expect(specs).toHaveLength(2);
      expect(specs[1]!.model).toBe("llama3.1:8b");
    });

    it("leaves the NEXT genuine session-end still able to announce itself", async () => {
      // `switching` is consumed only by `onDone`, and that is what makes a stop
      // settle quietly — no `done` attention item, no push. Retiring a session
      // never reaches `onDone` (the stream loop calls it only while
      // `harnessSession === live`, and retiring clears that first), so setting
      // the flag here would leave it `true` on a session that outlives the
      // turn and silently swallow the next real session-end notification.
      broker = new SessionBroker({
        store,
        bus: (bus = new EventBus()),
        harnesses: new HarnessRegistry({ providers: [{ harness: noLiveSwitchHarness(), descriptor: GOOSE_PROVIDER }] }),
        authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
        deps: { stopTimeoutMs: 5 },
      });
      const chat = await store.saveChat({
        id: "chat-switch-then-stop",
        projectId: "project-1",
        title: "Switch then stop",
        modeId: "plan",
        effort: "low",
        harness: "goose",
        model: "qwen3-coder:30b",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "one");
      await broker.waitFor(chat.id, "idle");
      await broker.setModel(chat.id, "llama3.1:8b");

      await broker.sendMessage(chat.id, "two");
      await broker.waitFor(chat.id, "idle");

      // Watch ONLY for the "Session ended" item the quiet branch skips.
      const ended: string[] = [];
      bus.subscribe((e) => {
        if (e.type === "attention-add" && e.item.kind === "done") ended.push(e.item.chatId);
      });
      await broker.stop(chat.id);

      // With the flag leaked, `onDone` takes the quiet branch and this is empty.
      expect(ended).toEqual([chat.id]);
    });

    it("does not restart a provider that CAN switch in place", async () => {
      // Codex advertises liveModelSwitch, so tearing its thread down would
      // throw away context for no reason.
      const chat = await store.saveChat({
        id: "chat-live-switch",
        projectId: "project-1",
        title: "Live",
        modeId: "plan",
        effort: "low",
        harness: "codex",
        model: "gpt-test",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "one");
      await broker.waitFor(chat.id, "idle");
      await broker.setModel(chat.id, "gpt-other");
      await broker.sendMessage(chat.id, "two");
      await broker.waitFor(chat.id, "idle");
      expect(specs).toHaveLength(1);
    });
  });

  describe("context window on a harness that fell back", () => {
    /** A harness that answers `contextWindow` but whose runtime is missing. */
    function unavailableLocalHarness(probed: () => void): Harness {
      return {
        kind: "goose",
        capabilities: {
          toolPermissions: true,
          questions: false,
          subagents: false,
          skills: true,
          compaction: false,
          fork: false,
          usageLimits: false,
          liveModelSwitch: false,
          livePermissionSwitch: true,
          efforts: [],
          preToolGuard: true,
          guardsMcpToolNames: true,
          managerTransport: "http",
        },
        // The CLI is NOT installed — this is what makes the broker fall back.
        runtime: () => ({ kind: "goose", source: "missing", available: false }),
        listModels: async () => [],
        readLimits: async () => null,
        generateText: async () => "title",
        // Ollama does not care that the goose CLI is absent, so this would
        // happily answer for a session that is about to run on Claude.
        contextWindow: async () => {
          probed();
          return 32_768;
        },
        createSession: (spec: HarnessSessionSpec) => {
          specs.push(spec);
          return session;
        },
      };
    }

    it("asks the harness that will RUN, not the one that was configured", async () => {
      // Regression: this was resolved with `find(session.harnessKind)` before
      // `startHarnessSession` had a chance to fall back. A chat configured for
      // goose on a box without the goose CLI runs on Claude — but the goose
      // probe still succeeded against a reachable Ollama, so a ~200k Claude
      // session came up with its meter seeded to 32768 and, more persistently,
      // its browser MCP tools silently gated off as unaffordable.
      let probes = 0;
      const claude: Harness = {
        kind: "claude",
        capabilities: {
          toolPermissions: true,
          questions: true,
          subagents: true,
          skills: true,
          compaction: true,
          fork: true,
          usageLimits: true,
          liveModelSwitch: true,
          livePermissionSwitch: true,
          efforts: ["low", "medium", "high"],
          preToolGuard: true,
          guardsMcpToolNames: true,
          managerTransport: "in-process",
        },
        runtime: () => ({ kind: "claude", source: "installed", available: true }),
        listModels: async () => [],
        readLimits: async () => null,
        generateText: async () => "title",
        createSession: (spec: HarnessSessionSpec) => {
          specs.push(spec);
          return session;
        },
      };
      broker = new SessionBroker({
        store,
        bus: (bus = new EventBus()),
        harnesses: new HarnessRegistry({
          harnesses: { claude },
          providers: [{ harness: unavailableLocalHarness(() => (probes += 1)), descriptor: GOOSE_PROVIDER }],
        }),
        authored: new AuthoredConfigService({ globalRoot: join(dir, "global") }),
        deps: { stopTimeoutMs: 5 },
      });

      const chat = await store.saveChat({
        id: "fellback",
        projectId: "p1",
        title: "t",
        modeId: "plan",
        effort: "low",
        harness: "goose",
        worktrees: [],
        prs: [],
        createdAt: 1,
      });
      broker.create(chat);
      await broker.sendMessage(chat.id, "go");
      await broker.waitFor(chat.id, "idle");

      // Claude implements no `contextWindow`, so the honest answer is "unknown"
      // — which leaves the meter and the MCP surface exactly as they were.
      expect(specs[0]!.contextWindow).toBeUndefined();
      // And the absent runtime was never consulted about a session it is not running.
      expect(probes).toBe(0);
    });
  });
});
