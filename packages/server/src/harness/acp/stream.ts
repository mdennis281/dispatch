/**
 * ACP `session/update` notifications → neutral {@link HarnessEvent}s.
 *
 * ACP's stream is update-oriented: one notification type (`session/update`)
 * carrying a discriminated `update.sessionUpdate`. That is a closer fit to
 * Dispatch's transcript than either of the other two runtimes, so most of the
 * work here is naming rather than restructuring.
 *
 * THE NAMING DECISION, inherited from the Codex decoder and for the same
 * reason. goose names its tools `shell`, `write`, `edit`; Claude names them
 * `Bash`, `Write`, `Edit`. We translate INTO Claude's names and, just as
 * importantly, into Claude's INPUT KEYS (`path` → `file_path`), because every
 * downstream consumer already keys off both: the tool icons, the target
 * derivation that labels "running Bash · git status", and the workflow guard's
 * Bash matcher. A goose row that said `shell · path=x` would render untargeted
 * and slip past the guard. The cost is that a goose command row says "Bash"
 * when goose would say "shell" — a name the user already knows.
 *
 * WHAT IS DELIBERATELY DROPPED. `tool_call_update` frames with
 * `status: "in_progress"` carry live stdout chunks. Dispatch has no streaming
 * tool-output event to put them in, so they are ignored rather than
 * accumulated: buffering output nothing can render would grow unboundedly on a
 * long-running command for no user-visible gain.
 */
import type { HarnessEvent } from "../types.js";
import type { RpcFrame } from "./rpc.js";

/** One ACP session update, loosely typed — we probe fields rather than model every variant. */
type Update = Record<string, unknown> & { sessionUpdate?: string };

/**
 * goose's developer-extension tool names → Claude's.
 *
 * Every entry was observed on a live goose 1.51.0 run, not taken from docs.
 * A tool that is not here keeps its own name, which is the right default: an
 * MCP tool from a project server must NOT be renamed, and inventing a mapping
 * for a tool we have not seen would be guessing at its input shape too.
 */
const TOOL_NAMES: Record<string, string> = {
  shell: "Bash",
  write: "Write",
  edit: "Edit",
  read_image: "Read",
};

/**
 * goose input keys → Claude's, per translated tool.
 *
 * Only the keys that downstream code reads are remapped; everything else is
 * passed through untouched so nothing is silently lost from the transcript.
 */
export function remapInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...input };
  const renameTo = (from: string, to: string): void => {
    if (from in out && !(to in out)) {
      out[to] = out[from];
      delete out[from];
    }
  };
  switch (toolName) {
    case "write":
    case "edit":
      // Target derivation and the diff viewer both read `file_path`.
      renameTo("path", "file_path");
      break;
    case "read_image":
      renameTo("source", "file_path");
      break;
    default:
      break;
  }
  return out;
}

/**
 * The tool name to show, given goose's metadata.
 *
 * An MCP tool arrives with an `extensionName` that is not `developer`; those
 * become `mcp__<extension>__<tool>` so they group under their server in the UI
 * exactly the way Claude's and Codex's do.
 */
export function toolNameOf(toolName: string | undefined, extensionName: string | undefined): string {
  if (!toolName) return "Tool";
  if (extensionName && extensionName !== "developer") {
    return `mcp__${extensionName}__${toolName}`;
  }
  return TOOL_NAMES[toolName] ?? toolName;
}

/** Flatten ACP content blocks to the text Dispatch persists on a tool result. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    // ACP wraps a block as { type: "content", content: { type: "text", text } }.
    const inner = (e.content ?? e) as Record<string, unknown>;
    if (typeof inner.text === "string") parts.push(inner.text);
  }
  return parts.join("\n");
}

export interface AcpStreamDecoderOpts {
  genId: () => string;
}

/**
 * Translate one session's update stream.
 *
 * Stateful because agent text arrives as chunks that must be re-assembled into
 * the single `assistant` event the transcript stores, and because the context
 * figures arrive on their own update rather than on the turn result.
 */
export class AcpStreamDecoder {
  private readonly genId: () => string;
  /** Accumulated assistant text for the message currently streaming. */
  private text = "";
  private thinking = "";
  /** Stable id correlating this message's deltas with its final event. */
  private messageId?: string;
  private lastContextTokens?: number;
  private lastContextWindow?: number;
  /** Tool calls seen this turn, so an update can recover the name for a result. */
  private readonly toolNames = new Map<string, string>();

  constructor(opts: AcpStreamDecoderOpts) {
    this.genId = opts.genId;
  }

  contextTokens(): number | undefined {
    return this.lastContextTokens;
  }

  contextWindow(): number | undefined {
    return this.lastContextWindow;
  }

  /** The id the current streaming message uses, minting one when needed. */
  private currentId(hint?: unknown): string {
    if (!this.messageId) this.messageId = typeof hint === "string" && hint ? hint : this.genId();
    return this.messageId;
  }

