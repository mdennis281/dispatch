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
