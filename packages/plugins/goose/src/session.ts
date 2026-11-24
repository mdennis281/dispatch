/**
 * One ACP session: the {@link HarnessSession} the broker actually drives.
 *
 * WHAT ACP GIVES US THAT CODEX DOES NOT. `session/request_permission` is raised
 * per TOOL CALL, with the tool's id, title and raw input attached, and it is a
 * real JSON-RPC request that blocks the agent until answered. That is the same
 * shape as Claude's `canUseTool`, which is why this provider advertises
 * `toolPermissions: true` where the Codex adapter must advertise false. The
 * workflow guard therefore gets a genuine veto point here: a denied call is
 * denied BEFORE it runs and the turn continues, rather than being caught after
 * the fact and needing the turn restarted.
 *
 * WHAT IT DOES NOT GIVE US, stated plainly because each one is a capability
 * declared false rather than an oversight:
 *   - no reasoning effort (no field anywhere in the protocol)
 *   - no fork (`session/load` resumes; there is no fork-at-message)
 *   - no account rate limits — a local model has none
 *   - no structured question channel (`AskUserQuestion` has no ACP twin)
 *   - no mid-session model switch: the model is chosen by the agent's own
 *     config at spawn, so {@link AcpSession.setModel} records the choice for
 *     the NEXT session rather than pretending to apply it now.
 *
 * COMPACTION IS A SLASH COMMAND, NOT A METHOD. ACP defines no compaction call,
 * but goose answers `/compact` and `/clear` sent as an ordinary prompt, so
 * {@link AcpSession.compact} and {@link AcpSession.clear} are turns of their
 * own (`controlTurns`). goose's `/compact` takes no argument, so a focus cannot
 * reach its summariser. goose also compacts on its own between model calls,
 * at the ratio the spawn env sets (see `gooseAutoCompactThreshold`); both kinds
 * surface as a `compacted` event rather than goose's own chatter.
 *
 * THE HANG HAZARD. Every agent→client request must be answered. An unanswered
 * one leaves the turn pinned forever with no error, no timeout and nothing on
 * stderr — observed during the spike. {@link AcpSession.onAgentRequest}
 * therefore has a total fallback: anything it does not recognise is refused
 * rather than dropped.
 */
import type { Effort, McpServerConfig, PermissionMode } from "@dispatch/shared";
import type {
  HarnessEvent,
  HarnessInput,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
  HarnessToolPolicy,
} from "@dispatch/shared";
import { readFileSync } from "node:fs";
import type { ImageRef, SlashCommandInfo } from "@dispatch/shared";
import type { AcpConnection, AgentRequest, RpcFrame } from "./rpc.js";
import { AcpStreamDecoder, turnEndOf, toolNameOf, remapInput } from "./stream.js";
import { HarnessEventQueue } from "@dispatch/shared";
import { catchToolGuard } from "@dispatch/shared";
import {
  toAcpMode,
  toEnvironmentBlock,
  toInstructionBlock,
  pickPermissionOption,
  gooseAutoCompactThreshold,
} from "./options.js";

/** A message waiting to go, or a slash command run as a turn of its own. */
type QueuedInput = HarnessInput & { control?: "compact" | "clear" };

/** What goose answers a successful `/compact` / `/clear` with (1.51.0). */
const CONTROL_REPLY = { compact: "Compaction complete", clear: "Conversation cleared" } as const;

/** A permission request waiting on the human. */
interface PendingAsk {
  /** JSON-RPC id of the agent's request, needed to answer it. */
  rpcId: number | string;
  options: { optionId: string; name?: string; kind?: string }[];
}

export interface AcpSessionOpts {
  spec: HarnessSessionSpec;
  conn: AcpConnection;
  /** Argv/env are owned by the harness; the session only needs to tear down. */
  release?: () => void;
  genId: () => string;
}

export class AcpSession implements HarnessSession {
  private readonly spec: HarnessSessionSpec;
  private readonly conn: AcpConnection;
  private readonly release?: () => void;
  private readonly genId: () => string;
  private readonly decoder: AcpStreamDecoder;

