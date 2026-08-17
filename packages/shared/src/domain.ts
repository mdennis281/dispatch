/**
 * Domain / config / persisted entities. These are the JSON records the Store
 * reads and writes (projects, subApps, agents, modes, chats) plus the runtime
 * views (worktrees, runners, PRs, workflow runs). Zod = source of truth.
 */
import * as z from "zod";
import {
  EffortSchema,
  HarnessKindSchema,
  McpServerConfigSchema,
  PermissionModeSchema,
  ChatStatusSchema,
  ShellTranscriptFilterSchema,
} from "./common.js";
import { ResumePlanSchema } from "./limits.js";
import { WorkflowConfigSchema } from "./workflow.js";

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
  /**
   * How change ships in this repo (see {@link WorkflowConfigSchema}). Absent →
   * inferred from `shipCmd` for back-compat; resolve it with `resolveWorkflow`
   * rather than reading this field directly.
   */
  workflow: WorkflowConfigSchema.optional(),
  /** Transcript-shell categories shown for this project; unset inherits the app. */
  shellFilter: ShellTranscriptFilterSchema.optional(),
  /** MCP servers passed through to every session in this project. */
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  /**
   * Which agent runtime new chats in this project start on. Absent means
   * `DEFAULT_HARNESS` — left optional rather than defaulted so an untouched
   * project record round-trips byte-identical and existing installs don't all
   * show as edited on first read.
   */
  harness: HarnessKindSchema.optional(),
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
  /**
   * Reasoning effort this agent pins for itself. Unset ⇒ it inherits the chat's
   * effort, exactly like `model`. Passed straight through as
   * `AgentDefinition.effort`, so it applies whether the agent runs as the main
   * thread or is spawned as a subagent.
   *
   * Accepts `null` as "inherit" so a PUT can CLEAR a pinned level — an omitted
   * key means "unchanged" once the route merges over the stored record, which
   * would otherwise make the pin a one-way door.
   */
  effort: EffortSchema.nullish().transform((v) => v ?? undefined),
  scope: ConfigScopeSchema.default("global"),
  /** Set when scope === "project". */
  projectId: z.string().optional(),
  /**
   * Source filename within the agents dir, when this agent was loaded from a
   * repo's `.dispatch/`. The id is a slug of the frontmatter NAME, which need
   * not match the filename — so anything opening or deleting the file has to be
   * told which file it was, not derive it.
   */
  file: z.string().optional(),
  createdAt: z.number().int().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
/**
 * What a CLIENT may send for an agent (pre-parse). Differs from
 * {@link AgentConfig} on `effort`, where `null` is the wire form of "inherit" —
 * the only way to clear a pinned level through a merging PUT.
 */
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;

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
  /**
   * When this PR was observed to reach `merged`/`closed`, epoch ms. Persisted so
   * the "PR done" dot survives a server restart or a page reload — it used to
   * live only on the in-memory session and was lost by both.
   */
  settledAt: z.number().int().optional(),
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
  /** Deep link to the first comment, so a row in the PR catalog is clickable. */
  url: z.string().optional(),
  /** ISO timestamp of the first comment — drives "newest comment" ordering. */
  createdAt: z.string().optional(),
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

/* ------------------------------------------------------------- PR registry */

/**
 * What ONE reviewer is actually doing right now.
 *
 * The terminal three (`approved` / `changes_requested` / `commented`) were the
 * only states this app could see, because they're the only ones REST exposes —
 * and they cannot answer the question that matters while you wait: has the
 * reviewer STARTED? `in_progress` is that answer. GitHub represents a review
 * that has been begun but not submitted as a `PENDING` PullRequestReview, and
 * the GraphQL API returns another author's PENDING review where
 * `GET /pulls/{n}/reviews` omits it entirely. That PENDING row is precisely the
 * "Copilot is reviewing…" spinner on the PR page.
 *
 * `requested` is the weaker claim: on the hook, nothing begun that we can see.
 */
