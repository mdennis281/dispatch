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
 *   - no host-triggered compaction
 *   - no account rate limits — a local model has none
 *   - no structured question channel (`AskUserQuestion` has no ACP twin)
 *   - no mid-session model switch: the model is chosen by the agent's own
 *     config at spawn, so {@link AcpSession.setModel} records the choice for
 *     the NEXT session rather than pretending to apply it now.
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
} from "../types.js";
import { readFileSync } from "node:fs";
import type { ImageRef, SlashCommandInfo } from "@dispatch/shared";
import type { AcpConnection, AgentRequest, RpcFrame } from "./rpc.js";
import { AcpStreamDecoder, turnEndOf, toolNameOf, remapInput } from "./stream.js";
import {
  toAcpMode,
  toEnvironmentBlock,
  toInstructionBlock,
  pickPermissionOption,
} from "./options.js";

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
  private outbox: HarnessInput[] = [];
  private unsubscribes: (() => void)[] = [];
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /** True while a `session/prompt` is in flight — ACP allows one turn at a time. */
  private turnInFlight = false;
  /** Set once the first prompt has carried the system-prompt appends. */
  private instructionsSent = false;
  private commands: SlashCommandInfo[] = [];
  private model?: string;
  private mode: PermissionMode;

  /* ------------------------------------------------- the event stream */

  private readonly queue: HarnessEvent[] = [];
  private waiter?: () => void;
  private ended = false;

  constructor(opts: AcpSessionOpts) {
    this.spec = opts.spec;
    this.conn = opts.conn;
    this.release = opts.release;
    this.genId = opts.genId;
    this.model = opts.spec.model;
    this.mode = opts.spec.permissionMode;
    this.decoder = new AcpStreamDecoder({ genId: opts.genId });

    opts.spec.abortSignal?.addEventListener("abort", () => void this.dispose(), { once: true });
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
      result = await this.conn.call("session/load", {
        sessionId: this.spec.resumeSessionId,
        cwd: this.spec.cwd,
        mcpServers,
      });
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
    try {
      const result = await this.conn.call<Record<string, unknown>>("session/prompt", {
        sessionId: this.sessionId,
        prompt: this.promptBlocks(next),
      });
      this.emit(...this.decoder.flushMessage());
      this.emit(
        turnEndOf(result, {
          contextTokens: this.decoder.contextTokens(),
          contextWindow: this.window(),
        }),
      );
    } finally {
      this.turnInFlight = false;
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

  /* ------------------------------------------------------- receiving */

  private onNotify(frame: RpcFrame): void {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    // One process serves one session, but the field is present — honour it
    // rather than assuming, so a stray frame can never cross-contaminate.
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) return;

    const update = (params.update ?? {}) as Record<string, unknown>;
    if (update.sessionUpdate === "available_commands_update") {
      this.commands = toSlashCommands(update.availableCommands);
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
      this.onPermissionRequest(req);
      return;
    }
    // `fs/*` and `terminal/*` should never arrive: DISPATCH_CLIENT_CAPABILITIES
    // declares both false, so the agent does this work itself. If one does
    // arrive, refusing beats hanging.
    this.conn.respondError(req.id, `dispatch does not implement ${req.method}`);
  }

  private onPermissionRequest(req: AgentRequest): void {
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
    this.emit({
      type: "permission-request",
      requestId,
      toolName: toolNameOf(rawName, "developer"),
      input: remapInput(rawName ?? "", rawInput),
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
      modeId: toAcpMode(mode),
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
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

  /** ACP has no host-triggered compaction; `compaction` is advertised false. */
  async compact(_focus?: string): Promise<void> {
    /* not supported */
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
