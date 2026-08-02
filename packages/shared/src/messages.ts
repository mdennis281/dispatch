/**
 * Persisted chat transcript rows (messages.jsonl) + the attention/permission
 * primitives that drive the global Attention Queue. Each JSONL line is one
 * ChatMessage; the discriminated union tag is `kind`.
 */
import * as z from "zod";
import {
  ImageRefSchema,
  MessageOriginSchema,
  EffortSchema,
  PermissionDecisionSchema,
} from "./common.js";

/** Fields shared by every persisted row. */
const MessageBase = {
  id: z.string(),
  chatId: z.string(),
  /** epoch ms. */
  ts: z.number().int(),
  /** Turn index within the session (0-based). */
  turn: z.number().int().optional(),
  sessionId: z.string().optional(),
};

/** A user turn (or steering injection). */
export const UserMessageRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("user"),
  text: z.string().optional(),
  images: z.array(ImageRefSchema).optional(),
  origin: MessageOriginSchema.optional(),
  effort: EffortSchema.optional(),
  /** True when this was queued mid-run to steer the agent. */
  steering: z.boolean().optional(),
});
export type UserMessageRow = z.infer<typeof UserMessageRowSchema>;

/** An assistant text/thinking turn. */
export const AssistantMessageRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("assistant"),
  text: z.string(),
  thinking: z.string().optional(),
  model: z.string().optional(),
  /** SDK assistant message uuid (for rollback/fork anchoring). */
  uuid: z.string().optional(),
  subagentType: z.string().optional(),
  /**
   * When set, this row was produced BY a subagent — it is the tool_use id of the
   * `Task` call that spawned it (SDK `parent_tool_use_id`). The client nests every
   * row sharing a `parentToolUseId` under that Task tool card as a sub-transcript.
   */
  parentToolUseId: z.string().nullable().optional(),
});
export type AssistantMessageRow = z.infer<typeof AssistantMessageRowSchema>;

/** A tool invocation (name starting `mcp__` → an MCP card). */
export const ToolUseRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("tool_use"),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** MCP server id parsed from an `mcp__<server>__<tool>` name. */
  server: z.string().optional(),
  /** Non-null when this tool_use itself runs inside a subagent (nested Task). */
  parentToolUseId: z.string().nullable().optional(),
  /** Subagent type that produced this tool_use (when it runs inside one). */
  subagentType: z.string().optional(),
  uuid: z.string().optional(),
  /**
   * LEAN-TRANSCRIPT MARKER (never persisted — set only on the wire). True when
   * `input` was projected down to a display preview because the real payload is
   * large. The card fetches the full row on expand (see {@link ChatMessage} and
   * the `/messages/full` route). Absent ⇒ `input` is verbatim.
   */
  inputOmitted: z.boolean().optional(),
});
export type ToolUseRow = z.infer<typeof ToolUseRowSchema>;

/** The result of a tool invocation. */
export const ToolResultRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("tool_result"),
  toolUseId: z.string(),
  name: z.string().optional(),
  ok: z.boolean(),
  content: z.unknown().optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().int().optional(),
  /**
   * Image blocks returned by the tool (e.g. a Claude-in-Chrome screenshot),
   * persisted to the chat's assets dir and rendered inline in the ToolCallCard.
   * The bulky base64 is stripped from `content` and lives here as an ImageRef.
   */
  images: z.array(ImageRefSchema).optional(),
  /** Non-null when this result belongs to a subagent's own tool call (nesting). */
  parentToolUseId: z.string().nullable().optional(),
  /** Subagent type that produced this result (when it runs inside one). */
  subagentType: z.string().optional(),
  /**
   * LEAN-TRANSCRIPT MARKER (never persisted — set only on the wire). True when
   * `content` was clipped to a head preview; `contentBytes` is the real size.
   * The card fetches the full row on expand. Absent ⇒ `content` is verbatim.
   */
  contentOmitted: z.boolean().optional(),
  /** Byte size of the un-clipped `content` (only set alongside `contentOmitted`). */
  contentBytes: z.number().int().optional(),
});
export type ToolResultRow = z.infer<typeof ToolResultRowSchema>;

