/**
 * Domain / config / persisted entities. These are the JSON records the Store
 * reads and writes (projects, subApps, agents, modes, chats) plus the runtime
 * views (worktrees, runners, PRs, workflow runs). Zod = source of truth.
 */
import * as z from "zod";
import {
  EffortSchema,
  McpServerConfigSchema,
  PermissionModeSchema,
  ChatStatusSchema,
} from "./common.js";

/* ------------------------------------------------------------------ subApps */

/** A runnable app inside a project repo (game, metrics-server, studio-director…). */
export const SubAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Path relative to the repo root (or worktree root). */
  path: z.string(),
  install: z.string().optional(),
  dev: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  /** Ports the app binds; used for per-worktree offset allocation. */
  ports: z.array(z.number().int()).optional(),
  /**
   * Extra env for the dev process, with `{port}` / `{portN}` placeholders
   * substituted from the allocated ports (`{port}` = primary, `{port2}` =
   * second, …). This is how a tool that ignores the injected `PORT` gets its
   * port — e.g. Vite reads `CLIENT_PORT`, so `env: { CLIENT_PORT: "{port}" }`.
   * The `dev`/`build`/`test` command strings accept the same placeholders.
   */
  env: z.record(z.string(), z.string()).optional(),
  /** One-click URL template, e.g. "http://localhost:{port}". */
  url: z.string().optional(),
  /** Path to a docker-compose file to `docker compose up` instead of a process. */
  dockerCompose: z.string().optional(),
});
export type SubApp = z.infer<typeof SubAppSchema>;

/* ----------------------------------------------------------------- projects */

/** A project = one git repo with many subApps. */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute path to the repo working copy. */
  repoPath: z.string(),
  /** Directory under which per-task worktrees are created. */
  worktreeRoot: z.string(),
  /** Custom worktree command (Hivebreak → "pnpm worktree"). */
  worktreeCmd: z.string().optional(),
  /** Custom ship command (Hivebreak → "pnpm ship"). */
  shipCmd: z.string().optional(),
  /** MCP servers passed through to every session in this project. */
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  subApps: z.array(SubAppSchema).default([]),
  /** Default branch for diff-vs-base / PR base (default "main"). */
  defaultBranch: z.string().optional(),
  createdAt: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

/* ------------------------------------------------------------ agents & modes */

/** Config scope: global (all projects) or a single project. */
export const ConfigScopeSchema = z.enum(["global", "project"]);
export type ConfigScope = z.infer<typeof ConfigScopeSchema>;

/** A custom agent: instructions + permission profile + tool gating. */
export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** System-prompt append / agent prompt. */
  instructions: z.string(),
  permissionMode: PermissionModeSchema,
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  scope: ConfigScopeSchema.default("global"),
  /** Set when scope === "project". */
  projectId: z.string().optional(),
  createdAt: z.number().int().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** A mode = a named permission posture + optional instruction overlay. */
export const ModeConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissionMode: PermissionModeSchema,
  instructions: z.string().optional(),
  scope: ConfigScopeSchema.default("global"),
  projectId: z.string().optional(),
});
export type ModeConfig = z.infer<typeof ModeConfigSchema>;

/* ------------------------------------------------------------ PRs & workflows */

/** Lightweight PR reference persisted on a chat. */
export const PRRefSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  /** "owner/repo" if known. */
  repo: z.string().optional(),
  title: z.string().optional(),
  state: z.enum(["open", "closed", "merged"]).optional(),
});
export type PRRef = z.infer<typeof PRRefSchema>;

/** A single CI check / status on a PR. */
export const CheckRunSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
    ])
    .nullable()
    .optional(),
  url: z.string().optional(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

/** A PR's aggregate review decision (GitHub `reviewDecision`). */
export const ReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** A GitHub review thread (for resolve tracking). */
export const ReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean().optional(),
  path: z.string().optional(),
  line: z.number().int().nullable().optional(),
  author: z.string().optional(),
  body: z.string().optional(),
});
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;

