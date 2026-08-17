/**
 * Self-contained `.dispatch/` project config — schemas + types.
 *
 * A managed repo may carry a committable `.dispatch/` directory at its
 * root that is the SOURCE OF TRUTH for its authored Dispatch config
 * (custom commands, instructions, sub-apps, MCP servers, agents, modes, memory).
 * Dispatch discovers it, validates it, and normalizes it into the shape
 * below; `.data` then keeps only runtime state.
 *
 * Two layers live here:
 *   - the raw MANIFEST (`project.yaml`) as authored on disk, and
 *   - the normalized in-memory {@link ProjectConfig} the server exposes + later
 *     phases consume (mapped onto the existing store shapes where they exist:
 *     {@link SubAppSchema}, {@link McpServerConfigSchema}, {@link AgentConfigSchema}).
 *
 * Zod is the single source of truth; every TS type is `z.infer`-ed from its
 * schema so validation and typing can never drift.
 */
import * as z from "zod";
import {
  EffortSchema,
  McpServerConfigSchema,
  PermissionModeSchema,
  ShellTranscriptFilterSchema,
} from "./common.js";
import { SubAppSchema, AgentConfigSchema } from "./domain.js";
import { WorkflowConfigSchema } from "./workflow.js";

/* ------------------------------------------------------------ dir defaults */

/** The config directory name at the managed repo root. */
export const CONFIG_DIR_NAME = ".dispatch";
/**
 * The pre-rename config directory name. Still honoured when a repo has no
 * `.dispatch/` yet, so a checkout that predates the rename keeps working
 * untouched — nothing here ever writes to it. Drop this (and
 * {@link CONFIG_DIR_NAMES}) once every managed repo has committed a `.dispatch/`.
 */
export const LEGACY_CONFIG_DIR_NAME = ".claude-manager";
/** Config dir names in resolution order — current first, legacy last. */
export const CONFIG_DIR_NAMES = [CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME] as const;
/** The manifest filename within {@link CONFIG_DIR_NAME}. */
export const MANIFEST_FILE = "project.yaml";

/** Extension for an exported config archive (a zip of {@link CONFIG_DIR_NAME}). */
export const ARCHIVE_EXT = ".dispatch";
/**
 * The pre-rename archive extension. Import still accepts it — the format never
 * changed, only its name, and an archive exported before the rename is a plain
 * zip that unpacks identically. Only export stopped producing it.
 */
export const LEGACY_ARCHIVE_EXT = ".cm";
/** Archive extensions a file picker should offer, current first. */
export const ARCHIVE_EXTS = [ARCHIVE_EXT, LEGACY_ARCHIVE_EXT] as const;
/** Default sub-directory names (overridable via the manifest's dir fields). */
export const DEFAULT_INSTRUCTIONS_DIR = "instructions";
export const DEFAULT_AGENTS_DIR = "agents";
export const DEFAULT_MODES_DIR = "modes";
export const DEFAULT_MEMORY_DIR = "memory";
export const DEFAULT_SKILLS_DIR = "skills";

/* =============================================================== manifest */

/**
 * One instruction entry in the manifest: either a `file` reference (resolved
 * relative to the instructions dir / config dir) or inline `text`. Concatenated
 * (in order) into the project's system-prompt append.
 */
export const ManifestInstructionSchema = z.union([
  z.object({ file: z.string() }),
  z.object({ text: z.string() }),
]);
export type ManifestInstruction = z.infer<typeof ManifestInstructionSchema>;

/**
 * A sub-app as authored in the manifest. Uses `cwd`/`docker` (friendlier
 * authoring names) which normalize onto the store {@link SubAppSchema}'s
 * `path`/`dockerCompose`.
 */
export const ManifestSubAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Path relative to the repo root (maps to SubApp.path). */
  cwd: z.string(),
  install: z.string().optional(),
  dev: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  ports: z.array(z.number().int()).optional(),
  /** Extra env for the dev process; `{port}`/`{portN}` placeholders are
   *  substituted from the allocated ports (maps to SubApp.env). */
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  /** docker-compose file (maps to SubApp.dockerCompose). */
  docker: z.string().optional(),
});
export type ManifestSubApp = z.infer<typeof ManifestSubAppSchema>;

