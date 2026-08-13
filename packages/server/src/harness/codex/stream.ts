/**
 * Codex app-server notifications → neutral {@link HarnessEvent}s.
 *
 * Codex's stream is item-oriented where Claude's is message-oriented: instead
 * of one `assistant` message carrying text and `tool_use` blocks together, each
 * thing that happens is its own ThreadItem with a `started` and a `completed`
 * notification around it. That is a better fit for Dispatch's transcript than
 * the SDK's shape, so most of the work here is naming rather than restructuring.
 *
 * THE NAMING DECISION. Codex's tool items are typed (`commandExecution`,
 * `fileChange`, `mcpToolCall`) where Claude's are named (`Bash`, `Edit`,
 * `mcp__server__tool`). We deliberately translate INTO Claude's names, because
 * every downstream consumer — the tool icons, the target derivation that labels
 * "running Bash · git status", the todo folder, the workflow guard's Bash
 * matcher — already keys off them. Inventing a parallel Codex vocabulary would
 * mean forking all of that for no user-visible gain. The cost is that a Codex
 * command row says "Bash" when Codex would say "shell"; that is a name the user
 * already knows, so it reads as consistency rather than a lie.
 *
 * Two mappings earn special mention:
 *   - `turn/plan/updated` becomes a `TodoWrite` tool call, which makes Codex's
 *     plan render in the existing todo strip with no client change at all.
 *   - `usageLimitExceeded` becomes a {@link HarnessLimitHit} carrying an exact
 *     reset timestamp, where the Claude path has to parse English prose.
 */
import type { HarnessEvent, HarnessLimitHit, HarnessQuestion } from "../types.js";
import type { RpcFrame } from "./rpc.js";

/** A Codex ThreadItem, loosely typed — we probe fields rather than model 20 variants. */
type Item = Record<string, unknown> & { type?: string; id?: string };

/** Codex plan-step status → the client's todo vocabulary. */
function todoStatus(s: unknown): string {
  return s === "inProgress" ? "in_progress" : s === "completed" ? "completed" : "pending";
}

/** Shorten a command for a row's display target. */
function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? s;
  return line;
}

export interface CodexStreamDecoderOpts {
  genId: () => string;
}

/**
 * Translate one thread's notification stream.
 *
 * Stateful for the same reason the Claude decoder is: agent text arrives as
 * deltas keyed by `itemId` and must finalize under the same id so the client
 * can swap the live buffer for the persisted row in place.
 */
export class CodexStreamDecoder {
  private readonly genId: () => string;
  /** Context window reported for the running model, for the meter denominator. */
  contextWindow?: number;
  /** Most recent total-token occupancy for this thread. */
  private lastContextTokens?: number;
  /** Reasoning text accumulated per item id, flushed onto the next message. */
  private readonly reasoning = new Map<string, string>();
  /** Item ids we have already emitted a tool-use for. */
  private readonly startedTools = new Set<string>();
  /** Whether this runtime exposes structured collaboration items. */
  private sawStructuredCollaboration = false;

  constructor(opts: CodexStreamDecoderOpts) {
    this.genId = opts.genId;
  }

  contextTokens(): number | undefined {
    return this.lastContextTokens;
  }

