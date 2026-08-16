/**
 * SessionBroker — the CORE of Dispatch.
 *
 * Owns `Map<chatId, LiveSession>`. Each LiveSession wraps a single Agent SDK
 * `query()` in STREAMING INPUT mode (the InputChannel push/close pattern proven
 * in `spikes/streaming-input.ts`), so N chats run out-of-process and Node stays
 * responsive. Per chat we run a small state machine:
 *
 *     idle → running → awaiting-input → running → done/error
 *              ↑___________(next turn)___________|
 *
 * Responsibilities:
 *  - Feed + steer a live session (per-chat FIFO input queue, mid-run injection).
 *  - Route SDK `canUseTool` prompts to the host as `permission-request` events +
 *    a global AttentionItem, and block the tool until `resolvePermission(...)`.
 *  - Forward stream messages (assistant text/thinking, tool_use, tool_result,
 *    result) as WsServerEvents AND persist them to the Store JSONL transcript.
 *  - Map UI mode/effort → SDK permissionMode / reasoning effort.
 *  - Enforce a configurable cap on concurrently-ACTIVE sessions (default 6); over
 *    the cap, new turns park in a visible `queued` state and drain in FIFO order.
 *  - Emit AttentionItems when a turn completes (idle) or the session ends (done).
 *
 * The SDK `query` function, id generator, and clock are injectable so tests can
 * script an async iterator + capture the canUseTool callback without the real
 * subprocess or network.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  AgentDefinition,
  HookCallback,
  HookInput,
  HookJSONOutput,
  McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import type {
  Chat,
  Project,
  PermissionMode,
  Effort,
  ChatStatus,
  AgentActivity,
  PermissionDecision,
  PermissionRequest,
  ChatMessage,
  MessagePart,
  ImageRef,
  AgentConfig,
  ModeConfig,
  McpServerConfig,
  SkillConfig,
  ContextUsage,
  ResolvedWorkflow,
  WorkflowMergeMethod,
  PRRef,
  HarnessKind,
} from "@dispatch/shared";
import {
  DEFAULT_HARNESS,
  EffortSchema,
  classifyWorkflowViolation,
  isPrSettledIdle,
  resolveWorkflow,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import type { TerminalService } from "./terminal.js";
import type { MemoryService } from "./memory.js";
import type { MemoryHistoryService } from "./memory-history.js";
import type { GitHubService } from "./github.js";
import type { RunnerService } from "./runner.js";
import type { WorktreeService } from "./worktree.js";
import {
  createManagerMcpServer,
  overrideConsentPrompt,
  type ManagerAskQuestion,
  type ManagerAskResult,
  type ManagerMcpGitHub,
  type ManagerMcpPrApproval,
  type ManagerMcpPrCreate,
  type PrLandingPolicy,
  type SpawnChatConsent,
  type SpawnChatRequest,
  type SpawnChatTarget,
  type SpawnedChat,
} from "./mcp/manager-mcp.js";
import { createMcpConfigEditor } from "./mcp/mcp-config-editor.js";
import { materializeSkills, cleanupMaterializedSkills } from "./skill-materializer.js";
import { bundledSkills } from "./bundled-skills.js";
import { buildWorkflowDirective, createWorkflowGuardHook, inspectCwd } from "./workflow.js";
import { createBackgroundShellGuardHook } from "./shell-guard.js";
import { AgentCwdTracker } from "./agent-cwd.js";
import { claudeExecutableOption } from "./runtime.js";
import type {
  HarnessEvent,
  HarnessQuestion,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "../harness/types.js";
import type { HarnessRegistry } from "../harness/index.js";
import type { ManagerMcpBridge, ManagerMcpGrant } from "./mcp/manager-http.js";
import { managerMcpContextOf } from "./mcp/manager-mcp.js";

/**
 * The always-injected "prefer the manager tools" directive. Lists only the
 * `mcp__manager__*` tools THIS session actually has (gated the same way the MCP
 * server offers them) and tells the agent to reach for them instead of
 * hand-rolling shell equivalents — the recurring failure mode where an agent
 * re-implements `watch_pr` as a `gh` sleep loop or a background Monitor task.
 */
export function buildManagerToolsDirective(caps: {
  github: boolean;
  terminals: boolean;
  memory: boolean;
  runner: boolean;
  mcpConfig?: boolean;
  /** The project opted into auto-merge → this session can land its own PRs. */
  prApproval?: boolean;
  /** Change ships through a PR here → this session opens PRs with `create_pr`. */
  prCreate?: boolean;
  /** Reviewers `create_pr` will request (`workflow.pr.reviewers`). */
  prReviewers?: readonly string[];
}): string {
  const lines = [
    "# Manager tools — prefer these over improvising",
    "",
    "You run inside Dispatch, which gives you first-class `mcp__manager__*` " +
      "tools. Prefer them over hand-rolled shell equivalents: they are cheaper, they " +
      "cancel cleanly when the chat is stopped, and they surface live status in the UI.",
    "",
    "- `mcp__manager__wait` — pause yourself for a set time (e.g. let a build settle) " +
      "instead of a `sleep` loop.",
    "- `mcp__manager__wait_for_chat` — block until another chat is at rest, instead of polling it.",
    "- `mcp__manager__context_usage` — check how full your own context window is " +
      "(tokens, window size, percent, per-category breakdown) instead of guessing.",
    "- `mcp__manager__compact_context` — compact your own context in place when it's " +
      "filling up (past ~80%) and you have more work to do; the session continues " +
      "from a summarized, smaller window.",
    "- `mcp__manager__ask_user` — ask one to three structured questions through " +
      "Dispatch's radio or multi-select question card. Use it whenever an unanswered " +
      "choice materially changes the work; it is available in every chat mode.",
  ];
  if (caps.github) {
    lines.push(
      "- `mcp__manager__watch_pr` — wait on AND react to a GitHub PR. It returns the " +
        "instant a CI check fails, a new review comment/thread appears, or the PR " +
        "merges/closes. Call it in a loop: fix what it reports, then call it again, " +
        "until it returns `done:true`. **Never** hand-roll `gh pr view` / `gh pr checks` " +
        "polling loops or a background Bash/Monitor task to watch a PR — `watch_pr` is " +
        "the supported way and, unlike a one-shot loop, keeps surfacing each NEW round " +
        "of review comments so you don't stop watching after the first fix. It also " +
        "reports `reviewStalled:true` when NO reviewer is actually queued, so you stop " +
        "waiting on a review that isn't coming.",
      "- `mcp__manager__resolve_thread` — reply in a review thread and mark it RESOLVED. " +
        "Fixing the code and replying is not enough: an unresolved thread still reads as " +
        "outstanding and blocks the merge. Call it for every comment you addressed, " +
        "passing the `thread:` id `watch_pr` printed with the comment. Leave a thread " +
        "open (`resolve: false`) only when you did NOT act on it.",
      "- `mcp__manager__request_review` — put reviewers back on the hook. GitHub clears a " +
        "reviewer's request the moment they submit, and your fix commits do NOT re-queue " +
        "them — so after you address a round, call this (once your fixes are PUSHED) and " +
        "then go back to `watch_pr`. Without it the PR sits with an empty queue forever.",
    );
  }
  if (caps.prCreate) {
    // Named BEFORE approve_pr because it comes first in the loop, and stated as
    // a prohibition on the raw command because that is the habit being replaced:
    // an agent that reaches for `gh pr create` opens a PR nobody was asked to
    // review, that isn't linked to this chat, and that nothing is watching.
    lines.push(
      "- `mcp__manager__create_pr` — open the PR for your work. **Never run `gh pr create`** " +
        "(it's refused): `create_pr` pushes the branch with an upstream, opens the PR, " +
        (caps.prReviewers?.length
          ? `requests review from ${caps.prReviewers.join(", ")}, `
          : "requests this project's configured reviewers, ") +
        "records the PR on this chat, and arms the watcher so review activity comes back " +
        "to you. It refuses on the mistakes that make a PR useless (on the trunk, no " +
        "commits, dirty tree) and names the override argument for each.",
    );
  }
  if (caps.prApproval) {
    lines.push(
      "- `mcp__manager__approve_pr` — approve and merge a PR once it's ready. This project " +
        "has auto-merge on: when `watch_pr` reports CI green with no open threads, call " +
        "`approve_pr` and consider the task finished. It re-verifies state, checks, threads " +
        "and the `hold` label before merging, and refuses with reasons if anything's off. " +
        "**Unless the user told you not to merge** — asked to review it first, to leave the " +
        "PR open, or to just ship it — in which case don't call it; say the PR is ready and stop.",
    );
  }
  if (caps.terminals) {
    lines.push(
      "- `mcp__manager__terminal` — a NAMED, persistent shell (cwd + env survive between " +
        "calls) for multi-step command sequences, instead of re-`cd`-ing in Bash each time. " +
        "Pass `background: true` (with its own `name`) for anything that never returns on " +
        "its own — a dev server, a watcher — and read it back with " +
        "`mcp__manager__terminal_output`. That is the ONLY sanctioned way to start a " +
        "long-running process: a Bash/PowerShell `run_in_background` spawns outside the " +
        "server's process tree, so Dispatch can neither show it nor stop it, and it is " +
        "left holding its port when this chat ends. The guard refuses that flag.",
    );
  }
  if (caps.memory) {
    lines.push(
      "- `mcp__manager__remember` / `recall` / `forget` — durable project memory that " +
        "carries facts across chats; record anything a future session would need re-told.",
      "- `mcp__manager__memory_list` / `memory_search` / `memory_history` / " +
        "`memory_similar` — the CURATION reads over that same memory, for when you need " +
        "an exhaustive answer rather than the most relevant one: the full inventory with " +
        "age and usage, every literal mention of a string, a fact's commit history " +
        "(including what was deliberately retired), and its near-duplicates.",
    );
  }
  if (caps.runner) {
    lines.push(
      "- `mcp__manager__run_subapp` — launch this project's app and get a live localhost " +
        "URL to actually SEE your change, instead of asking the user to run it.",
    );
  }
  if (caps.mcpConfig) {
    lines.push(
      "- `mcp__manager__mcp_list` / `mcp_add` / `mcp_remove` — read and edit the MCP servers " +
        "configured for this project.",
    );
    // The routing hint. An agent asked to "install the Linear MCP" will otherwise
    // reach for `.mcp.json` or `claude mcp add` from memory — neither of which
    // this harness reads. Naming the trigger conditions explicitly is what makes
    // the skill fire before the wrong file gets written, not after.
    lines.push(
      "",
      "## Setting up MCP servers",
      "",
      "The moment the conversation turns to MCP — installing or adding a server, connecting a " +
        "tool integration, a server that won't connect or whose tools aren't appearing, or " +
        "writing a new MCP server — **load the `mcp-setup` skill first**. It has this harness's " +
        "actual procedure, and the defaults you'd reach for otherwise are wrong here.",
      "",
      "The short version, so you don't get it wrong before the skill loads: this project's MCP " +
        "servers live in `.dispatch/project.yaml`, edited via `mcp__manager__mcp_add` or " +
        "the `dispatch mcp add` CLI. **Never** hand-edit `project.yaml`, and never write `.mcp.json`, " +
        "`~/.claude.json`, or `.claude/settings.json` to configure a server — the manager does " +
        "not read those. Secrets go in as `${VAR}` placeholders, never literal keys: the file " +
        "is committed.",
    );
  }
  return lines.join("\n");
}

/**
 * Adapt a {@link GitHubService} into the narrow {@link ManagerMcpGitHub} surface
 * the manager MCP's `watch_pr` tool needs, bound to one session's `cwd`.
 * `prMergeState` lets `gh` auto-detect the repo from cwd; `prChecks`,
 * `reviewThreads` and `prReviewState` require an explicit `owner/name`, so we
 * resolve it from cwd lazily and cache the promise (a per-session one-shot). Any
 * resolve/gh failure on those READS degrades to `null` — the watcher treats that
 * as "nothing new this poll" rather than aborting. An explicit `repo` override
 * always wins.
 *
 * The three ACTIONS (`requestReviewers`, `replyToThread`, `resolveThread`) throw
 * instead, because the failure they'd otherwise hide is the one that matters:
 * an agent told "resolved" for a thread that is still open.
 */
function makeGithubBinding(
  github: GitHubService,
  cwd: string | undefined,
  chatId: string,
  reviewers: readonly string[] = [],
): ManagerMcpGitHub {
  let repoP: Promise<string | null> | undefined;
  const repoFor = async (override?: string): Promise<string | null> => {
    if (override) return override;
    if (!cwd) return null; // no launch dir → can't auto-resolve the repo
    return (repoP ??= github.resolveRepo(cwd).catch(() => null));
  };
  return {
    prMergeState: (n, repo) => github.prMergeState(n, { repo, cwd }),
    prChecks: async (n, repo) => {
      const r = await repoFor(repo);
      return r ? github.prChecks(r, n).catch(() => null) : null;
    },
    reviewThreads: async (n, repo) => {
      const r = await repoFor(repo);
      return r ? github.reviewThreads(r, n).catch(() => null) : null;
    },
    // Same degrade-to-null contract as checks/threads: an unreadable queue is
    // "no news this poll", never a claim that nobody is queued.
    prReviewState: async (n, repo) => {
      const r = await repoFor(repo);
      return r ? github.prReviewState(r, n).catch(() => null) : null;
    },
    // These three THROW on failure rather than degrading — they are actions the
    // agent asked for, and silently doing nothing is how a thread stays open.
    requestReviewers: async (n, list, repo) => {
      const r = await repoFor(repo);
      if (!r) throw new Error("could not resolve the repo — pass `repo` as 'owner/name'");
      return github.requestReviewers(r, n, list, { chatId });
    },
    replyToThread: (threadId, body) => github.replyToThread(threadId, body, { chatId }),
    resolveThread: (threadId) => github.resolveThread(threadId, { chatId }),
    defaultReviewers: reviewers,
    notePrMerged: () => github.notePrMerged(chatId),
  };
}

/**
 * Adapt a {@link GitHubService} into the {@link ManagerMcpPrApproval} surface the
 * `approve_pr` tool needs. Built ONLY for sessions whose project sets
 * `autoMerge: "on-green"` — the broker passing `undefined` here is what keeps the
 * tool off every other project.
 *
 * `readiness` reads the threads SEPARATELY from `prDetail` even though the detail
 * fetch also tries them: `prDetail` swallows a thread-read failure into
 * `undefined`, which is indistinguishable from "no threads", and merging over
 * review comments we merely failed to fetch is the exact mistake this tool must
 * not make. Here a failed read stays `null` and blocks.
 */
/**
 * Adapt a {@link GitHubService} into the {@link ManagerMcpPrCreate} surface the
 * `create_pr` tool needs. Built for every session whose project ships change
 * through a PR (`requirePr`), which is the same condition under which the trunk
 * guard refuses a raw `gh pr create` — so the refusal always has somewhere to
 * point.
 *
 * `create` is deliberately one method covering all five steps (push, create,
 * request reviewers, record on the chat, arm the watcher). Splitting it would
 * re-create exactly the failure it exists to fix: each step individually
 * skippable, and nothing noticing when one was.
 */
function makePrCreateBinding(
  github: GitHubService,
  cwd: string | undefined,
  chatId: string,
  opts: {
    trunk: string;
    reviewers: readonly string[];
    draft: boolean;
    /** Pre-seeds the review watcher's dedup state; absent → no watcher wired. */
    arm?: (chatId: string, ref: PRRef) => void;
  },
): ManagerMcpPrCreate {
  let repoP: Promise<string | null> | undefined;
  const repoFor = async (): Promise<string | null> => {
    if (!cwd) return null;
    return (repoP ??= github.resolveRepo(cwd).catch(() => null));
  };

  /**
   * Which directory to inspect: the caller's, if it is a worktree of the SAME
   * repository, else the session's.
   *
   * The bound `cwd` is fixed when the session is built, so it is stale for any
   * agent that moved afterwards — notably one the Claude Code harness put in
   * `.claude/worktrees/` via its own `EnterWorktree`, which the server never
   * hears about. See `PrCreateWhere` in manager-mcp.ts for what that cost.
   *
   * The same-repository check is the whole safety story, and it is deliberately
   * `--git-common-dir` rather than a path-prefix test: linked worktrees share one
   * common dir wherever they physically live, and a prefix test would both miss
   * a worktree parked outside the repo and accept an unrelated repo nested
   * inside it. Anything that fails the check falls back to the bound cwd rather
   * than throwing — a bad hint must not be able to BLOCK a PR that the default
   * would have opened correctly.
   */
  const cwdFor = async (requested?: string): Promise<string | undefined> => {
    if (!requested || !cwd) return cwd;
    const ok = await github.sameRepository(requested, cwd).catch(() => false);
    return ok ? requested : cwd;
  };

  return {
    reviewers: opts.reviewers,
    draft: opts.draft,
    preflight: async (base, at) => {
      const repo = await repoFor();
      const where = await cwdFor(at);
      if (!repo || !where) return null;
      const pre = await github.prCreatePreflight(repo, { cwd: where, trunk: opts.trunk, base });
      return {
        branch: pre.branch,
        trunk: pre.trunk,
        base: pre.base,
        aheadOfBase: pre.aheadOfBase,
        dirty: pre.dirty,
        existing: pre.existing
          ? {
              number: pre.existing.number,
              url: pre.existing.url,
              state: pre.existing.state,
              labels: pre.existing.labels ?? [],
            }
          : null,
        cwd: where,
      };
    },
    create: async (input) => {
      const repo = await repoFor();
      // NOT named `cwd`: shadowing the binding's own parameter is how the next
      // reader convinces themselves the two are the same directory.
      const where = await cwdFor(input.cwd);
      if (!repo || !where) throw new Error("could not resolve this chat's repo");
      const pre = await github.prCreatePreflight(repo, {
        cwd: where,
        trunk: opts.trunk,
        base: input.base,
      });
      if (!pre.branch) throw new Error("this checkout is on a detached HEAD");
      const pr = await github.createPr(repo, {
        // `where`, NOT the binding's cwd: this is the call that PUSHES. Reading
        // the branch from one checkout and pushing from another would ship
        // whatever the session's directory happened to be sitting on.
        cwd: where,
        branch: pre.branch,
        base: pre.base,
        title: input.title,
        body: input.body,
        draft: input.draft,
        chatId,
      });
      if (!pr) throw new Error("the PR was created but could not be read back");

      // Reviewers next, and NEVER fatally: the PR already exists, so throwing
      // here would leave it open with the agent believing the call failed.
      const reviewers = opts.reviewers.length
        ? await github.requestReviewers(repo, pr.number, opts.reviewers, { chatId })
        : { requested: [], failed: [] };

      // The ownership record. Without it nothing downstream — the PRs panel, the
      // review watcher, the auto-resume rule — can tell whose PR this is.
      let attached = false;
      try {
        await github.attachPr(chatId, pr, repo);
        attached = true;
      } catch {
        /* reported to the agent as a warning line, not a failure */
      }

      const ref: PRRef = {
        number: pr.number,
        url: pr.url,
        branch: pr.branch,
        repo,
        title: pr.title,
        state: pr.state,
      };
      opts.arm?.(chatId, ref);

      return {
        number: pr.number,
        url: pr.url,
        branch: pr.branch,
        base: pr.baseBranch,
        draft: pr.isDraft,
        reviewersRequested: reviewers.requested,
        reviewersFailed: reviewers.failed,
        attached,
        watching: Boolean(opts.arm),
      };
    },
  };
}