/** A stdio MCP transport (spawns a subprocess). */
export const ManifestMcpStdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Pin the working directory. Omit it — the default (the chat's worktree, else
   * the repo root) is what gives each worktree its own server. Setting this puts
   * every chat in the project back on one directory.
   */
  cwd: z.string().optional(),
});

/** An HTTP/SSE MCP transport (connects to a URL). */
export const ManifestMcpHttpTransportSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** A manifest MCP transport (stdio | http | sse). */
export const ManifestMcpTransportSchema = z.union([
  ManifestMcpStdioTransportSchema,
  ManifestMcpHttpTransportSchema,
]);
export type ManifestMcpTransport = z.infer<typeof ManifestMcpTransportSchema>;

/** A named MCP server in the manifest (normalizes into a keyed record). */
export const ManifestMcpServerSchema = z.object({
  name: z.string(),
  transport: ManifestMcpTransportSchema,
  /**
   * How many ports to LEASE per checkout for this server, substituted into the
   * transport as `{mcpPort}` / `{mcpPortN}`. This is the answer to "two chats
   * in two worktrees both start this server and fight over one port": write the
   * placeholder instead of a number and each checkout gets its own, stable
   * across restarts. See `mcp-ports.ts`.
   */
  ports: z.number().int().min(1).max(8).optional(),
  /** Inclusive [min, max] band to lease from. Defaults to 5400-5499. */
  portRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  /**
   * Command run in a newly created worktree to warm this server up (typically
   * booting the dev server it fronts). Best-effort — never fails the worktree.
   */
  prewarm: z.string().optional(),
});
export type ManifestMcpServer = z.infer<typeof ManifestMcpServerSchema>;

/** Default session posture for chats started under this project. */
export const ManifestDefaultsSchema = z.object({
  mode: z.string().optional(),
  effort: EffortSchema.optional(),
  model: z.string().optional(),
  /**
   * Whether chats in this project show the context Dispatch attaches on the
   * human's behalf (surfaced memories, repo snapshots) in the transcript.
   * Committed with the repo because it's a statement about how much this
   * project's work wants auditing — a chat can still override it either way,
   * and a chat that doesn't falls through to the app setting, then to off.
   */
  showInjectedContext: z.boolean().optional(),
  /** Transcript-shell categories enabled by default for chats in this project. */
  shellFilter: ShellTranscriptFilterSchema.optional(),
});
export type ManifestDefaults = z.infer<typeof ManifestDefaultsSchema>;

/**
 * Per-project override of the app's spawn-chat consent policy — whether an agent
 * calling `mcp__manager__spawn_chat` here may start a chat WITHOUT stopping for
 * the human's approval. Absent → the global setting decides, which defaults to
 * asking. Committed with the repo because "agents may fan themselves out
 * unattended in this codebase" is a statement about the codebase, not about
 * whoever happens to be at the keyboard.
 */
export const ManifestSpawnChatSchema = z.object({
  autoApprove: z.boolean(),
});
export type ManifestSpawnChat = z.infer<typeof ManifestSpawnChatSchema>;

/**
 * The raw `.dispatch/project.yaml` manifest. All fields optional except
 * `name`. Unknown keys are rejected (strict) so a typo surfaces as a structured
 * error instead of silently dropping.
 */