  private sessionId?: string;
  private started = false;
  private disposed = false;
  /** Messages queued before the session exists / while a turn is running. */
  private outbox: QueuedInput[] = [];
  /**
   * The slash command the in-flight turn is running, and goose's reply to it.
   * The reply is held back from the transcript: goose's "Compaction complete"
   * as an assistant message would read as the MODEL saying it, and anything
   * else it says here is an error.
   */
  private controlTurn?: { kind: "compact" | "clear"; reply: string; preTokens?: number };
  private unsubscribes: (() => void)[] = [];
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /** True while a `session/prompt` is in flight — ACP allows one turn at a time. */
  private turnInFlight = false;
  /** Set once the first prompt has carried the system-prompt appends. */
  private instructionsSent = false;
  private commands: SlashCommandInfo[] = [];
  /**
   * True while `session/load` is in flight. ACP requires the agent to REPLAY
   * the whole conversation as `session/update` notifications before it answers
   * the load — and Dispatch already has that transcript. Decoding the replay
   * re-persisted every earlier message and tool call, stamped with the current
   * time: a daily scheduled goose chat grew to 636 rows, most of them copies
   * of the same `chatcmpl-*` ids repeated once per run.
   */
  private loading = false;
  private model?: string;
  private mode: PermissionMode;
  /**
   * The mode gates tools, so every call has to surface for the guard to see.
   *
   * Mutable, and it has to be: a mode switch deliberately does NOT rebuild the
   * runtime mid-turn, so a snapshot taken at construction would leave a chat
   * switched INTO a restricted mode sitting in `auto` — raising no permission
   * requests, and therefore never reaching the guard that was just tightened.
   */
  private restricted: boolean;

  /* ------------------------------------------------- the event stream */

  private readonly out = new HarnessEventQueue<HarnessEvent>();

  constructor(opts: AcpSessionOpts) {
    this.spec = opts.spec;
    this.conn = opts.conn;
    this.release = opts.release;
    this.genId = opts.genId;
    this.model = opts.spec.model;
    this.mode = opts.spec.permissionMode;
    this.restricted = gatesTools(opts.spec);
    this.decoder = new AcpStreamDecoder({ genId: opts.genId });

    opts.spec.abortSignal?.addEventListener("abort", () => void this.dispose(), { once: true });
  }

  get events(): AsyncIterable<HarnessEvent> {
    return this.out.iterable();
  }

  private emit(...events: HarnessEvent[]): void {
    this.out.push(...events);
  }

  private end(): void {
    this.out.end();
  }

