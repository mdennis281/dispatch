/**
 * One Agent SDK `query()`, presented as a {@link HarnessSession}.
 *
 * This is the no-regressions half of the harness split: every behaviour the
 * SessionBroker used to implement inline against the SDK still happens, just on
 * this side of the seam. In particular the two things that are easy to lose:
 *
 *  - THE INPUT CHANNEL. The SDK consumes an async iterable of user messages,
 *    which is what makes mid-turn steering possible. Pushes that arrive before
 *    the iterator is pulled must buffer, not drop.
 *  - `canUseTool` IS TWO CHANNELS. It gates ordinary tools AND carries
 *    AskUserQuestion, which is not a permission at all — the answer rides back
 *    as a rewritten tool input. Both are surfaced here as distinct neutral
 *    events so the broker no longer has to know that.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKUserMessage,
  PermissionResult,
  AgentDefinition,
  HookCallback,
  HookInput,
  HookJSONOutput,
  McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { Effort, PermissionMode } from "@dispatch/shared";
import { EffortSchema } from "@dispatch/shared";
import type {
  HarnessEvent,
  HarnessInput,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "../types.js";
import { ClaudeStreamDecoder, QUESTION_TOOL } from "./stream.js";
import { buildQuestionAnswer, neutralQuestions } from "./questions.js";
import { claudeExecutableOption } from "../../services/runtime.js";
import { spawnWithPid } from "./spawn.js";

/** The subset of the SDK `query` signature this session calls. */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage> | string;
  options?: Options;
}) => Query;

/** Built-in mode-id → SDK permissionMode. */
export const BUILTIN_MODE_PERMISSION: Record<string, PermissionMode> = {
  default: "default",
  ask: "default",
  plan: "plan",
  edit: "acceptEdits",
  acceptEdits: "acceptEdits",
  auto: "auto",
  yolo: "bypassPermissions",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
  dontAsk: "dontAsk",
};

/**
 * LEGACY effort lever — a fixed thinking-token budget per level.
 *
 * Superseded by the SDK's first-class `effort`, which the runtime interprets
 * per model and uses to guide adaptive thinking. Kept only as the fallback for
 * `setEffort` on a runtime without the live control.
 */
export const EFFORT_THINKING_TOKENS: Record<Effort, number> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 60_000,
};

/**
 * A buffered async iterable of user messages.
 *
 * The SDK pulls from this to learn about new user input. Pushes that land
 * before a pull are queued; a pull with an empty queue parks until one arrives.
 */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter?: () => void;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    this.queue.push(msg);
    this.waiter?.();
    this.waiter = undefined;
  }

  pending(): number {
    return this.queue.length;
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        for (;;) {
          const next = this.queue.shift();
          if (next) return { value: next, done: false };
          if (this.closed) return { value: undefined as never, done: true };
          await new Promise<void>((resolve) => (this.waiter = resolve));
        }
      },
    };
  }
}

/**
 * Put the subprocess's stderr back on a bare process-exit error.
 *
 * ONLY on that shape. `fail()` also handles transport errors, aborts and
 * anything the stream threw, and stapling the last subprocess's stderr onto an
 * unrelated failure would be worse than saying nothing — the tail outlives the
 * process it came from, so it could describe a run that already ended.
 *
 * A message that already carries a tail (the SDK's own launcher ran, because
 * this session didn't provide a spawner) is left exactly as it was.
 */
export function withStderrTail(message: string, tail: string): string {
  if (!tail.trim()) return message;
  if (!/process exited with code/i.test(message)) return message;
  if (message.includes(tail.trim().slice(-80))) return message;
  return `${message}\n${tail.trimEnd()}`;
}

export interface ClaudeSessionOpts {
  spec: HarnessSessionSpec;
  query?: QueryFn;
  genId: () => string;
}

export class ClaudeSession implements HarnessSession {
  private readonly spec: HarnessSessionSpec;
  private readonly queryFn: QueryFn;
  private readonly genId: () => string;
  private readonly decoder: ClaudeStreamDecoder;

  private input?: InputChannel;
  private query?: Query;
  private started = false;
  private disposed = false;
  private outbox: HarnessInput[] = [];
  private effort: Effort;
  private modelOverride?: string;

  /** Resolvers for in-flight `canUseTool` calls, keyed by our request id. */
  private readonly pendingPermissions = new Map<string, (r: PermissionResult) => void>();
  /** The tool input each pending question was asked with, for answer building. */
  private readonly questionInputs = new Map<string, Record<string, unknown>>();

  /**
   * Effort the runtime reports per thread, learned from PreToolUse hooks.
   * `null` keys the main loop; a tool_use id keys a subagent thread.
   */
  private readonly threadEfforts = new Map<string | null, Effort>();
  /** Which thread each tool call belongs to, so a hook can attribute itself. */
  private readonly toolThreads = new Map<string, string | null>();

