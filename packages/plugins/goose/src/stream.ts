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
import { figuresOfUsage } from "@dispatch/shared";
import type { HarnessEvent } from "@dispatch/shared";
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
 * Split a goose tool name into its extension and bare tool.
 *
 * goose spells the same tool three ways depending on which frame carries it,
 * and every one of them has to land on the same canonical name:
 *
 * - `_meta.goose.toolCall.toolName` is the FULL registry name,
 *   `dispatch-project__project_info`, with `extensionName: "dispatch-project"`
 *   beside it. Prefixing that again is what recorded
 *   `mcp__dispatch-project__dispatch-project__project_info` on every MCP call.
 * - A permission request has no meta, only goose's display title, which
 *   `format_tool_name` renders as `dispatch-project: project info` (extension,
 *   colon, underscores turned to spaces). Read as-is that name matched no
 *   `mcp__…` guard rule at all.
 * - A tool the model invented arrives only inside goose's error text, as the
 *   raw `<ext>__<tool>` it asked for, with no extension beside it.
 *
 * A name that already starts with `mcp__` is returned untouched: a model that
 * hallucinates Claude's spelling must not become `mcp__mcp__…`.
 */
export function splitToolName(
  toolName: string,
  extensionName: string | undefined,
): { extension?: string; tool: string } {
  const name = toolName.trim();
  const colon = name.indexOf(": ");
  if (colon > 0) {
    // goose's display form. Tool names do not contain spaces, so turning them
    // back into underscores undoes `format_tool_name` exactly.
    return {
      extension: name.slice(0, colon).trim().replace(/ /g, "_"),
      tool: name.slice(colon + 2).trim().replace(/ /g, "_"),
    };
  }
  if (extensionName && extensionName !== "developer") {
    const prefix = `${extensionName}__`;
    return { extension: extensionName, tool: name.startsWith(prefix) ? name.slice(prefix.length) : name };
  }
  const sep = name.indexOf("__");
  if (sep > 0) return { extension: name.slice(0, sep), tool: name.slice(sep + 2) };
  return { extension: extensionName, tool: name };
}

/**
 * The tool name to show, given goose's metadata.
 *
 * An MCP tool becomes the canonical `mcp__<extension>__<tool>` so it groups
 * under its server in the UI exactly the way Claude's and Codex's do — and,
 * more to the point, so it is the SAME string the guard's rules, the manager
 * card tracking and the metrics classifier key on.
 */
export function toolNameOf(toolName: string | undefined, extensionName: string | undefined): string {
  if (!toolName?.trim()) return "Tool";
  if (toolName.startsWith("mcp__")) return toolName;
  const { extension, tool } = splitToolName(toolName, extensionName);
  if (extension && extension !== "developer") return `mcp__${extension}__${tool}`;
  return TOOL_NAMES[tool] ?? tool;
}

/** The MCP server a canonical tool name belongs to, if it is an MCP tool. */
function serverOf(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep > 0 ? rest.slice(0, sep) : undefined;
}

/**
 * The tool the model asked for, recovered from goose's refusal of it.
 *
 * When the model calls a tool that was not advertised, goose's `ToolRequest`
 * holds an `Err` instead of a call, so the `tool_call` it sends has no
 * `_meta.goose.toolCall`, no `rawInput`, and the title `error`. The name the
 * model used survives only in the failed result:
 * `-32600: Tool 'dispatch-github__list_prs' was not advertised for this model turn`.
 */
export function requestedToolOf(errorText: string): string | undefined {
  const match = /Tool '([^']+)'/.exec(errorText);
  return match?.[1];
}

/**
 * A tool name out of a `tool_call` title, or undefined when the title carries
 * none. goose titles a call it could not parse `error`; that is goose's
 * placeholder, not a tool the model asked for.
 */
function nameFromTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const idx = title.indexOf("·");
  const head = (idx < 0 ? title : title.slice(0, idx)).trim();
  return head && head !== "error" ? head : undefined;
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
  /**
   * Calls goose could not name, held until their result names them.
   *
   * Emitting them on arrival is what recorded eight `Tool {}` rows for a model
   * that invented `dispatch-github__list_prs`: the transcript showed a nameless
   * call instead of the hallucination it was. goose answers such a call at
   * once, without running or asking about anything, so the hold is one frame.
   */
  private readonly unnamed = new Map<string, { title: unknown; input: Record<string, unknown> }>();

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
   * Everything still buffered at turn end: the finished assistant message and
   * any unnamed call whose result never came.
   *
   * A held call that outlives its turn (a cancel landing between goose's call
   * and its refusal) is released under whatever its title says, or `Tool`. A
   * vague row beats a call silently missing from the transcript.
   */
  flushMessage(): HarnessEvent[] {
    const held: HarnessEvent[] = [];
    for (const [toolUseId, call] of this.unnamed) {
      held.push(this.toolUseEvent(toolUseId, toolNameOf(nameFromTitle(call.title), undefined), call.input));
    }
    this.unnamed.clear();
    return [...held, ...this.flushText()];
  }

  /**
   * Emit the finished assistant message, if one is buffered.
   *
   * Called when a tool call interrupts the text, because that is where a
   * message is known to be complete. ACP has no "message finished" update.
   */
  private flushText(): HarnessEvent[] {
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
    const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;

    if (!rawName) {
      // goose had no call to describe — see `unnamed`. Its result carries the
      // name, so wait for it rather than record a `Tool` nobody asked for.
      this.unnamed.set(toolCallId, { title: update.title, input: rawInput });
      return this.flushText();
    }

    const name = toolNameOf(rawName, extension);
    // remapInput keys on the bare tool, never the `<ext>__<tool>` registry name.
    const input = remapInput(splitToolName(rawName, extension).tool, rawInput);

    // A tool call ends whatever text was streaming before it.
    return [...this.flushText(), this.toolUseEvent(toolCallId, name, input)];
  }

  private toolUseEvent(toolUseId: string, name: string, input: Record<string, unknown>): HarnessEvent {
    const server = serverOf(name);
    return { type: "tool-use", toolUseId, name, input, ...(server ? { server } : {}) };
  }

  private toolResult(update: Update): HarnessEvent[] {
    const status = typeof update.status === "string" ? update.status : undefined;
    // Only terminal statuses are results. `in_progress` carries live stdout we
    // have nowhere to render; `pending` carries nothing at all.
    if (status !== "completed" && status !== "failed") return [];
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return [];
    const text = contentText(update.content);
    const held = this.unnamed.get(toolCallId);
    const use: HarnessEvent[] = [];
    if (held) {
      this.unnamed.delete(toolCallId);
      // The name the model actually used, so a hallucinated tool reads as
      // one: `mcp__dispatch-github__list_prs` failing "not advertised", not a
      // nameless `Tool` failing. goose drops the arguments along with the
      // call, so the input is whatever little it did send — usually nothing.
      const requested = requestedToolOf(text) ?? nameFromTitle(held.title);
      use.push(this.toolUseEvent(toolCallId, toolNameOf(requested, undefined), held.input));
    }
    return [
      ...use,
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
      ...this.flushText(),
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
    ...(usage ? { usage, turnTokens: figuresOfUsage(usage) } : {}),
    ...(context.contextTokens !== undefined ? { contextTokens: context.contextTokens } : {}),
    ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
  };
}