export const PrReviewerStateSchema = z.enum([
  "requested",
  "in_progress",
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
]);
export type PrReviewerState = z.infer<typeof PrReviewerStateSchema>;

/** What KIND of account a reviewer is — bots are reviewers here, not an edge case. */
export const PrReviewerKindSchema = z.enum(["user", "bot", "team", "mannequin"]);
export type PrReviewerKind = z.infer<typeof PrReviewerKindSchema>;

/** One reviewer on a PR, and where they've got to. */
export const PrReviewerSchema = z.object({
  login: z.string(),
  kind: PrReviewerKindSchema.default("user"),
  state: PrReviewerStateSchema,
  /** ISO timestamp of their latest SUBMITTED review, when they have one. */
  submittedAt: z.string().optional(),
  /**
   * They reviewed a commit that is no longer this PR's head — so their verdict
   * is about code you have since replaced. Distinct from having no review at
   * all, and the difference decides whether re-requesting them is warranted.
   */
  stale: z.boolean().optional(),
});
export type PrReviewer = z.infer<typeof PrReviewerSchema>;

/**
 * A tracked pull request — the third catalog, beside worktrees and terminals.
 *
 * Keyed `owner/repo#number` rather than by number alone: PR numbers restart at 1
 * per repository, and a store keyed on the bare number let one project's PR #7
 * overwrite another's (the exact hazard `ProjectPRsView` documents as its reason
 * for refusing to fold `pr-update` in at all).
 *
 * This holds LIVE STATE, continuously tracked, which is what separates it from
 * everything that came before: `Chat.prs` records only that a chat owns a PR,
 * and the old project overlay re-fetched from `gh` on every open and kept
 * nothing. `Chat.prs` remains the ownership pointer — `chatId` here is copied
 * FROM it — so the settled-PR green dot keeps reading the record it always has.
 */
export const PrRecordSchema = z.object({
  /** `owner/repo#number` — the primary key. */
  key: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().default(""),
  branch: z.string().default(""),
  baseBranch: z.string().default(""),
  state: z.enum(["open", "closed", "merged"]).default("open"),
  isDraft: z.boolean().default(false),
  author: z.string().optional(),
  labels: z.array(z.string()).default([]),
  /** Parked by a hold label (see `isHeldByLabel`) — precomputed for the roster. */
  hold: z.boolean().default(false),
  /**
   * false = MERGE CONFLICTS. null = GitHub hasn't computed it yet, which it
   * reports as `UNKNOWN` on a PR it has only just been asked about — treating
   * that as "conflicted" would flag half the PRs opened in the last minute.
   */
  mergeable: z.boolean().nullable().default(null),
  mergeStateStatus: z.string().optional(),
  reviewDecision: ReviewDecisionSchema.nullable().default(null),
  reviewers: z.array(PrReviewerSchema).default([]),
  threads: z.array(ReviewThreadSchema).default([]),
  checks: z.array(CheckRunSchema).default([]),
  /** Issue-comment count (review threads are counted separately, in `threads`). */
  commentCount: z.number().int().optional(),
  /** Head sha, so a reviewer's verdict can be dated against the current code. */
  headRefOid: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  mergedAt: z.string().optional(),
  closedAt: z.string().optional(),

  /* --- registry scope (RegistryScoped) --- */
  projectId: z.string().optional(),
  /**
   * The chat that owns this PR, from its `Chat.prs`. Absent = nobody in Dispatch
   * opened it — a human's PR, a bot's. Shown as "unattributed", exactly like a
   * worktree that appeared from outside: a visible, fixable state rather than an
   * invisible one.
   */
  chatId: z.string().optional(),

  /* --- tracking bookkeeping --- */
  firstSeenAt: z.number().int(),
  /** Last completed poll, epoch ms. 0 = created from a ref, never polled yet. */
  lastPolledAt: z.number().int().default(0),
  /** Last poll at which any tracked field actually CHANGED — the recency stamp. */
  lastChangedAt: z.number().int(),
  /** Earliest epoch ms the sweep should poll this row again (adaptive cadence). */
  nextPollAt: z.number().int().default(0),
  /** Consecutive polls that changed nothing — drives the backoff ladder. */
  quietPolls: z.number().int().default(0),
  /**
   * Why the last poll failed. Kept ON the row rather than dropping it: a stale
   * row that says why it's stale is honest; one that silently keeps showing
   * five-minute-old state as current is not.
   */
  pollError: z.string().optional(),
});
export type PrRecord = z.infer<typeof PrRecordSchema>;