function makePrApprovalBinding(
  github: GitHubService,
  cwd: string | undefined,
  chatId: string,
  defaultMethod: WorkflowMergeMethod,
  policy: PrLandingPolicy,
  /**
   * Puts a load-bearing override in front of the human. Injected rather than
   * reached for off the broker so this stays a plain function and the "what
   * happens when they say no" path is testable without a live session.
   */
  confirmOverride: ManagerMcpPrApproval["confirmOverride"],
): ManagerMcpPrApproval {
  let repoP: Promise<string | null> | undefined;
  const repoFor = async (override?: string): Promise<string | null> => {
    if (override) return override;
    if (!cwd) return null;
    return (repoP ??= github.resolveRepo(cwd).catch(() => null));
  };
  const requireRepo = async (override?: string): Promise<string> => {
    const r = await repoFor(override);
    if (!r) throw new Error("could not resolve this chat's repo — pass `repo` as 'owner/name'");
    return r;
  };
  return {
    defaultMethod,
    policy,
    confirmOverride,
    readiness: async (n, repo) => {
      const r = await repoFor(repo);
      if (!r) return null;
      const pr = await github.prDetail(r, n);
      if (!pr) return null;
      const threads = await github.reviewThreads(r, n).catch(() => null);
      // Who was asked vs who actually reported. `reviewDecision` alone can't
      // answer this: it's null both when nobody has reviewed and when the repo
      // has no review requirement, and treating those the same is what let a PR
      // be called done with nobody having looked at it.
      // `null`, NOT an empty result — the same rule `threads` follows above.
      // Coercing a failed read into "requested: []" reads downstream as "nobody
      // was even asked", which points the agent at re-opening the PR through
      // `create_pr` when the actual problem was a transient API error.
      const reviews = await github.prReviewState(r, n).catch(() => null);
      return {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        mergeable: pr.mergeable ?? null,
        mergeStateStatus: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision ?? null,
        labels: pr.labels ?? [],
        checks: pr.checks,
        threads,
        requestedReviewers: reviews?.requested ?? null,
        submittedReviews: reviews?.reported ?? null,
      };
    },
    approve: async (n, repo, body) => github.approve(await requireRepo(repo), n, body, { chatId }),
    merge: async (n, repo, method) => {
      // GitHubService.merge already emits the notice, refreshes the PR and fires
      // notePrMerged → the trunk sync, so a manager merge and an observed one
      // land the manager in exactly the same state.
      await github.merge(await requireRepo(repo), n, method, { chatId });
    },
  };
}

/* ------------------------------------------------------------------ deps */

/** The subset of the SDK `query` signature the broker calls. */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage> | string;
  options?: Options;
}) => Query;

/** Injectable seams (all default to the real implementations). */
export interface SessionBrokerDeps {
  query?: QueryFn;
  genId?: () => string;
  now?: () => number;
}

/**
 * The slice of {@link ProjectConfigService} the broker consumes: a managed
 * repo's self-contained `.dispatch/` config as the SOURCE OF TRUTH for
 * authored agents, modes, and custom instructions. Config-sourced agents/modes
 * take precedence over `.data`-defined ones (resolved config-first, store-
 * fallback), and the authored instructions are injected into the session's
 * system prompt. A minimal interface keeps the dependency one-way + stubbable.
 */
export interface BrokerProjectConfig {
  /** A config-sourced agent by id, or null when none is authored. */
  getAgent(id: string): AgentConfig | null;
  /** A config-sourced mode by id (mapped to the store shape), or null. */
  getMode(id: string): ModeConfig | null;
  /** The bounded, delimited system-prompt append for a project's authored
   *  instructions, or null when it has none (inject nothing). */
  buildInstructionsInjection(projectId: string): string | null;
  /** A project's config-sourced external MCP servers (name → config), or `{}`.
   *  Merged into the session's `Options.mcpServers` alongside `manager`. */
  getMcpServers(projectId: string): Record<string, McpServerConfig>;
  /** A project's config-sourced skills (from `.dispatch/skills/`), or `[]`.
   *  Materialized into the session cwd's `.claude/skills/` so the SDK finds them. */
  getSkills(projectId: string): SkillConfig[];
  /** A project's authored spawn-chat consent override, or null when it has none
   *  (then the app setting decides). Optional so older fakes stay valid. */
  getSpawnAutoApprove?(projectId: string): boolean | null;
}

export interface SessionBrokerOptions {
  store: Store;
  bus: EventBus;
  /** Max concurrently-active sessions (running + awaiting-input). Default 6. */
  maxActiveSessions?: number;
  /** Persistent-terminal service exposed to sessions as `mcp__manager__terminal`. */
  terminals?: TerminalService;
  /** Per-project agent memory: injected at start + exposed as `mcp__manager__remember|recall|forget`. */
  memory?: MemoryService;
  /** Git history of the memory dir: backs `mcp__manager__memory_history`. Optional —
   *  without it that one tool reports itself unavailable and the rest still work. */
  memoryHistory?: MemoryHistoryService;
  /** GitHub control plane: backs `mcp__manager__watch_pr`'s checks/threads/merge polls. */
  github?: GitHubService;
  /** SubApp runner: backs `mcp__manager__run_subapp` (launch apps + get a URL). */
  runner?: RunnerService;
  /** Worktrees: resolve/create a launch dir for run_subapp + list branches. */
  worktrees?: WorktreeService;
  /** Self-contained `.dispatch/` config: source of truth for authored
   *  agents/modes/instructions (config wins over `.data` on id collision). */
  projectConfig?: BrokerProjectConfig;
  /** Provider registry used by chats whose harness is not the legacy Claude path. */
  harnesses?: HarnessRegistry;
  /** HTTP front door for Dispatch's manager MCP tools (required by Codex). */
  managerMcp?: ManagerMcpBridge;
  /**
   * Called when a turn ends in ERROR, with the SDK's message. The broker doesn't
   * interpret it — the ResumeScheduler decides whether it was a usage limit and
   * schedules the chat to continue itself (see services/resume-scheduler.ts).
   */
  onTurnError?: (chatId: string, reason: string | undefined) => void;
  deps?: SessionBrokerDeps;
}

/** Steering priority forwarded to `SDKUserMessage.priority`. */
export type MessagePriority = "now" | "next" | "later";

/** Options for a single user/steering message. */
export interface SendOptions {
  priority?: MessagePriority;
  images?: ImageRef[];
  /** Per-message effort override (also updates the chat's effort going forward). */
  effort?: Effort;
  /**
   * Authorship breakdown for a COMPOSED message (a launched task's briefing plus
   * the human's own words). Callers build `text` and `parts` from the same parts
   * via `composeMessageText`, and the transcript renders these instead of one
   * undifferentiated wall attributed to the human.
   */
  parts?: MessagePart[];
}

/** Host answer to a `permission-request`. */
export interface PermissionResolution {
  decision: PermissionDecision; // "allow" | "deny"
  /** Replace the tool input on allow. */
  updatedInput?: Record<string, unknown>;
  /** Deny reason / allow note. */
  message?: string;
}

/** Read-only view of a session for callers/tests. */
export interface SessionView {
  chatId: string;
  projectId: string;
  status: ChatStatus;
  modeId: string;
  effort: Effort;
  agentId?: string;
  sessionId?: string;
  started: boolean;
  pendingPermissionIds: string[];
}

/* -------------------------------------------------------- mode / effort maps */

/** Built-in mode-id → SDK permissionMode fallback (used when no ModeConfig). */
export const BUILTIN_MODE_PERMISSION: Record<string, PermissionMode> = {
  default: "default",
  ask: "default",
  plan: "plan",
  edit: "acceptEdits",
  acceptEdits: "acceptEdits",
  auto: "auto",
  yolo: "bypassPermissions",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
  dontAsk: "dontAsk",
};

/**
 * LEGACY effort lever — a fixed thinking-token budget per level.
 *
 * Superseded by the SDK's first-class `effort` (see {@link buildOptions} and
 * {@link SessionBroker.pushEffort}): a budget pins one number for every model and
 * fights adaptive thinking, whereas `effort` is interpreted per model and is what
 * subagents/agent definitions also speak. Kept ONLY as the fallback for a runtime
 * whose `applyFlagSettings` control is missing or rejects the level, so a live
 * effort change still does something rather than silently no-op.
 */
export const EFFORT_THINKING_TOKENS: Record<Effort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 32_000,
  max: 60_000,
};

/** Effort → SDK ThinkingConfig (legacy fallback only — see above). */
export function effortToThinking(effort: Effort): Options["thinking"] {
  return { type: "enabled", budgetTokens: EFFORT_THINKING_TOKENS[effort] };
}

/** Thread key for the MAIN loop in the per-thread effort maps (subagents key by run id). */
const MAIN_THREAD = "__main__";

/** Widest thread-effort map we keep per session (FIFO-trimmed; see `noteToolThread`). */
const THREAD_MAP_CAP = 2_000;

/** Max time `stop()`/`dispose()` waits for a subprocess consume loop to unwind. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Tools whose call blocks the main agent on work happening elsewhere. Keeping
 * this as a real chat status (rather than a client-only color guess) makes the
 * blue waiting state survive reloads and server restarts.
 */
export function statusForTool(name: string, input?: Record<string, unknown>): ChatStatus {
  const normalized = name.toLowerCase().replace(/[.:/]/g, "_");
  const encodedInput = input ? safeHandoffJson(input).toLowerCase() : "";
  const terminal =
    normalized === "bash" ||
    normalized === "shell_command" ||
    normalized.endsWith("_shell_command") ||
    normalized.includes("manager__terminal") ||
    normalized === "functions_wait" ||
    (normalized === "functions_exec" &&
      (encodedInput.includes("mcp__manager__terminal") || encodedInput.includes("shell_command")));
  const subagent =
    normalized === "task" ||
    normalized === "agent" ||
    normalized.endsWith("_wait_agent") ||
    normalized.includes("collaboration_wait_agent");
  return terminal || subagent ? "waiting" : "running";
}

/* ------------------------------------------------------- internal helpers */

/** Parse `mcp__<server>__<tool>` → server id. */
function parseMcpServer(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i >= 0 ? rest.slice(0, i) : rest;
}

function safeHandoffJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * Tokens a single request occupies in the context window: its whole input side
 * (fresh + cache-read + cache-creation) plus the generated output. Reads one
 * assistant message's OWN `usage` (per-request, not the session-cumulative usage
 * on the result). Returns null when usage is absent/empty.
 */
function contextTokensOf(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const sum =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return sum > 0 ? sum : null;
}

/** Pick a file extension for a stored asset from its media type (inverse of
 *  {@link mediaTypeFromName}); defaults to `.png` for anything unrecognized. */
function extFromMediaType(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

/** Guess an image media type from a stored asset filename. */
function mediaTypeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  switch (dot >= 0 ? name.slice(dot).toLowerCase() : "") {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/** Best-effort "what is the tool acting on" for the working-state label. */
function deriveTarget(input: Record<string, unknown>): string | undefined {
  const fp = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof fp === "string") return fp;
  const cmd = input.command;
  if (typeof cmd === "string") return cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
  return undefined;
}

/**
 * Best-effort one-line summary of an AskUserQuestion payload for the triage
 * list. The tool input isn't schema-guaranteed, so probe the common shapes
 * (`{ questions: [{ question }] }` or a flat `{ question | prompt | header }`).
 */
function questionSummary(input: Record<string, unknown>): string {
  const first =
    Array.isArray(input.questions) && input.questions.length
      ? (input.questions[0] as Record<string, unknown>)
      : input;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const text =
    pick(first.question) ??
    pick(first.prompt) ??
    pick(first.header) ??
    pick(first.title) ??
    pick(input.question);
  if (!text) return "Claude has a question";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Tools that run their OWN human gate and must therefore not be prompted for at
 * the `canUseTool` layer as well (see {@link SessionBroker.handlePermission}).
 */
const SELF_GATED_TOOLS: ReadonlySet<string> = new Set([
  "mcp__manager__ask_user",
  "mcp__manager__spawn_chat",
]);

/** Shorten text for a prompt card, marking that it was cut. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One answer within a (possibly multi-question) AskUserQuestion response. */
interface QuestionAnswerOpt {
  questionIndex?: number;
  optionId?: string;
  answer?: string;
  /** Extra instructions typed alongside the choice (see {@link withNotes}). */
  notes?: string;
}

/**
 * Fold the user's notes INTO the chosen answer string.
 *
 * The CLI tool reads exactly one thing off `updatedInput` — the `answers` map of
 * question text → answer string (confirmed live; see spikes/ask-user-question.ts).
 * Anything else we merge onto the input is ignored, so a separate `notes` field
 * would be silently dropped and the user would watch the model act as though
 * they'd never typed it. Appending keeps notes on the one channel that reaches
 * the model.
 */
function withNotes(value: string, notes?: string): string {
  const n = pickStr(notes);
  return n ? `${value} — additional instructions: ${n}` : value;
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Resolve one answer's chosen value against its question's options. */
function resolveAnswerValue(
  question: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  opt: { optionId?: string; answer?: string },
): string | undefined {
  let value = pickStr(opt.answer);
  if (!value && opt.optionId) {
    const options =
      question && Array.isArray(question.options)
        ? question.options
        : Array.isArray(input.options)
          ? input.options
          : [];
    const match = options.find(
      (o): o is Record<string, unknown> =>
        !!o &&
        typeof o === "object" &&
        ((o as Record<string, unknown>).label === opt.optionId ||
          (o as Record<string, unknown>).id === opt.optionId),
    );
    value = pickStr(match?.label) ?? pickStr(opt.optionId);
  }
  return value;
}

function questionTextOf(
  question: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): string | undefined {
  return (
    pickStr(question?.question) ??
    pickStr(question?.prompt) ??
    pickStr(input.question) ??
    pickStr(question?.header)
  );
}

/**
 * Build the `updatedInput` that answers an AskUserQuestion tool call, plus a
 * human-readable summary for the persisted permission row.
 *
 * AskUserQuestion rides the `canUseTool` channel and the chosen answer is fed
 * back to the model as the tool's ALLOW result: the CLI tool reads
 * `input.answers` — a map of question text → chosen answer string — and, when
 * an entry is absent, hands the model "The user did not answer the questions."
 * (verified live against the bundled 0.3.199 CLI runtime). A single ask carries
 * one `questions[0]`; the model can also ask MANY at once (`questions[1..]`), so
 * we map EVERY answered question's text → its chosen value, keyed by index. The
 * client sends the human-readable label(s) as `answer` (comma-joined for
 * multi-select, or free text); `optionId` is a label fallback.
 */
function buildQuestionAnswer(
  input: Record<string, unknown>,
  opts: {
    optionId?: string;
    answer?: string;
    notes?: string;
    answers?: QuestionAnswerOpt[];
  },
): { updatedInput: Record<string, unknown>; message?: string } {
  const questions = Array.isArray(input.questions)
    ? (input.questions as Record<string, unknown>[])
    : null;

  // Normalize to a list of per-question answers. The single-question shape
  // (optionId/answer, no index) targets questions[0].
  const list: QuestionAnswerOpt[] =
    opts.answers && opts.answers.length
      ? opts.answers
      : [
          {
            questionIndex: 0,
            optionId: opts.optionId,
            answer: opts.answer,
            notes: opts.notes,
          },
        ];

  const answers: Record<string, string> = {};
  const summary: string[] = [];
  for (const a of list) {
    const q = questions ? questions[a.questionIndex ?? 0] : undefined;
    const key = questionTextOf(q, input);
    const value = resolveAnswerValue(q, input, a);
    if (key && value) {
      const withNote = withNotes(value, a.notes);
      answers[key] = withNote;
      const header = pickStr(q?.header);
      summary.push(header && list.length > 1 ? `${header}: ${withNote}` : withNote);
    }
  }

  return {
    updatedInput: { ...input, answers },
    message: summary.length ? summary.join(" · ") : undefined,
  };
}

/** Pull display text out of an SDKUserMessage (string content or text blocks). */
function extractUserText(msg: SDKUserMessage): string {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * An async-iterable input channel we push user messages into over time and
 * close when the session ends. Exactly the shape the SDK consumes as `prompt`.
 */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queued: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false });
    else this.queued.push(msg);
  }

  /** Buffered-but-not-yet-consumed count (used to detect chained turns). */
  pending(): number {
    return this.queued.length;
  }

  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((w = this.waiting.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queued.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>((res) => this.waiting.push(res));
      },
    };
  }
}

/**
 * What a memory lookup surfaced for one turn: the `<system-reminder>` block for
 * the model, plus which memories went in whole vs. as one-liners (that split is
 * what the transcript's context label reports). Derived from the service so the
 * two can't drift.
 */
type SurfacedMemory = NonNullable<Awaited<ReturnType<MemoryService["surfaceFor"]>>>;