  /** Surface a failure as a turn end rather than an unhandled rejection. */
  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit(
      { type: "notice", level: "error", text: message },
      { type: "turn-end", ok: false, subtype: "error", result: message },
    );
    this.turnInFlight = false;
  }

  /* --------------------------------------------------------- sending */

  send(input: HarnessInput): void {
    if (this.disposed) return;
    this.outbox.push(input);
    if (!this.started) {
      this.started = true;
      void this.open().catch((err) => this.fail(err));
    } else {
      void this.flush().catch((err) => this.fail(err));
    }
  }

  pending(): number {
    return this.outbox.length;
  }

  /** Open (or resume) the session, then drain whatever is queued. */
  private async open(): Promise<void> {
    const init = await this.conn.ready();

    this.unsubscribes.push(this.conn.onNotify((f) => this.onNotify(f)));
    this.unsubscribes.push(this.conn.onRequest((r) => this.onAgentRequest(r)));
    this.conn.events.once("close", (err: Error) => {
      if (!this.disposed) this.fail(err);
      this.end();
    });

    const mcpServers = toAcpMcpServers(this.spec);

    let result: { sessionId?: string; modes?: { currentModeId?: string } };
    if (this.spec.resumeSessionId && init.agentCapabilities?.loadSession) {
      this.loading = true;
      try {
        result = await this.conn.call("session/load", {
          sessionId: this.spec.resumeSessionId,
          cwd: this.spec.cwd,
          mcpServers,
        });
      } finally {
        this.loading = false;
      }
      // `session/load` echoes no id of its own — it reopens the one we named.
      result.sessionId ??= this.spec.resumeSessionId;
    } else {
      result = await this.conn.call("session/new", { cwd: this.spec.cwd, mcpServers });
    }

    this.sessionId = result.sessionId;
    if (!this.sessionId) throw new Error("acp agent opened a session with no id");

    // The posture the spec asked for, not whatever the agent defaulted to.
    await this.applyMode(this.mode);

    this.emit({
      type: "init",
      sessionId: this.sessionId,
      ...(this.model ? { model: this.model } : {}),
      permissionMode: this.mode,
      ...(this.window() !== undefined ? { contextWindow: this.window() } : {}),
    });

    await this.flush();
  }

  /**
   * Send queued messages, one turn at a time.
   *
   * ACP has no steering channel: a `session/prompt` while another is in flight
   * is not defined to interleave, so messages that arrive mid-turn wait for the
   * current one instead. That is a real behavioural difference from Claude,
   * where a push mid-turn steers the running agent.
   */
  private async flush(): Promise<void> {
    if (this.turnInFlight || !this.sessionId) return;
    const next = this.outbox.shift();
    if (!next) return;
    this.turnInFlight = true;
    if (next.control) {
      this.controlTurn = {
        kind: next.control,
        reply: "",
        preTokens: this.decoder.contextTokens(),
      };
    }
    try {
      const result = await this.conn.call<Record<string, unknown>>("session/prompt", {
        sessionId: this.sessionId,
        // A command goes ALONE. goose recognises `/compact` only when the
        // turn's message text is exactly that, so the first-prompt instruction
        // blocks riding along would turn it into a request for the model to
        // talk about compacting. They wait for the next real message instead.
        prompt: next.control ? [{ type: "text", text: next.text }] : this.promptBlocks(next),
      });
      this.emit(...this.decoder.flushMessage());
      this.emit(...this.endControlTurn());
      this.emit(
        turnEndOf(result, {
          contextTokens: this.decoder.contextTokens(),
          contextWindow: this.window(),
        }),
      );
    } finally {
      this.turnInFlight = false;
      this.controlTurn = undefined;
    }
    // Anything that queued up while the turn ran goes now.
    if (this.outbox.length) void this.flush().catch((err) => this.fail(err));
  }

  /**
   * The content blocks for one message.
   *
   * Dispatch's system-prompt appends ride on the FIRST prompt only. ACP has no
   * system-prompt slot, and re-sending them every turn would re-pay their token
   * cost on a context window a local model can ill afford.
   */
  private promptBlocks(input: HarnessInput): unknown[] {
    const blocks: unknown[] = [];
    if (!this.instructionsSent) {
      // BEFORE the project's own instructions, because it is the frame they are
      // read in: "run the test suite" means something different on a box with
      // no `grep`. Every other provider states this in a system prompt it
      // builds itself; ACP has no system-prompt slot, so it rides here.
      blocks.push({
        type: "text",
        text: toEnvironmentBlock(process.platform, this.spec.cwd),
      });
      const instructions = toInstructionBlock(this.spec.systemPromptAppends);
      if (instructions) blocks.push({ type: "text", text: instructions });
      this.instructionsSent = true;
    }
    blocks.push({ type: "text", text: input.text });
    for (const image of input.images ?? []) {
      const block = toImageBlock(image);
      if (block) blocks.push(block);
    }
    return blocks;
  }

  /**
   * The events a finished `/compact` or `/clear` turn ends on.
   *
   * goose reports failure as an ordinary assistant message (its compaction
   * errors are caught and returned as text), so anything but the known reply
   * is surfaced as an error notice instead of being lost.
   */
  private endControlTurn(): HarnessEvent[] {
    const turn = this.controlTurn;
    if (!turn) return [];
    const reply = turn.reply.trim();
    if (reply === CONTROL_REPLY[turn.kind]) {
      if (turn.kind === "clear") return [];
      // Both sizes from here, not left to the host: goose sends the
      // post-compaction `usage_update` BEFORE the turn ends (seen live), so
      // the host's "last reading" would already be the shrunken one.
      const postTokens = this.decoder.contextTokens();
      return [
        {
          type: "compacted",
          trigger: "manual",
          ...(turn.preTokens !== undefined ? { preTokens: turn.preTokens } : {}),
          ...(postTokens !== undefined ? { postTokens } : {}),
        },
      ];
    }
    return [{ type: "notice", level: "error", text: reply || `goose did not confirm /${turn.kind}` }];
  }

  /* ------------------------------------------------------- receiving */

  private onNotify(frame: RpcFrame): void {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    // One process serves one session, but the field is present — honour it
    // rather than assuming, so a stray frame can never cross-contaminate.
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) return;

    const update = (params.update ?? {}) as Record<string, unknown>;
    if (frame.method === GOOSE_UPDATE_METHOD) {
      if (isAutoCompactionDone(update)) {
        // Mid-turn: whatever text streamed before the summary is its own row.
        this.emit(...this.decoder.flushMessage(), { type: "compacted", trigger: "auto" });
      }
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      this.commands = toSlashCommands(update.availableCommands);
      return;
    }
    // Dropped BEFORE the decoder, not filtered after it: the decoder
    // accumulates message text across chunks, so a replayed chunk left in its
    // buffer would be glued onto the front of the next real reply — which is
    // what the bloated chat shows ("…more accurate and helpful response.I'll
    // do a full…"). Only the content-bearing kinds: a `usage_update` during
    // load is the live context size, which the meter wants.
    if (this.loading && REPLAYED_UPDATES.has(String(update.sessionUpdate))) return;
    if (this.controlTurn && update.sessionUpdate === "agent_message_chunk") {
      const content = (update.content ?? {}) as Record<string, unknown>;
      if (typeof content.text === "string") this.controlTurn.reply += content.text;
      return;
    }
    this.emit(...this.decoder.decode(frame));
  }

  /**
   * Answer an agent→client request.
   *
   * The final `else` is load-bearing: an unanswered request hangs the turn
   * forever. Anything unrecognised is refused explicitly so the agent gets an
   * error it can report instead of blocking.
   */
  private onAgentRequest(req: AgentRequest): void {
    if (req.method === "session/request_permission") {
      void this.onPermissionRequest(req);
      return;
    }
    // `fs/*` and `terminal/*` should never arrive: DISPATCH_CLIENT_CAPABILITIES
    // declares both false, so the agent does this work itself. If one does
    // arrive, refusing beats hanging.
    this.conn.respondError(req.id, `dispatch does not implement ${req.method}`);
  }

  private async onPermissionRequest(req: AgentRequest): Promise<void> {
    const toolCall = (req.params.toolCall ?? {}) as Record<string, unknown>;
    const rawOptions = Array.isArray(req.params.options) ? req.params.options : [];
    const options = rawOptions.map((o) => {
      const opt = (o ?? {}) as Record<string, unknown>;
      return {
        optionId: String(opt.optionId ?? ""),
        name: typeof opt.name === "string" ? opt.name : undefined,
        kind: typeof opt.kind === "string" ? opt.kind : undefined,
      };
    });
    const requestId = this.genId();
    this.pendingAsks.set(requestId, { rpcId: req.id, options });

    const title = typeof toolCall.title === "string" ? toolCall.title : undefined;
    const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
    // The permission request's toolCall carries NO `_meta.goose.toolCall`, so
    // unlike a `tool_call` update there is no tool name to read. The title is
    // the only carrier: goose formats it "<tool> · <target>". Recovering the
    // name from it is what lets the guard and the approval card see the same
    // `Bash` that the transcript row will show a moment later.
    const { rawName, target } = splitPermissionTitle(title);
    const toolName = toolNameOf(rawName, "developer");
    const input = remapInput(rawName ?? "", rawInput);

    // THE GUARD RUNS BEFORE THE CARD. This adapter advertises
    // `preToolGuard: true`, and until now that was a lie: a call the host
    // forbids arrived as an ordinary approval prompt, so a mode's denylist
    // became something the human could click through. For the global posture
    // that is the whole thing defeated by one "Allow".
    //
    // Declined at the protocol level rather than by not showing the card: the
    // agent is blocked on this RPC and has to be answered either way — which
    // is also why a guard that throws counts as no verdict, not as no answer.
    // No cwd in the context: goose's permission request does not carry one,
    // and the chat's starting directory would be a guess dressed as a fact.
    const blocked = await catchToolGuard(this.spec.toolGuard, toolName, input, "in-place", {
      toolUseId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
    }).catch(() => null);
    // `dispose` answers every registered ask; one it reached while the guard
    // deliberated has been answered already and must not be answered twice.
    if (!this.pendingAsks.has(requestId)) return;
    if (blocked) {
      this.pendingAsks.delete(requestId);
      const rejectId = pickPermissionOption(options, "deny");
      this.conn.respond(
        req.id,
        rejectId
          ? { outcome: { outcome: "selected", optionId: rejectId } }
          : { outcome: { outcome: "cancelled" } },
      );
      this.emit(blocked);
      return;
    }

    this.emit({
      type: "permission-request",
      requestId,
      toolName,
      input,
      ...(target ? { target } : {}),
    });
  }

  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    const optionId = pickPermissionOption(ask.options, resolution.decision);
    if (!optionId) {
      // No option we can select — cancel rather than leave the agent waiting.
      this.conn.respond(ask.rpcId, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.conn.respond(ask.rpcId, { outcome: { outcome: "selected", optionId } });
  }

  /** ACP has no structured question channel; `questions` is advertised false. */
  resolveQuestion(_requestId: string, _answers: HarnessQuestionAnswer[]): void {
    /* nothing can be pending */
  }

  /* -------------------------------------------------------- controls */

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    // A notification, not a request — ACP defines no response for it.
    this.conn.notify("session/cancel", { sessionId: this.sessionId });
  }

  private async applyMode(mode: PermissionMode): Promise<void> {
    if (!this.sessionId) return;
    await this.conn.call("session/set_mode", {
      sessionId: this.sessionId,
      modeId: toAcpMode(mode, this.restricted),
    });
  }

  async setPermissionMode(mode: PermissionMode, policy?: HarnessToolPolicy): Promise<void> {
    this.mode = mode;
    // The gate moves with the mode. Only when the broker said so: a caller
    // with nothing to say about the policy must not be read as "no policy".
    if (policy) this.restricted = gatesTools(policy);
    await this.applyMode(mode);
  }

  /**
   * ACP cannot change the model of a live session.
   *
   * The agent resolves its model from its own config when it spawns, so the
   * honest behaviour is to record the choice and let the NEXT session pick it
   * up — which is what the broker does when it restarts a chat. Advertised as
   * `liveModelSwitch: false` so the UI says so rather than appearing to work.
   */
  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  /** ACP has no reasoning-effort concept. */
  async setEffort(_effort: Effort): Promise<void> {
    /* nothing to set */
  }

  /**
   * goose's own `/compact`, as a turn of its own at the front of the queue.
   *
   * The focus is DROPPED, deliberately: goose matches the command text exactly
   * (`/compact`, `/summarize`) and ignores anything after it, and sending the
   * focus as a message of its own would just be a turn the model answers.
   */
  async compact(_focus?: string): Promise<void> {
    this.enqueueControl("compact");
  }

  /**
   * goose's own `/clear`, in place: the process, its session id and every MCP
   * server it holds are kept, where a retire-and-respawn would rebuild them.
   */
  async clear(): Promise<void> {
    this.enqueueControl("clear");
  }

  private enqueueControl(kind: "compact" | "clear"): void {
    if (this.disposed) return;
    // Ahead of queued messages, like Claude's `priority: "next"`: a compaction
    // asked for because the window is full should not wait behind the very
    // messages that would overflow it.
    this.outbox.unshift({ text: `/${kind}`, control: kind });
    if (!this.started) {
      this.started = true;
      void this.open().catch((err) => this.fail(err));
    } else {
      void this.flush().catch((err) => this.fail(err));
    }
  }

  /**
   * Accept a moved limit only when it changes nothing goose would notice.
   *
   * goose reads its threshold from the env once, at spawn, so a threshold that
   * really moved is refused and the host respawns the session (`session/load`
   * keeps the conversation). Two limits that round to the same ratio, or that
   * both sit at or past the window, keep the running process.
   */
  async setContextTokenLimit(limit: number | undefined): Promise<void> {
    const { contextWindow, autoCompact, contextTokenLimit } = this.spec;
    const now = gooseAutoCompactThreshold(contextTokenLimit, contextWindow, autoCompact);
    const next = gooseAutoCompactThreshold(limit, contextWindow, autoCompact);
    if (now !== next) throw new Error("goose fixes its compaction threshold when it starts");
  }

  async contextWindow(): Promise<number | undefined> {
    return this.window();
  }

  /**
   * The context window to report — the resolved one, never the agent's.
   *
   * goose sends `size: 128000` in every `usage_update` whatever model is
   * loaded. The Ollama behind it was serving 32768, so the meter read 28% full
   * at the moment a 36,191-token request was rejected for not fitting. The
   * broker resolves the real number from Ollama and puts it on the spec; the
   * decoder's value is the fallback for when it could not.
   */
  private window(): number | undefined {
    return this.spec.contextWindow ?? this.decoder.contextWindow();
  }

  /** Commands the agent announced via `available_commands_update`. */
  async slashCommands(): Promise<SlashCommandInfo[]> {
    return this.commands;
  }

  /**
   * The agent process's pid — the root of this chat's process tree.
   *
   * Available precisely because this adapter spawns one process per session;
   * see the module header on `rpc.ts` for why that trade was made.
   */
  pid(): number | undefined {
    return this.conn.pid();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Any request still waiting on a human would otherwise pin the agent while
    // it dies. Cancel them first so the teardown is clean.
    for (const [, ask] of this.pendingAsks) {
      this.conn.respond(ask.rpcId, { outcome: { outcome: "cancelled" } });
    }
    this.pendingAsks.clear();
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.conn.dispose();
    this.release?.();
    this.end();
  }
}