/** Rich runtime PR view produced by GitHubService. */
export const PRInfoSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  branch: z.string(),
  baseBranch: z.string(),
  isDraft: z.boolean(),
  repo: z.string().optional(),
  author: z.string().optional(),
  body: z.string().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeStateStatus: z.string().optional(),
  /** Aggregate review decision (null = none yet). */
  reviewDecision: ReviewDecisionSchema.nullable().optional(),
  labels: z.array(z.string()).optional(),
  checks: z.array(CheckRunSchema).default([]),
  reviewThreads: z.array(ReviewThreadSchema).optional(),
  /** Count of issue-comments on the PR (from a list/detail fetch). */
  commentCount: z.number().int().optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  updatedAt: z.string().optional(),
  createdAt: z.string().optional(),
});
export type PRInfo = z.infer<typeof PRInfoSchema>;

/** A GitHub Actions workflow definition. */
export const WorkflowDefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string(),
  state: z.string().optional(),
});
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/** A GitHub Actions run (dispatched or observed). */
export const WorkflowRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  workflowName: z.string().optional(),
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "requested",
    "waiting",
    "pending",
  ]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
    ])
    .nullable()
    .optional(),
  event: z.string().optional(),
  headBranch: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/** A workflow paired with its most-recent run (the default Actions view). */
export const WorkflowWithLastRunSchema = z.object({
  workflow: WorkflowDefSchema,
  /** The latest run of this workflow, or null when it has never run. */
  lastRun: WorkflowRunSchema.nullable(),
});
export type WorkflowWithLastRun = z.infer<typeof WorkflowWithLastRunSchema>;

/** One `workflow_dispatch` input, parsed from the workflow YAML (for a Run form). */
export const WorkflowInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(["string", "boolean", "choice", "number", "environment"]).optional(),
  required: z.boolean().optional(),
  /** Stringified default (booleans/numbers coerced to text for form binding). */
  default: z.string().optional(),
  /** Allowed values when `type === "choice"`. */
  options: z.array(z.string()).optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

/* -------------------------------------------------------------------- chats */

/** A chat: the crown-jewel session. May own many worktrees/PRs over its life. */
export const ChatSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  /** SDK session id captured from the init message (for resume/fork). */
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  modeId: z.string(),
  effort: EffortSchema,
  /** SDK model id backing the session (unset = SDK/subscription default). */
  model: z.string().optional(),
  /** Worktree paths this chat has created/owns. */
  worktrees: z.array(z.string()).default([]),
  prs: z.array(PRRefSchema).default([]),
  /** Last-known live status (authoritative source is the SessionBroker). */
  status: ChatStatusSchema.optional(),
  archived: z.boolean().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int().optional(),
});
export type Chat = z.infer<typeof ChatSchema>;

/* --------------------------------------------------------------- worktrees */