export const ProjectManifestSchema = z.object({
  name: z.string(),
  worktreeRoot: z.string().optional(),
  /** Custom worktree command (maps to Project.worktreeCmd). */
  worktree: z.string().optional(),
  /** Custom ship command (maps to Project.shipCmd). */
  ship: z.string().optional(),
  /**
   * How change ships in this repo — the workflow PROFILE plus any per-field
   * overrides (see {@link WorkflowConfigSchema}). Absent → the rung is inferred
   * from whether a `ship` command is set, so pre-profile manifests keep working.
   */
  workflow: WorkflowConfigSchema.optional(),
  /** Per-project spawn-chat consent policy (see {@link ManifestSpawnChatSchema}). */
  spawnChat: ManifestSpawnChatSchema.optional(),
  defaults: ManifestDefaultsSchema.optional(),
  instructions: z.array(ManifestInstructionSchema).optional(),
  subApps: z.array(ManifestSubAppSchema).optional(),
  mcpServers: z.array(ManifestMcpServerSchema).optional(),
  /** Dir override for memories (default `memory/`). */
  memory: z.string().optional(),
  /** Dir override for agents (default `agents/`). */
  agents: z.string().optional(),
  /** Dir override for modes (default `modes/`). */
  modes: z.string().optional(),
  /** Dir override for skills (default `skills/`). */
  skills: z.string().optional(),
  /** Dir override for instruction files (default `instructions/`). */
  instructionsDir: z.string().optional(),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

/* ============================================================ normalized */

/** One resolved instruction (a read file or inline text) in load order. */
export const NormalizedInstructionSchema = z.object({
  source: z.enum(["file", "text"]),
  /** The path AS AUTHORED in the manifest (for round-tripping it back). */
  file: z.string().optional(),
  /**
   * Where the file actually resolved to, config-dir-relative and
   * forward-slashed. `file` alone is ambiguous — the loader accepts it relative
   * to either the instructions dir or the config dir — so anything that opens or
   * deletes the file (the config UI) needs the resolved answer, not the guess.
   */
  rel: z.string().optional(),
  text: z.string(),
});
export type NormalizedInstruction = z.infer<typeof NormalizedInstructionSchema>;

/** Normalized default session posture. */
export const ProjectConfigDefaultsSchema = z.object({
  mode: z.string().optional(),
  effort: EffortSchema.optional(),
  model: z.string().optional(),
  /** Project-level default for the transcript's injected-context disclosure. */
  showInjectedContext: z.boolean().optional(),
  shellFilter: ShellTranscriptFilterSchema.optional(),
});
export type ProjectConfigDefaults = z.infer<typeof ProjectConfigDefaultsSchema>;

/**
 * A mode authored under `modes/*.yaml`. Richer than the store `ModeConfig` (it
 * also carries a description + tool gating), so it's its own type — later phases
 * map `permissionMode`/tools onto the SDK options when a chat selects it.
 */
export const ConfigModeSchema = z.object({
  /** Slug of the mode name (its stable identity within the project). */
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  permissionMode: PermissionModeSchema,
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  /** Relative source file (within the config dir), for round-tripping. */
  file: z.string().optional(),
});
export type ConfigMode = z.infer<typeof ConfigModeSchema>;

/**
 * A skill authored under `skills/`. Claude Code skills (a `SKILL.md` document
 * with `{ name, description }` frontmatter + a body of instructions, optionally
 * with supporting files) are the one config kind the Agent SDK has no direct
 * "source" option for: it only discovers `<cwd>/.claude/skills/`. So a config
 * skill is MATERIALIZED into the session cwd's `.claude/skills/` at launch (a
 * MERGE that never clobbers a skill the repo already ships) — `dir`/`path`/
 * `layout` describe the on-disk source for that copy.
 *
 * Two layouts are supported:
 *   - `skills/<dir>/SKILL.md` — a skill directory (SKILL.md + any supporting
 *     files); the whole dir is copied, and
 *   - flat `skills/<name>.md` — a single-file skill.
 */
export const SkillConfigSchema = z.object({
  /** Slug of the skill name (its stable identity within the project). */
  id: z.string(),
  /** Skill name — frontmatter `name`, else the dir / file base name. */
  name: z.string(),
  /** One-line description (frontmatter `description`), if any. */
  description: z.string().optional(),
  /** Directory name to materialize under `.claude/skills/` (never clobbered). */
  dir: z.string(),
  /** Absolute path to the SKILL.md source file (or the flat `<name>.md`). */
  path: z.string(),
  /** On-disk layout: a `<dir>/SKILL.md` skill dir, or a flat `<name>.md`. */
  layout: z.enum(["dir", "flat"]),
});
export type SkillConfig = z.infer<typeof SkillConfigSchema>;

/**
 * The normalized, in-memory project config the server loads from a managed
 * repo's `.dispatch/`. This is the shape the API exposes and phases 2-4
 * consume. Store shapes are reused where they exist ({@link SubAppSchema},
 * {@link McpServerConfigSchema}, {@link AgentConfigSchema}); `modes` is the
 * richer {@link ConfigModeSchema}.
 */
export const ProjectConfigSchema = z.object({
  /** Absolute path to the `.dispatch/` dir this was loaded from. */
  sourceDir: z.string(),
  /** Display name from the manifest. */
  name: z.string(),
  worktreeRoot: z.string().optional(),
  /** From manifest `worktree` (maps to Project.worktreeCmd). */
  worktreeCmd: z.string().optional(),
  /** From manifest `ship` (maps to Project.shipCmd). */
  shipCmd: z.string().optional(),
  /** From manifest `workflow` (maps to Project.workflow). */
  workflow: WorkflowConfigSchema.optional(),
  /** From manifest `spawnChat` — this project's spawn-consent override. */
  spawnChat: ManifestSpawnChatSchema.optional(),
  defaults: ProjectConfigDefaultsSchema.optional(),
  /** Resolved instructions in load order (files read + inline text). */
  instructions: z.array(NormalizedInstructionSchema).default([]),
  /** All instruction text concatenated → the system-prompt append body. */
  instructionsText: z.string().optional(),
  /** Sub-apps mapped onto the store SubApp shape. */
  subApps: z.array(SubAppSchema).default([]),
  /** MCP servers keyed by name (as the store + SDK consume them). */
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
  /** Agents loaded from `agents/*.md` (mapped onto the store AgentConfig). */
  agents: z.array(AgentConfigSchema).default([]),
  /** Modes loaded from `modes/*.yaml`. */
  modes: z.array(ConfigModeSchema).default([]),
  /** Skills loaded from `skills/` — materialized into `<cwd>/.claude/skills/`. */
  skills: z.array(SkillConfigSchema).default([]),
  /** Absolute resolved memory dir (the memory SOURCE OF TRUTH). */
  memoryDir: z.string(),
  /** Absolute resolved agents dir. */
  agentsDir: z.string(),
  /** Absolute resolved modes dir. */
  modesDir: z.string(),
  /** Absolute resolved skills dir. */
  skillsDir: z.string(),
  /** Absolute resolved instructions dir. */
  instructionsDir: z.string(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/* ------------------------------------------------------------ ui sections */

/**
 * The parts of a project's config the UI presents as separate sections — and the
 * vocabulary the config-authoring flow speaks. Shared rather than client-local
 * because the server composes a DIFFERENT briefing per section (where the file
 * goes, what shape it takes), so both ends have to agree on the names.
 *
 * `workflow` and `memory` appear in the UI but are not authorable here: workflow
 * has its own editor (it's manifest keys, not files), and memory has its own
 * view and is written by agents through the memory tools.
 */
export const ConfigSectionSchema = z.enum([
  "workflow",
  "instructions",
  "agents",
  "modes",
  "skills",
  "mcp",
  "subApps",
  "memory",
]);
export type ConfigSection = z.infer<typeof ConfigSectionSchema>;

// "Which sections can an agent write for me?" used to live here as
// AUTHORABLE_SECTIONS. It moved to the agent-task catalog (agent-tasks.ts): a
// writable section is just a task whose id is `config:<section>`, so the two
// lists can no longer disagree. See `configTaskId`.

/** Where a load error originated (for surfacing in the UI, never a throw). */
export const ProjectConfigErrorScopeSchema = z.enum([
  "manifest",
  "instruction",
  "agent",
  "mode",
  "skill",
  "io",
]);
export type ProjectConfigErrorScope = z.infer<typeof ProjectConfigErrorScopeSchema>;

/** One structured, non-fatal config error. */
export const ProjectConfigErrorSchema = z.object({
  scope: ProjectConfigErrorScopeSchema,
  /** Relative file (within the config dir) the error concerns, if applicable. */
  file: z.string().optional(),
  message: z.string(),
});
export type ProjectConfigError = z.infer<typeof ProjectConfigErrorSchema>;

/**
 * The result of loading a project's config: the source dir (null when the
 * project has no `.dispatch/` → back-compat fallback), the normalized
 * config (null when there's no dir OR the manifest was unparseable), and any
 * structured errors gathered along the way.
 */
export const ProjectConfigResultSchema = z.object({
  /** Absolute `.dispatch/` path, or null when the project has none. */
  sourceDir: z.string().nullable(),
  config: ProjectConfigSchema.nullable(),
  errors: z.array(ProjectConfigErrorSchema).default([]),
});
export type ProjectConfigResult = z.infer<typeof ProjectConfigResultSchema>;