  /* ------------------------------------------------- the event stream */

  private readonly queue: HarnessEvent[] = [];
  private waiter?: () => void;
  private ended = false;

  /**
   * Pid of the live Claude Code subprocess, or undefined between runs.
   *
   * The root of this chat's process tree — every MCP server the session spawns
   * descends from it — which is what makes "how many processes is this chat
   * holding" and "reap them" answerable. See {@link spawnWithPid}.
   */
  private livePid?: number;

  /**
   * The dead subprocess's last stderr, kept for the error message.
   *
   * Providing `spawnClaudeCodeProcess` is what stops the SDK collecting its own
   * tail (`SpawnedProcess` declares no `stderr`), so without this a session that
   * dies on a bad flag reports a bare "process exited with code 1" instead of
   * the CLI's own account of why. See {@link spawnWithPid}.
   */
  private lastStderrTail = "";

  constructor(opts: ClaudeSessionOpts) {
    this.spec = opts.spec;
    this.queryFn = opts.query ?? (sdkQuery as unknown as QueryFn);
    this.genId = opts.genId;
    this.effort = opts.spec.effort;
    this.modelOverride = opts.spec.model;
    this.decoder = new ClaudeStreamDecoder({
      genId: opts.genId,
      effortOf: (parent) => this.threadEfforts.get(parent),
      onToolThread: (id, parent) => this.toolThreads.set(id, parent),
    });
  }

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<HarnessEvent> => ({
        next: async (): Promise<IteratorResult<HarnessEvent>> => {
          for (;;) {
            const next = this.queue.shift();
            if (next) return { value: next, done: false };
            if (this.ended) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => (this.waiter = resolve));
          }
        },
      }),
    };
  }

  private emit(...events: HarnessEvent[]): void {
    if (this.ended) return;
    this.queue.push(...events);
    this.waiter?.();
    this.waiter = undefined;
  }

  private end(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  /* --------------------------------------------------------- sending */

  send(input: HarnessInput): void {
    if (this.disposed) return;
    if (input.effort) this.effort = input.effort;
    this.outbox.push(input);
    if (!this.started) {
      this.started = true;
      void this.start().catch((err) => this.fail(err));
    } else {
      this.flush();
    }
  }

  pending(): number {
    return this.input?.pending() ?? this.outbox.length;
  }

  pid(): number | undefined {
    return this.livePid;
  }

  private async start(): Promise<void> {
    // Set synchronously before the first await so concurrent steering pushes
    // land in the channel rather than being dropped.
    this.input = new InputChannel();
    const options = this.buildOptions();
    this.query = this.queryFn({ prompt: this.input, options });
    this.flush();
    void this.consume();
  }

  private flush(): void {
    if (!this.input) return;
    for (const msg of this.outbox) this.input.push(this.toSdkMessage(msg));
    this.outbox = [];
  }

  /** A Dispatch message → the SDK's user-message envelope. */
  private toSdkMessage(msg: HarnessInput): SDKUserMessage {
    const content: unknown[] = [];
    for (const img of msg.images ?? []) {
      if (!img.path) continue;
      content.push(
        /^(https?:|data:)/.test(img.path)
          ? { type: "image", source: { type: "url", url: img.path } }
          : { type: "image", source: { type: "file", path: img.path } },
      );
    }
    if (msg.text) content.push({ type: "text", text: msg.text });
    return {
      type: "user",
      message: { role: "user", content },
      ...(msg.priority ? { priority: msg.priority } : {}),
    } as unknown as SDKUserMessage;
  }

  private async consume(): Promise<void> {
    const q = this.query;
    if (!q) return;
    try {
      for await (const msg of q) {
        for (const event of this.decoder.decode(msg)) this.emit(event);
      }
    } catch (err) {
      // An abort is an expected end, not a failure.
      if (!this.disposed) this.fail(err);
    }
    this.end();
  }

  private fail(err: unknown): void {
    const message = withStderrTail(
      err instanceof Error ? err.message : String(err),
      this.lastStderrTail,
    );
    this.emit({ type: "turn-end", ok: false, subtype: "error", result: message });
    this.end();
  }

  /* ---------------------------------------------------- SDK options */

  private buildOptions(): Options {
    const options: Options = {
      permissionMode: this.spec.permissionMode,
      // Launch with the skip-permissions CAPABILITY so "Bypass" can be selected
      // mid-session — the SDK rejects setPermissionMode("bypassPermissions")
      // otherwise. It only enables the choice; canUseTool still gates the rest.
      allowDangerouslySkipPermissions: true,
      canUseTool: (name, input, o) => this.onCanUseTool(name, input, o),
      // The first-class effort lever: one level the runtime interprets per model
      // and every subagent inherits. Deliberately NOT a `thinking` budget, which
      // pins the same token count for every model and overrides adaptive
      // thinking.
      effort: this.effort,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      ...(this.spec.abortSignal
        ? { abortController: abortControllerFor(this.spec.abortSignal) }
        : {}),
      // Run on the user's installed Claude Code when it's newer than the SDK's
      // bundled one. MUST match what the model probe uses, or the picker would
      // offer models the session can't run.
      ...claudeExecutableOption(),
      // Spawn the subprocess ourselves ONLY to learn its pid — see spawn.ts.
      // The cast is because the SDK types the hook against its own structural
      // `SpawnedProcess`, which `ChildProcess` satisfies but does not name.
      spawnClaudeCodeProcess: spawnWithPid({
        onSpawn: (pid) => {
          this.livePid = pid;
        },
        onExit: (pid, stderrTail) => {
          // Guarded: a `dispose()` → immediate restart can land the new pid
          // before the old child's `exit` fires, and clearing unconditionally
          // would blank the pid of the session that is actually running.
          if (this.livePid === pid) this.livePid = undefined;
          if (stderrTail) this.lastStderrTail = stderrTail;
        },
      }) as unknown as Options["spawnClaudeCodeProcess"],
    };
    if (this.spec.cwd) options.cwd = this.spec.cwd;
    if (this.modelOverride) options.model = this.modelOverride;

    options.settings = {
      autoCompactEnabled: this.spec.autoCompact ?? true,
      ...(this.spec.autoCompactWindow ? { autoCompactWindow: this.spec.autoCompactWindow } : {}),
    };

    if (this.spec.resumeSessionId) {
      options.resume = this.spec.resumeSessionId;
      if (this.spec.fork) options.forkSession = true;
      if (this.spec.forkAtId) {
        (options as unknown as Record<string, unknown>).resumeSessionAt = this.spec.forkAtId;
      }
    }

    // Learn the effort the runtime is REALLY running each thread at. Hook inputs
    // are the only place that number surfaces, they fire for subagents too, and
    // they report the level after any silent downgrade for the model.
    const hooks: NonNullable<Options["hooks"]> = {
      PreToolUse: [{ hooks: [this.observeEffortHook()] }],
    };
    // …and enforce the workflow contract. A PreToolUse hook rather than
    // canUseTool so it still fires under bypassPermissions, which is exactly
    // when an unattended agent is most likely to reach for `git push origin
    // main`.
    if (this.spec.toolGuard) {
      hooks.PreToolUse!.push({ matcher: "Bash", hooks: [this.guardHook()] });
    }
    options.hooks = hooks;

    if (this.spec.agent) {
      const a = this.spec.agent;
      const def: AgentDefinition = {
        description: a.description,
        prompt: a.prompt,
        tools: a.tools,
        disallowedTools: a.disallowedTools,
        model: a.model,
        permissionMode: a.permissionMode,
        effort: a.effort ?? this.effort,
      };
      options.agents = { [a.id]: def };
      options.agent = a.id;
    }

    if (this.spec.systemPromptAppends.length) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: this.spec.systemPromptAppends.join("\n\n"),
      };
    }

    const servers: Record<string, SdkMcpServerConfig> = {
      ...(this.spec.mcpServers as unknown as Record<string, SdkMcpServerConfig>),
    };
    // Applied LAST so a project-configured server can't shadow Dispatch's own
    // tools even if it manages to collide with a `dispatch-*` name.
    const manager = this.spec.managerMcp;
    if (manager?.transport === "in-process") {
      for (const [name, server] of Object.entries(manager.servers)) {
        servers[name] = server as SdkMcpServerConfig;
      }
    }
    options.mcpServers = servers;

    return options;
  }

  /** Reads the runtime's reported effort off every PreToolUse input. */
  private observeEffortHook(): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const raw = (input as unknown as Record<string, unknown>).effort;
      const parsed = EffortSchema.safeParse(raw);
      if (parsed.success) {
        // `agent_id` names the subagent thread; its absence means the main loop.
        const agentId = (input as unknown as { agent_id?: unknown }).agent_id;
        const toolUseId = (input as unknown as { tool_use_id?: unknown }).tool_use_id;
        const thread =
          typeof agentId === "string" && agentId
            ? this.toolThreads.get(String(toolUseId ?? "")) ?? null
            : null;
        this.threadEfforts.set(thread, parsed.data);
      }
      return {};
    };
  }

  /** Blocks a Bash call the workflow contract forbids. */
  private guardHook(): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const guard = this.spec.toolGuard;
      if (!guard) return {};
      const toolInput = ((input as unknown as { tool_input?: unknown }).tool_input ?? {}) as Record<
        string,
        unknown
      >;
      const reason = guard("Bash", toolInput);
      if (!reason) return {};
      this.emit({ type: "notice", level: "warn", text: `Blocked: ${reason}` });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      } as unknown as HookJSONOutput;
    };
  }

  /* ----------------------------------------------- permissions + asks */

  /**
   * The SDK's single "may I?" callback, split into the two things it actually
   * carries: a real permission prompt, and an AskUserQuestion.
   */
  private onCanUseTool(
    name: string,
    input: Record<string, unknown>,
    opts: { signal?: AbortSignal } | undefined,
  ): Promise<PermissionResult> {
    const requestId = this.genId();
    return new Promise<PermissionResult>((resolve) => {
      // An aborted turn must settle the promise, or the SDK waits forever.
      //
      // `{ once: true }` is NOT sufficient on its own: it unregisters when the
      // event FIRES, and in the normal case abort never comes. The signal here
      // belongs to the whole session (one AbortController per `startQuery`), not
      // to this one request, so every permission prompt used to leave a listener
      // on it for the life of the session. Past ten, Node emits a
      // `MaxListenersExceededWarning` — which, under a launcher whose stderr has
      // no reader, was the seed of a 106 MB crash-log loop. Unregister on the
      // settle path too, so the listener count tracks OUTSTANDING prompts.
      const signal = opts?.signal;
      const onAbort = (): void => {
        if (this.pendingPermissions.delete(requestId)) {
          resolve({ behavior: "deny", message: "interrupted" });
        }
      };
      const settle = (result: PermissionResult): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      this.pendingPermissions.set(requestId, settle);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (name === QUESTION_TOOL) {
        this.questionInputs.set(requestId, input);
        this.emit({ type: "question-request", requestId, questions: neutralQuestions(input) });
        return;
      }
      this.emit({
        type: "permission-request",
        requestId,
        toolName: name,
        input,
        target: deriveTarget(input),
      });
    });
  }

  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    this.questionInputs.delete(requestId);
    if (resolution.decision === "allow") {
      resolve({
        behavior: "allow",
        updatedInput: resolution.updatedInput ?? {},
      } as unknown as PermissionResult);
    } else {
      resolve({ behavior: "deny", message: resolution.message ?? "denied" } as PermissionResult);
    }
  }

  /**
   * Answer an AskUserQuestion.
   *
   * The SDK expects the answer to arrive as a REWRITTEN TOOL INPUT rather than
   * a separate payload — the tool then "returns" what the human picked. That
   * encoding is Claude-specific, which is exactly why it lives here.
   */
  resolveQuestion(requestId: string, answers: HarnessQuestionAnswer[]): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    const input = this.questionInputs.get(requestId) ?? {};
    this.pendingPermissions.delete(requestId);
    this.questionInputs.delete(requestId);
    resolve({
      behavior: "allow",
      updatedInput: buildQuestionAnswer(input, answers),
    } as unknown as PermissionResult);
  }

  /* --------------------------------------------------------- control */

  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch {
      /* nothing running */
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    (this.spec as { permissionMode: PermissionMode }).permissionMode = mode;
    try {
      await this.query?.setPermissionMode(mode);
    } catch {
      /* takes effect next turn */
    }
  }

  async setModel(model: string): Promise<void> {
    this.modelOverride = model;
    try {
      await this.query?.setModel(model);
    } catch {
      /* takes effect next turn */
    }
  }

  /**
   * Push a new effort level at a live session.
   *
   * The SDK's live control is a thinking-token budget, not the first-class
   * `effort` — that is fixed at launch — so this is a best-effort approximation
   * until the next turn re-launches with the real lever.
   */
  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
    try {
      await this.query?.setMaxThinkingTokens(EFFORT_THINKING_TOKENS[effort]);
    } catch {
      /* not supported by this runtime */
    }
  }

  async compact(): Promise<void> {
    // The SDK compacts via a slash command on the input channel; there is no
    // control-channel equivalent.
    this.input?.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "/compact" }] },
    } as unknown as SDKUserMessage);
  }

  async contextWindow(): Promise<number | undefined> {
    return this.decoder.contextWindow;
  }

  /** Set once the host learns the window, so turn-end rows carry a denominator. */
  setContextWindow(window: number | undefined): void {
    this.decoder.contextWindow = window;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Settle anything the SDK is blocked on, or the subprocess never exits.
    for (const [, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "session stopped" } as PermissionResult);
    }
    this.pendingPermissions.clear();
    this.questionInputs.clear();
    this.input?.close();
    try {
      await this.query?.interrupt();
    } catch {
      /* already down */
    }
    this.end();
  }
}

/** Best-effort "what is the tool acting on" for the working-state label. */
function deriveTarget(input: Record<string, unknown>): string | undefined {
  const fp = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof fp === "string") return fp;
  const cmd = input.command;
  if (typeof cmd === "string") return cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
  return undefined;
}

/** Bridge an AbortSignal to the AbortController the SDK wants. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