/* ------------------------------------------------------------ helpers */

/** goose's own notification channel, opted into at `initialize`. */
const GOOSE_UPDATE_METHOD = "_goose/unstable/session/update";

/**
 * Is this goose-custom update the end of an AUTO compaction?
 *
 * goose 1.51.0 brackets one with two `status_message` notices, "Exceeded
 * auto-compact threshold of N%. Performing auto-compaction..." and then
 * "Compaction complete", plus a `progress` status between them. Only the last
 * says it worked (a failure arrives as assistant text instead), and one row per
 * compaction is the contract. The text is the only marker there is: the notice
 * carries no kind, and the compaction's own `message_usage` frame is not sent.
 */
function isAutoCompactionDone(update: Record<string, unknown>): boolean {
  if (update.sessionUpdate !== "status_message") return false;
  const status = (update.status ?? {}) as Record<string, unknown>;
  return status.type === "notice" && status.message === CONTROL_REPLY.compact;
}

/**
 * The `session/update` kinds goose's `replay_conversation_to_client` sends
 * during `session/load` — each would become a transcript row (or, for text,
 * decoder state) if decoded. `plan` is included because the spec replays
 * "like `session/prompt`", which may carry one. Everything else that arrives
 * during a load (`usage_update`, `available_commands_update`,
 * `current_mode_update`, `session_info_update`) describes the session as it is
 * now, not its history, and passes through.
 */
