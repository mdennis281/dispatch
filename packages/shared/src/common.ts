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
  /**
   * Working directory for a stdio server. Defaults to the project's repo path,
   * so relative `args` (e.g. `./tools/sim-mcp/index.mjs`) resolve against the
   * repo — not against wherever the manager itself happens to be running.
   */
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** A permission decision returned from an attention/permission card. */
export const PermissionDecisionSchema = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** A selectable session model for the composer picker: SDK model id + label. */
export const ModelOptionSchema = z.object({
  /** SDK model id, e.g. "claude-opus-4-8". */
  value: z.string(),
  /** Display label, e.g. "Opus 4.8". */
  label: z.string(),
  /** Optional tier hint, e.g. "deepest" / "balanced" / "fast". */
  hint: z.string().optional(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/** The app's default session model when a chat hasn't pinned one. */
export const DEFAULT_MODEL = "claude-opus-4-8";

/**
 * Static model list used when the live Anthropic Models API is unavailable
 * (no ANTHROPIC_API_KEY — e.g. subscription/OAuth auth) and as the client's
 * pre-fetch seed so the picker never renders empty. Ordered most→least capable.
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: "claude-fable-5", label: "Fable 5", hint: "most capable" },
  { value: "claude-opus-4-8", label: "Opus 4.8", hint: "deepest" },
  { value: "claude-sonnet-5", label: "Sonnet 5", hint: "balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fast" },
];