/** Compose the registry key. The one place the `repo#number` shape is spelled. */
export function prRecordKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

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

/**
 * Why a chat was created, when something in the app spawned it to do a specific
 * job rather than a human opening a blank one.
 *
 * The point is recognition: a sidebar of a dozen chats all called "New chat"
 * hides the one that's off writing your agent config. `kind` is a stable slug
 * the UI maps to an icon + tint (unknown kinds fall back to the default dot, so
 * a new spawner never has to ship a UI change to be safe), and `label` is the
 * human sentence — the specific job, not the category.
 *
 * Convention for `kind`: `<feature>:<section>`, e.g. `config:agents`. Kept a
 * free string rather than an enum precisely so features can add purposes without
 * a schema migration; anything persisted is display metadata only and never
 * changes how the session runs.
 */
export const ChatPurposeSchema = z.object({
  kind: z.string(),
  label: z.string().optional(),
});
export type ChatPurpose = z.infer<typeof ChatPurposeSchema>;

/** A chat: the crown-jewel session. May own many worktrees/PRs over its life. */
export const ChatSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  /**
   * The runtime this chat runs on, captured from the project at creation and
   * never changed afterwards.
   *
   * Pinned rather than read live because `sessionId` below is only meaningful
   * to the runtime that issued it — re-pointing a project's harness must not
   * silently make every existing chat unresumable. Absent means the chat
   * predates harness selection, i.e. Claude.
   */
  harness: HarnessKindSchema.optional(),
  /**
   * Last runtime migration. A migrated chat starts a fresh native session and
   * receives a bounded neutral transcript handoff; native session ids are never
   * reused across providers.
   */
  harnessHandoff: z
    .object({
      from: HarnessKindSchema,
      to: HarnessKindSchema,
      at: z.number().int(),
    })
    .optional(),
  /** Runtime session id captured from the init event (for resume/fork). */
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
  /** Why this chat exists, when the app spawned it for a job. Display-only. */
  purpose: ChatPurposeSchema.optional(),
  /**
   * Whether THIS chat's transcript shows the context Dispatch attached on your
   * behalf — surfaced memories, a working-tree snapshot, anything the model was
   * given that you never typed and never saw.
   *
   * Three-level setting: unset means inherit (project manifest `defaults`, then
   * app settings, then off). Only ever affects rendering — the model receives
   * the same context either way, so toggling it can't change how a chat runs.
   */
  showInjectedContext: z.boolean().optional(),
  /** Transcript-shell categories shown for this chat; unset inherits the project. */
  shellFilter: ShellTranscriptFilterSchema.optional(),
  archived: z.boolean().optional(),
  /**
   * A pending (or just-settled) auto-resume after a usage limit. Persisted so a
   * server restart re-arms the timer instead of silently dropping the chat.
   */
  resume: ResumePlanSchema.optional(),
  /**
   * When the user last sent a message, epoch ms. Distinct from `updatedAt`,
   * which any bookkeeping write bumps — this one moves ONLY on real user input,
   * which is what {@link isPrSettledIdle} needs to tell "the PR landed and
   * nobody has said anything since" from "the PR landed and we kept working".
   */
  lastUserMessageAt: z.number().int().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int().optional(),
});
export type Chat = z.infer<typeof ChatSchema>;

