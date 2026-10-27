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
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ContextUsage,
  Effort,
  ImageRef,
  McpServerConfig,
  PermissionMode,
  SlashCommandInfo,
} from "@dispatch/shared";
import { EffortSchema, mediaTypeFromName } from "@dispatch/shared";
import type {
  HarnessEvent,
  HarnessInput,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "@dispatch/shared";
import { catchToolGuard, compactCommand } from "@dispatch/shared";
import { claudeCompactWindow } from "./compact.js";
import { ClaudeStreamDecoder, QUESTION_TOOL } from "./stream.js";
import { buildQuestionAnswer, neutralQuestions } from "./questions.js";
import { claudeExecutableOption } from "./runtime.js";
import { envWithAccount } from "./account.js";
import { spawnWithPid } from "./spawn.js";
import { claudeSdkMcpServers } from "./manager-servers.js";

/** The subset of the SDK `query` signature this session calls. */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage> | string;
  options?: Options;
}) => Query;

/**
 * LEGACY effort lever — a fixed thinking-token budget per level.
 *
 * Superseded by the SDK's first-class `effort`, which the runtime interprets
 * per model and uses to guide adaptive thinking, and on a live session by
 * `applyFlagSettings({ effortLevel })`. Kept only as the last fallback for
 * `setEffort` on a CLI that has neither, so a live change never silently
 * no-ops. These are the numbers the broker's direct loop shipped with; there
 * used to be a second, disagreeing table here.
 */
export const EFFORT_THINKING_TOKENS: Record<Effort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 32_000,
  max: 60_000,
};

/**
 * How long a `getContextUsage()` read inside the message loop may take. Bounded
 * because the loop waits on it, and a stalled control request must not stall
 * the stream behind it.
 */
