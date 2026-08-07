/**
 * Agent SDK message stream → neutral {@link HarnessEvent}s.
 *
 * Lifted verbatim (behavior-wise) out of `SessionBroker.handleMessage`, which
 * used to switch on the raw SDK union inline. The subtle parts are all still
 * here and still commented, because they are the parts that break quietly:
 *
 *  - the single `streamAssistantId` slot that lets a finalized `assistant` row
 *    replace the live typing buffer in place, and why ONLY the main loop may
 *    touch it;
 *  - main-loop-only context accounting, since subagents carry their own window;
 *  - AskUserQuestion being suppressed here because it renders as an interactive
 *    question card off the permission channel instead.
 *
 * Kept as a stateful decoder rather than a pure function because the SDK stream
 * genuinely is stateful: `message_start` allocates an id that a later
 * `assistant` message must reuse. Isolating that state here is what let the
 * broker stop caring which runtime it is talking to.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "@dispatch/shared";
import type { HarnessEvent } from "../types.js";

/** Tool whose call is rendered as a question card, not a generic tool row. */
export const QUESTION_TOOL = "AskUserQuestion";

/**
 * Tokens occupying the context window for one request.
 *
 * Cache reads/writes count against the window exactly like fresh input, so the
 * occupancy is input + both cache buckets + output. Returns null when the usage
 * payload isn't shaped like we expect, so a miss leaves the last good number in
 * place instead of zeroing the meter.
 */
export function contextTokensOf(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total =
    n(u.input_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.output_tokens);
  return total > 0 ? total : null;
}

/** Parse `mcp__<server>__<tool>` → server id. Undefined for a built-in tool. */
export function parseMcpServer(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i >= 0 ? rest.slice(0, i) : rest;
}