const REPLAYED_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/**
 * Dispatch's MCP vocabulary → ACP's `mcpServers` array.
 *
 * ACP takes a LIST of tagged servers where Dispatch keeps a name→config map, so
 * the name moves from the key onto the entry. Two transports matter:
 *
 *   stdio  `{ name, command, args, env: [{name, value}] }`
 *   http   `{ type: "http", name, url, headers: [{name, value}] }`
 *
 * The env/header shape is the trap: ACP wants an ARRAY of name/value pairs, not
 * an object. Passing an object silently yields a server with no environment.
 *
 * Dispatch's own manager tools arrive already shaped as HTTP endpoints plus one
 * bearer token (see services/mcp/manager-http.ts), which is exactly what
 * `mcpCapabilities.http` unlocks — the reason this provider can serve the full
 * `mcp__dispatch-*` surface without a second implementation.
 */
export function toAcpMcpServers(spec: HarnessSessionSpec): unknown[] {
  const pairs = (obj: Record<string, string> | undefined): { name: string; value: string }[] =>
    Object.entries(obj ?? {}).map(([name, value]) => ({ name, value }));

  const out: unknown[] = [];
  for (const [name, config] of Object.entries(spec.mcpServers ?? {})) {
    const c = config as McpServerConfig;
    if (c.url) {
      out.push({ type: "http", name, url: c.url, headers: pairs(c.headers) });
    } else if (c.command) {
      out.push({ name, command: c.command, args: c.args ?? [], env: pairs(c.env) });
    }
  }

  const manager = spec.managerMcp;
  if (manager && manager.transport === "http") {
    for (const [name, url] of Object.entries(manager.urls)) {
      out.push({
        type: "http",
        name,
        url,
        headers: [{ name: "Authorization", value: `Bearer ${manager.token}` }],
      });
    }
  }
  return out;
}

