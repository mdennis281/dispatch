/**
 * Shared primitives: enums + small building-block schemas used across the
 * domain, message, and wire layers. Zod is the source of truth; TS types are
 * derived via z.infer so schema and type can never drift.
 */
import * as z from "zod";

/**
 * Tool families that can be shown inside Dispatch's compact transcript shell.
 *
 * `pr` was here and is deliberately gone: pull-request tools left the terminal
 * frame for cards of their own, so a toggle that hid them among shell commands
 * no longer describes anything. Retiring a category is exactly why the filter
 * parses leniently below.
 */
export const SHELL_TRANSCRIPT_CATEGORIES = [
  "shell",
  "memory",
  "wait",
  "preview",
  "chat",
  "dispatch",
] as const;
export const ShellTranscriptCategorySchema = z.enum(SHELL_TRANSCRIPT_CATEGORIES);
export type ShellTranscriptCategory = z.infer<typeof ShellTranscriptCategorySchema>;
/**
 * Unknown categories are DROPPED rather than rejected.
 *
 * This is the one schema in the app where strictness would be self-inflicted
 * damage: the stored value is a list of product concepts, and retiring one (as
 * `pr` was) would otherwise make every chat, project and settings record that
 * mentions it fail to parse — turning a UI change into an unreadable install.
 * A filter naming a category that no longer exists means "that thing is gone",
 * not "this file is corrupt".
 */
export const ShellTranscriptFilterSchema = z
  .preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item) =>
            (SHELL_TRANSCRIPT_CATEGORIES as readonly unknown[]).includes(item),
          )
        : value,
    z.array(ShellTranscriptCategorySchema),
  )
  .refine(
    (items) => items.length <= SHELL_TRANSCRIPT_CATEGORIES.length,
    "too many shell filter categories",
  )
  .refine((items) => new Set(items).size === items.length, "duplicate shell filter category");
export type ShellTranscriptFilter = z.infer<typeof ShellTranscriptFilterSchema>;

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

/**
 * WHERE a project's config dir lives — the repo, or the app's own config root.
 *
 *   - `repo`     — `<repoPath>/.dispatch/`. Committable: the config travels with
 *                  the code, teammates inherit it on clone, and a change to it is
 *                  reviewed like any other diff.
 *   - `external` — `<configDir>/projects/<id>/`, owned by the install. Nothing
 *                  Dispatch authors — the manifest, instructions, skills, and the
 *                  hundreds of files an agent's `remember` accumulates — ever
 *                  touches the working tree, so a repo with commit policies
 *                  (protected trunk, required review, a lint gate on every file)
 *                  never has to be argued with to save a memory.
 *
 * The two do NOT merge. Exactly one directory is a project's config, because a
 * merge rule makes "why is this instruction in effect" unanswerable by reading
 * one file — and the whole value of the manifest is that it is readable.
 *
 * `external` is the default for a project with no committed `.dispatch/`. A repo
 * that HAS one keeps using it regardless of the default: someone committed that
 * deliberately, and quietly reading a different directory instead would strand
 * every instruction and memory in it. See `resolveConfigDir` for the full
 * precedence chain.
 *
 * It lives in `common.ts` rather than beside the rest of the config vocabulary in
 * `project-config.ts` only because `domain.ts` needs it for `Project` and
 * `project-config.ts` already imports FROM `domain.ts` — defining it there would
 * close a cycle and leave one of the two zod schemas undefined at init.
 */
export const ProjectConfigLocationSchema = z.enum(["repo", "external"]);
export type ProjectConfigLocation = z.infer<typeof ProjectConfigLocationSchema>;

/** Where a project's config goes when neither it nor its repo has said. */
export const DEFAULT_CONFIG_LOCATION: ProjectConfigLocation = "external";

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
 * How an attachment should be PRESENTED. `ImageRef` long predates chats
 * carrying anything but images; rather than rename it (and every call site) it
 * now also carries video, audio and plain files, distinguished by `mimeType`.
 * Lives here because the server picks the kind when ingesting and the client
 * picks the element to render — one table, or the two drift.
 */
export type MediaKind = "image" | "video" | "audio" | "file";

export function mediaKind(mime: string | undefined): MediaKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "file";
}

/** Human-readable byte size, for captions and for the summary the model sees. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
   * Working directory for a stdio server. Defaults to the CHAT'S directory — its
   * worktree when it has one, else the project repo path — so relative `args`
   * (e.g. `./tools/sim-mcp/index.mjs`) resolve against the tree the chat is
   * actually working in, not against wherever the manager happens to be running.
   *
   * That default is what makes a server launched from a worktree serve THAT
   * worktree. An explicit value here opts out and pins every chat to one dir.
   */
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),

  /* ---- Dispatch-only knobs. Stripped by `resolveMcpServer` before the config
     reaches a harness, so they never ride along into an SDK that would choke on
     an unknown key. ---- */

  /**
   * How many ports this server needs. Each is LEASED per (project, server,
   * checkout) and substituted into `env`/`args`/`url` as `{mcpPort}` /
   * `{mcpPortN}`, so two worktrees running the same server never collide.
   * Absent → no leases, and the placeholders stay literal.
   */
  ports: z.number().int().min(1).max(8).optional(),
  /** Inclusive [min, max] band to lease from. Defaults to {@link DEFAULT_MCP_PORT_RANGE}. */
  portRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  /**
   * Command run after a worktree is created, in that worktree, with this
   * server's fully-expanded env (leased ports included). For a server that
   * fronts a dev server this boots it so the first tool call isn't cold.
   * Best-effort: its failure never fails worktree creation.
   */
  prewarm: z.string().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Default band for leased MCP ports. Deliberately clear of the 5173/4318/4319
 * range that Vite and Dispatch's own two instances live in.
 */
export const DEFAULT_MCP_PORT_RANGE: readonly [number, number] = [5400, 5499];

/** Keys that are Dispatch's own and must not be forwarded to a harness SDK. */
export const MCP_DISPATCH_ONLY_KEYS = ["ports", "portRange", "prewarm"] as const;

/**
 * One checkout's claim on a set of ports for one MCP server. Persisted so the
 * SAME worktree gets the SAME ports across restarts — a server that adopts an
 * already-healthy dev server (rather than spawning a second) depends on that
 * stability, and a port that moved every boot would strand the old one.
 */
export const McpPortLeaseSchema = z.object({
  projectId: z.string(),
  server: z.string(),
  /** Normalized checkout path; the identity the lease is really keyed on. */
  checkout: z.string(),
  ports: z.array(z.number().int()),
  leasedAt: z.number(),
});
export type McpPortLease = z.infer<typeof McpPortLeaseSchema>;

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