/** Result of `git worktree` inspection + diff-vs-base stats. */
export const WorktreeInfoSchema = z.object({
  path: z.string(),
  branch: z.string(),
  /** HEAD commit sha. */
  head: z.string().optional(),
  /** Base branch this was cut from (default "main"). */
  base: z.string().optional(),
  isDirty: z.boolean().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  locked: z.boolean().optional(),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  createdAt: z.number().int().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

/** A local git branch, for the launch branch/worktree picker. */
export const BranchInfoSchema = z.object({
  name: z.string(),
  /** Last commit (committer) date, epoch ms — drives the recency sort. */
  lastCommitAt: z.number().int().optional(),
  /** True for the branch checked out in the primary repo (project.repoPath). */
  isCurrent: z.boolean().optional(),
  /** Absolute path of the worktree on this branch, if one exists. */
  worktreePath: z.string().optional(),
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

/* ----------------------------------------------------------------- runners */

export const RunnerStatusSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "stopped",
  "crashed",
  "exited",
]);
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

/** A live subApp process (or docker-compose stack) under RunnerService. */
export const RunnerInstanceSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  worktreePath: z.string(),
  /** Branch the worktree is on (for display + branch-scoped tracking). */
  branch: z.string().optional(),
  subAppId: z.string(),
  kind: z.enum(["process", "docker"]).default("process"),
  pid: z.number().int().optional(),
  /** Primary allocated port after offset. */
  port: z.number().int().optional(),
  /** All allocated ports (offset-mapped from subApp.ports). */
  ports: z.array(z.number().int()).optional(),
  /** Resolved one-click URL. */
  url: z.string().optional(),
  /** True when a docker-compose stack backs this runner (needs `down` to stop). */
  usedDocker: z.boolean().optional(),
  /** Directory to run `docker compose` from — persisted so a post-restart
   *  reconcile / stop can tear the detached stack down without the live map. */
  composeDir: z.string().optional(),
  /** Compose file basename passed to `docker compose -f`. */
  composeFile: z.string().optional(),
  status: RunnerStatusSchema,
  startedAt: z.number().int().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type RunnerInstance = z.infer<typeof RunnerInstanceSchema>;

/* --------------------------------------------------------------- terminals */

/** Lifecycle of a persistent named shell managed by TerminalService. */
export const TerminalStatusSchema = z.enum(["live", "exited"]);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

/**
 * A persistent, named shell whose cwd/env survive across commands — the agent's
 * `mcp__manager__terminal` sessions, visualized read-only in the UI. Keyed by
 * `${chatId}::${name}`.
 */
export const TerminalInfoSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  /** Agent-chosen terminal name (e.g. "build", "server"). */
  name: z.string(),
  /** Live working directory (tracked after every command). */
  cwd: z.string(),
  status: TerminalStatusSchema,
  /** True while a command is executing in this shell. */
  busy: z.boolean().optional(),
  /** The most recent command run in this shell (header display). */
  lastCommand: z.string().optional(),
  /** Exit code of the most recent command (null = cmdlet / no native exit). */
  lastExitCode: z.number().int().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int().optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

/* -------------------------------------------------- checkpoints / workflow */

/** Per-message git-shadow-ref checkpoint (rollback map value). */
export const CheckpointSchema = z.object({
  messageId: z.string(),
  chatId: z.string(),
  /** Hidden git ref holding the tree snapshot. */
  ref: z.string(),
  /** SDK message uuid to fork/resume the session at. */
  sessionMessageUuid: z.string().optional(),
  worktreePath: z.string().optional(),
  createdAt: z.number().int(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/* ------------------------------------------------------------- agent memory */

/**
 * Classification of a durable project memory. Mirrors the kinds the human's own
 * Claude Code memory uses (a durable user preference, a piece of feedback, a
 * project fact, or a pointer to reference material).
 */
export const MemoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/**
 * One durable, cross-chat fact scoped to a PROJECT. Persisted as a single
 * markdown file (frontmatter `{ name, description, type }` + a markdown body)
 * under `.data/projects/<projectId>/memory/<file>`, listed by a generated
 * `MEMORY.md` index. The index + descriptions are injected into every session at
 * start (read); agents append via `mcp__manager__remember` (write); the Memory
 * panel curates them.
 */
export const ProjectMemorySchema = z.object({
  /** Owning project id. */
  projectId: z.string(),
  /** Kebab-case slug — the memory's stable identity within its project. */
  name: z.string(),
  /** One-line description shown in the index + injected into the prompt. */
  description: z.string(),
  type: MemoryTypeSchema,
  /** Full markdown body (the fact itself). */
  body: z.string(),
  /** Markdown filename within the project's memory dir (e.g. "my-fact.md"). */
  file: z.string(),
  /** Last write time (epoch ms). */
  updatedAt: z.number().int().optional(),
});
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

/** A tracked GitHub workflow-dispatch job initiated from the UI. */
export const WorkflowRunRequestSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  workflow: z.string(),
  ref: z.string(),
  inputs: z.record(z.string(), z.string()).optional(),
  runId: z.number().int().optional(),
  status: z.string().optional(),
  createdAt: z.number().int(),
});
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;
