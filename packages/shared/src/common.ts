/**
 * Shared primitives: enums + small building-block schemas used across the
 * domain, message, and wire layers. Zod is the source of truth; TS types are
 * derived via z.infer so schema and type can never drift.
 */
import * as z from "zod";

/**
 * Which agent runtime executes a chat.
 *
 * Set per project (and mirrored onto every chat at creation — see
 * `Chat.harness`), because a session id is only meaningful to the runtime that
 * issued it: a Claude session cannot be resumed on Codex and vice versa. Pinning
 * at creation is what lets the project default change without stranding chats
 * that are already running.
 */
export const HarnessKindSchema = z.enum(["claude", "codex"]);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/** The harness a project gets when it has never said otherwise. */
export const DEFAULT_HARNESS: HarnessKind = "claude";

/** SDK PermissionMode literal union (mirrors @anthropic-ai/claude-agent-sdk 0.3.222). */
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
  "waiting",
  "awaiting-input",
  "done",
  "failed",
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

/**
 * A selectable session model for the composer picker — a projection of the
 * runtime's own `ModelInfo` (see server `services/models.ts`), which is why
 * `value` is whatever the runtime offers rather than always a dated wire id.
 */
export const ModelOptionSchema = z.object({
  /** Id to send as `options.model` — often an alias, e.g. "default" / "opus[1m]" / "sonnet". */
  value: z.string(),
  /** Display label, e.g. "Opus". */
  label: z.string(),
  /** Optional tier hint, e.g. "deepest" / "balanced" / "fast". */
  hint: z.string().optional(),
  /** Canonical wire id `value` resolves to, e.g. "opus[1m]" → "claude-opus-4-8[1m]". */
  resolvedModel: z.string().optional(),
  /** The runtime's one-line blurb, e.g. "Sonnet 5 · Efficient for routine tasks". */
  description: z.string().optional(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/**
 * The app's default session model when a chat hasn't pinned one. "default" is a
 * real runtime alias meaning "whatever Claude Code recommends today", so an
 * unpinned chat tracks the recommendation instead of freezing on the model that
 * happened to be best when this line was written.
 */
export const DEFAULT_MODEL = "default";

/**
 * Static model list used only when the live list can't be read from the runtime
 * (see server `services/models.ts`), and as the client's pre-fetch seed so the
 * picker never renders empty. Deliberately ALIASES, not dated wire ids: aliases
 * keep resolving to the current model as new ones ship, so a stale fallback
 * degrades to "slightly wrong labels" instead of "unselectable dead ids".
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", label: "Default", hint: "recommended" },
  { value: "opus", label: "Opus", hint: "deepest" },
  { value: "sonnet", label: "Sonnet", hint: "balanced" },
  { value: "haiku", label: "Haiku", hint: "fast" },
];

/**
 * Codex's equivalent seed list.
 *
 * Unlike Claude's, these are concrete ids rather than aliases — Codex's
 * `model/list` has no "default" alias, it flags one row `isDefault`. A stale
 * entry here therefore degrades to a dead id rather than a wrong label, which
 * is why the live list is always preferred and this is only ever a last resort.
 */
export const FALLBACK_MODELS_CODEX: ModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", hint: "recommended" },
  { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", hint: "deepest" },
  { value: "gpt-5.6-luna", label: "GPT-5.6-Luna", hint: "balanced" },
  { value: "gpt-5.4-mini", label: "GPT-5.4-Mini", hint: "fast" },
];

/** The seed model list for a harness, used before/instead of a live probe. */
export function fallbackModels(harness: HarnessKind): ModelOption[] {
  return harness === "codex" ? FALLBACK_MODELS_CODEX : FALLBACK_MODELS;
}

/**
 * The default model id for a harness when a chat hasn't pinned one.
 *
 * Claude has a real "default" alias it resolves server-side; Codex does not, so
 * an unpinned Codex chat sends no model at all and lets `thread/start` pick.
 */
export function defaultModelFor(harness: HarnessKind): string | undefined {
  return harness === "codex" ? undefined : DEFAULT_MODEL;
}

/** Strip a context-window suffix so "claude-opus-4-8[1m]" and "claude-opus-4-8" compare equal. */
function bareModel(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

/**
 * Find the picker row that represents model id `id`.
 *
 * The same model reaches us under several ids — an alias the runtime offers
 * ("opus[1m]"), the wire id that alias resolves to ("claude-opus-4-8[1m]"), or a
 * bare id persisted on a chat before the list went live ("claude-opus-4-8") — so
 * we widen the match in precedence order and stop at the first hit. Returning a
 * single row (not a predicate) matters for the picker: several rows can resolve
 * to the same wire id (both "default" and "opus[1m]" are Opus today), and only
 * one of them may render as selected.
 */
export function findModel(models: ModelOption[], id: string): ModelOption | undefined {
  return (
    models.find((m) => m.value === id) ??
    models.find((m) => bareModel(m.value) === bareModel(id)) ??
    models.find((m) => m.resolvedModel != null && bareModel(m.resolvedModel) === bareModel(id))
  );
}