/** ACP's announced commands → the composer's menu rows. */
export function toSlashCommands(raw: unknown): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommandInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : undefined;
    if (!name) continue;
    const hint = (e.input ?? {}) as Record<string, unknown>;
    out.push({
      name,
      ...(typeof e.description === "string" ? { description: e.description } : {}),
      ...(typeof hint.hint === "string" ? { argumentHint: hint.hint } : {}),
      // Everything the agent announces is built into it; a Dispatch-authored
      // command would have come from disk and been catalogued separately.
      source: "builtin",
      aliases: [],
    });
  }
  return out;
}

/**
 * Recover a tool name from a permission request's title.
 *
 * The permission request's `toolCall` carries no `_meta`, so unlike a
 * `tool_call` update there is no tool name to read — only a title that goose
 * formats as `"<tool> · <target>"` (with a U+00B7 middle dot). Splitting it is
 * what lets the approval card, the workflow guard and the transcript row that
 * follows all name the same tool.
 *
 * A title with no separator is a tool with no target (`"tree"`), which is a
 * name on its own. An absent title leaves the name undefined, and
 * {@link toolNameOf} turns that into the generic "Tool" rather than a crash.
 */
export function splitPermissionTitle(title: string | undefined): {
  rawName?: string;
  target?: string;
} {
  if (!title) return {};
  const idx = title.indexOf("·");
  if (idx < 0) return { rawName: title.trim() };
  return {
    rawName: title.slice(0, idx).trim() || undefined,
    target: title.slice(idx + 1).trim() || undefined,
  };
}