/** Content blocks of an SDK message, defensively. */
function contentBlocks(m: Record<string, unknown>): Record<string, unknown>[] {
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

/** How the decoder asks the host what effort a thread is really running at. */
export type EffortResolver = (parentToolUseId: string | null) => Effort | undefined;

export interface ClaudeStreamDecoderOpts {
  /** Fresh ids for rows the SDK doesn't name. */
  genId: () => string;
  /**
   * Effort the runtime reported for a thread, learned from PreToolUse hooks.
   * Kept a callback because only the session (which installs the hook) knows.
   */
  effortOf?: EffortResolver;
  /** Called with each tool_use id + its thread, before the event is emitted. */
  onToolThread?: (toolUseId: string, parentToolUseId: string | null) => void;
}

export class ClaudeStreamDecoder {
  private readonly genId: () => string;
  private readonly effortOf: EffortResolver;
  private readonly onToolThread?: (id: string, parent: string | null) => void;

  /**
   * The id the in-flight MAIN-LOOP assistant message is streaming under.
   *
   * One slot, because the main loop is sequential. Subagents deliberately never
   * read or write it: their partials interleave with the main loop's, so a
   * subagent `message_start` landing here would orphan the main loop's buffer
   * as a stuck ●●● row and duplicate its text.
   */
  private streamAssistantId?: string;

  /** Main-loop context occupancy from the last assistant message. */
  private lastContextTokens?: number;

  /** Session id, learned at init and stamped onto later events by the caller. */
  sessionId?: string;
  /** Model the SDK reports at init. */
  model?: string;
  /** Window size, set by the session once it can probe for it. */
  contextWindow?: number;

  constructor(opts: ClaudeStreamDecoderOpts) {
    this.genId = opts.genId;
    this.effortOf = opts.effortOf ?? (() => undefined);
    this.onToolThread = opts.onToolThread;
  }

  /** Latest known main-loop occupancy, for the turn-end event. */
  contextTokens(): number | undefined {
    return this.lastContextTokens;
  }

  /**
   * Translate one SDK message into zero or more neutral events.
   *
   * Synchronous and allocation-light: the broker still owns the async work
   * (persisting tool-result images, writing rows), so this stays testable
   * without a filesystem.
   */
  decode(raw: SDKMessage): HarnessEvent[] {
    const m = raw as unknown as Record<string, unknown> & { type: string };
    switch (m.type) {
      case "system":
        return this.decodeSystem(m);
      case "assistant":
        return this.decodeAssistant(m);
      case "user":
        return this.decodeUser(m);
      case "stream_event":
        return this.decodeStreamEvent(m);
      case "result":
        return this.decodeResult(m);
      default:
        return [];
    }
  }

  private decodeSystem(m: Record<string, unknown>): HarnessEvent[] {
    const subtype = String((m as { subtype?: unknown }).subtype ?? "system");
    const out: HarnessEvent[] = [];

    if (subtype === "init") {
      const sid = (m as { session_id?: string }).session_id;
      if (sid) this.sessionId = sid;
      this.model = (m as { model?: string }).model;
      out.push({
        type: "init",
        sessionId: this.sessionId ?? "",
        model: this.model,
        permissionMode: (m as { permissionMode?: string }).permissionMode,
        tools: (m as { tools?: unknown }).tools,
        mcpServers: (m as { mcp_servers?: unknown }).mcp_servers,
      });
    }

    // A backgrounded task (async `Agent` spawn, backgrounded `Bash`) settled.
    // This is the ONLY per-task completion signal in the stream — the task's
    // tool call answered with a launch ack long ago — so it has to become its
    // own row keyed to the launching tool_use.
    if (subtype === "task_notification") {
      const usage = (m as { usage?: Record<string, unknown> }).usage;
      const status = String((m as { status?: unknown }).status ?? "completed");
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
      out.push({
        type: "task-notification",
        taskId: String((m as { task_id?: unknown }).task_id ?? ""),
        toolUseId:
          typeof (m as { tool_use_id?: unknown }).tool_use_id === "string"
            ? ((m as { tool_use_id?: string }).tool_use_id as string)
            : undefined,
        status: status === "failed" || status === "stopped" ? status : "completed",
        summary:
          typeof (m as { summary?: unknown }).summary === "string"
            ? ((m as { summary?: string }).summary as string)
            : undefined,
        totalTokens: num(usage?.total_tokens),
        toolUses: num(usage?.tool_uses),
        durationMs: num(usage?.duration_ms),
      });
    }
    return out;
  }

  private decodeAssistant(m: Record<string, unknown>): HarnessEvent[] {
    // A subagent (spawned via the Task tool) tags every message it emits with
    // the spawning tool_use id + its own type. Both ride onto the events so the
    // client can nest them under the same Task card.
    const parentToolUseId = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    const subagentType = (m as { subagent_type?: string }).subagent_type;
    const isMainLoop = parentToolUseId === null;

    // Only the main loop's usage describes the window the user is watching —
    // subagents each have their own separate context.
    if (isMainLoop) {
      const ctx = contextTokensOf((m as { message?: { usage?: unknown } }).message?.usage);
      if (ctx !== null) this.lastContextTokens = ctx;
    }

    let text = "";
    let thinking = "";
    const toolBlocks: Record<string, unknown>[] = [];
    for (const b of contentBlocks(m)) {
      const t = b.type;
      if (t === "text") text += String(b.text ?? "");
      else if (t === "thinking") thinking += String(b.thinking ?? "");
      else if (t === "tool_use") toolBlocks.push(b);
    }

    // Correlate this finalized message with the buffer its chunks streamed into
    // by reusing the exact id they published under. That in-place swap is what
    // stops the client from showing the text twice.
    const apiMessageId = (m as { message?: { id?: string } }).message?.id;
    const assistantId = isMainLoop
      ? this.streamAssistantId ?? apiMessageId ?? this.genId()
      : apiMessageId ?? this.genId();
    // The main loop is sequential, so consuming the slot is unconditional — a
    // no-op when nothing streamed (e.g. a tool-only message).
    if (isMainLoop) this.streamAssistantId = undefined;

    const out: HarnessEvent[] = [];
    if (text || thinking) {
      out.push({
        type: "assistant",
        id: assistantId,
        text,
        thinking: thinking || undefined,
        model: this.model,
        uuid: (m as { uuid?: string }).uuid,
        parentToolUseId,
        subagentType,
        effort: this.effortOf(parentToolUseId),
      });
    }

    for (const tb of toolBlocks) {
      const name = String(tb.name ?? "");
      // AskUserQuestion is surfaced as an interactive question card off the
      // permission channel; a generic tool row here would duplicate it and
      // leave an orphan "running AskUserQuestion" card that never resolves.
      if (name === QUESTION_TOOL) continue;
      const toolUseId = String(tb.id ?? this.genId());
      // Stamped BEFORE the event goes out: the PreToolUse hook for this call is
      // what reports the thread's effort, and it can only name the call.
      this.onToolThread?.(toolUseId, parentToolUseId);
      out.push({
        type: "tool-use",
        toolUseId,
        name,
        input: (tb.input ?? {}) as Record<string, unknown>,
        server: parseMcpServer(name),
        parentToolUseId,
        subagentType,
        effort: this.effortOf(parentToolUseId),
        uuid: (m as { uuid?: string }).uuid,
      });
    }
    return out;
  }

  private decodeUser(m: Record<string, unknown>): HarnessEvent[] {
    // A subagent's tool_result rides a `user` message tagged with the spawning
    // Task tool_use id — carry that through so the row nests correctly.
    const parentToolUseId = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    const subagentType = (m as { subagent_type?: string }).subagent_type;
    const out: HarnessEvent[] = [];
    for (const b of contentBlocks(m)) {
      if (b.type !== "tool_result") continue;
      out.push({
        type: "tool-result",
        toolUseId: String(b.tool_use_id ?? ""),
        ok: !b.is_error,
        content: b.content,
        parentToolUseId,
        subagentType,
      });
    }
    return out;
  }

  private decodeStreamEvent(m: Record<string, unknown>): HarnessEvent[] {
    // Only the MAIN loop streams live. Subagents run concurrently and their
    // partials interleave; honoring them would let a subagent `message_start`
    // clobber the single id slot. Subagent text still renders from its
    // finalized (nested) assistant row.
    const parentToolUseId = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    if (parentToolUseId !== null) return [];

    const event = (m as { event?: Record<string, unknown> }).event;
    if (!event || typeof event !== "object") return [];
    const et = String((event as { type?: unknown }).type ?? "");

    if (et === "message_start") {
      // Adopt the id the chunks AND the finalized row will share, so the two
      // correlate even when a subagent message finalizes in between.
      const startId = (event as { message?: { id?: string } }).message?.id;
      this.streamAssistantId = startId ?? this.genId();
      return [];
    }
    if (et !== "content_block_delta") return [];

    const delta = (event as { delta?: Record<string, unknown> }).delta;
    const dt = String((delta as { type?: unknown } | undefined)?.type ?? "");
    let channel: "text" | "thinking" | undefined;
    let piece = "";
    if (dt === "text_delta") {
      channel = "text";
      piece = String((delta as { text?: unknown }).text ?? "");
    } else if (dt === "thinking_delta") {
      channel = "thinking";
      piece = String((delta as { thinking?: unknown }).thinking ?? "");
    }
    if (!channel || !piece) return [];

    // Defensive: if `message_start` was missed, allocate on the first delta so
    // the id still correlates with the finalized row.
    if (!this.streamAssistantId) this.streamAssistantId = this.genId();
    return [{ type: "delta", id: this.streamAssistantId, channel, delta: piece }];
  }

  private decodeResult(m: Record<string, unknown>): HarnessEvent[] {
    const isError = Boolean((m as { is_error?: unknown }).is_error);
    const result =
      typeof (m as { result?: unknown }).result === "string"
        ? ((m as { result?: string }).result as string)
        : undefined;
    return [
      {
        type: "turn-end",
        ok: !isError,
        subtype: String((m as { subtype?: unknown }).subtype ?? "success"),
        result,
        numTurns: (m as { num_turns?: number }).num_turns,
        durationMs: (m as { duration_ms?: number }).duration_ms,
        costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
        usage: (m as { usage?: unknown }).usage,
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
      },
    ];
  }
}