interface OutboxItem {
  id: string;
  text: string;
  /** Original refs (persisted on the transcript row, kept small). */
  images?: ImageRef[];
  /** Pre-resolved SDK image sources (local asset files inlined as base64). */
  imageSources?: Record<string, unknown>[];
  /**
   * Auto-surfaced project-memory context (a `<system-reminder>` block) prepended
   * to the SDK message ONLY — never emitted on the visible transcript row. Set
   * when the turn's text matched relevant, not-yet-surfaced memories.
   */
  memoryContext?: string;
  priority: MessagePriority;
}

interface PendingPermission {
  resolve?: (r: PermissionResult) => void;
  /** Neutral adapter that owns this ask (Codex); absent for the Claude SDK. */
  harnessSession?: HarnessSession;
  questions?: HarnessQuestion[];
  toolName: string;
  input: Record<string, unknown>;
  request: PermissionRequest;
  attentionId: string;
  /** Manager ask_user inactivity window; native harness questions do not set one. */
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const questionTimeoutMessage = (timeoutMs: number): string =>
  `No answer was submitted within ${timeoutMs / 1_000} seconds of the last user activity.`;

interface LiveSession {
  chatId: string;
  projectId: string;
  project: Project | null;
  worktreeCwd?: string;
  modeId: string;
  agentId?: string;
  effort: Effort;
  harnessKind: HarnessKind;
  /**
   * Effort the session's own agent definition pins, when it pins one. The main
   * loop then runs at THIS level rather than `effort` (which stays the chat's
   * pick and the level every un-pinned subagent inherits).
   */
  agentEffort?: Effort;
  /**
   * OBSERVED effort per thread — `MAIN_THREAD` for the main loop, a subagent's
   * spawning Task tool_use id for a run. Reported by the PreToolUse observer hook
   * (see `observeEffortHook`), so it is the level the runtime actually applied,
   * after any silent downgrade for the model and after any effort an agent
   * definition pinned for itself. Absent until that thread runs its first tool.
   */
  effortByThread: Map<string, Effort>;
  /**
   * tool_use id → the thread that issued it (`MAIN_THREAD` or the spawning Task's
   * id). The hook only knows the tool call it is gating, so this is the thread
   * back from that to the run whose effort it just reported.
   */
  threadOfTool: Map<string, string>;
  /**
   * Where each thread is working on disk, and the guard that keeps a subagent
   * out of another task's worktree. Created on the first turn and kept for the
   * life of the session — a background subagent outlives the turn that spawned
   * it, which is precisely how the 2026-08-07 stray writes happened (see
   * `agent-cwd.ts`).
   */
  cwdTracker?: AgentCwdTracker;
  sessionId?: string;
  /**
   * The project's resolved workflow contract, plus what `buildOptions` learned
   * about where this session's cwd actually IS. Stamped once per turn (in
   * `buildOptions`) and read by the permission guard, so the rules injected into
   * the prompt and the rules enforced on tool calls can never disagree.
   */
  workflow?: ResolvedWorkflow;
  /** The protected trunk for this project (`defaultBranch`, default "main"). */
  trunk?: string;
  /** Branch at the session cwd, or null when detached / unknown. */
  branch?: string | null;
  /** True when the session cwd is a linked worktree rather than the checkout. */
  inWorktree?: boolean;
  /** Model the SDK reported for the live session (display only). */
  model?: string;
  /** Model explicitly chosen by the user (pins new/resumed queries via options.model). */
  modelOverride?: string;
  status: ChatStatus;
  /**
   * A `watch_pr` this turn reached a terminal PR state (merged/closed). Sticky
   * until the next user message resets it, so the chat's dot can read green
   * ("PR done") once the agent settles back to idle. Purely a display signal.
   */
  prWatchSettled?: boolean;
  started: boolean;
  input?: InputChannel;
  query?: Query;
  harnessSession?: HarnessSession;
  managerGrant?: ManagerMcpGrant;
  abortController?: AbortController;
  runLoop?: Promise<void>;
  outbox: OutboxItem[];
  pendingPermissions: Map<string, PendingPermission>;
  /**
   * Id shared by the in-flight MAIN-LOOP assistant message's token chunks AND
   * its finalized transcript row. Allocated when the message's stream begins
   * (`message_start` / first delta), consumed + cleared when its finalized
   * `assistant` row is emitted, so the client swaps the streaming buffer for
   * the persisted row in place (no duplicate).
   *
   * Deliberately main-loop-only: subagents run CONCURRENTLY (with the main loop
   * and each other) and their partials interleave, so sharing this single slot
   * with them would let a subagent `message_start` clobber the main loop's id
   * and orphan its buffer as a stuck ●●● StreamingRow. The stream_event handler
   * skips subagent partials, and subagent finalize never touches this slot.
   */
  streamAssistantId?: string;
  /**
   * Context-window occupancy (tokens) of the most recent MAIN-LOOP request this
   * turn — the last top-level assistant message's own `usage` (input + cache +
   * output), NOT the cumulative session usage on the result. Stamped onto the
   * `result` row so the composer's context meter reflects "how full is the
   * window right now", which is what auto-compaction watches.
   */
  lastContextTokens?: number;
  /**
   * The model's context-window size (tokens) for this session, learned from the
   * SDK's `getContextUsage()` control (`maxTokens`) at init and after a model
   * switch. Stamped onto each `result` row so the composer meter divides by the
   * correct window — the 1M variant reports 1M here, a 200k model reports 200k —
   * instead of a hardcoded constant. Undefined until the first refresh lands.
   */
  contextWindow?: number;
  /** Per-session serialized transcript write chain. */
  writeChain: Promise<void>;
  turn: number;
  idleAttentionId?: string;
  stopping: boolean;
  /** Teardown is a provider migration; settle quietly instead of as session done. */
  switching?: boolean;
  /** One-shot resume/fork config consumed at the next query start. */
  resumeSessionId?: string;
  forkAtUuid?: string;
  fork: boolean;
  /** Skill dirs materialized into `<cwd>/.claude/skills/` for this query (the
   *  ones WE created), removed on teardown so a repo-owned skill is never touched. */
  materializedSkillDirs?: string[];
  /**
   * Names of project memories already auto-surfaced into this session, so a
   * relevant memory is injected once (not re-pushed every matching turn). Reset
   * only with the session; the agent still has the memory in-context after.
   */
  surfacedMemories: Set<string>;
}

/* =============================================================== SessionBroker */

export class SessionBroker {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cap: number;
  private readonly terminals?: TerminalService;
  private readonly memory?: MemoryService;
  private readonly memoryHistory?: MemoryHistoryService;
  private readonly github?: GitHubService;
  private readonly runner?: RunnerService;
  private readonly worktrees?: WorktreeService;
  private readonly projectConfig?: BrokerProjectConfig;
  private readonly harnesses?: HarnessRegistry;
  private readonly managerMcp?: ManagerMcpBridge;
  /** Settable after construction — the scheduler is built after the broker. */
  onTurnError?: (chatId: string, reason: string | undefined) => void;
  /**
   * Hand a freshly-created PR to the review watcher. Settable after construction
   * for the same reason as `onTurnError`: the watcher is built after the broker.
   * Absent → `create_pr` says so out loud rather than implying it's watched.
   */
  armPrWatch?: (chatId: string, ref: PRRef) => void;
  /**
   * Create + start a chat on the agent's behalf, once the human has approved it
   * (see `mcp__manager__spawn_chat`). Settable after construction for the same
   * reason as `onTurnError`: creating a chat goes through the routes' `createChat`
   * / `ensureSession` pair, which needs the whole service container — and the
   * container is built around the broker, not before it. Absent → the tool isn't
   * offered at all, rather than offered and broken.
   */
  spawnChat?: (input: {
    request: SpawnChatRequest;
    project: SpawnChatTarget;
    /** The chat that asked, so the new one can be traced back to it. */
    parentChatId: string;
  }) => Promise<SpawnedChat>;
  private readonly query: QueryFn;
  private readonly genId: () => string;
  private readonly now: () => number;

  private readonly sessions = new Map<string, LiveSession>();
  /** FIFO of chatIds parked in `queued` waiting for an active slot. */
  private queueOrder: string[] = [];

  constructor(opts: SessionBrokerOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.cap = Math.max(1, opts.maxActiveSessions ?? 6);
    this.terminals = opts.terminals;
    this.memory = opts.memory;
    this.memoryHistory = opts.memoryHistory;
    this.github = opts.github;
    this.runner = opts.runner;
    this.worktrees = opts.worktrees;
    this.projectConfig = opts.projectConfig;
    this.harnesses = opts.harnesses;
    this.managerMcp = opts.managerMcp;
    this.onTurnError = opts.onTurnError;
    this.query = opts.deps?.query ?? (sdkQuery as unknown as QueryFn);
    this.genId = opts.deps?.genId ?? (() => nanoid());
    this.now = opts.deps?.now ?? (() => Date.now());
  }

  /* --------------------------------------------------------- public API */

  /** Register (lazily) a live session for a chat. Idempotent. */
  create(chat: Chat, project?: Project | null, worktreeCwd?: string): SessionView {
    let session = this.sessions.get(chat.id);
    if (!session) {
      session = {
        chatId: chat.id,
        projectId: chat.projectId,
        project: project ?? null,
        worktreeCwd,
        modeId: chat.modeId,
        agentId: chat.agentId,
        effort: chat.effort,
        harnessKind: chat.harness ?? DEFAULT_HARNESS,
        effortByThread: new Map(),
        threadOfTool: new Map(),
        sessionId: chat.sessionId,
        model: chat.model,
        modelOverride: chat.model,
        status:
          chat.status === "running" ||
          chat.status === "waiting" ||
          chat.status === "queued" ||
          chat.status === "awaiting-input"
            ? "error"
            : (chat.status ?? "idle"),
        // Rebuilt from the record, not carried over: a session created after a
        // restart has no memory of the merge that settled this chat, and without
        // this the green "PR done" dot silently downgraded to plain idle.
        prWatchSettled: isPrSettledIdle(chat) || undefined,
        started: false,
        outbox: [],
        pendingPermissions: new Map(),
        writeChain: Promise.resolve(),
        turn: 0,
        stopping: false,
        fork: false,
        surfacedMemories: new Set(),
      };
      this.sessions.set(chat.id, session);
    }
    return this.view(session);
  }

  /** Re-create a session pointing at the chat's persisted SDK session for resume. */
  resume(chat: Chat, project?: Project | null, worktreeCwd?: string): SessionView {
    this.create(chat, project, worktreeCwd);
    const session = this.sessions.get(chat.id)!;
    if (chat.sessionId) session.resumeSessionId = chat.sessionId;
    return this.view(session);
  }

  /**
   * Send a user message. Starts a turn if the session is idle (subject to the
   * active-session cap → `queued`); injects as steering if a turn is running.
   */
  async sendMessage(
    chatId: string,
    text: string,
    opts: SendOptions | MessagePriority = {},
  ): Promise<void> {
    const session = this.mustGet(chatId);
    const o: SendOptions = typeof opts === "string" ? { priority: opts } : opts;
    if (o.effort) this.applyEffort(session, o.effort);

    // A fresh user message supersedes any completed PR watch: the green "PR done"
    // dot resets so the chat reads as active again (the imminent turn flips it to
    // the pulsing running state). Persisted alongside the live flag so the reset
    // survives a reload too — otherwise a chat you'd already resumed past its
    // merge would go back to reading "PR done" the next time it rehydrated.
    session.prWatchSettled = false;
    const userMessageAt = this.now();
    session.writeChain = session.writeChain.catch(() => {}).then(async () => {
      try {
        await this.store.patchChat(chatId, { lastUserMessageAt: userMessageAt });
      } catch {
        /* best-effort: worst case the dot reads stale until the next write */
      }
    });

    // A message sent while a question is pending is an implicit decline: unblock
    // the AskUserQuestion(s) so this message can be consumed as the real reply.
    this.declinePendingQuestions(
      session,
      "The user dismissed this question and replied with a message instead.",
    );

    const steering = this.isActive(session);
    const id = this.genId();

    // Auto-surface the durable memories most relevant to THIS turn: a
    // <system-reminder> prepended to the SDK message, and a collapsed `context`
    // part on the transcript row so what was injected is auditable rather than
    // invisible. Once-per-session per memory, best-effort — a lookup failure
    // must never block the turn.
    //
    // Resolved BEFORE the row is emitted, because a row can't be patched after
    // the fact (transcripts are append-only). That costs the row a local memory
    // search's worth of latency; the alternative is a transcript that silently
    // omits context the model was given, which is the exact opacity this whole
    // parts mechanism exists to remove.
    const memory = await this.surfaceMemory(session, text);
    const parts = this.messageParts(text, o.parts, memory);

    await this.emit(session, {
      kind: "user",
      id,
      chatId,
      ts: this.now(),
      turn: session.turn,
      sessionId: session.sessionId,
      text,
      images: o.images,
      effort: session.effort,
      steering: steering || undefined,
      ...(parts ? { parts } : {}),
    });

    // Resolve any local asset images to inline SDK sources before queueing (the
    // transcript row above keeps the small relative refs; the SDK gets bytes).
    // No images → no extra await, so the text-only fast path is unchanged.
    const imageSources = o.images?.length
      ? await this.resolveImageSources(chatId, o.images)
      : undefined;

    this.resolveIdleAttention(session);
    session.outbox.push({
      id,
      text,
      images: o.images,
      imageSources,
      memoryContext: memory?.block,
      priority: o.priority ?? "next",
    });
    this.schedule(session);
  }

  /**
   * Rank this project's durable memories against a turn's text and return an
   * invisible `<system-reminder>` block for the SDK message when relevant,
   * not-yet-surfaced ones clear the bar. Records only the memories given IN FULL
   * (`names`) so each body pushes at most once per session; the pointer-tier ones
   * (`pointed`) stay eligible, so a memory first seen as a one-liner can still
   * arrive whole on a later turn that matches it strongly. Best-effort: any
   * failure (or no memory service / no project) yields undefined and the turn
   * proceeds normally.
   */
  private async surfaceMemory(
    session: LiveSession,
    text: string,
  ): Promise<SurfacedMemory | undefined> {
    if (!this.memory || !session.projectId || !text.trim()) return undefined;
    try {
      const surfaced = await this.memory.surfaceFor(session.projectId, text, {
        exclude: session.surfacedMemories,
      });
      if (!surfaced) return undefined;
      for (const name of surfaced.names) session.surfacedMemories.add(name);
      return surfaced;
    } catch {
      return undefined;
    }
  }

  /**
   * The authorship breakdown to persist on a user row, or undefined when there's
   * nothing to break down — a plain typed message with no injected context keeps
   * rendering exactly as it always has, and writes no extra bytes.
   *
   * Caller-supplied parts (a launched task's briefing) already satisfy
   * `composeMessageText(parts) === text`; the memory block is appended as a
   * `context` part, which composeMessageText would append to the text too. That
   * is deliberate: the block is NOT in `text` (it's prepended to the SDK message
   * separately, and only for the model), so it is marked `context` and the
   * renderer keeps it collapsed and out of the message body.
   */
  private messageParts(
    text: string,
    given: MessagePart[] | undefined,
    memory: SurfacedMemory | undefined,
  ): MessagePart[] | undefined {
    if (!memory) return given;
    const count = memory.names.length + memory.pointed.length;
    const detail = memory.names.length
      ? `${memory.names.length} in full`
      : "names only";
    return [
      ...(given ?? (text ? [{ kind: "text" as const, text }] : [])),
      {
        kind: "context",
        label: `${count} project ${count === 1 ? "memory" : "memories"} surfaced — ${detail}`,
        text: memory.block,
      },
    ];
  }

  /**
   * Turn each ImageRef into an SDK image source. `data:`/`http(s)` refs pass
   * straight through; a relative/local path is read from the chat's assets dir
   * and inlined as base64 (so an uploaded sprite is usable in send-message).
   */
  private async resolveImageSources(
    chatId: string,
    images?: ImageRef[],
  ): Promise<Record<string, unknown>[]> {
    if (!images?.length) return [];
    const out: Record<string, unknown>[] = [];
    for (const img of images) {
      const direct = this.imageSource(img);
      if (direct) {
        out.push(direct);
        continue;
      }
      try {
        const name = img.path.split(/[\\/]/).pop() ?? img.path;
        const buf = await this.store.readChatAsset(chatId, name);
        if (buf) {
          out.push({
            type: "base64",
            media_type: img.mimeType ?? mediaTypeFromName(name),
            data: buf.toString("base64"),
          });
        }
      } catch {
        /* unreadable asset → skip; the text still sends */
      }
    }
    return out;
  }

  /** Resolve only Store's portable `assets/<name>` refs; other relative paths belong to the harness cwd. */
  private resolveHarnessImages(chatId: string, images?: ImageRef[]): ImageRef[] | undefined {
    return images?.map((img) => {
      const match = /^assets[\\/]([^\\/]+)$/.exec(img.path);
      const name = match?.[1];
      return !name || name === "." || name === ".."
        ? img
        : { ...img, path: join(this.store.chatAssetsDir(chatId), name) };
    });
  }

  /** Answer a permission request; resolves the blocked `canUseTool` promise. */
  resolvePermission(requestId: string, resolution: PermissionResolution): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingPermissions.get(requestId);
      if (!pending) continue;
      session.pendingPermissions.delete(requestId);
      if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);

      if (pending.harnessSession) {
        pending.harnessSession.resolvePermission(requestId, resolution);
      } else {
        const result: PermissionResult =
          resolution.decision === "allow"
            ? { behavior: "allow", updatedInput: resolution.updatedInput ?? pending.input }
            : { behavior: "deny", message: resolution.message ?? "Denied by user." };
        pending.resolve?.(result);
      }