const LIVE_USAGE_TIMEOUT_MS = 3_000;

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
  private spec: HarnessSessionSpec;
  private readonly queryFn: QueryFn;
  private readonly genId: () => string;
  private readonly decoder: ClaudeStreamDecoder;

  private input?: InputChannel;
  private query?: Query;
  /** The SDK stream, read one message at a time — see {@link absorb}. */
  private sdk?: AsyncIterator<unknown>;
  /** A read of {@link sdk} in flight, kept across wake-ups so none is lost. */
  private pull?: Promise<{ result: IteratorResult<unknown> } | { error: unknown }>;
  private started = false;
  private disposed = false;
  private outbox: HarnessInput[] = [];
  private effort: Effort;
  private modelOverride?: string;

  /** Resolvers for in-flight `canUseTool` calls, keyed by our request id. */
  private readonly pendingPermissions = new Map<string, (r: PermissionResult) => void>();
  /**
   * The tool input each pending request was asked with: a question's, to build
   * its answer on, and a permission's, to hand back on an allow that names no
   * replacement. The SDK runs the tool with exactly the `updatedInput` it gets,
   * so an allow answered with `{}` ran every auto-allowed call with no
   * arguments at all.
   */
  private readonly requestInputs = new Map<string, Record<string, unknown>>();

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
   * Why the runtime died, when it did — rethrown by the event iterator so the
   * host settles the chat as errored rather than as a failed turn. See
   * `HarnessSession.events`.
   */
  private fatal?: Error;

  /**
   * This session's own abort, linked to the host's `spec.abortSignal`. Owned
   * here rather than borrowed so `dispose()` can kill the subprocess tree
   * whether or not the host aborts: closing the input alone leaves the CLI to
   * notice on its own.
   */
  private readonly abort = new AbortController();

  /**
   * The `autoCompactWindow` the live query was spawned with, so
   * `setContextTokenLimit` can tell a move the CLI would notice from one it
   * would clamp away.
   */
  private spawnWindow?: number;

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
    // What the host already knew carries over a respawn, so the first turn-end
    // of a resumed session has a denominator before the runtime is asked.
    this.decoder.contextWindow = opts.spec.contextWindow;
    const hostSignal = opts.spec.abortSignal;
    if (hostSignal) {
      if (hostSignal.aborted) this.abort.abort();
      else hostSignal.addEventListener("abort", () => void this.dispose(), { once: true });
    }
  }

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<HarnessEvent> => ({
        next: async (): Promise<IteratorResult<HarnessEvent>> => {
          for (;;) {
            const next = this.queue.shift();
            if (next) return { value: next, done: false };
            if (this.ended) {
              // Once: a consumer that keeps pulling after the throw sees an
              // ordinary end, not the same death reported twice.
              const fatal = this.fatal;
              this.fatal = undefined;
              if (fatal) throw fatal;
              return { value: undefined as never, done: true };
            }
            // Nothing queued: read the runtime's NEXT message — only now, when
            // the host has finished with everything before it — or take an
            // event raised on the side (a permission prompt, a guard refusal),
            // whichever comes first. A read already in flight is kept, never
            // re-issued.
            if (this.sdk && !this.pull) {
              this.pull = this.sdk.next().then(
                (result) => ({ result }),
                (error: unknown) => ({ error }),
              );
            }
            const pushed = new Promise<undefined>((resolve) => {
              this.waiter = () => resolve(undefined);
            });
            const read = await (this.pull ? Promise.race([this.pull, pushed]) : pushed);
            if (read) {
              this.pull = undefined;
              await this.absorb(read);
            }
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
    this.spawnWindow = (options.settings as { autoCompactWindow?: number } | undefined)
      ?.autoCompactWindow;
    this.query = this.queryFn({ prompt: this.input, options });
    this.flush();
    this.sdk = this.query[Symbol.asyncIterator]();
    // A consumer already parked on an empty queue starts reading now.
    this.waiter?.();
    this.waiter = undefined;
  }

  private flush(): void {
    if (!this.input) return;
    for (const msg of this.outbox) this.input.push(this.toSdkMessage(msg));
    this.outbox = [];
  }

  /**
   * A Dispatch message → the SDK's user-message envelope: the text, THEN its
   * images.
   *
   * Images go as bytes. The API takes `base64` and `url` sources and nothing
   * that names a local file — the `{ type: "file", path }` this used to send is
   * not a source the API knows, so an uploaded screenshot never reached the
   * model. A text-only message stays a plain string, as it always was.
   */
  private toSdkMessage(msg: HarnessInput): SDKUserMessage {
    const images = (msg.images ?? [])
      .map((img) => this.imageSource(img))
      .filter((s): s is Record<string, unknown> => !!s);
    const content: unknown = images.length
      ? [
          ...(msg.text ? [{ type: "text", text: msg.text }] : []),
          ...images.map((source) => ({ type: "image", source })),
        ]
      : msg.text;
    return {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
      ...(msg.priority ? { priority: msg.priority } : {}),
    } as unknown as SDKUserMessage;
  }

  /**
   * One image as an API source. Read synchronously because `send()` is: the
   * order messages reach the input channel is the order they were sent, and an
   * async read would let a text-only message overtake an image one. An
   * unreadable file is skipped — the text still goes.
   */
  private imageSource(img: ImageRef): Record<string, unknown> | undefined {
    const path = img.path;
    if (!path) return undefined;
    if (/^https?:/i.test(path)) return { type: "url", url: path };
    const data = /^data:([^;]+);base64,(.*)$/s.exec(path);
    if (data) return { type: "base64", media_type: data[1], data: data[2] };
    try {
      const abs = isAbsolute(path) || !this.spec.cwd ? path : join(this.spec.cwd, path);
      return {
        type: "base64",
        // These become `image` blocks, which the API rejects with a non-image
        // type — so an unrecognised extension still has to guess an image.
        media_type: img.mimeType ?? mediaTypeFromName(path, "image/png"),
        data: readFileSync(abs).toString("base64"),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Turn one read of the SDK stream into queued events.
   *
   * The stream is read only as fast as the host consumes events — one message,
   * fully handled, then the next — which is exactly how the broker's direct
   * loop read it. That backpressure is load-bearing: the CLI's input channel is
   * only pulled as its stream is, so `pending()` at a turn end still counts
   * the messages that will open the next turns. Read eagerly in a loop of its
   * own, as this adapter used to, the stream ran ahead of the host, `pending()`
   * read 0 while two chained turns were already under way, and the chat went
   * idle in the middle of them.
   */
  private async absorb(
    read: { result: IteratorResult<unknown> } | { error: unknown },
  ): Promise<void> {
    if ("error" in read) {
      // An abort is an expected end, not a failure.
      if (!this.disposed && !this.abort.signal.aborted) this.fail(read.error);
      else this.end();
      return;
    }
    if (read.result.done) {
      this.end();
      return;
    }
    for (const event of this.decoder.decode(read.result.value as never)) {
      if (event.type === "compacted") {
        // `post_tokens` counts the summary and kept messages only — not the
        // system prompt and tools — so it read 3k on a chat whose very next
        // request was 29k. The CLI's own breakdown counts everything.
        const live = (await this.readContextUsage(LIVE_USAGE_TIMEOUT_MS))?.totalTokens;
        if (typeof live === "number" && Number.isFinite(live) && live >= 0) {
          event.postTokens = live;
          this.decoder.setContextTokens(live);
        }
      }
      this.emit(event);
      // The window is the meter's denominator and only the runtime knows it:
      // learn it once the process is live, and again after every turn, since a
      // model fallback can move it mid-session.
      if (event.type === "init" || event.type === "turn-end") void this.refreshWindow();
    }
  }

  /** The runtime died — see `HarnessSession.events` for why that is not a turn-end. */
  private fail(err: unknown): void {
    this.fatal = new Error(
      withStderrTail(err instanceof Error ? err.message : String(err), this.lastStderrTail),
    );
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
      abortController: this.abort,
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
    // The login account: `CLAUDE_CONFIG_DIR` on the subprocess. The SDK's `env`
    // REPLACES the inherited environment rather than overlaying it, hence the
    // merge — and it stays unset for the default account.
    const env = envWithAccount(this.spec.account);
    if (env) options.env = env;

    // The neutral limit becomes the window Claude Code compacts short of, so
    // its own between-requests trigger lands on the threshold — see
    // `claudeCompactWindow`.
    const window = claudeCompactWindow(this.spec.contextTokenLimit, this.spec.autoCompactWindow);
    options.settings = {
      autoCompactEnabled: this.spec.autoCompact ?? true,
      ...(window ? { autoCompactWindow: window } : {}),
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
    // No matcher: the guard answers for the MODE's tool denylist as well as the
    // workflow contract, and a denylist that only fired for `Bash` would gate
    // the shell while waving `Edit` and `approve_pr` through. The broker's
    // guard returns null for anything it has no rule about, so the extra calls
    // cost a function call each.
    if (this.spec.toolGuard) {
      hooks.PreToolUse!.push({ hooks: [this.guardHook()] });
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

    options.mcpServers = this.mcpServerSet();

    // The skills the host put on disk under the cwd are only DISCOVERED by the
    // CLI; `'all'` is what enables every one it found. Omitted is not "off" —
    // it is the CLI's own default, which is what a session with none gets.
    if (this.spec.skills.length) options.skills = "all";

    // Mode tool gating — see `HarnessSessionSpec.allowedTools`. Keeps a denied
    // tool out of the catalogue entirely; `toolGuard` above is what enforces it.
    // `!== undefined`, not `.length` — see the broker's `stampModeGate`: a
    // defined-but-empty allowlist permits nothing and must survive the trip.
    if (this.spec.allowedTools !== undefined) options.allowedTools = this.spec.allowedTools;
    if (this.spec.disallowedTools !== undefined) {
      options.disallowedTools = this.spec.disallowedTools;
    }

    return options;
  }

  /** The full server set handed to the SDK — at start, and again on every swap. */
  private mcpServerSet(): Record<string, SdkMcpServerConfig> {
    const servers: Record<string, SdkMcpServerConfig> = {
      ...(this.spec.mcpServers as unknown as Record<string, SdkMcpServerConfig>),
    };
    // Applied LAST so a project-configured server can't shadow Dispatch's own
    // tools even if it manages to collide with a `dispatch-*` name. Re-wrapping
    // on every swap is safe: the SDK keys a connected in-process server by name
    // and keeps the one it has, so a fresh config around the SAME instance
    // reconnects nothing.
    const manager = this.spec.managerMcp;
    if (manager?.transport === "in-process") {
      Object.assign(servers, claudeSdkMcpServers(manager.servers as Record<string, McpServer>));
    }
    return servers;
  }

  /**
   * `setMcpServers` REPLACES the whole dynamic set, so it gets every server —
   * Dispatch's in-process ones included. That is safe mid-tool-call: the SDK
   * keeps an in-process instance it already has under the same name connected,
   * and only hands process servers to the CLI, which reconnects the ones whose
   * definition changed. Omitting the manager servers would disconnect them,
   * including the one whose tool call triggered this refresh.
   */
  async updateMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    this.spec = { ...this.spec, mcpServers: { ...this.spec.mcpServers, ...servers } };
    await this.query?.setMcpServers(this.mcpServerSet());
  }

  /**
   * Reads the runtime's reported effort off every PreToolUse input. Read-only:
   * it always returns an empty verdict, so it can never block a call.
   *
   * The level is `input.effort.level`. This read `input.effort` itself — an
   * object, which never parses as a level — so every run card showed the
   * configured effort instead of what the runtime actually applied.
   */
  private observeEffortHook(): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const i = input as unknown as {
        effort?: { level?: unknown };
        agent_id?: unknown;
        tool_use_id?: unknown;
      };
      const level = EffortSchema.safeParse(i.effort?.level);
      if (!level.success) return {}; // a model without effort support
      // `agent_id` names a subagent thread; its absence means the main loop.
      // A subagent call whose run we can't name yet (a hook that beat its own
      // row) is skipped rather than credited to the main loop.
      if (typeof i.agent_id !== "string" || !i.agent_id) {
        this.threadEfforts.set(null, level.data);
        return {};
      }
      const thread =
        typeof i.tool_use_id === "string" ? this.toolThreads.get(i.tool_use_id) : undefined;
      if (thread) this.threadEfforts.set(thread, level.data);
      return {};
    };
  }

  /** Runs the host's composed tool guard on every call, before it runs. */
  private guardHook(): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const i = input as unknown as {
        tool_input?: unknown;
        tool_name?: unknown;
        agent_id?: unknown;
        tool_use_id?: unknown;
      };
      const toolInput = (i.tool_input ?? {}) as Record<string, unknown>;
      const agentId = typeof i.agent_id === "string" && i.agent_id ? i.agent_id : undefined;
      const toolUseId = typeof i.tool_use_id === "string" ? i.tool_use_id : undefined;
      // The run a subagent's call belongs to, when the stream has already
      // shown us the call — the host can do this lookup itself, but only once
      // its row has gone out, and a hook can beat it.
      const parent = agentId && toolUseId ? this.toolThreads.get(toolUseId) : undefined;
      // The real tool name, not a hardcoded "Bash": the hook is unmatched now,
      // so the guard must be told which tool it is being asked about. The cwd
      // goes in the CONTEXT: splicing it into the input (as this used to) made
      // the blocked row show a `cwd` argument the model never passed.
      const blocked = await catchToolGuard(
        this.spec.toolGuard,
        typeof i.tool_name === "string" ? i.tool_name : "Bash",
        toolInput,
        "in-place",
        {
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
          agentId,
          toolUseId,
          parentToolUseId: parent ?? undefined,
        },
      );
      if (!blocked) return {};
      this.emit(blocked);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: blocked.reason,
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
    opts:
      | {
          signal?: AbortSignal;
          title?: string;
          displayName?: string;
          description?: string;
          decisionReason?: string;
          toolUseID?: string;
          agentID?: string;
        }
      | undefined,
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
          this.requestInputs.delete(requestId);
          resolve({ behavior: "deny", message: "interrupted" });
        }
      };
      const settle = (result: PermissionResult): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      this.pendingPermissions.set(requestId, settle);
      signal?.addEventListener("abort", onAbort, { once: true });

      // The run asking: the stream named this call's thread before the CLI
      // asked about it. A subagent call it didn't name stays unattributed
      // rather than being charged to the main loop.
      const thread = opts?.toolUseID ? this.toolThreads.get(opts.toolUseID) : undefined;
      const parentToolUseId = thread ?? (opts?.agentID ? undefined : null);
      this.requestInputs.set(requestId, input);
      if (name === QUESTION_TOOL) {
        this.emit({
          type: "question-request",
          requestId,
          questions: neutralQuestions(input),
          parentToolUseId,
        });
        return;
      }
      this.emit({
        type: "permission-request",
        requestId,
        toolName: name,
        input,
        target: deriveTarget(input),
        // The CLI's own wording for the card — the direct loop always showed
        // it, and a card rebuilt from the tool name alone read "Allow Bash?".
        title: opts?.title,
        displayName: opts?.displayName,
        description: opts?.description,
        reason: opts?.decisionReason,
        parentToolUseId,
      });
    });
  }

  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    const original = this.requestInputs.get(requestId) ?? {};
    this.requestInputs.delete(requestId);
    if (resolution.decision === "allow") {
      resolve({
        behavior: "allow",
        updatedInput: resolution.updatedInput ?? original,
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
    const input = this.requestInputs.get(requestId) ?? {};
    this.pendingPermissions.delete(requestId);
    this.requestInputs.delete(requestId);
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
    if (!this.query) return;
    await this.query.setModel(model);
    // A switch can move the window (200k ↔ the 1M variant); relearn it so the
    // meter's denominator follows the model rather than the one before.
    void this.refreshWindow();
  }

  /**
   * Push a new effort level at a live session.
   *
   * `effort` is a start-of-query option, so the live twin is the flag-settings
   * layer: `applyFlagSettings({ effortLevel })` merges over user/project
   * settings and takes effect on the next request — subagents spawned after it
   * included. Falls back to the legacy thinking budget when the running CLI
   * predates the control or rejects the level, and REJECTS when that fails too,
   * so the host can say the change didn't land.
   */
  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
    // Everything observed so far described the OLD level; drop it so the next
    // hook re-reports, and a downgrade for this level is learned fresh.
    this.threadEfforts.clear();
    const q = this.query;
    if (!q) return;
    const apply = (q as Partial<Query>).applyFlagSettings;
    if (typeof apply === "function") {
      try {
        // `Settings.effortLevel` is typed low..xhigh while the query option
        // takes "max" too; the CLI reads the same strings for both, so pass it
        // through rather than silently clamping a chat that asked for max.
        await apply.call(q, { effortLevel: effort as "low" | "medium" | "high" | "xhigh" });
        return;
      } catch {
        /* fall through to the thinking-budget fallback */
      }
    }
    await q.setMaxThinkingTokens(EFFORT_THINKING_TOKENS[effort]);
  }

  /**
   * The `/` commands this runtime accepts, from the SDK's own list — built-ins,
   * plugin commands, and every skill it discovered (including the ones Dispatch
   * materialized into `<cwd>/.claude/skills/`).
   *
   * Asked of the SDK rather than derived from disk because only the runtime
   * knows its own built-ins, and only it knows what discovery actually found.
   * Returns [] rather than throwing when no query is live or the CLI is too old
   * to answer — the composer's menu then falls back to what Dispatch can see.
   */
  async slashCommands(): Promise<SlashCommandInfo[]> {
    try {
      const commands = await this.query?.supportedCommands();
      if (!Array.isArray(commands)) return [];
      return commands.map((c) => ({
        name: String(c.name ?? ""),
        description: c.description ? String(c.description) : undefined,
        argumentHint: c.argumentHint ? String(c.argumentHint) : undefined,
        // Everything the runtime reports is a "builtin" from Dispatch's side —
        // the catalog re-labels anything it also found on disk, so a project
        // skill isn't presented as something Claude Code ships.
        source: "builtin" as const,
        aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
      })).filter((c) => c.name);
    } catch {
      return [];
    }
  }

  /**
   * Compact via the CLI's own `/compact` — a slash command on the input
   * channel, with no control-channel equivalent. The focus rides the way the
   * CLI's `/compact focus on the API changes` does.
   *
   * Through `send()`, as an ordinary message, because that is what it is to the
   * CLI: it answers with a result like any turn (`controlTurns`). Pushed
   * straight at the channel, as this used to be, a compaction asked of a session
   * that had not started yet went nowhere.
   */
  async compact(focus?: string): Promise<void> {
    this.send({ text: compactCommand(focus), priority: "next" });
  }

  /**
   * The CLI's `/clear`, in place. The session id moves (the CLI opens a new
   * one), which the host sees at the next `init`; the subprocess, its MCP
   * servers and everything they hold are kept.
   */
  async clear(): Promise<void> {
    this.send({ text: "/clear", priority: "next" });
  }

  /**
   * Accept a moved limit without a respawn when the window it derives is the
   * one the CLI is already running with — two limits below its floor clamp to
   * the same window, and respawning for that buys nothing. A window that DID
   * move is refused: `applyFlagSettings({ autoCompactWindow })` is accepted and
   * changes nothing (measured), so only a respawn moves it.
   */
  async setContextTokenLimit(limit: number | undefined, autoCompactWindow?: number): Promise<void> {
    const next = claudeCompactWindow(limit, autoCompactWindow);
    if (this.query && next !== this.spawnWindow) {
      throw new Error("Claude Code fixes its compaction window when it starts");
    }
    this.spec = { ...this.spec, contextTokenLimit: limit, autoCompactWindow };
  }

  async contextWindow(): Promise<number | undefined> {
    return this.decoder.contextWindow;
  }

  /** The CLI's own breakdown, for the meter's detail view. */
  async contextUsage(): Promise<ContextUsage | undefined> {
    return this.readContextUsage();
  }

  /**
   * `getContextUsage()`, optionally bounded, never throwing. A fresh read also
   * refreshes the window the turn-end rows carry.
   */
  private async readContextUsage(timeoutMs?: number): Promise<ContextUsage | undefined> {
    const q = this.query;
    if (!q?.getContextUsage) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = q.getContextUsage();
      const usage = await (timeoutMs === undefined
        ? read
        : Promise.race([
            read,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), timeoutMs);
            }),
          ]));
      if (!usage) return undefined;
      if (typeof usage.maxTokens === "number" && usage.maxTokens > 0) {
        this.decoder.contextWindow = usage.maxTokens;
      }
      return usage as unknown as ContextUsage;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Learn the live model's window and hand it to the host's meter. */
  private async refreshWindow(): Promise<void> {
    const max = (await this.readContextUsage())?.maxTokens;
    if (typeof max === "number" && max > 0) this.emit({ type: "usage", contextWindow: max });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Settle anything the SDK is blocked on, or the subprocess never exits.
    for (const [, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message: "session stopped" } as PermissionResult);
    }
    this.pendingPermissions.clear();
    this.requestInputs.clear();
    // Close the input, then kill the tree — the broker's direct loop did exactly
    // this for years. Closing only asks the CLI to wind down; the abort is what
    // the SDK turns into a kill of the process and every MCP server hanging off
    // it. No `interrupt()` first: awaiting a control request on a runtime that
    // has stopped answering would hold the kill behind it.
    this.input?.close();
    this.abort.abort();
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

