/**
 * Shared primitives: enums + small building-block schemas used across the
 * domain, message, and wire layers. Zod is the source of truth; TS types are
 * derived via z.infer so schema and type can never drift.
 */
import * as z from "zod";

/** SDK PermissionMode literal union (mirrors @anthropic-ai/claude-agent-sdk 0.3.199). */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Reasoning-effort lever surfaced in the composer; maps to thinking-token budget. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/** SessionBroker state machine + backpressure state. */
export const ChatStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "awaiting-input",
  "done",
  "error",
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

/** Derived "agent working" animation state for the live chat header. */
export const AgentActivitySchema = z.object({
  state: z.enum(["idle", "thinking", "responding", "tool", "awaiting"]),
  /** Human label e.g. "running Bash", "editing app.ts", "thinking…". */
  label: z.string().optional(),
  toolName: z.string().optional(),
  /** File / target the tool is acting on, if derivable. */
  target: z.string().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

/** Origin of a user message (mirrors SDKMessageOrigin). */
export const MessageOriginSchema = z.enum(["human", "channel", "peer"]);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

/** An image attached to / produced by a chat (paste/drop send, sprite receive). */
export const ImageRefSchema = z.object({
  id: z.string(),
  /** Path under the chat's assets/ dir, or a data/remote URL. */
  path: z.string(),
  mimeType: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

/**
 * MCP server config, forwarded verbatim to the SDK's `mcpServers`. Kept a loose
 * object (unknown keys preserved) so any SDK-supported transport shape passes
 * through unmodified from filesystem config.
 */
export const McpServerConfigSchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** A permission decision returned from an attention/permission card. */
export const PermissionDecisionSchema = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