/**
 * Does this chat read as "PR done" — finished, its PR landed, nothing said
 * since? True when the chat is idle, one of its PRs reached a terminal state,
 * and no user message followed it.
 *
 * Derived from the persisted record rather than tracked as its own flag, so it
 * survives a server restart and a page reload alike. The broker's in-memory
 * `prWatchSettled` is the live echo of this; this is the durable truth.
 */
export function isPrSettledIdle(chat: Pick<Chat, "status" | "prs" | "updatedAt" | "lastUserMessageAt">): boolean {
  // Absent status means idle, matching what session creation assumes — a legacy
  // chat that never recorded one must not be locked out of the green dot.
  if ((chat.status ?? "idle") !== "idle") return false;
  let settledAt: number | undefined;
  for (const pr of chat.prs ?? []) {
    if (pr.state !== "merged" && pr.state !== "closed") continue;
    // A terminal PR with no `settledAt` predates that field. Its settle time is
    // unrecoverable, so fall back to the chat's last write — for a chat that
    // ended on a merge (the case this whole path exists for) that IS about when
    // it settled, and it lets already-landed chats read correctly instead of
    // staying gray forever.
    //
    // Only while the chat ALSO predates `lastUserMessageAt`, though: once we've
    // started recording user messages, an undated ref can't be compared against
    // them, and guessing "now" would pin the dot green through every later turn.
    const legacy = chat.lastUserMessageAt === undefined;
    const at = pr.settledAt ?? (legacy ? chat.updatedAt : undefined);
    if (at !== undefined && (settledAt === undefined || at > settledAt)) settledAt = at;
  }
  if (settledAt === undefined) return false;
  return (chat.lastUserMessageAt ?? 0) <= settledAt;
}

/* --------------------------------------------------------------- worktrees */

/** Result of `git worktree` inspection + diff-vs-base stats. */
/**
 * How a worktree came to exist — the field that makes attribution auditable.
 *
 * `ui` and `tool` are the tracked paths: the record is written in the same call
 * that runs `git worktree add`, so the owning chat is KNOWN rather than guessed.
 * `harness` is the SDK's own `EnterWorktree` (which Dispatch can't intercept)
 * and `external` is a tree that simply appeared in `git worktree list` — both
 * are back-filled by the detector, and a `harness`/`external` row with no
 * `chatId` is precisely the "whose worktree is this?" case that used to be
 * invisible.
 */
export const WorktreeOriginSchema = z.enum(["ui", "tool", "harness", "external"]);
export type WorktreeOrigin = z.infer<typeof WorktreeOriginSchema>;

/**
 * The persisted half of a worktree: who owns it and where it came from.
 *
 * Existence stays git's to answer (`git worktree list` is ground truth and can
 * change under us — someone deletes a directory, another instance removes a
 * tree). This record only holds what git cannot tell us, keyed by the worktree's
 * canonical path.
 */
export const WorktreeRecordSchema = z.object({
  /** Canonical absolute path — the primary key. */
  path: z.string(),
  projectId: z.string(),
  branch: z.string(),
  /** Owning chat, when one is known. Absent = unattributed, and shown as such. */
  chatId: z.string().optional(),
  origin: WorktreeOriginSchema,
  /** Base ref the branch was cut from. */
  base: z.string().optional(),
  /** Optional human label, for a worktree cut for a named piece of work. */
  label: z.string().optional(),
  createdAt: z.number().int(),
  /**
   * Last time this path was seen in `git worktree list`. A row outlives neither
   * the tree nor a reconcile pass, so this is a freshness stamp, not a tombstone.
   */
  lastSeenAt: z.number().int(),
});
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