      this.recordResolvedPermission(
        session,
        requestId,
        pending,
        resolution.decision,
        resolution.message,
      );
      return true;
    }
    return false;
  }

  private recordResolvedPermission(
    session: LiveSession,
    requestId: string,
    pending: PendingPermission,
    decision: PermissionDecision,
    message?: string,
  ): void {
      void this.emit(session, {
        kind: "permission",
        id: this.genId(),
        chatId: session.chatId,
        ts: this.now(),
        sessionId: session.sessionId,
        requestId,
        toolName: pending.toolName,
        input: pending.input,
        decision,
        displayName: pending.request.displayName,
        title: pending.request.title,
        description: pending.request.description,
        message,
      });
      this.bus.publish({
        type: "permission-resolved",
        chatId: session.chatId,
        requestId,
        decision,
      });
      this.bus.publish({
        type: "attention-resolve",
        id: pending.attentionId,
        chatId: session.chatId,
      });

      if (session.pendingPermissions.size === 0 && session.status === "awaiting-input") {
        this.setStatus(session, "running", {
          state: decision === "allow" ? "tool" : "responding",
        });
      }
  }

  /**
   * Answer an AskUserQuestion prompt. AskUserQuestion arrives over the same
   * `canUseTool` channel as a permission, but the answer must ride back as the
   * tool's ALLOW result with an `answers` map merged onto the original input
   * (see {@link buildQuestionAnswer}) — otherwise the CLI tool reports the
   * question as unanswered and the model can't act on the choice. Returns false
   * if no pending request matches `requestId`.
   */
  answerQuestion(
    requestId: string,
    answer: {
      optionId?: string;
      answer?: string;
      notes?: string;
      answers?: {
        questionIndex: number;
        optionId?: string;
        answer?: string;
        notes?: string;
      }[];
    },
  ): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingPermissions.get(requestId);
      if (!pending) continue;
      if (pending.harnessSession && pending.questions) {
        const submitted = answer.answers?.length
          ? answer.answers
          : [{ questionIndex: 0, optionId: answer.optionId, answer: answer.answer, notes: answer.notes }];
        const answers: HarnessQuestionAnswer[] = submitted.flatMap((item) => {
          const question = pending.questions?.[item.questionIndex];
          const selected = item.answer ?? item.optionId;
          const values =
            question?.multiSelect && item.answer
              ? item.answer.split(",").map((value) => value.trim()).filter(Boolean)
              : selected
                ? [selected]
                : [];
          return question && values.length
            ? [{ questionId: question.id, selected: values, notes: item.notes }]
            : [];
        });
        session.pendingPermissions.delete(requestId);
        pending.harnessSession.resolveQuestion(requestId, answers);
        this.recordResolvedPermission(session, requestId, pending, "allow", answer.answer);
        return true;
      }
      const { updatedInput, message } = buildQuestionAnswer(pending.input, answer);
      return this.resolvePermission(requestId, {
        decision: "allow",
        updatedInput,
        message: message ?? answer.answer,
      });
    }
    return false;
  }

  /** Reset a manager ask_user inactivity timeout after a card interaction. */
  touchQuestion(chatId: string, requestId: string): boolean {
    const session = this.sessions.get(chatId);
    const pending = session?.pendingPermissions.get(requestId);
    if (!session || !pending || pending.toolName !== "AskUserQuestion") return false;
    this.armQuestionTimeout(session, requestId, pending);
    return true;
  }

  /**
   * Decline an AskUserQuestion without answering. Resolves the pending request
   * as a DENY so the CLI tool reports it declined and the model continues on its
   * own judgement, rather than acting on a fabricated selection. Returns false if
   * no pending request matches `requestId`.
   */
  declineQuestion(requestId: string, message?: string): boolean {
    for (const session of this.sessions.values()) {
      if (!session.pendingPermissions.has(requestId)) continue;
      return this.resolvePermission(requestId, {
        decision: "deny",
        message: message ?? "The user declined to answer this question.",
      });
    }
    return false;
  }

  /**
   * Implicitly decline every pending AskUserQuestion on this session. A new user
   * message is itself a form of declining: the blocked question(s) must resolve
   * for the turn to consume the message, and answering-by-message would be a lie.
   * Non-question permission gates are left untouched.
   */
  private declinePendingQuestions(session: LiveSession, message: string): void {
    for (const [requestId, p] of session.pendingPermissions) {
      if (p.toolName !== "AskUserQuestion") continue;
      this.resolvePermission(requestId, { decision: "deny", message });
    }
  }

  /** Interrupt the running turn (streaming-input only). */
  async interrupt(chatId: string): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session?.query && !session?.harnessSession) return false;
    try {
      await (session.harnessSession?.interrupt() ?? session.query!.interrupt());
      // Interrupting abandons any tool blocked on a permission answer; clear the
      // pending prompts (+ their cards / attention items) so they don't strand.
      this.drainPendingPermissions(session, "Interrupted.");
      this.bus.publish({ type: "notice", chatId, level: "info", text: "Interrupted." });
      return true;
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "interrupt failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Switch the chat's mode; applies live via `setPermissionMode` if running. */
  async setMode(chatId: string, modeId: string): Promise<PermissionMode> {
    const session = this.mustGet(chatId);
    session.modeId = modeId;
    const mode = await this.resolvePermissionMode(modeId);
    if (session.harnessSession) {
      await session.harnessSession.setPermissionMode(mode).catch((err) => {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setMode failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (session.query) {
      try {
        await session.query.setPermissionMode(mode);
      } catch (err) {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setMode failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void this.patchChat(chatId, { modeId });
    return mode;
  }

  /** Set reasoning effort; applies live via the flag-settings layer if running. */
  async setEffort(chatId: string, effort: Effort): Promise<void> {
    const session = this.mustGet(chatId);
    this.applyEffort(session, effort);
    if (session.harnessSession) {
      void session.harnessSession.setEffort(effort).catch((err) => {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setEffort failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }
    void this.patchChat(chatId, { effort });
  }

  /** Switch the active agent (applies to the next turn / restart). */
  async setAgent(chatId: string, agentId: string | null): Promise<void> {
    const session = this.mustGet(chatId);
    session.agentId = agentId ?? undefined;
    void this.patchChat(chatId, { agentId: agentId ?? undefined });
  }

  /**
   * Switch the model backing the chat. Applies live via `Query.setModel` when a
   * turn is running, pins new/resumed queries via `options.model`, and persists
   * `chat.model` (emitting `chat-update`). Passing an empty string clears the
   * override, reverting to the SDK/subscription default on the next query.
   */
  async setModel(chatId: string, model: string): Promise<void> {
    const session = this.mustGet(chatId);
    const next = model.trim() || undefined;
    session.modelOverride = next;
    session.model = next; // reflect the choice on subsequent transcript rows
    if (session.harnessSession && next) {
      await session.harnessSession.setModel(next).catch((err) => {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setModel failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (session.query) {
      try {
        await session.query.setModel(next);
      } catch (err) {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setModel failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void this.patchChat(chatId, { model: next });
    // A model switch can change the context window (e.g. 200k ↔ 1M variant);
    // relearn it so the meter's denominator follows the new model.
    if (session.query) void this.refreshContextWindow(session);
  }

  /**
   * Move a Dispatch chat to another runtime. Native session ids cannot cross
   * providers, so the new provider starts a fresh native session and receives a
   * bounded, provider-neutral transcript handoff on its first turn.
   */
  async setHarness(chatId: string, harness: HarnessKind): Promise<void> {
    const chat = await this.store.getChat(chatId);
    if (!chat) throw new Error(`chat "${chatId}" not found`);
    const previous = chat.harness ?? DEFAULT_HARNESS;
    if (previous === harness) return;

    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.switching = true;
      await this.stop(chatId);
      this.sessions.delete(chatId);
    }

    const settings = await this.store.getSettings().catch(() => undefined);
    const defaults = settings?.harness?.defaults?.[harness];
    const updated: Chat = {
      ...chat,
      harness,
      harnessHandoff: { from: previous, to: harness, at: this.now() },
      sessionId: undefined,
      agentId: this.harnesses?.find(harness)?.capabilities.subagents
        ? chat.agentId
        : undefined,
      model: defaults?.model,
      effort: defaults?.effort ?? chat.effort,
      status: "idle",
      updatedAt: this.now(),
    };
    const saved = await this.store.saveChat(updated);
    const project = await this.store.getProject(saved.projectId).catch(() => null);
    this.create(saved, project, saved.worktrees[0]);
    this.bus.publish({ type: "chat-update", chat: saved });
    this.bus.publish({
      type: "notice",
      chatId,
      level: "info",
      text: `Switched from ${previous} to ${harness}. The next turn will receive a transcript handoff.`,
    });
  }

  /**
   * The live context-window breakdown for a chat — the SDK's `getContextUsage()`
   * control: total/max tokens, percentage, model, and per-category token counts
   * (system prompt, tools, MCP tools, memory files, messages…). Powers the meter
   * dropup's detail view. Returns null when the session isn't live (never started
   * this process, or torn down) or the SDK build predates the control.
   */
  async getContextUsage(chatId: string): Promise<ContextUsage | null> {
    const session = this.sessions.get(chatId);
    if (session?.harnessSession) {
      const maxTokens = await session.harnessSession.contextWindow().catch(() => undefined);
      if (maxTokens) session.contextWindow = maxTokens;
      return maxTokens
        ? ({ totalTokens: session.lastContextTokens ?? 0, maxTokens } as ContextUsage)
        : null;
    }
    const q = session?.query;
    if (!q?.getContextUsage) return null;
    try {
      const u = await q.getContextUsage();
      // Cache the window off this fresh read so idle meters stay correct too.
      if (session && typeof u.maxTokens === "number") session.contextWindow = u.maxTokens;
      return u as ContextUsage;
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "context usage query failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Compact the session's context in place via the SDK's native `/compact`
   * command (summarize-and-continue, keeping the session id). Runs as a turn on
   * the existing subprocess; a notice marks it in the transcript. No-op guard is
   * unnecessary — an empty context compacts to nothing harmlessly.
   */
  compact(chatId: string): void {
    const session = this.mustGet(chatId);
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId,
      ts: this.now(),
      sessionId: session.sessionId,
      level: "info",
      text: "Compacting context…",
    });
    if (session.harnessSession) void session.harnessSession.compact();
    else {
      session.outbox.push({ id: this.genId(), text: "/compact", priority: "next" });
      this.schedule(session);
    }
  }

  /**
   * Record that a `watch_pr` on this chat reached a terminal PR state. Sets the
   * sticky display flag so the chat's dot turns green ("PR done") the moment the
   * agent settles back to idle; a new user message (or fork/clear) clears it.
   */
  markPrWatched(chatId: string, pr?: { number: number; state: "merged" | "closed" }): void {
    const session = this.sessions.get(chatId);
    if (session) session.prWatchSettled = true;
    // The in-memory flag above only lives as long as the session does — it used
    // to be the ONLY record, so a server restart (or just a page reload, which
    // rehydrates from the store) dropped a landed chat back to a neutral gray
    // dot. Stamp the PR ref too, so `isPrSettledIdle` can rebuild the state.
    if (pr) void this.persistPrSettled(chatId, pr);
  }

  /** Record a terminal PR state + when we saw it on the chat's matching ref. */
  private async persistPrSettled(
    chatId: string,
    pr: { number: number; state: "merged" | "closed" },
  ): Promise<void> {
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat?.prs?.some((p) => p.number === pr.number)) return;
      const prs = chat.prs.map((p) =>
        p.number === pr.number ? { ...p, state: pr.state, settledAt: this.now() } : p,
      );
      // patchChat, not saveChat: settling a PR is bookkeeping, not conversational
      // activity, so it must not bump the chat up the sidebar's recency sort.
      const saved = await this.store.patchChat(chatId, { prs });
      if (saved) this.bus.publish({ type: "chat-update", chat: saved });
    } catch {
      /* best-effort: the live flag still carries the dot for this session */
    }
  }

  /**
   * Clear the model's context via the SDK's native `/clear` command — starts the
   * next turn fresh. The persisted transcript (messages.jsonl) is intentionally
   * left intact; only the model's working context is reset. A notice records it.
   */
  clearContext(chatId: string): void {
    const session = this.mustGet(chatId);
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId,
      ts: this.now(),
      sessionId: session.sessionId,
      level: "info",
      text: "Cleared the model's context (transcript kept).",
    });
    if (session.harnessSession) {
      // Codex has native compaction but no in-thread `/clear`: retire the native
      // thread and let the next user message create a fresh one. Dispatch's
      // transcript remains the durable conversation record.
      const live = session.harnessSession;
      session.switching = true;
      session.harnessSession = undefined;
      session.started = false;
      session.sessionId = undefined;
      session.managerGrant?.revoke();
      session.managerGrant = undefined;
      void live.dispose();
      void this.patchChat(chatId, { sessionId: undefined });
      this.onTurnEnd(session);
    } else {
      session.outbox.push({ id: this.genId(), text: "/clear", priority: "next" });
      this.schedule(session);
    }
  }

  /**
   * Learn the model's context-window size from the SDK and cache it on the
   * session so subsequent `result` rows carry the right denominator. Fire-and-
   * forget: any failure (no live query, older SDK, transport hiccup) leaves the
   * last known window in place and never disrupts a turn.
   */
  private async refreshContextWindow(session: LiveSession): Promise<void> {
    const q = session.query;
    if (!q?.getContextUsage) return;
    try {
      const u = await q.getContextUsage();
      if (typeof u.maxTokens === "number" && u.maxTokens > 0) {
        session.contextWindow = u.maxTokens;
      }
    } catch {
      /* best-effort — keep whatever window we already had */
    }
  }

  /** Stop the live subprocess (tree-kill via abort) but keep the chat record. */
  async stop(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;
    // Already terminal — nothing to tear down. Never re-run onDone (that would
    // emit a duplicate "Session ended" attention item, e.g. from dispose()).
    if (session.status === "done" || session.status === "error") {
      this.queueOrder = this.queueOrder.filter((x) => x !== chatId);
      return;
    }
    this.drainPendingPermissions(session, "Session stopped.");
    session.outbox = [];
    this.queueOrder = this.queueOrder.filter((x) => x !== chatId);

    if (session.started && session.harnessSession) {
      session.stopping = true;
      try {
        await session.harnessSession.dispose();
      } catch {
        /* ignore */
      }
      await this.awaitLoop(session.runLoop, STOP_TIMEOUT_MS);
      session.managerGrant?.revoke();
      session.managerGrant = undefined;
    } else if (session.started && session.input) {
      session.stopping = true;
      try {
        session.input.close();
      } catch {
        /* ignore */
      }
      try {
        session.abortController?.abort();
      } catch {
        /* ignore */
      }
      // Wait for the consume loop to unwind so onDone fires (status/attention
      // events settle) BEFORE we return — dispose() then never clears the map
      // while a subprocess is still emitting against a removed session.
      await this.awaitLoop(session.runLoop, STOP_TIMEOUT_MS);
    } else {
      this.onDone(session);
    }
  }

  /**
   * Fork the SDK session at a past message uuid (rollback). Ends the current
   * live query if any and arms a forked start for the next `sendMessage`.
   */
  async fork(chatId: string, atMessageUuid: string): Promise<SessionView | null> {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    // Abandon any in-flight permission prompt (+ its card / attention item); the
    // forked turn starts fresh, so a stranded "allow?" would never resolve.
    this.drainPendingPermissions(session, "Session forked.");
    if (session.started && session.harnessSession) {
      session.stopping = true;
      await session.harnessSession.dispose().catch(() => {});
      await this.awaitLoop(session.runLoop, STOP_TIMEOUT_MS);
      session.managerGrant?.revoke();
      session.managerGrant = undefined;
    } else if (session.started && session.input) {
      session.stopping = true;
      try {
        session.input.close();
      } catch {
        /* ignore */
      }
      try {
        session.abortController?.abort();
      } catch {
        /* ignore */
      }
    }
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    session.resumeSessionId = session.sessionId;
    session.forkAtUuid = atMessageUuid;
    session.fork = true;
    this.setStatus(session, "idle", { state: "idle" });
    return this.view(session);
  }

  /**
   * Forget a session entirely (the chat was DELETED). Unlike `stop()` — which
   * tears the subprocess down but keeps the entry so a worktree rebind / resume
   * can reuse it — `drop()` removes it from the map so a create→delete cycle
   * can't leak `LiveSession` objects. Call AFTER `stop()` has settled.
   */
  drop(chatId: string): boolean {
    this.queueOrder = this.queueOrder.filter((x) => x !== chatId);
    // Tear down the chat's persistent shells alongside its session — a deleted
    // chat must not leak live powershell processes.
    this.terminals?.killChat(chatId);
    return this.sessions.delete(chatId);
  }

  /* ------------------------------------------------------ introspection */

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  getStatus(chatId: string): ChatStatus | undefined {
    return this.sessions.get(chatId)?.status;
  }

  getSession(chatId: string): SessionView | undefined {
    const s = this.sessions.get(chatId);
    return s ? this.view(s) : undefined;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  /**
   * Every still-open permission request across all live sessions. A permission
   * card is synthesized client-side from the transient `permission-request`
   * event and is only persisted once resolved, so a (re)connecting client
   * re-materializes its open cards from this snapshot — otherwise a reconnect
   * mid-tool leaves a badge whose card is gone and the tool unanswerable.
   */
  pendingPermissionSnapshot(): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const session of this.sessions.values()) {
      for (const p of session.pendingPermissions.values()) out.push(p.request);
    }
    return out;
  }

  /** Count of sessions holding an active slot (running or awaiting-input). */
  activeCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (this.isActive(s)) n += 1;
    return n;
  }

  /** Resolve when a chat reaches `status` via a future event (test helper). */
  waitFor(chatId: string, status: ChatStatus, timeoutMs = 2_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const off = this.bus.on("chat-status", (e) => {
        if (e.chatId === chatId && e.status === status) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${chatId} → ${status}`));
      }, timeoutMs);
    });
  }

  /** Tear down every session (process teardown). */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
    // `setStatus(done)` is deliberately non-blocking during ordinary event
    // handling. Teardown is the one place it must be durable before exit, or a
    // graceful Dispatch restart can resurrect the preceding running color.
    await Promise.all(
      [...this.sessions.values()].map((session) => session.writeChain.catch(() => {})),
    );
    this.sessions.clear();
    this.queueOrder = [];
  }

  /* -------------------------------------------------------- scheduling */

  private isActive(s: LiveSession): boolean {
    return s.status === "running" || s.status === "waiting" || s.status === "awaiting-input";
  }

  private schedule(session: LiveSession): void {
    // A turn is already active → inject the buffered message(s) as steering.
    if (session.started && this.isActive(session)) {
      this.flushOutbox(session);
      // Re-publish the current status so the client's "N queued" chip reflects the
      // just-injected message immediately (it decrements again as the SDK consumes).
      this.setStatus(session, session.status);
      return;
    }
    // Otherwise this message must START a turn → needs a free active slot.
    if (this.activeCount() < this.cap) {
      this.startTurn(session);
    } else {
      if (!this.queueOrder.includes(session.chatId)) this.queueOrder.push(session.chatId);
      this.setStatus(session, "queued");
    }
  }

  private startTurn(session: LiveSession): void {
    this.queueOrder = this.queueOrder.filter((id) => id !== session.chatId);
    if (!session.started) {
      // Lazy-start the SDK subprocess. Sets input/started synchronously before
      // its first await, so concurrent steering pushes land safely.
      void this.startQuery(session);
    } else {
      // Alive but idle → begin a fresh turn on the existing subprocess.
      this.flushOutbox(session);
    }
    this.setStatus(session, "running", { state: "thinking", label: "thinking…" });
  }

  private async startQuery(session: LiveSession): Promise<void> {
    if (!(await this.withinOverallContextBudget(session))) return;
    if (session.harnessKind !== "claude") {
      await this.startHarnessSession(session);
      return;
    }
    session.input = new InputChannel();
    session.abortController = new AbortController();
    session.started = true;
    let options: Options;
    try {
      options = await this.buildOptions(session);
    } catch (err) {
      this.onError(session, err);
      return;
    }
    // Consume one-shot resume/fork config.
    session.resumeSessionId = undefined;
    session.forkAtUuid = undefined;
    session.fork = false;

    try {
      session.query = this.query({ prompt: session.input, options });
    } catch (err) {
      this.onError(session, err);
      return;
    }
    this.flushOutbox(session);
    session.runLoop = this.consume(session);
  }

  private flushOutbox(session: LiveSession): void {
    if (session.harnessSession) {
      for (const item of session.outbox) {
        session.harnessSession.send({
          text: item.memoryContext ? `${item.memoryContext}\n\n${item.text}` : item.text,
          images: this.resolveHarnessImages(session.chatId, item.images),
          priority: item.priority,
          effort: session.effort,
        });
      }
      session.outbox = [];
      return;
    }
    if (!session.input) return;
    for (const item of session.outbox) session.input.push(this.toSdkUserMessage(item));
    session.outbox = [];
  }

  /** Start a non-legacy provider through the neutral harness seam. */
  private async startHarnessSession(session: LiveSession): Promise<void> {
    if (!this.harnesses) {
      this.onError(session, new Error("Harness registry is not configured."));
      return;
    }
    session.abortController = new AbortController();
    session.started = true;

    try {
      // Reuse the policy/config assembly that has years of Claude-specific edge
      // cases, then project only its neutral pieces into the provider adapter.
      const options = await this.buildOptions(session);
      const resolved = this.harnesses.resolve(session.harnessKind);
      if (resolved.fellBack) {
        this.bus.publish({
          type: "notice",
          chatId: session.chatId,
          level: "warn",
          text: `${session.harnessKind} is unavailable; using ${resolved.harness.kind}.`,
        });
        session.harnessKind = resolved.harness.kind;
        void this.patchChat(session.chatId, { harness: resolved.harness.kind });
      }

      const allMcp = (options.mcpServers ?? {}) as Record<string, unknown>;
      const managerConfig = allMcp.manager;
      const mcpServers = Object.fromEntries(
        Object.entries(allMcp).filter(([name]) => name !== "manager"),
      ) as Record<string, McpServerConfig>;

      let managerMcp: HarnessSessionSpec["managerMcp"];
      if (resolved.harness.capabilities.managerTransport === "in-process" && managerConfig) {
        managerMcp = { transport: "in-process", server: managerConfig };
      } else if (resolved.harness.capabilities.managerTransport === "http") {
        const context = managerMcpContextOf(managerConfig);
        if (context && this.managerMcp) {
          session.managerGrant?.revoke();
          const grant = this.managerMcp.mint(session.chatId, () => context);
          session.managerGrant = grant;
          managerMcp = {
            transport: "http",
            url: grant.url,
            token: grant.token,
            tokenEnvVar: grant.tokenEnvVar,
          };
        }
      }

      const prompt = options.systemPrompt as { append?: string } | undefined;
      const selectedAgent = options.agent ? options.agents?.[options.agent] : undefined;
      const appSettings = await this.store.getSettings().catch(() => undefined);
      const contextTokenLimit = appSettings?.harness?.contextLimits?.perChatTokens;
      const spec: HarnessSessionSpec = {
        cwd: options.cwd,
        permissionMode: options.permissionMode ?? "default",
        effort: session.effort,
        model: session.modelOverride,
        systemPromptAppends: prompt?.append ? [prompt.append] : [],
        agent: selectedAgent
          ? {
              id: options.agent!,
              description: selectedAgent.description,
              prompt: selectedAgent.prompt,
              tools: selectedAgent.tools,
              disallowedTools: selectedAgent.disallowedTools,
              model: selectedAgent.model,
              permissionMode: selectedAgent.permissionMode,
              effort: selectedAgent.effort as Effort | undefined,
            }
          : undefined,
        mcpServers,
        managerMcp,
        skills: (session.materializedSkillDirs ?? []).map((dir) => ({
          dir,
          name: dir.split(/[\\/]/).pop() ?? dir,
        })),
        resumeSessionId: session.resumeSessionId,
        forkAtId: session.forkAtUuid,
        fork: session.fork,
        autoCompact: appSettings?.autoCompact?.enabled ?? true,
        autoCompactWindow: appSettings?.autoCompact?.window,
        contextTokenLimit,
        abortSignal: session.abortController.signal,
        toolGuard: (toolName, input) => {
          if (toolName !== "Bash" || session.workflow?.guard === "off") return null;
          const command = typeof input.command === "string" ? input.command : "";
          const violation = classifyWorkflowViolation(command, {
            defaultBranch: session.trunk ?? "main",
            currentBranch: session.branch ?? null,
            inWorktree: Boolean(session.inWorktree),
            autoMerge: session.workflow?.autoMerge === "on-green",
            requirePr: Boolean(session.workflow?.requirePr),
          });
          if (!violation) return null;
          const blocked = session.workflow?.guard === "deny";
          this.bus.publish({
            type: "notice",
            chatId: session.chatId,
            level: blocked ? "warn" : "info",
            text: `${blocked ? "Blocked" : "Workflow warning"}: ${violation.reason}`,
          });
          return blocked ? violation.reason : null;
        },
      };

      session.harnessSession = resolved.harness.createSession(spec);
      session.resumeSessionId = undefined;
      session.forkAtUuid = undefined;
      session.fork = false;
      this.flushOutbox(session);
      session.runLoop = this.consumeHarness(session);
    } catch (err) {
      session.managerGrant?.revoke();
      session.managerGrant = undefined;
      this.onError(session, err);
    }
  }

  private pump(): void {
    while (this.activeCount() < this.cap && this.queueOrder.length > 0) {
      const id = this.queueOrder[0]!;
      const session = this.sessions.get(id);
      if (!session || session.status !== "queued") {
        this.queueOrder.shift();
        continue;
      }
      this.queueOrder.shift();
      this.startTurn(session);
    }
  }

  /**
   * Keep concurrently-running chats inside the app-level aggregate context
   * budget. Idle chats retain their native sessions but do not consume an active
   * execution slot; queued work is retried whenever another turn settles.
   */
  private async withinOverallContextBudget(session: LiveSession): Promise<boolean> {
    const settings = await this.store.getSettings().catch(() => undefined);
    const limit = settings?.harness?.contextLimits?.overallTokens;
    if (!limit) return true;
    const perChatLimit = settings?.harness?.contextLimits?.perChatTokens;
    const active = [...this.sessions.values()]
      .filter((candidate) => candidate.chatId !== session.chatId && this.isActive(candidate))
      .reduce(
        (sum, candidate) =>
          sum + (candidate.lastContextTokens ?? candidate.contextWindow ?? perChatLimit ?? 200_000),
        0,
      );
    if (active < limit) return true;
    session.started = false;
    if (!this.queueOrder.includes(session.chatId)) this.queueOrder.push(session.chatId);
    this.setStatus(session, "queued");
    this.bus.publish({
      type: "notice",
      chatId: session.chatId,
      level: "info",
      text: `Waiting for context budget (${active.toLocaleString()} / ${limit.toLocaleString()} tokens in active chats).`,
    });
    return false;
  }

  /* ---------------------------------------------------------- consume */

  private async consumeHarness(session: LiveSession): Promise<void> {
    const live = session.harnessSession;
    if (!live) return;
    try {
      for await (const event of live.events) await this.handleHarnessEvent(session, event);
      this.onDone(session);
    } catch (err) {
      this.onError(session, err);
    }
  }

  /** Neutral provider events → Dispatch's persisted transcript and live wire. */
  private async handleHarnessEvent(session: LiveSession, event: HarnessEvent): Promise<void> {
    const base = {
      id: this.genId(),
      chatId: session.chatId,
      ts: this.now(),
      turn: session.turn,
      sessionId: session.sessionId,
    };
    switch (event.type) {
      case "init":
        session.sessionId = event.sessionId;
        session.model = event.model ?? session.model;
        session.contextWindow = event.contextWindow ?? session.contextWindow;
        await this.patchChat(session.chatId, {
          sessionId: event.sessionId,
          model: session.model,
          harness: session.harnessKind,
          harnessHandoff: undefined,
        });
        await this.emit(session, {
          ...base,
          sessionId: event.sessionId,
          kind: "system",
          subtype: "init",
          data: {
            harness: session.harnessKind,
            model: event.model,
            permissionMode: event.permissionMode,
            tools: event.tools,
            mcpServers: event.mcpServers,
          },
        });
        return;
      case "delta":
        session.streamAssistantId = event.id;
        this.bus.publish({
          type: "message-chunk",
          chatId: session.chatId,
          messageId: event.id,
          delta: event.delta,
          channel: event.channel,
        });
        return;
      case "assistant":
        session.streamAssistantId = undefined;
        this.setStatus(session, "running", { state: "responding", label: "responding" });
        await this.emit(session, {
          ...base,
          id: event.id,
          kind: "assistant",
          text: event.text,
          thinking: event.thinking,
          model: event.model ?? session.model,
          uuid: event.uuid,
          parentToolUseId: event.parentToolUseId,
          subagentType: event.subagentType,
          effort: event.effort ?? session.effort,
        });
        return;
      case "tool-use": {
        const toolStatus = statusForTool(event.name, event.input);
        this.setStatus(session, toolStatus, {
          state: "tool",
          label: `${toolStatus === "waiting" ? "waiting on" : "running"} ${event.name}`,
          toolName: event.name,
          target: deriveTarget(event.input),
        });
        await this.emit(session, {
          ...base,
          kind: "tool_use",
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          server: event.server ?? parseMcpServer(event.name),
          parentToolUseId: event.parentToolUseId,
          subagentType: event.subagentType,
          effort: event.effort ?? session.effort,
          uuid: event.uuid,
        });
        return;
      }
      case "tool-result": {
        const persisted = await this.persistContentImages(session, event.content);
        await this.emit(session, {
          ...base,
          kind: "tool_result",
          toolUseId: event.toolUseId,
          ok: event.ok,
          isError: event.ok ? undefined : true,
          content: persisted.content,
          images: persisted.images.length ? persisted.images : undefined,
          parentToolUseId: event.parentToolUseId,
          subagentType: event.subagentType,
        });
        this.setStatus(session, "running", { state: "thinking", label: "thinking." });
        return;
      }
      case "permission-request":
        this.registerHarnessPermission(session, event.requestId, event.toolName, event.input, {
          description: event.reason,
        });
        return;
      case "question-request": {
        const input = {
          questions: event.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            multiSelect: q.multiSelect,
            allowOther: q.allowOther,
            options: q.options.map((o) => ({ id: o.label, ...o })),
          })),
        };
        this.registerHarnessPermission(
          session,
          event.requestId,
          "AskUserQuestion",
          input,
          {},
          event.questions,
        );
        return;
      }
      case "task-notification":
        await this.emit(session, {
          ...base,
          kind: "task_status",
          taskId: event.taskId,
          toolUseId: event.toolUseId,
          status: event.status,
          summary: event.summary,
          totalTokens: event.totalTokens,
          toolUses: event.toolUses,
          durationMs: event.durationMs,
        });
        return;
      case "usage":
        session.lastContextTokens = event.contextTokens ?? session.lastContextTokens;
        session.contextWindow = event.contextWindow ?? session.contextWindow;
        return;
      case "notice":
        this.bus.publish({
          type: "notice",
          chatId: session.chatId,
          level: event.level,
          text: event.text,
        });
        await this.emit(session, { ...base, kind: "notice", level: event.level, text: event.text });
        return;
      case "compacted":
        await this.emit(session, {
          ...base,
          kind: "system",
          subtype: "compact",
          text: "Context compacted.",
        });
        return;
      case "turn-end":
        session.lastContextTokens = event.contextTokens ?? session.lastContextTokens;
        session.contextWindow = event.contextWindow ?? session.contextWindow;
        await this.emit(session, {
          ...base,
          kind: "result",
          subtype: event.subtype,
          isError: !event.ok,
          numTurns: event.numTurns,
          durationMs: event.durationMs,
          result: event.result,
          usage: event.usage,
          contextTokens: session.lastContextTokens,
          contextWindow: session.contextWindow,
          costUsd: event.costUsd,
        });
        session.turn += 1;
        if (!event.ok) this.onTurnError?.(session.chatId, event.result ?? event.limit?.reason);
        if ((session.harnessSession?.pending() ?? 0) > 0 || session.outbox.length > 0) {
          this.setStatus(session, "running", { state: "thinking" });
          this.flushOutbox(session);
        } else if (!event.ok) {
          this.onTurnFailed(session);
        } else {
          this.onTurnEnd(session);
        }
        return;
    }
  }

  private async consume(session: LiveSession): Promise<void> {
    const q = session.query;
    if (!q) return;
    try {
      for await (const msg of q) {
        await this.handleMessage(session, msg);
      }
      this.onDone(session);
    } catch (err) {
      this.onError(session, err);
    }
  }

  private async handleMessage(session: LiveSession, raw: SDKMessage): Promise<void> {
    // The SDK message union is vast; access fields pragmatically (spike pattern).
    const m = raw as unknown as Record<string, unknown> & { type: string };
    switch (m.type) {
      case "system": {
        const subtype = String((m as { subtype?: unknown }).subtype ?? "system");
        if (subtype === "init") {
          const sid = (m as { session_id?: string }).session_id;
          if (sid && sid !== session.sessionId) {
            session.sessionId = sid;
            void this.patchChat(session.chatId, { sessionId: sid, harnessHandoff: undefined });
          }
          session.model = (m as { model?: string }).model;
          await this.emit(session, {
            kind: "system",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            sessionId: session.sessionId,
            subtype: "init",
            data: {
              model: (m as { model?: unknown }).model,
              permissionMode: (m as { permissionMode?: unknown }).permissionMode,
              tools: (m as { tools?: unknown }).tools,
              mcpServers: (m as { mcp_servers?: unknown }).mcp_servers,
            },
          });
          // Learn this model's context window now that the subprocess is live, so
          // the very next result row carries the correct meter denominator.
          void this.refreshContextWindow(session);
        }
        // A backgrounded task (async `Agent` spawn, backgrounded `Bash`) settled.
        // This is the ONLY per-task completion signal in the stream — the task's
        // tool call answered with a launch ack long ago — so persist it as a row
        // keyed to the launching tool_use. Without it the client can only ask
        // "is the parent turn still running", which gives every background task
        // the same status (see shared TaskStatusRowSchema).
        if (subtype === "task_notification") {
          const usage = (m as { usage?: Record<string, unknown> }).usage;
          const raw = String((m as { status?: unknown }).status ?? "completed");
          const num = (v: unknown): number | undefined =>
            typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
          await this.emit(session, {
            kind: "task_status",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            taskId: String((m as { task_id?: unknown }).task_id ?? ""),
            toolUseId:
              typeof (m as { tool_use_id?: unknown }).tool_use_id === "string"
                ? ((m as { tool_use_id?: string }).tool_use_id as string)
                : undefined,
            status: raw === "failed" || raw === "stopped" ? raw : "completed",
            summary:
              typeof (m as { summary?: unknown }).summary === "string"
                ? ((m as { summary?: string }).summary as string)
                : undefined,
            totalTokens: num(usage?.total_tokens),
            toolUses: num(usage?.tool_uses),
            durationMs: num(usage?.duration_ms),
          });
        }
        return;
      }
      case "assistant": {
        // A subagent (spawned via the Task tool) tags every message it emits with
        // the spawning tool_use id + its own type. Capture both so the finalized
        // rows carry the nesting key the client groups on.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const subagentType = (m as { subagent_type?: string }).subagent_type;
        // Track the main-loop context occupancy from this request's OWN usage
        // (subagent messages have their own separate context, so ignore them).
        if (parentToolUseId === null) {
          const ctx = contextTokensOf((m as { message?: { usage?: unknown } }).message?.usage);
          if (ctx !== null) session.lastContextTokens = ctx;
        }
        const blocks = this.contentBlocks(m);
        let text = "";
        let thinking = "";
        const toolBlocks: Record<string, unknown>[] = [];
        for (const b of blocks) {
          const t = b.type;
          if (t === "text") text += String(b.text ?? "");
          else if (t === "thinking") thinking += String(b.thinking ?? "");
          else if (t === "tool_use") toolBlocks.push(b);
        }
        // Correlate this finalized row with the buffer its chunks streamed into.
        // Only the MAIN loop streams (subagent partials are skipped — see the
        // stream_event handler), so a main-loop row reuses the exact id its chunks
        // published under (`streamAssistantId`) — that's what lets the client swap
        // the live buffer for the persisted row in place. A subagent row NEVER
        // reads or clears that slot: doing so would let it adopt the main loop's
        // live buffer id and orphan it (a stuck ●●● StreamingRow + duplicate text).
        const apiMessageId = (m as { message?: { id?: string } }).message?.id;
        const isMainLoop = parentToolUseId === null;
        const assistantId = isMainLoop
          ? session.streamAssistantId ?? apiMessageId ?? this.genId()
          : apiMessageId ?? this.genId();
        // The main loop is sequential — at most one message streams at a time — so
        // consuming its slot on finalize is unconditional (no-op when nothing
        // streamed, e.g. a tool-only message).
        if (isMainLoop) session.streamAssistantId = undefined;
        if (text || thinking) {
          this.setStatus(session, "running", { state: "responding", label: "responding" });
          await this.emit(session, {
            kind: "assistant",
            id: assistantId,
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            text,
            thinking: thinking || undefined,
            model: session.model,
            uuid: (m as { uuid?: string }).uuid,
            subagentType,
            effort: this.threadEffort(session, parentToolUseId),
            parentToolUseId,
          });
        }
        for (const tb of toolBlocks) {
          const name = String(tb.name ?? "");
          const input = (tb.input ?? {}) as Record<string, unknown>;
          // AskUserQuestion is surfaced as an interactive QuestionCard via the
          // `canUseTool` → permission-request path; suppress the redundant
          // generic tool_use row so the transcript shows one canonical question
          // surface (and no orphan "running AskUserQuestion" tool card).
          if (name === "AskUserQuestion") continue;
          const toolStatus = statusForTool(name, input);
          this.setStatus(session, toolStatus, {
            state: "tool",
            label: `${toolStatus === "waiting" ? "waiting on" : "running"} ${name}`,
            toolName: name,
            target: deriveTarget(input),
          });
          const toolUseId = String(tb.id ?? this.genId());
          // Stamped BEFORE the row goes out: the PreToolUse hook for this call is
          // what reports the thread's effort, and it can only name the call.
          this.noteToolThread(session, toolUseId, parentToolUseId);
          await this.emit(session, {
            kind: "tool_use",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            toolUseId,
            name,
            input,
            server: parseMcpServer(name),
            parentToolUseId,
            subagentType,
            effort: this.threadEffort(session, parentToolUseId),
            uuid: (m as { uuid?: string }).uuid,
          });
        }
        return;
      }
      case "user": {
        // A subagent's tool_result rides a `user` message tagged with the spawning
        // Task tool_use id — carry that (and the subagent type) onto the row so it
        // nests under the same Task card as the subagent's assistant/tool_use rows.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const subagentType = (m as { subagent_type?: string }).subagent_type;
        // Surface tool_result blocks; ignore plain echoes of our own input.
        for (const b of this.contentBlocks(m)) {
          if (b.type !== "tool_result") continue;
          // Persist any image content the tool returned (e.g. a Claude-in-Chrome
          // screenshot) to the chat's assets dir and hand the client small
          // ImageRefs; the enriched `tool_result` row IS the render event (fanned
          // out as `chat-message`, drawn inline in the ToolCallCard).
          const { images, content } = await this.persistContentImages(session, b.content);
          await this.emit(session, {
            kind: "tool_result",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            toolUseId: String(b.tool_use_id ?? ""),
            ok: !b.is_error,
            isError: b.is_error ? true : undefined,
            content,
            images: images.length ? images : undefined,
            parentToolUseId,
            subagentType,
          });
        }
        return;
      }
      case "stream_event": {
        // Token-level partials (only with includePartialMessages). Forward text /
        // thinking deltas as `message-chunk` so the client types out the reply,
        // then supersedes the buffer with the finalized `assistant` row (same id).
        //
        // Only the MAIN loop streams live. Subagents run concurrently (with the
        // main loop and each other) and their partials interleave; honoring them
        // would let a subagent `message_start` clobber the single streamAssistantId
        // slot and orphan the main loop's buffer as a stuck ●●● StreamingRow. A
        // subagent's text still renders from its finalized (nested) `assistant` row.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        if (parentToolUseId !== null) return;
        const event = (m as { event?: Record<string, unknown> }).event;
        if (!event || typeof event !== "object") return;
        const et = String((event as { type?: unknown }).type ?? "");
        if (et === "message_start") {
          // A new assistant message begins its token stream → adopt the SDK message
          // id its chunks and finalized row will share (so the two correlate even
          // when a subagent message finalizes in between). Fall back to a fresh id
          // only if the SDK omits it.
          const startId = (event as { message?: { id?: string } }).message?.id;
          session.streamAssistantId = startId ?? this.genId();
          return;
        }
        if (et !== "content_block_delta") return;
        const delta = (event as { delta?: Record<string, unknown> }).delta;
        const dt = String((delta as { type?: unknown } | undefined)?.type ?? "");
        let channel: "text" | "thinking" | undefined;
        let piece = "";
        if (dt === "text_delta") {
          channel = "text";
          piece = String((delta as { text?: unknown }).text ?? "");
        } else if (dt === "thinking_delta") {
          channel = "thinking";
          piece = String((delta as { thinking?: unknown }).thinking ?? "");
        }
        if (!channel || !piece) return;
        // Defensive: if `message_start` was missed, allocate on the first delta so
        // the id still correlates with the finalized row.
        if (!session.streamAssistantId) session.streamAssistantId = this.genId();
        this.bus.publish({
          type: "message-chunk",
          chatId: session.chatId,
          messageId: session.streamAssistantId,
          delta: piece,
          channel,
        });
        return;
      }
      case "result": {
        const isError = Boolean((m as { is_error?: unknown }).is_error);
        const resultText =
          typeof (m as { result?: unknown }).result === "string"
            ? ((m as { result?: string }).result as string)
            : undefined;
        await this.emit(session, {
          kind: "result",
          id: this.genId(),
          chatId: session.chatId,
          ts: this.now(),
          turn: session.turn,
          sessionId: session.sessionId,
          subtype: String((m as { subtype?: unknown }).subtype ?? "success"),
          isError,
          numTurns: (m as { num_turns?: number }).num_turns,
          durationMs: (m as { duration_ms?: number }).duration_ms,
          result: resultText,
          usage: (m as { usage?: unknown }).usage,
          contextTokens: session.lastContextTokens,
          contextWindow: session.contextWindow,
          costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
        });
        session.turn += 1;
        // A turn that ended in error may have hit a usage limit — hand the
        // message off so the chat can schedule itself to continue.
        if (isError) this.onTurnError?.(session.chatId, resultText);
        // Relearn the window off-loop for the next turn's row (cheap; the model
        // — hence window — can shift mid-session on a switch or fallback).
        void this.refreshContextWindow(session);
        const limits = await this.store.getSettings().catch(() => undefined);
        const perChatLimit = limits?.harness?.contextLimits?.perChatTokens;
        if (
          !isError &&
          (limits?.autoCompact?.enabled ?? true) &&
          perChatLimit &&
          (session.lastContextTokens ?? 0) >= perChatLimit
        ) {
          session.outbox.push({ id: this.genId(), text: "/compact", priority: "next" });
          this.flushOutbox(session);
        }
        // Chained turn buffered? Stay running; otherwise the turn is complete.
        if (session.input && session.input.pending() > 0) {
          this.setStatus(session, "running", { state: "thinking" });
        } else if (isError) {
          this.onTurnFailed(session);
        } else {
          this.onTurnEnd(session);
        }
        return;
      }
      default:
        return;
    }
  }

  private contentBlocks(m: Record<string, unknown>): Record<string, unknown>[] {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    return content.filter(
      (b): b is Record<string, unknown> => !!b && typeof b === "object",
    );
  }

  /**
   * Scan a tool_result's `content` for image blocks the agent received, persist
   * any inline base64 image to the chat's assets dir, and return the resulting
   * ImageRefs plus a sanitized copy of the content. Claude supplies image bytes
   * under `source`; Codex MCP results use top-level `data` + `mimeType`, and can
   * occasionally serialize the whole CallToolResult into a text block. Handle
   * all three so provider boundaries never turn a screenshot into a megabyte of
   * base64 in the transcript.
   */
  private async persistContentImages(
    session: LiveSession,
    content: unknown,
  ): Promise<{ images: ImageRef[]; content: unknown }> {
    if (!Array.isArray(content)) return { images: [], content };
    const images: ImageRef[] = [];
    const out: unknown[] = [];
    for (const raw of content) {
      const block = raw as Record<string, unknown> | null;
      if (!block || typeof block !== "object" || block.type !== "image") {
        if (
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.trimStart().startsWith("{")
        ) {
          try {
            const parsed = JSON.parse(block.text) as Record<string, unknown>;
            if (parsed && Array.isArray(parsed.content)) {
              const nested = await this.persistContentImages(session, parsed.content);
              if (nested.images.length) {
                images.push(...nested.images);
                out.push({ ...block, text: JSON.stringify({ ...parsed, content: nested.content }) });
                continue;
              }
            }
          } catch {
            // Ordinary text (including non-result JSON) stays byte-for-byte intact.
          }
        }
        out.push(raw);
        continue;
      }
      const source = block.source as Record<string, unknown> | undefined;
      const srcType = source ? String(source.type ?? "") : "";
      const directData = typeof block.data === "string" ? block.data : undefined;
      const base64 = srcType === "base64" ? source?.data : directData;
      if (typeof base64 === "string") {
        const mime =
          typeof source?.media_type === "string"
            ? source.media_type
            : typeof block.mimeType === "string"
              ? block.mimeType
              : typeof block.mime_type === "string"
                ? block.mime_type
                : "image/png";
        try {
          const name = `${this.genId()}${extFromMediaType(mime)}`;
          const buf = Buffer.from(base64, "base64");
          const relPath = await this.store.writeChatAsset(session.chatId, name, buf);
          images.push({ id: this.genId(), path: relPath, mimeType: mime });
          out.push({ type: "image", media_type: mime, asset: relPath });
        } catch {
          // Persist failed (bad base64 / disk) → keep the raw block, no ref.
          out.push(raw);
        }
      } else if (srcType === "url" && typeof source?.url === "string") {
        images.push({
          id: this.genId(),
          path: source.url,
          mimeType:
            typeof source.media_type === "string" ? source.media_type : undefined,
        });
        out.push(raw);
      } else {
        out.push(raw);
      }
    }
    return { images, content: out };
  }

  /* --------------------------------------------------------- permission */

  private registerHarnessPermission(
    session: LiveSession,
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { title?: string; displayName?: string; description?: string },
    questions?: HarnessQuestion[],
  ): void {
    const request: PermissionRequest = {
      id: requestId,
      chatId: session.chatId,
      toolName,
      input,
      displayName: opts.displayName,
      title: opts.title,
      description: opts.description,
      createdAt: this.now(),
    };
    const attentionId = `att-perm-${requestId}`;
    const isQuestion = toolName === "AskUserQuestion";
    const summary = isQuestion ? questionSummary(input) : (opts.title ?? `Permission: ${toolName}`);

    session.pendingPermissions.set(requestId, {
      harnessSession: session.harnessSession,
      questions,
      toolName,
      input,
      request,
      attentionId,
    });
    this.setStatus(session, "awaiting-input", {
      state: "awaiting",
      label: isQuestion ? summary : (opts.title ?? `Allow ${toolName}?`),
      toolName,
    });
    this.bus.publish({ type: "permission-request", chatId: session.chatId, request });
    this.bus.publish({
      type: "attention-add",
      item: {
        id: attentionId,
        chatId: session.chatId,
        kind: isQuestion ? "question" : "permission",
        summary,
        projectId: session.projectId || undefined,
        permissionRequestId: requestId,
        createdAt: this.now(),
      },
    });
  }

  private handlePermission(
    session: LiveSession,
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      title?: string;
      displayName?: string;
      description?: string;
      timeoutMs?: number;
    },
  ): Promise<PermissionResult> {
    // A SELF-GATED tool asks for itself, in its own words, with its own card —
    // `spawn_chat` cannot create anything until `consentToSpawn` returns approved.
    // Prompting at this layer too would ask the human twice for one decision in
    // ask-y modes, and a deny HERE would skip the handler entirely, taking with it
    // the "declined — don't retry" answer the tool exists to give. So the generic
    // gate steps aside and the specific one stands. This is not a hole: the tool's
    // own gate is unconditional, and unlike this one it also holds under
    // bypassPermissions, where `canUseTool` is never consulted at all.
    if (SELF_GATED_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const requestId = this.genId();
    const request: PermissionRequest = {
      id: requestId,
      chatId: session.chatId,
      toolName,
      input,
      displayName: opts?.displayName,
      title: opts?.title,
      description: opts?.description,
      createdAt: this.now(),
    };
    const attentionId = `att-perm-${requestId}`;

    // AskUserQuestion rides the same `canUseTool` channel but is a *question*,
    // not a scary permission gate — categorize it so the triage list shows the
    // question tone/label and the dedicated `question` branch is reachable.
    const isQuestion = toolName === "AskUserQuestion";
    const summary = isQuestion
      ? questionSummary(input)
      : (opts?.title ?? `Permission: ${toolName}`);

    this.setStatus(session, "awaiting-input", {
      state: "awaiting",
      label: isQuestion ? summary : (opts?.title ?? `Allow ${toolName}?`),
      toolName,
    });
    this.bus.publish({ type: "permission-request", chatId: session.chatId, request });
    this.bus.publish({
      type: "attention-add",
      item: {
        id: attentionId,
        chatId: session.chatId,
        kind: isQuestion ? "question" : "permission",
        summary,
        projectId: session.projectId || undefined,
        permissionRequestId: requestId,
        createdAt: this.now(),
      },
    });

    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingPermission = {
        resolve,
        toolName,
        input,
        request,
        attentionId,
        timeoutMs: opts.timeoutMs,
      };
      session.pendingPermissions.set(requestId, pending);
      this.armQuestionTimeout(session, requestId, pending);
    });
  }

  /** Start (or restart) the inactivity clock owned by one pending question. */
  private armQuestionTimeout(
    session: LiveSession,
    requestId: string,
    pending: PendingPermission,
  ): void {
    if (!pending.timeoutMs) return;
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    pending.timeoutTimer = setTimeout(() => {
      this.resolvePermission(requestId, {
        decision: "deny",
        message: questionTimeoutMessage(pending.timeoutMs!),
      });
    }, pending.timeoutMs);
  }

  /**
   * Put a manager-MCP question through the same pending-card path as the native
   * harness question tools. Keeping this on the broker means Claude's in-process
   * server and Codex's HTTP bridge get byte-identical question/attention state.
   */
  async askUser(
    chatId: string,
    questions: ManagerAskQuestion[],
    timeoutSeconds?: number,
  ): Promise<ManagerAskResult> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return { status: "unavailable", message: "No live session is available to ask through." };
    }
    const result = await this.handlePermission(
      session,
      "AskUserQuestion",
      { questions, ...(timeoutSeconds ? { timeoutSeconds } : {}) },
      {
        displayName: "Question",
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1_000 : undefined,
      },
    );
    if (result.behavior !== "allow") {
      if (
        timeoutSeconds &&
        result.message === questionTimeoutMessage(timeoutSeconds * 1_000)
      ) {
        return { status: "timed_out", message: result.message };
      }
      return { status: "declined", message: result.message };
    }
    const raw = result.updatedInput?.answers;
    const answers = raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"
          ),
        )
      : {};
    return { status: "answered", answers };
  }

  /**
   * Decide whether a `spawn_chat` request needs the human, and get their answer
   * if it does.
   *
   * The policy is theirs alone: the TARGET project's manifest first (a repo can
   * insist on the prompt even where auto-approve is on globally, and vice versa),
   * then the app setting, which defaults to asking. Nothing the agent passes in
   * reaches this decision — that's the whole design, so that a chat spawning
   * chats stays something the human said yes to rather than something they read
   * about afterwards.
   */
  async consentToSpawn(
    chatId: string,
    request: SpawnChatRequest,
    target: SpawnChatTarget,
  ): Promise<SpawnChatConsent> {
    const projectPolicy = this.projectConfig?.getSpawnAutoApprove?.(target.id) ?? null;
    const auto =
      projectPolicy ??
      (await this.store
        .getSettings()
        .then((s) => s.spawnChat?.autoApprove ?? false)
        .catch(() => false));
    if (auto) return { approved: true, auto: true };

    const { approved, message } = await this.requestApproval(chatId, {
      toolName: "spawn_chat",
      title: `Start a new chat in ${target.name}?`,
      description: [
        request.reason ? `Why: ${request.reason}` : null,
        request.title ? `Title: ${request.title}` : null,
        `Brief: ${truncate(request.prompt, 600)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      // The card renders the input, so hand it the request AS ASKED — including
      // the prompt the new chat would receive verbatim, which is the one thing
      // worth reading before saying yes.
      input: { ...request },
    });
    return { approved, auto: false, message };
  }

  /**
   * Put a NON-tool decision in front of the human on a live session's behalf and
   * block until they answer — the same card, Attention Queue entry, transcript
   * row and resolve endpoint an ordinary `canUseTool` prompt uses.
   *
   * It rides the permission channel rather than inventing a parallel approval
   * surface because everything that makes a permission prompt hard to miss
   * (triage priority, notifier webhooks, the deny-all-pending teardown that stops
   * a stopped session from stranding a question) is wired to THAT channel. A
   * second one would have to re-earn all of it, and would be the surface that
   * quietly rots. `deny` on an unknown chat, so a caller can never read "no live
   * session" as consent.
   */
  async requestApproval(
    chatId: string,
    opts: { toolName: string; title: string; description?: string; input?: Record<string, unknown> },
  ): Promise<{ approved: boolean; message?: string }> {
    const session = this.sessions.get(chatId);
    if (!session) return { approved: false, message: "no live session to ask through" };
    const result = await this.handlePermission(
      session,
      opts.toolName,
      opts.input ?? {},
      { title: opts.title, description: opts.description, displayName: opts.toolName },
    );
    return result.behavior === "allow"
      ? { approved: true }
      : { approved: false, message: result.message };
  }

  /* ----------------------------------------------------- state helpers */

  private setStatus(session: LiveSession, status: ChatStatus, activity?: AgentActivity): void {
    const changed = session.status !== status;
    session.status = status;
    if (changed) {
      // Serialize with transcript writes so rapid running -> waiting -> idle
      // transitions always land in order. Status writes preserve updatedAt:
      // changing a dot color is not new conversational activity.
      session.writeChain = session.writeChain
        .catch(() => {})
        .then(async () => {
          try {
            await this.store.patchChat(session.chatId, { status });
          } catch (err) {
            this.bus.publish({
              type: "error",
              chatId: session.chatId,
              message: "failed to persist chat status",
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }
    this.bus.publish({
      type: "chat-status",
      chatId: session.chatId,
      status,
      activity,
      queued: this.queuedCount(session),
      prSettled: session.prWatchSettled || undefined,
    });
  }

  /** Steering messages submitted but not yet consumed by the SDK (outbox + input). */
  private queuedCount(session: LiveSession): number {
    return (
      session.outbox.length +
      (session.harnessSession?.pending() ?? session.input?.pending() ?? 0)
    );
  }

  private onTurnEnd(session: LiveSession): void {
    this.setStatus(session, "idle", { state: "idle" });
    const id = `att-idle-${session.chatId}-${this.genId()}`;
    session.idleAttentionId = id;
    this.bus.publish({
      type: "attention-add",
      item: {
        id,
        chatId: session.chatId,
        kind: "idle",
        summary: "Turn complete — awaiting your input",
        projectId: session.projectId || undefined,
        createdAt: this.now(),
      },
    });
    this.pump();
  }

  /** A turn failed but its reusable runtime session is still available. */
  private onTurnFailed(session: LiveSession): void {
    this.setStatus(session, "failed", { state: "idle" });
    this.pump();
  }

  private onDone(session: LiveSession): void {
    // Idempotent: a session that already settled must not emit a second "done".
    if (session.status === "done" || session.status === "error") return;
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    session.harnessSession = undefined;
    session.managerGrant?.revoke();
    session.managerGrant = undefined;
    session.stopping = false;
    this.cleanupSkills(session);
    this.resolveIdleAttention(session);
    if (session.switching) {
      session.switching = false;
      this.setStatus(session, "idle", { state: "idle" });
      this.queueOrder = this.queueOrder.filter((x) => x !== session.chatId);
      this.pump();
      return;
    }
    this.setStatus(session, "done", { state: "idle" });
    this.bus.publish({
      type: "attention-add",
      item: {
        id: `att-done-${session.chatId}-${this.genId()}`,
        chatId: session.chatId,
        kind: "done",
        summary: "Session ended",
        projectId: session.projectId || undefined,
        createdAt: this.now(),
      },
    });
    this.queueOrder = this.queueOrder.filter((x) => x !== session.chatId);
    this.pump();
  }

  private onError(session: LiveSession, err: unknown): void {
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    session.harnessSession = undefined;
    session.managerGrant?.revoke();
    session.managerGrant = undefined;
    // A crash after a completed turn leaves a live "Turn complete" item; clear it.
    this.resolveIdleAttention(session);
    this.drainPendingPermissions(session, "Session ended.");

    if (session.stopping) {
      // Deliberate stop/fork abort — settle as a clean done (which cleans skills).
      this.onDone(session);
      return;
    }
    this.cleanupSkills(session);
    this.setStatus(session, "error");
    const message = err instanceof Error ? err.message : String(err);
    this.bus.publish({ type: "error", chatId: session.chatId, message });
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId: session.chatId,
      ts: this.now(),
      level: "error",
      text: `Session error: ${message}`,
    });
    this.queueOrder = this.queueOrder.filter((x) => x !== session.chatId);
    this.pump();
  }

  private resolveIdleAttention(session: LiveSession): void {
    if (!session.idleAttentionId) return;
    this.bus.publish({
      type: "attention-resolve",
      id: session.idleAttentionId,
      chatId: session.chatId,
    });
    session.idleAttentionId = undefined;
  }

  /**
   * Deny + clear every pending permission on a teardown path (stop/fork/error/
   * interrupt). Unlike the normal `resolvePermission`, these are forced, so we
   * also publish the `permission-resolved` + `attention-resolve` UI events that
   * unstick the client's permission card and clear the global Attention Queue.
   */
  private drainPendingPermissions(session: LiveSession, message: string): void {
    for (const [requestId, p] of session.pendingPermissions) {
      if (p.timeoutTimer) clearTimeout(p.timeoutTimer);
      if (p.harnessSession) {
        p.harnessSession.resolvePermission(requestId, { decision: "deny", message });
      } else {
        p.resolve?.({ behavior: "deny", message });
      }
      this.bus.publish({
        type: "permission-resolved",
        chatId: session.chatId,
        requestId,
        decision: "deny",
      });
      this.bus.publish({
        type: "attention-resolve",
        id: p.attentionId,
        chatId: session.chatId,
      });
    }
    session.pendingPermissions.clear();
  }

  /** Await a consume loop to unwind, capped by `timeoutMs` (never rejects). */
  private async awaitLoop(loop: Promise<void> | undefined, timeoutMs: number): Promise<void> {
    if (!loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    try {
      await Promise.race([loop.catch(() => {}), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private applyEffort(session: LiveSession, effort: Effort): void {
    session.effort = effort;
    // Everything observed so far described the OLD level; drop it so the next
    // hook re-reports (and any downgrade for this level is learned fresh).
    session.effortByThread.clear();
    if (!session.query) return;
    void this.pushEffort(session.query, effort).catch((err: unknown) => {
      this.bus.publish({
        type: "error",
        chatId: session.chatId,
        message: "setEffort failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Push an effort change into a RUNNING query.
   *
   * `effort` is a start-of-query option, so the live twin is the flag-settings
   * layer: `applyFlagSettings({ effortLevel })` merges over user/project settings
   * and takes effect on the next request — subagents spawned after it included.
   * Falls back to the legacy thinking-token budget when the running CLI predates
   * the control (or rejects the level), so the lever is never a silent no-op.
   */
  private async pushEffort(q: Query, effort: Effort): Promise<void> {
    const apply = (q as Partial<Query>).applyFlagSettings;
    if (typeof apply === "function") {
      try {
        // `Settings.effortLevel` is typed low..xhigh while the query option
        // accepts "max" too; the CLI takes the same strings for both, so pass it
        // through rather than silently clamping a chat that asked for max.
        await apply.call(q, { effortLevel: effort as "low" | "medium" | "high" | "xhigh" });
        return;
      } catch {
        /* fall through to the thinking-budget fallback below */
      }
    }
    await q.setMaxThinkingTokens(EFFORT_THINKING_TOKENS[effort]);
  }

  /**
   * PreToolUse observer: record the effort the runtime applied to the thread this
   * tool call came from. Read-only — it always returns an empty verdict, so it can
   * never block or alter a call (the workflow guard is the hook that decides).
   *
   * A subagent's call carries `agent_id`; the run it belongs to is recovered from
   * the tool_use id, which `noteToolThread` stamped when the call was emitted.
   * An unattributable call (a hook that beat its own row, an id we trimmed) is
   * simply skipped — the row then shows the configured level instead.
   */
  private observeEffortHook(session: LiveSession): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const i = input as {
        effort?: { level?: unknown };
        agent_id?: string;
        tool_use_id?: string;
      };
      const level = EffortSchema.safeParse(i.effort?.level);
      if (!level.success) return {}; // model without effort support
      const thread = i.agent_id
        ? i.tool_use_id
          ? session.threadOfTool.get(i.tool_use_id)
          : undefined
        : MAIN_THREAD;
      if (thread) session.effortByThread.set(thread, level.data);
      return {};
    };
  }

  /**
   * PreToolUse guard: keep a subagent writing in the worktree it started in.
   *
   * WHY (2026-08-07). Five background subagents shared one session; the main
   * loop called `EnterWorktree` to go commit one of their branches, and because
   * `cwd` is session-scoped in the SDK — not per-thread — the others went with
   * it. Two edits landed on the wrong branch and were nearly committed by a
   * `git add -A`. The full account, and why refusing is the strongest thing
   * available on this side, is in `agent-cwd.ts`.
   *
   * A hook rather than `canUseTool` for the same reason the workflow guard is
   * one: it still fires under `bypassPermissions`, which is the posture the
   * incident happened in.
   */
  private agentCwdGuardHook(session: LiveSession): HookCallback {
    return async (input: HookInput): Promise<HookJSONOutput> => {
      const tracker = session.cwdTracker;
      const i = input as {
        cwd?: string;
        agent_id?: string;
        tool_use_id?: string;
        tool_name?: string;
        tool_input?: unknown;
      };
      if (!tracker || typeof i.cwd !== "string" || !i.tool_name) return {};
      // Same correlation the effort observer uses: a subagent's call carries
      // `agent_id`, and the RUN it belongs to is recovered from the tool_use id.
      // When that lookup misses (a hook that beat its own row, an id we trimmed)
      // fall back to `agent_id` itself — still one key per thread, just one the
      // spawn map can't reach, so the call is tracked rather than dropped.
      const thread = i.agent_id
        ? (i.tool_use_id ? session.threadOfTool.get(i.tool_use_id) : undefined) ??
          `agent:${i.agent_id}`
        : MAIN_THREAD;
      const refusal = await tracker.observe({
        thread,
        toolName: i.tool_name,
        cwd: i.cwd,
        input: (i.tool_input ?? {}) as Record<string, unknown>,
      });
      if (!refusal) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: refusal.reason,
        },
      } as unknown as HookJSONOutput;
    };
  }

  /**
   * The per-session cwd tracker, created once and kept (background subagents
   * outlive the turn that spawned them). `parentOf` is `threadOfTool` read in
   * the other direction: a child run's id IS the `Agent` tool_use id its spawner
   * issued, so looking that id up yields the spawning run.
   */
  private ensureCwdTracker(session: LiveSession): AgentCwdTracker {
    session.cwdTracker ??= new AgentCwdTracker({
      mainThread: MAIN_THREAD,
      parentOf: (thread) => session.threadOfTool.get(thread),
      onDisplaced: (loc) => {
        this.bus.publish({
          type: "notice",
          chatId: session.chatId,
          level: "warn",
          text:
            `A subagent's working directory moved: it started in ${loc.pinned} and is ` +
            `now in ${loc.current}. Check which branch its work is landing on before ` +
            `you commit.`,
        });
      },
      onRefused: (loc, refusal) => {
        this.bus.publish({
          type: "notice",
          chatId: session.chatId,
          level: "warn",
          text:
            `Blocked: a subagent tried to write into ${refusal.attempted}, which is a ` +
            `different worktree from the ${loc.pinned} it started in.`,
        });
      },
    });
    return session.cwdTracker;
  }

  /** Remember which thread issued a tool call, FIFO-trimmed for long sessions. */
  private noteToolThread(
    session: LiveSession,
    toolUseId: string,
    parentToolUseId: string | null,
  ): void {
    session.threadOfTool.set(toolUseId, parentToolUseId ?? MAIN_THREAD);
    if (session.threadOfTool.size > THREAD_MAP_CAP) {
      const oldest = session.threadOfTool.keys().next();
      if (!oldest.done) session.threadOfTool.delete(oldest.value);
    }
  }

  /**
   * The effort to stamp on a row from this thread: what a hook observed, else
   * what we configured for it — the agent's own pin for the main loop, the chat's
   * level for a subagent (which inherits it unless its definition says otherwise).
   */
  private threadEffort(session: LiveSession, parentToolUseId: string | null): Effort {
    const observed = session.effortByThread.get(parentToolUseId ?? MAIN_THREAD);
    if (observed) return observed;
    return parentToolUseId === null ? session.agentEffort ?? session.effort : session.effort;
  }

  /* ---------------------------------------------------------- options */

  private async resolvePermissionMode(modeId: string): Promise<PermissionMode> {
    const mode = await this.resolveMode(modeId);
    if (mode) return mode.permissionMode;
    return BUILTIN_MODE_PERMISSION[modeId] ?? "default";
  }

  /**
   * Resolve a mode by id, config-first: a `.dispatch/`-authored mode
   * (the source of truth) wins over a `.data`-defined one on id collision.
   */
  private async resolveMode(modeId: string): Promise<ModeConfig | null> {
    return (
      this.projectConfig?.getMode(modeId) ??
      (await this.store.getMode(modeId).catch(() => null))
    );
  }

  /**
   * Resolve an agent by id, config-first: a `.dispatch/`-authored agent
   * (the source of truth) wins over a `.data`-defined one on id collision.
   */
  private async resolveAgent(agentId: string): Promise<AgentConfig | null> {
    return (
      this.projectConfig?.getAgent(agentId) ??
      (await this.store.getAgent(agentId).catch(() => null))
    );
  }

  /** The project owning a chat (for the run_subapp MCP binding). Null on any miss. */
  private async projectForChat(chatId: string): Promise<Project | null> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return null;
    return this.store.getProject(chat.projectId).catch(() => null);
  }

  private async buildOptions(session: LiveSession): Promise<Options> {
    const permissionMode = await this.resolvePermissionMode(session.modeId);
    const project =
      session.project ??
      (session.projectId
        ? await this.store.getProject(session.projectId).catch(() => null)
        : null);
    const cwd = session.worktreeCwd ?? project?.repoPath;

    const options: Options = {
      permissionMode,
      // Launch every session with the skip-permissions capability so the "Bypass"
      // posture is switchable mid-session. The SDK rejects
      // setPermissionMode("bypassPermissions") unless the session launched with this
      // flag. It only ENABLES bypass to be selected (user-controlled); canUseTool
      // still gates every other mode.
      allowDangerouslySkipPermissions: true,
      canUseTool: (name, input, o) => this.handlePermission(session, name, input, o),
      // The FIRST-CLASS effort lever: one level the runtime interprets per model
      // (and guides adaptive thinking with), inherited by every subagent this
      // session spawns unless its own definition pins one. Deliberately NOT a
      // `thinking` budget — that pins the same token count for every model and
      // overrides adaptive thinking; it survives only as the fallback in
      // `pushEffort` for a runtime without the live control.
      effort: session.effort,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      abortController: session.abortController,
      // Run on the user's installed Claude Code when it's newer than the one
      // bundled with the SDK. MUST match what services/models.ts probes for the
      // picker: the runtime decides which model ids resolve, so a picker fed by
      // a newer binary than the session would offer models the session can't run.
      ...claudeExecutableOption(),
    };
    if (cwd) options.cwd = cwd;
    // A user-chosen model pins the query; unset falls back to the SDK default.
    // (Kept separate from `session.model`, which mirrors the model the SDK
    // *reports* at init and would otherwise feed the "[1m]" display id back in.)
    if (session.modelOverride) options.model = session.modelOverride;

    // Native auto-compaction (SDK `Settings` layer): keep it ON by default so a
    // session summarizes itself and continues when the window fills, instead of
    // erroring — this is the "auto-clean at the limit" behavior. A global setting
    // can disable it or override the compaction reserve window.
    const appSettings = await this.store.getSettings().catch(() => undefined);
    const ac = appSettings?.autoCompact;
    options.settings = {
      autoCompactEnabled: ac?.enabled ?? true,
      ...(ac?.window ? { autoCompactWindow: ac.window } : {}),
    };

    // Config-sourced agents/modes (the `.dispatch/` source of truth) win
    // over `.data`-defined ones on id collision.
    const mode = await this.resolveMode(session.modeId);
    const agent = session.agentId ? await this.resolveAgent(session.agentId) : null;

    // The workflow contract — how change ships in THIS project. Resolved BEFORE
    // the tools directive because it decides one of the session's capabilities:
    // `approve_pr` exists only where the project opted into auto-merge, so the
    // directive can't be written until we know. Also feeds `session.workflow` for
    // the permission guard below, so the rules the agent reads and the rules
    // enforced on it come from one object.
    const wfCtx = await inspectCwd(cwd);
    const workflow = resolveWorkflow(project);
    session.workflow = workflow;
    session.trunk = project?.defaultBranch ?? "main";
    session.branch = wfCtx.branch;
    session.inWorktree = Boolean(session.worktreeCwd) || wfCtx.linked;
    const canApprovePr = Boolean(this.github) && workflow.autoMerge === "on-green";
    // `create_pr` exists wherever change ships through a PR — the same condition
    // the guard uses to refuse a raw `gh pr create`, so a refusal always has a
    // sanctioned path to name.
    const canCreatePr = Boolean(this.github) && workflow.requirePr;

    const appends: string[] = [];
    const handoff = await this.buildHarnessHandoff(session.chatId);
    if (handoff) appends.push(handoff);
    // Lead with the manager-tools directive so EVERY session (any project)
    // discovers the `mcp__manager__*` tools it has and is steered to prefer them
    // over hand-rolled shell equivalents (the #1 way agents waste effort here).
    appends.push(
      buildManagerToolsDirective({
        github: Boolean(this.github),
        terminals: Boolean(this.terminals),
        memory: Boolean(this.memory && session.projectId),
        runner: Boolean(this.runner && this.worktrees),
        mcpConfig: Boolean(session.projectId),
        prApproval: canApprovePr,
        prCreate: canCreatePr,
        prReviewers: workflow.pr.reviewers,
      }),
    );
    // The rendered contract itself comes next — before the project's own
    // instructions, so an authored instruction can still refine it.
    const workflowDirective = buildWorkflowDirective(workflow, {
      defaultBranch: session.trunk,
      inWorktree: session.inWorktree,
      branch: session.branch,
      github: Boolean(this.github),
      prCreate: canCreatePr,
      memory: Boolean(this.memory && session.projectId),
    });
    if (workflowDirective) appends.push(workflowDirective);

    // Learn the effort the runtime is REALLY running each thread at. Hook inputs
    // are the only place that number surfaces (the message stream never carries
    // it), they fire for subagents too (tagged with `agent_id`), and they report
    // the level after any silent downgrade for the model — so this is what the
    // run cards get to show instead of re-stating the chat's pick. No matcher =
    // every tool; the callback only reads and returns.
    options.hooks = {
      ...options.hooks,
      PreToolUse: [
        ...(options.hooks?.PreToolUse ?? []),
        { hooks: [this.observeEffortHook(session)] },
      ],
    };

    // …and keep each subagent writing where it started. No matcher, because the
    // guard has to SEE every call to know where a thread is before it can judge
    // a write — a `Bash` that `cd`s into another worktree is the move that
    // matters, even though only the write that follows is refused. See
    // `agentCwdGuardHook` for the incident this exists for.
    this.ensureCwdTracker(session);
    options.hooks = {
      ...options.hooks,
      PreToolUse: [
        ...(options.hooks?.PreToolUse ?? []),
        { hooks: [this.agentCwdGuardHook(session)] },
      ],
    };

    // …and refuse `run_in_background`, which spawns outside the server's process
    // tree and orphans onto its port when the session ends. Only where there IS
    // somewhere to redirect to: no TerminalService, no tracked alternative, no
    // guard. See services/shell-guard.ts for the incident.
    if (this.terminals) {
      options.hooks = {
        ...options.hooks,
        PreToolUse: [
          ...(options.hooks?.PreToolUse ?? []),
          {
            hooks: [
              createBackgroundShellGuardHook({
                enabled: () => Boolean(this.terminals),
                onBlocked: () => {
                  this.bus.publish({
                    type: "notice",
                    chatId: session.chatId,
                    level: "info",
                    text:
                      "Blocked a background shell — redirected to " +
                      "mcp__manager__terminal({ background: true }), which is tracked.",
                  });
                },
              }),
            ],
          },
        ],
      };
    }

    // …and enforce the same contract. A PreToolUse hook (not `canUseTool`) so it
    // still fires under `bypassPermissions`, which is exactly when an unattended
    // agent is most likely to reach for `git push origin main`.
    if (workflow.guard !== "off") {
      options.hooks = {
        ...options.hooks,
        PreToolUse: [
          ...(options.hooks?.PreToolUse ?? []),
          {
            matcher: "Bash",
            hooks: [
              createWorkflowGuardHook({
                context: () =>
                  session.workflow
                    ? {
                        workflow: session.workflow,
                        trunk: session.trunk ?? "main",
                        inWorktree: Boolean(session.inWorktree),
                      }
                    : null,
                onViolation: (violation, blocked) => {
                  this.bus.publish({
                    type: "notice",
                    chatId: session.chatId,
                    level: blocked ? "warn" : "info",
                    text: `${blocked ? "Blocked" : "Workflow warning"}: ${violation.reason}`,
                  });
                },
              }),
            ],
          },
        ],
      };
    }

    if (mode?.instructions) appends.push(mode.instructions);

    // Inject the project's authored custom instructions from its
    // `.dispatch/` config — a clearly-delimited, bounded section alongside
    // the mode overlay + memory. Empty (no config / no instructions) → nothing,
    // and it never clobbers the existing appends.
    if (this.projectConfig && session.projectId) {
      const instructions = this.projectConfig.buildInstructionsInjection(session.projectId);
      if (instructions) appends.push(instructions);
    }

    // Read-at-start: inject the project's durable memory (index + one-line
    // descriptions, bounded — never full bodies) so every session begins knowing
    // the team's recorded facts. Empty project → nothing injected. Best-effort: a
    // read failure must never block a turn from starting.
    if (this.memory && session.projectId) {
      try {
        const injection = await this.memory.buildInjection(session.projectId);
        if (injection) appends.push(injection);
      } catch {
        /* no memory injection this turn */
      }
    }

    // An agent pins model/effort the same way: unset ⇒ inherit the chat's. Held
    // on the session too, because it is the main loop's DECLARED effort until a
    // hook reports what the runtime actually applied.
    session.agentEffort = agent?.effort;
    if (agent) {
      const def: AgentDefinition = {
        description: agent.name || "Custom agent",
        prompt: agent.instructions,
        tools: agent.allowedTools,
        disallowedTools: agent.disallowedTools,
        model: agent.model,
        permissionMode: agent.permissionMode,
        effort: agent.effort ?? session.effort,
      };
      options.agents = { [agent.id]: def };
      options.agent = agent.id;
    }
    if (appends.length) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: appends.join("\n\n"),
      };
    }
    // Register the in-process "manager" MCP on EVERY session so the agent can
    // self-pace (mcp__manager__wait / __wait_for_chat) and drive persistent
    // named shells (mcp__manager__terminal). Merge it alongside any
    // project-configured MCP servers; the session's abort signal cancels any
    // in-flight wait on stop/fork.
    const terminals = this.terminals;
    const memory = this.memory;
    const memoryHistory = this.memoryHistory;
    const github = this.github;
    const runner = this.runner;
    const worktrees = this.worktrees;
    const projectId = session.projectId;
    // The managed repo's `.dispatch/` config is the SOURCE OF TRUTH for
    // external MCP servers: layer the config-sourced servers OVER the `.data`
    // record (config wins per-name, a `.data`-only server survives), then apply
    // `manager` LAST so it's never clobbered (even by a config server named
    // "manager"). Consulting the config directly (not just the store-synced copy)
    // keeps a live watcher edit effective for this session.
    const configMcp = (
      this.projectConfig && projectId ? this.projectConfig.getMcpServers(projectId) : {}
    ) as unknown as Record<string, SdkMcpServerConfig>;
    options.mcpServers = {
      ...(project?.mcpServers as unknown as Record<string, SdkMcpServerConfig> | undefined),
      ...configMcp,
      manager: createManagerMcpServer({
        chatId: session.chatId,
        bus: this.bus,
        broker: this,
        // Bind the terminal runner to this session's chat + default cwd (its
        // worktree, else the repo root), so the agent just picks a name.
        terminals: terminals
          ? {
              run: (a) =>
                terminals.run({ chatId: session.chatId, cwd, ...a }),
              tail: (a) =>
                terminals.tail(session.chatId, a.name, a.lines),
            }
          : undefined,
        // Bind the memory runner to this session's project, so remember/recall/
        // forget just name the fact (scoped to the chat's project).
        memory:
          memory && projectId
            ? {
                remember: (input) => memory.write(projectId, input),
                recall: (query, opts) => memory.recall(projectId, query, opts),
                forget: (name) => memory.delete(projectId, name),
                findSimilar: (candidate, opts) =>
                  memory.findSimilar(projectId, candidate, opts),
                // The curation half: inventory, exact search, and commit history.
                // Bound the same way — the agent names the fact, never the project.
                inventory: (opts) => memory.inventory(projectId, opts),
                grep: (opts) => memory.grep(projectId, opts),
                read: (name) => memory.read(projectId, name),
                history: memoryHistory
                  ? (opts) => memoryHistory.forProject(projectId, opts)
                  : undefined,
              }
            : undefined,
        // Bind the PR watcher to this session's default cwd. `prMergeState` lets
        // `gh` auto-detect the repo from cwd; `prChecks`/`reviewThreads` need an
        // explicit owner/name, so resolve it from cwd ONCE (cached) and reuse it.
        // The agent may still pass an explicit repo override on any call. The
        // project's reviewer list rides along so `request_review` has a default —
        // the same list `create_pr` asks on the first round.
        github: github
          ? makeGithubBinding(github, cwd, session.chatId, workflow.pr.reviewers)
          : undefined,
        // The PR-landing surface — bound ONLY when this project's workflow opted
        // into auto-merge, which is what makes `approve_pr` absent (not merely
        // discouraged) everywhere else.
        prApproval:
          github && canApprovePr
            ? makePrApprovalBinding(
                github,
                cwd,
                session.chatId,
                workflow.mergeMethod,
                {
                  // The project's declared bar, resolved once and handed over — so
                  // what the human authored is exactly what gets enforced.
                  requireChecks: workflow.pr.requireChecks,
                  requireReview: workflow.pr.requireReview,
                  reviewers: workflow.pr.reviewers,
                },
                // An `allowNoReview`/`allowNoChecks` that actually suppresses a
                // blocker goes to the HUMAN on the ordinary permission channel.
                // Deliberately NOT routed through SELF_GATED_TOOLS: this gate is
                // conditional (almost every merge never reaches it), so the
                // generic canUseTool prompt for approve_pr must stay in place.
                (input) =>
                  this.requestApproval(session.chatId, {
                    toolName: "approve_pr_override",
                    ...overrideConsentPrompt(input, input.blockers),
                    input: {
                      number: input.number,
                      title: input.title,
                      url: input.url,
                      overriding: input.blockers.map((b) => b.code),
                    },
                  }),
              )
            : undefined,
        // The PR-CREATION surface — bound wherever change ships through a PR, so
        // the guard's refusal of a raw `gh pr create` always has a path to name.
        prCreate:
          github && canCreatePr
            ? makePrCreateBinding(github, cwd, session.chatId, {
                trunk: session.trunk ?? "main",
                reviewers: workflow.pr.reviewers,
                draft: workflow.pr.draft,
                arm: this.armPrWatch,
              })
            : undefined,
        // Bind the subApp launcher to this session's project so `run_subapp` can
        // list/start/stop apps and resolve (or create) a worktree per branch.
        runner:
          runner && worktrees
            ? {
                overview: async (chatId) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) return { subApps: [], running: [], branches: [] };
                  const all = await runner.list();
                  const running = all
                    .filter((r) => r.projectId === proj.id)
                    .map((r) => ({
                      subAppId: r.subAppId,
                      status: r.status,
                      url: r.url,
                      branch: r.branch,
                      port: r.port,
                    }));
                  const branches = (await worktrees.listBranches(proj)).map((b) => ({
                    name: b.name,
                    current: !!b.isCurrent,
                    hasWorktree: !!b.worktreePath,
                  }));
                  return {
                    subApps: (proj.subApps ?? []).map((s) => ({
                      id: s.id,
                      name: s.name,
                      ports: s.ports,
                    })),
                    running,
                    branches,
                  };
                },
                launch: async ({ chatId, subAppId, branch }) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) throw new Error("no project for this chat");
                  const subApp = (proj.subApps ?? []).find((s) => s.id === subAppId);
                  if (!subApp) throw new Error(`subApp "${subAppId}" not found`);
                  const b = branch || proj.defaultBranch || "main";
                  const path = await worktrees.resolveLaunchPath(proj, b);
                  const inst = await runner.start(path, subApp, {
                    projectId: proj.id,
                    chatId,
                    branch: b,
                  });
                  return {
                    subAppId: inst.subAppId,
                    status: inst.status,
                    url: inst.url,
                    branch: inst.branch,
                    port: inst.port,
                  };
                },
                stop: async ({ chatId, subAppId, branch }) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) return false;
                  const all = await runner.list();
                  const match = all.find(
                    (r) =>
                      r.projectId === proj.id &&
                      r.subAppId === subAppId &&
                      (!branch || r.branch === branch) &&
                      (r.status === "starting" || r.status === "running"),
                  );
                  if (!match) return false;
                  await runner.stop(match.id);
                  return true;
                },
              }
            : undefined,
        // Spawning a sibling chat: resolve the target project, ASK THE HUMAN,
        // then create it. Bound only when the container wired `spawnChat` in.
        chats: this.spawnChat
          ? {
              resolveProject: async (id) => {
                const target = id || projectId;
                if (!target) return null;
                const proj = await this.store.getProject(target).catch(() => null);
                return proj ? { id: proj.id, name: proj.name } : null;
              },
              consent: async ({ request, project: target }) =>
                this.consentToSpawn(session.chatId, request, target),
              spawn: async ({ request, project: target }) => {
                if (!this.spawnChat) throw new Error("chat spawning is not wired in");
                return this.spawnChat({
                  request,
                  project: target,
                  parentChatId: session.chatId,
                });
              },
            }
          : undefined,
        // Bind the MCP-config editor to the project's MAIN repo path, NOT this
        // session's cwd: `.dispatch/` is committed config, so a server the
        // agent adds while working in a throwaway worktree has to land in the
        // real working copy or it vanishes with the worktree.
        mcpConfig: project?.repoPath ? createMcpConfigEditor(project.repoPath) : undefined,
        signal: session.abortController?.signal,
        now: this.now,
      }),
    };
    // Skills: the managed repo's `.dispatch/skills/` is the SOURCE OF TRUTH,
    // but the SDK only DISCOVERS `<cwd>/.claude/skills/` (there's no option to
    // point it elsewhere). So materialize the config skills into the session cwd's
    // `.claude/skills/` — a MERGE that never clobbers a skill the repo already
    // ships — then flip `skills: 'all'` so every discovered skill (the repo's own
    // AND the config-authored ones) is enabled. Tracked dirs are removed on
    // teardown.
    //
    // Two sources are merged, PROJECT FIRST so it wins: the project's authored
    // skills, then the manager's own bundled skills (how MCP config works here,
    // etc. — see `bundled-skills.ts`). Because materialization skips any target
    // dir that already exists, a project or repo skill of the same name silently
    // overrides the bundled one rather than fighting it.
    if (cwd) {
      const projectSkills =
        this.projectConfig && projectId ? this.projectConfig.getSkills(projectId) : [];
      const skills = [...projectSkills, ...bundledSkills()];
      if (skills.length) {
        try {
          session.materializedSkillDirs = await materializeSkills(
            cwd,
            skills,
            session.harnessKind === "codex" ? ".agents" : ".claude",
          );
        } catch {
          /* best-effort: a copy failure must never block a turn from starting */
        }
        options.skills = "all";
      }
    }
    if (session.fork) {
      if (session.resumeSessionId) options.resume = session.resumeSessionId;
      if (session.forkAtUuid) options.resumeSessionAt = session.forkAtUuid;
      options.forkSession = true;
    } else if (session.resumeSessionId) {
      options.resume = session.resumeSessionId;
    }
    return options;
  }

  /** Build the portable context used when a chat changes native runtimes. */
  private async buildHarnessHandoff(chatId: string): Promise<string | undefined> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat?.harnessHandoff) return undefined;
    const rows = await this.store.readMessages(chatId, { limit: 240 }).catch(() => []);
    const rendered = rows
      .filter((row) => row.ts <= chat.harnessHandoff!.at)
      .flatMap((row): string[] => {
      switch (row.kind) {
        case "user":
          return row.text ? [`USER: ${row.text}`] : [];
        case "assistant":
          return row.text ? [`ASSISTANT: ${row.text}`] : [];
        case "tool_use":
          return [`TOOL CALL ${row.name}: ${safeHandoffJson(row.input)}`];
        case "tool_result":
          return [`TOOL RESULT ${row.toolUseId} (${row.ok ? "ok" : "error"}): ${safeHandoffJson(row.content)}`];
        case "notice":
          return [`DISPATCH NOTICE: ${row.text}`];
        default:
          return [];
      }
      });
    const budget = 60_000;
    const kept: string[] = [];
    let size = 0;
    for (let i = rendered.length - 1; i >= 0; i -= 1) {
      const line = rendered[i]!;
      if (size + line.length > budget) break;
      kept.unshift(line);
      size += line.length;
    }
    return [
      "# Provider handoff",
      `This Dispatch chat previously ran on ${chat.harnessHandoff.from} and now runs on ${chat.harnessHandoff.to}.`,
      "The transcript below is historical context, not a claim that old tool processes or approvals remain live. Continue the same user task and verify mutable state before acting.",
      kept.length < rendered.length ? "(Older transcript entries were omitted to fit the handoff budget.)" : "",
      "",
      ...kept,
      "# End provider handoff",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Remove ONLY the skill dirs we materialized for this session's query (never a
   *  repo-owned skill). Idempotent — clears the tracked list so it runs once. */
  private cleanupSkills(session: LiveSession): void {
    const dirs = session.materializedSkillDirs;
    session.materializedSkillDirs = undefined;
    if (dirs?.length) void cleanupMaterializedSkills(dirs);
  }

  /* ------------------------------------------------------ persistence */

  private emit(session: LiveSession, msg: ChatMessage): Promise<void> {
    session.writeChain = session.writeChain
      .catch(() => {})
      .then(async () => {
        try {
          const saved = await this.store.appendMessage(msg);
          this.bus.publish({ type: "chat-message", chatId: saved.chatId, message: saved });
        } catch (err) {
          this.bus.publish({
            type: "error",
            chatId: session.chatId,
            message: "failed to persist message",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return session.writeChain;
  }

  private async patchChat(chatId: string, patch: Partial<Chat>): Promise<void> {
    try {
      const saved = await this.store.patchChat(chatId, { ...patch, updatedAt: this.now() });
      if (!saved) return;
      this.bus.publish({ type: "chat-update", chat: saved });
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "failed to update chat",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ---------------------------------------------------------- helpers */

  private toSdkUserMessage(item: OutboxItem): SDKUserMessage {
    // Auto-surfaced memory rides in front of the user's text (SDK-only; the
    // transcript row keeps just item.text) so the agent sees the fact in context.
    const prefix = item.memoryContext ? `${item.memoryContext}\n\n` : "";
    let content: unknown = `${prefix}${item.text}`;
    const sources =
      item.imageSources && item.imageSources.length > 0
        ? item.imageSources
        : (item.images ?? [])
            .map((img) => this.imageSource(img))
            .filter((s): s is Record<string, unknown> => !!s);
    if (sources.length > 0) {
      const blocks: unknown[] = [];
      if (item.memoryContext) blocks.push({ type: "text", text: item.memoryContext });
      if (item.text) blocks.push({ type: "text", text: item.text });
      for (const source of sources) blocks.push({ type: "image", source });
      content = blocks;
    }
    return {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
      priority: item.priority,
    } as unknown as SDKUserMessage;
  }

  private imageSource(img: ImageRef): Record<string, unknown> | undefined {
    if (img.path.startsWith("http://") || img.path.startsWith("https://")) {
      return { type: "url", url: img.path };
    }
    const dataMatch = /^data:([^;]+);base64,(.*)$/.exec(img.path);
    if (dataMatch) {
      return { type: "base64", media_type: dataMatch[1], data: dataMatch[2] };
    }
    // Local file paths are inlined by a higher layer; skip best-effort here.
    return undefined;
  }

  private mustGet(chatId: string): LiveSession {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`No live session for chat ${chatId}`);
    return session;
  }

  private view(s: LiveSession): SessionView {
    return {
      chatId: s.chatId,
      projectId: s.projectId,
      status: s.status,
      modeId: s.modeId,
      effort: s.effort,
      agentId: s.agentId,
      sessionId: s.sessionId,
      started: s.started,
      pendingPermissionIds: [...s.pendingPermissions.keys()],
    };
  }
}