  /**
   * Emit the finished assistant message, if one is buffered.
   *
   * Called when a tool call interrupts the text and at turn end, because those
   * are the two places a message is known to be complete. ACP has no explicit
   * "message finished" update.
   */
  flushMessage(): HarnessEvent[] {
    if (!this.text && !this.thinking) return [];
    const event: HarnessEvent = {
      type: "assistant",
      id: this.currentId(),
      text: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
    };
    this.text = "";
    this.thinking = "";
    this.messageId = undefined;
    return [event];
  }

  /** Translate one notification frame. */
  decode(frame: RpcFrame): HarnessEvent[] {
    if (frame.method !== "session/update") return [];
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const update = (params.update ?? {}) as Update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.chunk(update, "text");
      case "agent_thought_chunk":
        return this.chunk(update, "thinking");
      case "tool_call":
        return this.toolCall(update);
      case "tool_call_update":
        return this.toolResult(update);
      case "usage_update":
        return this.usage(update);
      case "plan":
        return this.plan(update);
      default:
        // `session_info_update`, `current_mode_update`,
        // `available_commands_update` and anything an agent adds later. Silence
        // is correct: an unknown update must not become a transcript row.
        return [];
    }
  }

  private chunk(update: Update, channel: "text" | "thinking"): HarnessEvent[] {
    const content = (update.content ?? {}) as Record<string, unknown>;
    const delta = typeof content.text === "string" ? content.text : "";
    if (!delta) return [];
    const id = this.currentId(update.messageId);
    if (channel === "text") this.text += delta;
    else this.thinking += delta;
    return [{ type: "delta", id, channel, delta }];
  }

  private toolCall(update: Update): HarnessEvent[] {
    const toolCallId = String(update.toolCallId ?? this.genId());
    const meta = ((update._meta ?? {}) as Record<string, unknown>).goose as
      | Record<string, unknown>
      | undefined;
    const call = (meta?.toolCall ?? {}) as Record<string, unknown>;
    const rawName = typeof call.toolName === "string" ? call.toolName : undefined;
    const extension = typeof call.extensionName === "string" ? call.extensionName : undefined;
    const name = toolNameOf(rawName, extension);
    this.toolNames.set(toolCallId, name);

    const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
    const input = remapInput(rawName ?? "", rawInput);

    // A tool call ends whatever text was streaming before it.
    return [
      ...this.flushMessage(),
      {
        type: "tool-use",
        toolUseId: toolCallId,
        name,
        input,
        ...(extension && extension !== "developer" ? { server: extension } : {}),
      },
    ];
  }

  private toolResult(update: Update): HarnessEvent[] {
    const status = typeof update.status === "string" ? update.status : undefined;
    // Only terminal statuses are results. `in_progress` carries live stdout we
    // have nowhere to render; `pending` carries nothing at all.
    if (status !== "completed" && status !== "failed") return [];
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return [];
    const text = contentText(update.content);
    return [
      {
        type: "tool-result",
        toolUseId: toolCallId,
        ok: status === "completed",
        content: text ? [{ type: "text", text }] : [],
      },
    ];
  }

  private usage(update: Update): HarnessEvent[] {
    const used = typeof update.used === "number" ? update.used : undefined;
    const size = typeof update.size === "number" ? update.size : undefined;
    if (used === undefined && size === undefined) return [];
    if (used !== undefined) this.lastContextTokens = used;
    if (size !== undefined) this.lastContextWindow = size;
    return [
      {
        type: "usage",
        ...(used !== undefined ? { contextTokens: used } : {}),
        ...(size !== undefined ? { contextWindow: size } : {}),
      },
    ];
  }

  /**
   * An ACP plan becomes a `TodoWrite` call.
   *
   * Exactly the trick the Codex decoder uses for `turn/plan/updated`: rendering
   * it as the tool the client already has a todo strip for means the agent's
   * plan shows up with no client change at all.
   */
  private plan(update: Update): HarnessEvent[] {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    if (!entries.length) return [];
    const todos = entries.map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      const status = e.status === "in_progress" || e.status === "completed" ? e.status : "pending";
      return { content: String(e.content ?? ""), status, activeForm: String(e.content ?? "") };
    });
    return [
      ...this.flushMessage(),
      {
        type: "tool-use",
        toolUseId: this.genId(),
        name: "TodoWrite",
        input: { todos },
      },
    ];
  }
}

/** ACP stop reasons that mean the turn did not simply finish. */
const FAILED_STOPS = new Set(["refusal", "max_tokens", "max_turn_requests"]);

/**
 * The `session/prompt` response → a {@link HarnessEvent} turn end.
 *
 * ACP reports `stopReason` plus a token total. There is no cost figure and no
 * rate-limit concept — a local model has neither — so those fields stay absent
 * rather than being filled with zeros that would render as real numbers.
 */
export function turnEndOf(
  result: Record<string, unknown> | undefined,
  context: { contextTokens?: number; contextWindow?: number },
): HarnessEvent {
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
  const usage = (result?.usage ?? undefined) as Record<string, unknown> | undefined;
  return {
    type: "turn-end",
    ok: !FAILED_STOPS.has(stopReason),
    subtype: stopReason === "end_turn" ? "success" : stopReason,
    ...(usage ? { usage } : {}),
    ...(context.contextTokens !== undefined ? { contextTokens: context.contextTokens } : {}),
    ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
  };
}