/** A worktree as rendered: git's live view merged with its {@link WorktreeRecordSchema}. */
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
  /** From the record; absent for a tree seen before the registry knew of it. */
  origin: WorktreeOriginSchema.optional(),
  label: z.string().optional(),
  lastSeenAt: z.number().int().optional(),
  /** True for the project's primary checkout (never a disposable worktree). */
  isPrimary: z.boolean().optional(),
  /**
   * Whether this branch's work has landed on the trunk. UNDEFINED means nobody
   * could tell — no resolvable trunk ref, or no store to read PRs from — which
   * is a third answer, not a `false`.
   *
   * Two sources, OR'd, because neither alone is enough (see
   * `WorktreeService.mergedBranches`): git's own ancestry, and the merged PRs
   * Dispatch recorded. A squash merge rewrites history, so a landed branch is
   * NOT an ancestor of the trunk and git will call it unmerged forever — which
   * on a squash-merging repo would be almost every branch here.
   */
  merged: z.boolean().optional(),
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

/** Who opened a shell — an agent via `mcp__manager__terminal`, or a human. */
export const TerminalOriginSchema = z.enum(["agent", "ui"]);
export type TerminalOrigin = z.infer<typeof TerminalOriginSchema>;

/** One retained output line of a terminal transcript. */
export const TerminalLineSchema = z.object({
  /** `command` is the echoed input; the piped shell doesn't echo it itself. */
  stream: z.enum(["command", "stdout", "stderr"]),
  chunk: z.string(),
  ts: z.number().int(),
});
export type TerminalLineRecord = z.infer<typeof TerminalLineSchema>;

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
  /**
   * Set while a BACKGROUND command holds this shell — a dev server, a watcher.
   * The distinction matters to a human reading the Terminals tab: a shell that
   * has been `busy` for two hours is either wedged or is deliberately hosting a
   * long-lived process, and only this field tells them which.
   */
  background: z
    .object({ command: z.string(), since: z.number().int() })
    .optional(),
  /** OS pid of the shell process (absent in tests / after exit). */
  pid: z.number().int().optional(),
  /**
   * Project the owning chat belongs to. A terminal has always BEEN in a project
   * — its cwd is a worktree of one — but it never said so, which made "every
   * shell in this project" a question the app could not answer.
   */
  projectId: z.string().optional(),
  /** Who opened it: an agent through the MCP tool, or a human in the UI. */
  origin: TerminalOriginSchema.optional(),
  /** Last time output or a command touched this shell (drives `since` filters). */
  lastActivityAt: z.number().int().optional(),
  /** Retained line count / byte size of this shell's transcript. */
  lines: z.number().int().optional(),
  bytes: z.number().int().optional(),
  /**
   * True when the shell is only a RECORD — its transcript survived, but the
   * process did not (a server restart, or a sweep that outlived the shell). You
   * can still read it; you cannot run in it.
   */
  archived: z.boolean().optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

/**
 * The persisted half of a terminal.
 *
 * Terminals used to live entirely in a `Map` — a restart lost every shell AND
 * every transcript, so "what did that build actually print?" was answerable only
 * while the process that ran it was still up. This is the row that outlives it;
 * the output itself goes to `terminals/<logId>.jsonl`.
 */
export const TerminalRecordSchema = z.object({
  /** `${chatId}::${name}` — the same key the live map uses. */
  id: z.string(),
  /**
   * Filename-safe id for this terminal's JSONL transcript. Separate from `id`
   * because `id` embeds an agent-chosen name that may contain anything at all,
   * and `::` is not a legal Windows filename to begin with.
   */
  logId: z.string(),
  chatId: z.string(),
  projectId: z.string().optional(),
  name: z.string(),
  cwd: z.string(),
  origin: TerminalOriginSchema,
  lastCommand: z.string().optional(),
  lastExitCode: z.number().int().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastActivityAt: z.number().int(),
  lines: z.number().int().default(0),
  bytes: z.number().int().default(0),
});
export type TerminalRecord = z.infer<typeof TerminalRecordSchema>;

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