/**
 * An attached image → an ACP content block.
 *
 * ACP takes base64 bytes inline (`{ type: "image", data, mimeType }`) — there
 * is no "here is a path, go read it" block the way Codex's `localImage` is, so
 * the file is read here. A remote or data URL becomes a `resource_link`
 * instead, because inlining it would mean fetching it on the agent's behalf.
 *
 * Returns undefined rather than throwing when the file cannot be read: losing
 * an attachment is bad, but failing the whole turn because one image moved is
 * worse.
 */
export function toImageBlock(img: ImageRef): Record<string, unknown> | undefined {
  if (!img.path) return undefined;
  if (/^(https?:|data:)/.test(img.path)) {
    return { type: "resource_link", uri: img.path, name: img.alt ?? "attachment" };
  }
  try {
    return {
      type: "image",
      data: readFileSync(img.path).toString("base64"),
      mimeType: img.mimeType ?? "image/png",
    };
  } catch {
    return undefined;
  }
}

/**
 * Does this policy gate tools at all?
 *
 * An allowlist counts even when EMPTY — defined-but-empty permits nothing,
 * which is the strictest policy there is and the one a `.length` check
 * silently turns into the loosest.
 */
function gatesTools(policy: HarnessToolPolicy): boolean {
  return policy.allowedTools !== undefined || (policy.disallowedTools?.length ?? 0) > 0;
}