  /** Translate one notification frame. */
  decode(frame: RpcFrame): HarnessEvent[] {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    switch (frame.method) {
      case "item/agentMessage/delta":
        return [
          {
            type: "delta",
            id: String(p.itemId ?? ""),
            channel: "text",
            delta: String(p.delta ?? ""),
          },
        ];

      // Codex separates raw reasoning from its summary. Both are "thinking" to
      // Dispatch; whichever the model emits streams into the same channel.
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const id = String(p.itemId ?? "");
        const delta = String(p.delta ?? "");
        this.reasoning.set(id, (this.reasoning.get(id) ?? "") + delta);
        return [{ type: "delta", id, channel: "thinking", delta }];
      }

      case "item/started":
        return this.onItemStarted(p.item as Item);

      case "item/completed":
        return this.onItemCompleted(p.item as Item);

      case "turn/plan/updated":
        return this.onPlan(p);

      case "thread/tokenUsage/updated":
        return this.onTokenUsage(p);

      case "turn/completed":
        return this.onTurnCompleted(p);

      case "thread/compacted":
        return [{ type: "compacted" }];

      case "error":
        return this.onError(p);

      case "warning":
      case "configWarning":
      case "guardianWarning": {
        const text = this.noticeText(p);
        return text ? [{ type: "notice", level: "warn", text }] : [];
      }

      case "model/rerouted": {
        const to = typeof p.model === "string" ? p.model : "another model";
        return [{ type: "notice", level: "info", text: `Codex rerouted this turn to ${to}.` }];
      }

      default:
        return [];
    }
  }

  /* -------------------------------------------------------------- items */

  private onItemStarted(item: Item | undefined): HarnessEvent[] {
    if (!item?.type) return [];
    const id = String(item.id ?? this.genId());
    switch (item.type) {
      // The user's own message is already in the transcript — the broker wrote
      // it when it accepted the send. Echoing it would duplicate the row.
      case "userMessage":
      case "agentMessage":
      case "reasoning":
      case "plan":
        return [];
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "webSearch": {
        if (item.type === "collabAgentToolCall") this.sawStructuredCollaboration = true;
        const call = this.toolCallOf(item);
        if (!call) return [];
        this.startedTools.add(id);
        return [{ type: "tool-use", toolUseId: id, ...call }];
      }
      case "subAgentActivity":
        // The detailed run comes from `collabAgentToolCall` plus the child
        // thread stream. This marker carries only started/interacted/path; a
        // notice beside the real run card is duplicate, lower-fidelity noise.
        // Older app-server builds emitted only this marker, so retain their
        // previous notice rather than making those agents disappear entirely.
        return this.sawStructuredCollaboration
          ? []
          : [
              {
                type: "notice",
                level: "info",
                text: `Subagent ${String(item.kind ?? "activity")} (${String(item.agentPath ?? "")})`.trim(),
              },
            ];
      case "contextCompaction":
        return [{ type: "compacted" }];
      default:
        return [];
    }
  }

  private onItemCompleted(item: Item | undefined): HarnessEvent[] {
    if (!item?.type) return [];
    const id = String(item.id ?? this.genId());
    switch (item.type) {
      case "agentMessage": {
        const text = String(item.text ?? "");
        // Any reasoning that streamed before this message belongs to it.
        const thinking = this.drainReasoning();
        if (!text && !thinking) return [];
        return [{ type: "assistant", id, text, thinking: thinking || undefined, uuid: id }];
      }
      case "reasoning": {
        // A standalone reasoning item with no message after it still deserves
        // to show; accumulate it and let the next agentMessage carry it out.
        const content = [
          ...(Array.isArray(item.summary) ? (item.summary as string[]) : []),
          ...(Array.isArray(item.content) ? (item.content as string[]) : []),
        ]
          .filter((s) => typeof s === "string" && s.trim())
          .join("\n");
        if (content) this.reasoning.set(id, content);
        return [];
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "webSearch": {
        if (item.type === "collabAgentToolCall") this.sawStructuredCollaboration = true;
        const out: HarnessEvent[] = [];
        // A tool that completed without a `started` (fast paths, replayed
        // history) still needs its call row, or the result has nothing to
        // attach to and renders as an orphan.
        if (!this.startedTools.has(id)) {
          const call = this.toolCallOf(item);
          if (call) out.push({ type: "tool-use", toolUseId: id, ...call });
        }
        this.startedTools.delete(id);
        out.push({
          type: "tool-result",
          toolUseId: id,
          ok: this.itemOk(item),
          content: this.resultContentOf(item),
        });
        return out;
      }
      case "contextCompaction":
        return [{ type: "compacted" }];
      default:
        return [];
    }
  }

  /** Pull and clear any accumulated reasoning text. */
  private drainReasoning(): string {
    if (!this.reasoning.size) return "";
    const all = [...this.reasoning.values()].filter(Boolean).join("\n");
    this.reasoning.clear();
    return all;
  }

  /** Did this item succeed? */
  private itemOk(item: Item): boolean {
    const status = item.status;
    if (status === "failed" || status === "declined") return false;
    if (item.type === "commandExecution") {
      const code = item.exitCode;
      if (typeof code === "number") return code === 0;
    }
    if (item.type === "dynamicToolCall" && typeof item.success === "boolean") return item.success;
    if (item.type === "collabAgentToolCall") return item.status !== "failed";
    if (item.type === "mcpToolCall" && item.error) return false;
    return true;
  }

  /**
   * The name + input a Codex tool item should present as.
   *
   * See the module header for why these borrow Claude's tool names.
   */
  private toolCallOf(item: Item): { name: string; input: Record<string, unknown>; server?: string } | null {
    switch (item.type) {
      case "commandExecution": {
        const command = String(item.command ?? "");
        return {
          name: "Bash",
          input: {
            command,
            // `cwd` rides along so a row for a command run in a worktree says so.
            ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
            description: firstLine(command),
          },
        };
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
        const first = changes[0];
        const path = typeof first?.path === "string" ? first.path : undefined;
        return {
          name: changes.length > 1 ? "MultiEdit" : "Edit",
          input: {
            // `file_path` is what derives the "editing app.ts" working label.
            ...(path ? { file_path: path } : {}),
            edits: changes.map((c) => ({
              path: c.path,
              kind: (c.kind as { type?: string } | undefined)?.type ?? "update",
              diff: c.diff,
            })),
          },
        };
      }
      case "mcpToolCall": {
        const server = String(item.server ?? "");
        const tool = String(item.tool ?? "");
        return {
          name: `mcp__${server}__${tool}`,
          server: server || undefined,
          input: (item.arguments ?? {}) as Record<string, unknown>,
        };
      }
      case "dynamicToolCall": {
        const ns = typeof item.namespace === "string" && item.namespace ? item.namespace : undefined;
        const tool = String(item.tool ?? "");
        return {
          name: ns ? `mcp__${ns}__${tool}` : tool,
          server: ns,
          input: (item.arguments ?? {}) as Record<string, unknown>,
        };
      }
      case "collabAgentToolCall": {
        const tool = String(item.tool ?? "");
        const receivers = Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter((id): id is string => typeof id === "string")
          : [];
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        if (tool === "spawnAgent") {
          return {
            // `Agent` is already the provider-neutral spawn vocabulary consumed
            // by SubagentCard/AgentsPanel. The child thread gets attached to
            // this toolUseId by CodexSession.
            name: "Agent",
            input: {
              description: firstLine(prompt),
              prompt,
              ...(typeof item.model === "string" ? { model: item.model } : {}),
              ...(typeof item.reasoningEffort === "string"
                ? { effort: item.reasoningEffort }
                : {}),
              ...(receivers.length ? { agent_ids: receivers } : {}),
            },
          };
        }
        const names: Record<string, string> = {
          sendInput: "SendMessage",
          resumeAgent: "AgentResume",
          wait: "TaskOutput",
          closeAgent: "TaskStop",
        };
        return {
          name: names[tool] ?? "AgentControl",
          input: {
            ...(prompt ? { prompt } : {}),
            ...(receivers.length ? { agent_ids: receivers } : {}),
          },
        };
      }
      case "webSearch":
        return {
          name: "WebSearch",
          input: { query: item.query ?? (item.action as { query?: unknown } | undefined)?.query ?? "" },
        };
      default:
        return null;
    }
  }

  /** The content payload a completed tool item should carry. */
  private resultContentOf(item: Item): unknown {
    switch (item.type) {
      case "commandExecution":
        return item.aggregatedOutput ?? "";
      case "fileChange":
        return (Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [])
          .map((c) => String(c.diff ?? ""))
          .join("\n");
      case "mcpToolCall": {
        if (item.error) return item.error;
        const result = item.result as { content?: unknown } | null | undefined;
        return result?.content ?? result ?? "";
      }
      case "dynamicToolCall":
        return item.contentItems ?? "";
      case "collabAgentToolCall": {
        const receivers = Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.filter((id): id is string => typeof id === "string")
          : [];
        const states = (item.agentsStates ?? {}) as Record<
          string,
          { status?: unknown; message?: unknown }
        >;
        const details = Object.entries(states).map(([id, state]) => {
          const status = typeof state.status === "string" ? state.status : "unknown";
          const message = typeof state.message === "string" && state.message ? ` — ${state.message}` : "";
          return `${id}: ${status}${message}`;
        });
        // The async-run fold recognizes this launch acknowledgement and later
        // correlates the child turn's task-notification by agentId.
        if (item.tool === "spawnAgent" && receivers.length) {
          return [`agentId: ${receivers[0]}`, ...details].join("\n");
        }
        return details.join("\n") || receivers.join("\n");
      }
      default:
        return "";
    }
  }

  /* --------------------------------------------------------------- plan */

  /**
   * Codex's plan → a `TodoWrite` call.
   *
   * The client folds `TodoWrite` rows into the todo strip by replacing the
   * whole list each time, which is exactly Codex's semantics (`plan` is always
   * the complete list). So this is a rename, not a translation.
   */
  private onPlan(p: Record<string, unknown>): HarnessEvent[] {
    const plan = Array.isArray(p.plan) ? (p.plan as Record<string, unknown>[]) : [];
    if (!plan.length) return [];
    return [
      {
        type: "tool-use",
        toolUseId: this.genId(),
        name: "TodoWrite",
        input: {
          todos: plan.map((s) => ({
            content: String(s.step ?? ""),
            status: todoStatus(s.status),
          })),
          ...(typeof p.explanation === "string" && p.explanation
            ? { explanation: p.explanation }
            : {}),
        },
      },
    ];
  }

  /* -------------------------------------------------------------- usage */

  private onTokenUsage(p: Record<string, unknown>): HarnessEvent[] {
    const usage = p.tokenUsage as Record<string, unknown> | undefined;
    if (!usage) return [];
    const last = usage.last as Record<string, unknown> | undefined;
    const window = usage.modelContextWindow;
    if (typeof window === "number") this.contextWindow = window;
    // `total` is cumulative across every request in the thread and can grow to
    // millions; only `last` describes the request currently occupying context.
    const tokens = last?.totalTokens;
    if (typeof tokens === "number") this.lastContextTokens = tokens;
    return [
      {
        type: "usage",
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
      },
    ];
  }

  /* --------------------------------------------------------------- turn */

  private onTurnCompleted(p: Record<string, unknown>): HarnessEvent[] {
    const turn = p.turn as Record<string, unknown> | undefined;
    const status = String(turn?.status ?? "completed");
    const err = turn?.error as Record<string, unknown> | null | undefined;
    const ok = status === "completed";
    return [
      {
        type: "turn-end",
        ok,
        // "completed" is Codex's word for what Claude calls "success"; the rest
        // pass through so the transcript can say what actually happened.
        subtype: status === "completed" ? "success" : status,
        result: typeof err?.message === "string" ? err.message : this.finalTextOf(turn),
        durationMs: typeof turn?.durationMs === "number" ? turn.durationMs : undefined,
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
        limit: err ? limitHitOf(err) : undefined,
      },
    ];
  }

  /** The turn's final assistant text, when the summary carries it. */
  private finalTextOf(turn: Record<string, unknown> | undefined): string | undefined {
    const items = Array.isArray(turn?.items) ? (turn!.items as Item[]) : [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === "agentMessage" && typeof it.text === "string") return it.text;
    }
    return undefined;
  }

  /**
   * An `error` notification.
   *
   * `willRetry` means Codex is handling it internally — surfacing that as a
   * failed turn would end the chat while the runtime is still working, so it
   * becomes a notice instead.
   */
  private onError(p: Record<string, unknown>): HarnessEvent[] {
    const err = (p.error ?? {}) as Record<string, unknown>;
    const message = String(err.message ?? "Codex error");
    if (p.willRetry) return [{ type: "notice", level: "warn", text: `${message} — retrying.` }];
    const limit = limitHitOf(err);
    return [
      {
        type: "turn-end",
        ok: false,
        subtype: limit ? "usage_limit" : "error",
        result: message,
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
        limit,
      },
    ];
  }

  private noticeText(p: Record<string, unknown>): string | undefined {
    for (const k of ["message", "text", "warning", "detail"]) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * Was this error a usage limit, and when does it lift?
 *
 * Codex names the condition (`usageLimitExceeded`) instead of describing it in
 * prose, so unlike the Claude path there is no sentence to parse. The reset
 * instant is NOT on the error, though — it arrives separately on
 * `account/rateLimits/updated`, so the session merges the latest snapshot in
 * before handing this to the resume scheduler.
 */
export function limitHitOf(err: Record<string, unknown>): HarnessLimitHit | undefined {
  const info = err.codexErrorInfo;
  const code = typeof info === "string" ? info : undefined;
  if (code !== "usageLimitExceeded" && code !== "sessionBudgetExceeded") return undefined;
  return { reason: String(err.message ?? "Usage limit reached.") };
}

/**
 * A `item/tool/requestUserInput` payload → neutral questions.
 *
 * Codex's question shape is very close to Dispatch's own: an id, a header, the
 * question, and options with descriptions. The two real differences are that
 * Codex has no multi-select flag (every question is single-select) and it
 * models "let me type my own" as `isOther` rather than a synthesized option.
 */
export function questionsOf(params: Record<string, unknown>): HarnessQuestion[] {
  const raw = Array.isArray(params.questions) ? (params.questions as Record<string, unknown>[]) : [];
  return raw.map((q, i) => ({
    id: String(q.id ?? `q${i}`),
    header: String(q.header ?? "Question"),
    question: String(q.question ?? ""),
    multiSelect: false,
    allowOther: Boolean(q.isOther),
    options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => ({
      label: String(o.label ?? ""),
      description: typeof o.description === "string" ? o.description : undefined,
    })),
  }));
}