/** A turn-done result marker (mirrors SDKResultMessage). */
export const ResultRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("result"),
  subtype: z.string(),
  isError: z.boolean(),
  numTurns: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  result: z.string().optional(),
  usage: z.unknown().optional(),
  /**
   * Context-window occupancy (tokens) of the latest main-loop request at turn
   * end — the last top-level assistant message's own input+cache+output usage,
   * NOT the session-cumulative `usage` above. Drives the composer context meter.
   */
  contextTokens: z.number().int().optional(),
  /**
   * The model's context-window size (tokens) for this session — the authoritative
   * `maxTokens` reported by the SDK's context-usage control, so the composer meter
   * divides by the RIGHT window (e.g. 1M for the Opus 1M variant, not a hardcoded
   * 200k). Absent until the session has reported usage at least once.
   */
  contextWindow: z.number().int().optional(),
  costUsd: z.number().optional(),
});
export type ResultRow = z.infer<typeof ResultRowSchema>;

/** A system message (init/etc). */
export const SystemMessageRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("system"),
  subtype: z.string(),
  text: z.string().optional(),
  data: z.unknown().optional(),
  /**
   * LEAN-TRANSCRIPT MARKER (never persisted — set only on the wire). True when
   * `data` was projected to just the fields the transcript renders (`model`).
   */
  dataOmitted: z.boolean().optional(),
});
export type SystemMessageRow = z.infer<typeof SystemMessageRowSchema>;

/** A permission prompt + its resolution, persisted for the transcript. */
export const PermissionRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("permission"),
  requestId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  decision: z.enum(["allow", "deny", "pending"]),
  displayName: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  /** Deny reason / allow note. */
  message: z.string().optional(),
});
export type PermissionRow = z.infer<typeof PermissionRowSchema>;

/**
 * A BACKGROUND TASK'S OWN LIFECYCLE BEAT — the only per-task completion signal
 * the SDK gives us (`system/task_notification`).
 *
 * Background work (an async `Agent` spawn, a backgrounded `Bash`) answers its
 * tool call in milliseconds with a LAUNCH ACK and then keeps running. Nothing in
 * the row stream says when one of them stopped, so the UI could only fall back
 * to "is the parent turn still running" — which makes five parallel subagents
 * share one status and flip to done together. This row carries the SDK's own
 * verdict for exactly one task.
 *
 * `toolUseId` is the correlation key: the `Task`/`Agent`/`Bash` tool_use that
 * started it. `taskId` is the SDK's id for the same task and is the fallback
 * when the notification omits the tool_use (it appears in the launch ack text).
 */
export const TaskStatusRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("task_status"),
  /** SDK task id — stable for the life of one background task. */
  taskId: z.string(),
  /** The tool_use that launched it (absent on some notifications). */
  toolUseId: z.string().optional(),
  status: z.enum(["completed", "failed", "stopped"]),
  /** The SDK's one-line recap of how it went. */
  summary: z.string().optional(),
  /** Rollups the SDK reports at settle time. */
  totalTokens: z.number().int().optional(),
  toolUses: z.number().int().optional(),
  durationMs: z.number().int().optional(),
});
export type TaskStatusRow = z.infer<typeof TaskStatusRowSchema>;

/** A local (non-agent) notice injected into the transcript (rollback, errors…). */
export const NoticeRowSchema = z.object({
  ...MessageBase,
  kind: z.literal("notice"),
  level: z.enum(["info", "warn", "error"]),
  text: z.string(),
});
export type NoticeRow = z.infer<typeof NoticeRowSchema>;

/** One persisted transcript row (a single JSONL line). */
export const ChatMessageSchema = z.discriminatedUnion("kind", [
  UserMessageRowSchema,
  AssistantMessageRowSchema,
  ToolUseRowSchema,
  ToolResultRowSchema,
  ResultRowSchema,
  SystemMessageRowSchema,
  PermissionRowSchema,
  NoticeRowSchema,
  TaskStatusRowSchema,
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatMessageKind = ChatMessage["kind"];

/* --------------------------------------------------- attention / permission */

/** A pending permission decision surfaced from `canUseTool`. */
export const PermissionRequestSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  displayName: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.number().int().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/** A single item in the global cross-chat Attention Queue. */
export const AttentionItemSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  kind: z.enum(["permission", "question", "idle", "done"]),
  summary: z.string(),
  projectId: z.string().optional(),
  /** For kind==="permission", the PermissionRequest id. */
  permissionRequestId: z.string().optional(),
  createdAt: z.number().int(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
