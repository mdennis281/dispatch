/**
 * manager-mcp — Dispatch's own in-process SDK MCP tools.
 *
 * ONE factory, EIGHT servers. `createManagerTools` builds every tool definition
 * and owns the helpers they share; {@link createManagerMcpServers} partitions
 * that output by {@link ManagerCategory} and hands the SDK one server per
 * category. Registered on EVERY live session (see `SessionBroker.buildOptions`),
 * so the tools appear to the agent as `mcp__dispatch-<category>__<tool>` —
 * `mcp__dispatch-session__wait`, `mcp__dispatch-github__create_pr`.
 *
 * They were a single `manager` server until the split, which is why the names
 * below appear under the retired single-server name in older transcripts; see
 * `@dispatch/shared`'s manager-tools.ts for the registry and the migration.
 *
 * The tools let a chat pace ITSELF against the manager's own state:
 *
 *   - `mcp__dispatch-session__wait({ seconds, reason? })` — sleep for up to
 *     {@link WAIT_CAP_SECONDS}. While parked it publishes a `chat-status`
 *     "waiting Ns: <reason>" activity so the UI shows the self-imposed pause
 *     (reusing the working/typing header mechanism).
 *   - `mcp__dispatch-chat__wait_for_chat({ chatId, timeoutSeconds? })` — block until
 *     ANOTHER chat's broker state reaches a terminal state (idle/done/error),
 *     or the timeout fires. Returns the final state. An unknown chatId yields an
 *     informative (error-flagged) result rather than throwing.
 *   - `mcp__dispatch-github__watch_pr({ number, repo?, timeoutSeconds? })` — watch a
 *     GitHub PR (via {@link ManagerMcpGitHub}, reusing GitHubService's `gh`) and
 *     RETURN THE INSTANT it needs attention: a CI check fails, a new review
 *     thread/comment appears, or it merges/closes. Per-session dedup state means
 *     each new signal is reported exactly once, so an agent calling it in a loop
 *     (fix → watch again) never misses a later round of review comments and never
 *     hand-rolls a `gh pr view` / `gh pr checks` sleep loop or a background watcher.
 *   - `mcp__dispatch-github__create_pr({ title?, body?, base?, draft?, cwd? })` — OPEN the PR
 *     (via {@link ManagerMcpPrCreate}): push with upstream, create, request the
 *     reviewers the project's `workflow.pr.reviewers` declares, write a `PRRef`
 *     onto this chat, and arm the review watcher. Offered whenever the workflow
 *     has `requirePr`, which is the same condition under which the trunk guard
 *     REFUSES a raw `gh pr create` — the two are deliberately symmetric with the
 *     long-standing `gh pr merge` → `approve_pr` pair. Its refusals (on the
 *     trunk, no commits, dirty tree, `hold`) each name an override argument.
 *   - `mcp__dispatch-github__approve_pr({ number, repo?, method?, note? })` — approve and
 *     MERGE a PR (via {@link ManagerMcpPrApproval}), but only after re-reading its
 *     state/checks/threads/labels and finding nothing blocking ({@link prLandingBlockers}).
 *     Offered ONLY when the project's workflow sets `autoMerge: "on-green"`, which
 *     is what makes "the agent lands its own work" a per-project decision rather
 *     than something every session can do. A raw `gh pr merge` stays denied. Its
 *     `allowNoChecks`/`allowNoReview` escape hatches don't grant themselves: a
 *     load-bearing one goes to the human as a permission card and waits
 *     ({@link ManagerMcpPrApproval.confirmOverride}).
 *   - `mcp__dispatch-confirm__request_exemption({ guard, reason, command? })` — ASK the human
 *     to lift ONE command guard for THIS CHAT (see {@link ManagerMcpExemptions}).
 *     The escape hatch for the 2026-08-17 shape of failure: the sanctioned path a
 *     guard redirects to breaks, the guard goes on (correctly) refusing the raw
 *     command, and the chat is stranded with the only exits being a permanent
 *     project-config edit or a server restart. It grants nothing itself — the
 *     human picks whether the grant covers one command or the rest of the chat,
 *     a refusal is final, and the grant dies with the live session. Offered only
 *     where the guard is actually enforcing.
 *   - `mcp__dispatch-chat__spawn_chat({ prompt, projectId?, … })` — start ANOTHER chat
 *     (via {@link ManagerMcpChats}), but only after the human says yes. The
 *     consent rides the broker's ordinary permission channel, so the request
 *     lands as the same card + Attention Queue entry as any tool prompt rather
 *     than as a surface nobody watches. The tool deliberately has NO bypass
 *     argument: only the human's own `spawnChat.autoApprove` setting (global, or
 *     a project's manifest) can skip the prompt, because a gate an agent can
 *     argue its way past is not a gate. A decline comes back as a plain,
 *     non-error result telling it not to retry — a denial is an answer. Because
 *     the tool gates itself, the broker treats it as SELF-GATED and does not
 *     prompt for it at the `canUseTool` layer too (one decision, one prompt) —
 *     which also means the gate holds under `bypassPermissions`, where
 *     `canUseTool` is never consulted.
 *
 * Every handler awaits a REAL promise (a `setTimeout`, a poll `setInterval`,
 * and/or a `chat-status` bus subscription) and unwinds cleanly the instant the
 * owning session aborts
 * (stop/fork) — every timer + listener is cleared on the first settle. This is
 * the reusable in-process-MCP pattern the later Batch-6 features build on: a
 * per-session factory closed over `{ chatId, bus, broker, signal }`.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  MemoryTypeSchema,
  ManifestMcpTransportSchema,
  MERGE_HOLD_LABEL,
  encodePrToolPayload,
  WorkflowExemptionScopeSchema,
  WorkflowMergeMethodSchema,
  describeExemptionScope,
  prReviewAgentView,
  MANAGER_TOOL_CATEGORY,
  managerServerName,
  managerToolQualifiedName,
  AuthoredKindSchema,
  AuthoredScopeSchema,
  isWritableScope,
  type AuthoredItem,
  type AuthoredKind,
  type AuthoredScope,
  type WritableAuthoredScope,
  type ManagerCategory,
  type ManagerToolName,
  type ChatStatus,
  type CheckRun,
  type ContextUsage,
  type PrReviewAgentState,
  type PrSnapshot,
  type PrToolKind,
  type PrToolOutcome,
  type Effort,
  type ManifestMcpServer,
  type ProjectMemory,
  type ReviewDecision,
  type ReviewThread,
  type RegistryScope,
  type TerminalInfo,
  type WorkflowExemption,
  type WorkflowExemptionLifetime,
  type WorkflowExemptionScope,
  type WorkflowMergeMethod,
  type WorktreeInfo,
} from "@dispatch/shared";
import type { EventBus } from "../../bus.js";
import type { SpawnNestingVerdict } from "../chat-nesting.js";
import { clampBody } from "../memory.js";
import type { MemoryGrepMatch, MemoryInventoryEntry } from "../memory.js";
import type { MemoryHistoryResult } from "../memory-history.js";
import { renderFind, renderProject, renderRead } from "../inspect-render.js";
import type {
  FindChatsQuery,
  FindChatsResult,
  ProjectInfoQuery,
  ProjectInfoResult,
  ReadChatQuery,
  ReadChatResult,
} from "../inspect.js";
import type {
  PeerAskResult,
  PeerChatState,
  PeerDelivery,
  PeerReplyResult,
  PeerSendResult,
} from "../chat-messenger.js";

/** Hard ceiling on a single `wait` (also the default `wait_for_chat` timeout). */
export const WAIT_CAP_SECONDS = 3600;

/** How often `watch_pr` re-polls a PR's checks / review threads / merge state. */
export const PR_POLL_INTERVAL_MS = 20_000;

/**
 * Default per-call `watch_pr` timeout (30 min); still capped at
 * {@link WAIT_CAP_SECONDS}. The agent re-calls after each returned batch, so the
 * effective watch is unbounded — this only bounds a single quiet poll window.
 */
export const WATCH_PR_DEFAULT_TIMEOUT_SECONDS = 1800;

/**
 * How long a watch tolerates a PR with NO checks at all before saying so once.
 * Checks take a few seconds to register after a push, so an immediate "no CI
 * here" would be wrong far more often than it was right — but a repo that
 * genuinely has no CI must not cost the agent a silent 30-minute window either.
 */
export const NO_CHECKS_GRACE_MS = 60_000;

/**
 * How long a watch tolerates an EMPTY reviewer queue before reporting it once.
 *
 * A review request takes a moment to register after `create_pr` asks for it, and
 * a bot reviewer can briefly show as neither requested nor reported while it
 * picks the job up. Firing instantly would call that "nobody is queued" — the
 * exact false alarm that makes a signal ignorable. Same shape and reasoning as
 * {@link NO_CHECKS_GRACE_MS}.
 */
export const REVIEW_QUEUE_GRACE_MS = 60_000;

/**
 * How long a CLAIMED-but-unposted review round is presumed to still be running
 * when its chat cannot be found in the broker.
 *
 * The round lease is written BEFORE the reviewer chat exists (see
 * `PrRegistry.claimReviewAgent`), and a chat that has finished is no longer a
 * live session — so `broker.getStatus` answers `undefined` for both "spawning"
 * and "long gone". This window separates them: inside it the round gets the
 * benefit of the doubt, outside it a round that has posted nothing has stopped.
 * A round whose chat IS live overrides the window in either direction, so this
 * only has to cover spawn latency, never the length of a review.
 */
export const REVIEW_ROUND_GRACE_MS = 5 * 60_000;

/** One structured question the manager MCP can put in front of the human. */
export interface ManagerAskQuestion {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** The human's response to a manager-originated question card. */
export type ManagerAskResult =
  | { status: "answered"; answers: Record<string, string> }
  | { status: "declined"; message?: string }
  | { status: "timed_out"; message: string }
  | { status: "unavailable"; message: string };

/** Longest inactivity timeout an agent may put on a question card. */
export const ASK_USER_TIMEOUT_CAP_SECONDS = 3_600;

/**
 * Check conclusions that count as a FAILING check for `watch_pr` — the ones an
 * agent must react to (a red build, a required check it must satisfy). `neutral`,
 * `skipped`, and `success` are not actionable.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "stale",
]);

/** Broker states that end `wait_for_chat` (the target turn/session is at rest). */
const TERMINAL_STATES: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "idle",
  "done",
  "error",
]);

/** The narrow broker surface the manager MCP needs (kept decoupled for tests). */
export interface ManagerMcpBroker {
  /** Is a live session registered for this chat? */
  has(chatId: string): boolean;
  /** Current broker state of a chat's session, if any. */
  getStatus(chatId: string): ChatStatus | undefined;
  /** Live context-window breakdown for a chat (null when not live / unsupported). */
  getContextUsage(chatId: string): Promise<ContextUsage | null>;
  /** Compact a chat's context in place (native SDK `/compact`). */
  compact(chatId: string): void;
  /**
   * Flag that a `watch_pr` on this chat hit a terminal PR state (drives the green
   * "PR done" dot). Pass the PR so the state is stamped on the chat's ref and
   * survives a restart/reload, not just the life of this session.
   */
  markPrWatched(chatId: string, pr?: { number: number; state: "merged" | "closed" }): void;
  /** Ask the human through Dispatch's radio / multi-select question card. */
  askUser(
    chatId: string,
    questions: ManagerAskQuestion[],
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<ManagerAskResult>;
}

/**
 * The narrow terminal surface the manager MCP needs — a single `run` that
 * executes a command in a named PERSISTENT shell (cwd/env survive across calls),
 * already bound to this session's chat + default cwd by the broker.
 */
export interface ManagerMcpTerminals {
  run(args: {
    name: string;
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    background?: boolean;
  }): Promise<{
    output: string;
    exitCode: number | null;
    cwd: string;
    error?: string;
    timedOut?: boolean;
    backgrounded?: boolean;
  }>;
  /** Recent output of a named shell — how a backgrounded command is read back. */
  tail(args: {
    name: string;
    lines?: number;
    /** Substring filter; a watcher's tail is mostly noise without one. */
    q?: string;
    /** Only lines at/after this epoch-ms — "what's new since I last looked". */
    since?: number;
    stream?: "stdout" | "stderr";
  }): Promise<{ output: string; found: boolean }>;
  /** The shell roster, filtered — how an agent finds a terminal it has lost. */
  list(args: { scope?: RegistryScope; q?: string }): TerminalInfo[];
}

/**
 * The narrow worktree surface, bound to this session's chat + project.
 *
 * This exists so an agent NEVER has to run `git worktree add` — which the shell
 * guard now refuses. Going through here is what puts a row in the catalog with
 * this chat's id on it at the moment of creation, instead of leaving the
 * detector to work out afterwards whose tree it was.
 */
export interface ManagerMcpWorktrees {
  create(args: { branch: string; base?: string; label?: string }): Promise<WorktreeInfo>;
  /** Defaults to this chat's worktrees; widen with `scope`. */
  list(args: { scope?: RegistryScope; q?: string }): Promise<WorktreeInfo[]>;
  remove(args: { path: string; force?: boolean }): Promise<void>;
}

/**
 * The narrow project-memory surface the manager MCP needs — already bound to the
 * session's project by the broker, so the agent just names the fact. Omitted when
 * the session has no project (then the `remember` / `recall` / `forget` tools
 * aren't offered).
 */
export interface ManagerMcpMemory {
  remember(input: {
    name: string;
    description: string;
    type: "user" | "feedback" | "project" | "reference";
    body: string;
  }): Promise<ProjectMemory>;
  recall(
    query?: string,
    opts?: { type?: "user" | "feedback" | "project" | "reference" },
  ): Promise<{ index: string; matches: ProjectMemory[] }>;
  forget(name: string): Promise<boolean>;
  /**
   * Pre-existing memories that closely resemble a `remember` candidate — powers
   * the dedup nudge (consolidate instead of accumulating a second copy). Bound to
   * the session's project by the broker. Best-effort; may be omitted on older
   * wiring, so callers must treat it as optional.
   */
  findSimilar?(
    candidate: { name: string; description?: string; body?: string },
    /** Widen/narrow the sweep. Omitted → the dedup nudge's own defaults. */
    opts?: { threshold?: number; limit?: number },
  ): Promise<Array<{ name: string; description: string; similarity: number }>>;
  /**
   * The CURATION half of the memory surface, backing `memory_list` /
   * `memory_search` / `memory_history`. Separate from remember/recall/forget
   * because those answer "what should I know right now" (fuzzy, ranked, bounded)
   * while these answer "what is in this store and does it still belong"
   * (exhaustive, exact, with the age and usage signals attached).
   *
   * All optional so older wiring — and every existing test stub — keeps working;
   * a missing one reports itself unavailable rather than breaking the tool.
   */
  inventory?(opts: {
    type?: "user" | "feedback" | "project" | "reference";
    prefix?: string;
    names?: readonly string[];
  }): Promise<MemoryInventoryEntry[]>;
  grep?(opts: {
    pattern: string;
    regex?: boolean;
    caseSensitive?: boolean;
    field?: "name" | "description" | "body";
    limit?: number;
  }): Promise<{
    matches: MemoryGrepMatch[];
    truncated: boolean;
    timedOut?: boolean;
    scanned: number;
  }>;
  /** One memory by exact name — no ranking, no near-misses. */
  read?(name: string): Promise<ProjectMemory | null>;
  history?(opts: { name?: string; limit?: number }): Promise<MemoryHistoryResult>;
}

/**
 * The authored-guidance surface behind the `config_*` tools — instructions and
 * skills, already bound to this session's project by the broker so the agent
 * just names the item. Omitted when the session has neither a project nor a
 * global root (then the tools aren't offered at all).
 *
 * `scope` is resolved by the IMPLEMENTATION, not the tool: reads search
 * most-specific-first (project → global → shipped) so a plain name finds the
 * copy actually in effect, while writes must name a writable scope.
 */
export interface ManagerMcpAuthoring {
  /** Every item of a kind, across every scope, in listing order. */
  list(kind: AuthoredKind): Promise<AuthoredItem[]>;
  /** One item's raw file. Without `scope`, the most specific match wins. */
  read(
    kind: AuthoredKind,
    name: string,
    scope?: AuthoredScope,
  ): Promise<{ scope: AuthoredScope; path: string; text: string } | null>;
  write(input: {
    kind: AuthoredKind;
    scope: WritableAuthoredScope;
    name: string;
    description?: string;
    body: string;
  }): Promise<{ path: string; registered: boolean }>;
  remove(kind: AuthoredKind, name: string, scope: WritableAuthoredScope): Promise<boolean>;
  /**
   * Whether this session has a project to write `.dispatch/` config into. Decides
   * the DEFAULT scope, and lets a `scope:'project'` call be refused with a real
   * reason instead of writing somewhere surprising.
   */
  hasProject: boolean;
}

/** Merge/close-state view of a PR the `watch_pr` tool polls on. */
export interface PrPollResult {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
}

/**
 * ONE poll of a PR: its merge/close state plus every signal the watch reacts to,
 * read together.
 *
 * They travel together because they are now READ together — one GraphQL query
 * rather than the five `gh` subprocess spawns this tool used to make per poll
 * (see `GitHubService.pollPrState`). The same body feeds the background sweep
 * and the PR catalog, so the app and the agent can no longer hold different
 * beliefs about the same pull request.
 *
 * The three signal fields stay INDEPENDENTLY nullable even though the real
 * binding always fills them in. `null` means "this poll carried no read of that
 * signal", which is a different claim from an empty array — an empty check list
 * is what makes `no-checks` honest, and an empty reviewer queue is what makes
 * `review-stalled` fire. Collapsing the two would turn a failed read into a
 * confident false alarm, which is the exact bug the review-queue code exists to
 * prevent.
 */
export interface PrWatchSnapshot extends PrPollResult {
  /* Structurally a subset of `GitHubService`'s PrPollSnapshot; kept separate so
     this module stays decoupled from that service, as the rest of it is. */
  checks: CheckRun[] | null;
  threads: ReviewThread[] | null;
  review: {
    requested: string[];
    reported: Array<{ author: string; state: string }>;
  } | null;
}

/**
 * What a submitted review actually became.
 *
 * `event` is reported back because it may not be the one that was asked for:
 * GitHub refuses `REQUEST_CHANGES` on your own pull request, and Dispatch posts
 * under the human's own token unless a machine account is configured — so a
 * downgrade to `COMMENT` is the ordinary case, not an error. It is surfaced
 * rather than swallowed because the agent asked to block a merge and did not.
 */
export interface SubmitReviewOutcome {
  posted: boolean;
  url?: string;
  event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  /** Findings GitHub would not attach to a line, folded into the summary instead. */
  droppedComments?: number;
  error?: string;
}

/**
 * The narrow GitHub surface the manager MCP needs to watch a PR — already bound
 * to this session's default repo (its worktree cwd, else the project root) by
 * the broker. `repo` is an optional `owner/name` override.
 *
 * `pollPrState` null = no snapshot could be produced (unknown PR, unresolvable
 * repo, gh/GraphQL failure) and ENDS the watch as an error — the same contract
 * the merge-state read has always had, now covering the whole poll because the
 * whole poll is one call. Omitted from the ctx → the `watch_pr` tool isn't
 * offered.
 */
/**
 * A Copilot premium-request budget, as the empty-queue explainer reads it.
 *
 * Structural rather than imported from `github.js`, like every other GitHub
 * shape in this file — see {@link ManagerMcpGitHub}. `exhausted` is the only
 * required field because it is the only one the explanation cannot omit; the
 * numbers are there to make the sentence concrete when they are available.
 */
export interface CopilotQuotaFacts {
  entitlement?: number;
  used?: number;
  resetDate?: string;
  exhausted: boolean;
}

export interface ManagerMcpGitHub {
  pollPrState(prNumber: number, repo?: string): Promise<PrWatchSnapshot | null>;
  /** Put reviewers back on the hook. Omitted → the `request_review` tool isn't offered. */
  requestReviewers?(
    prNumber: number,
    reviewers: readonly string[],
    repo?: string,
  ): Promise<{ requested: string[]; failed: Array<{ reviewer: string; error: string }> }>;
  /** Reply in a review thread. Paired with `resolveThread` by `resolve_thread`. */
  replyToThread?(threadId: string, body: string): Promise<void>;
  /** Mark a review thread resolved. Omitted → the `resolve_thread` tool isn't offered. */
  resolveThread?(threadId: string): Promise<{
    dismissedReviews: number;
    dismissalError?: string;
  }>;
  /**
   * Submit a review — verdict, summary, inline comments. Omitted → the
   * `post_review` tool isn't offered, which is how it stays absent on every
   * project that has not configured a Dispatch reviewer.
   */
  submitReview?(
    prNumber: number,
    input: {
      event: "COMMENT" | "REQUEST_CHANGES";
      body: string;
      comments?: ReadonlyArray<{
        path: string;
        line: number;
        startLine?: number;
        side?: "LEFT" | "RIGHT";
        body: string;
      }>;
      commitId?: string;
    },
    repo?: string,
  ): Promise<SubmitReviewOutcome>;
  /**
   * Ask Dispatch's OWN reviewer to look at a PR.
   *
   * Bound only where the project configures a review agent with no GitHub login
   * — the mode where there is no account to put in GitHub's reviewer queue, so
   * the request is recorded on the PR's registry row instead and the background
   * sweep spawns off it. `request_review` calls this ALONGSIDE the GitHub
   * request rather than instead of it, because a project can genuinely want
   * both: a bot on GitHub and a reviewer here.
   */
  requestReviewAgent?(prNumber: number, repo?: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * The reviewers this project asks for (`workflow.pr.reviewers`), so
   * `request_review` has a default and the stalled-queue report can name them.
   */
  defaultReviewers?: readonly string[];
  /**
   * The GitHub login Dispatch's OWN reviewer posts as, when the project uses a
   * dedicated account. Absent in self-review mode, where the reviewer has no
   * account and is asked through {@link requestReviewAgent} instead.
   *
   * `request_review` needs it to tell its own spent reviewer apart from every
   * other name on the list. Without it the spent-cap refusal aborted the whole
   * tool, so `request_review({ reviewers: ["alice"] })` on a project whose
   * Dispatch reviewer was done reported success and never queued alice.
   */
  reviewAgentLogin?: string;
  /**
   * The account's Copilot premium-request budget — asked ONLY when a Copilot
   * reviewer has already been seen vanishing from the queue, to say whether the
   * budget is why. Best-effort and undocumented upstream; null means "couldn't
   * tell", never "fine". See `GitHubService.copilotQuota`.
   */
  copilotQuota?(): Promise<CopilotQuotaFacts | null>;
  /**
   * Report that the watched PR has MERGED. Most merges here are performed by the
   * repo's auto-merge job rather than by us, so `watch_pr` observing the terminal
   * state is the only moment the manager learns about them — and it's what lets
   * the primary checkout follow the trunk afterwards.
   */
  notePrMerged?(): void;
}

/* ---------------------------------------------------------------- create_pr */

/**
 * The branch state `create_pr` checks before opening anything. Mirrors
 * {@link import("../github.js").PrCreatePreflight}; kept structural so this
 * module stays decoupled from GitHubService.
 */
export interface PrCreateState {
  branch: string | null;
  trunk: string;
  base: string;
  /** null = we genuinely couldn't tell (no local base ref, shallow clone). */
  aheadOfBase: number | null;
  dirty: boolean;
  /** A PR that already exists for this branch, if any. */
  existing: { number: number; url: string; state: string; labels: string[] } | null;
  /**
   * The directory actually inspected. Reported in every refusal, because the
   * whole class of bug here is looking at the wrong checkout and saying nothing
   * about it. See {@link PrCreateWhere}.
   */
  cwd: string;
}

/** The escape hatches a caller passes when it genuinely knows better. */
export interface PrCreateOverrides {
  allowTrunk?: boolean;
  allowNoCommits?: boolean;
  allowDirty?: boolean;
  allowHold?: boolean;
}

/** One reason a PR may not be opened, with the sentence shown to the agent. */
export interface PrCreateBlocker {
  code: "detached" | "on-trunk" | "no-commits" | "dirty" | "hold";
  detail: string;
}

/**
 * Decide whether a branch may have a PR opened on it, and say exactly why not.
 *
 * Pure + exhaustive, exactly like {@link prLandingBlockers}: one complete list
 * rather than one obstacle per round-trip.
 *
 * The owner's chosen posture here is **enforce, with an escape hatch** — so
 * every refusal NAMES the argument that overrides it. A guard with no override
 * is a guard that gets routed around the first time it's wrong (that's how the
 * hand-rolled `gh pr create` happened in the first place); one that makes the
 * override explicit and auditable gets used correctly instead.
 *
 * An existing PR is deliberately NOT a blocker — see the tool, which returns it.
 */
export function prCreateBlockers(
  st: PrCreateState,
  overrides: PrCreateOverrides = {},
): PrCreateBlocker[] {
  const blockers: PrCreateBlocker[] = [];

  if (!st.branch) {
    blockers.push({
      code: "detached",
      detail:
        "This checkout is on a detached HEAD, so there's no branch to open a PR from. " +
        "Check out a task branch first.",
    });
    // Everything below is about a named branch; piling on is just noise.
    return blockers;
  }
  if (st.branch === st.trunk && !overrides.allowTrunk) {
    blockers.push({
      code: "on-trunk",
      detail:
        `You're on \`${st.trunk}\`, the protected trunk — a PR from the trunk to itself is ` +
        "not the workflow. Get a task worktree and branch, then open the PR from there. " +
        "Pass `allowTrunk: true` only if this repo genuinely PRs from its default branch.",
    });
  }
  // `null` means the probe couldn't tell — don't block on a guess (same rule the
  // trunk guard follows: a false positive is worse than a miss).
  if (st.aheadOfBase === 0 && !overrides.allowNoCommits) {
    blockers.push({
      code: "no-commits",
      detail:
        `This branch has no commits that \`${st.base}\` doesn't already have, so the PR ` +
        "would be empty. Commit your work first. Pass `allowNoCommits: true` to open it anyway.",
    });
  }
  if (st.dirty && !overrides.allowDirty) {
    blockers.push({
      code: "dirty",
      detail:
        "The working tree has uncommitted changes — they would NOT be in the PR, so the " +
        "reviewer would be reading a different change than the one you made. Commit them " +
        "(or stash them) first, or pass `allowDirty: true` if leaving them out is deliberate.",
    });
  }
  if (
    st.existing?.labels.some((l) => l.toLowerCase() === MERGE_HOLD_LABEL) &&
    !overrides.allowHold
  ) {
    blockers.push({
      code: "hold",
      detail:
        `The existing PR for this branch carries the \`${MERGE_HOLD_LABEL}\` label — someone ` +
        "parked it deliberately. Leave it alone and say so; pass `allowHold: true` only if " +
        "the human just told you to proceed.",
    });
  }

  return blockers;
}

/** What `create_pr` produced, for the summary it hands back to the agent. */
export interface PrCreateResult {
  number: number;
  url: string;
  branch: string;
  base: string;
  draft: boolean;
  /** Reviewers actually requested. */
  reviewersRequested: string[];
  /** Reviewers the request FAILED for (bad login, no access, bot not installed). */
  reviewersFailed: Array<{ reviewer: string; error: string }>;
  /** Whether the PR was recorded on this chat (the ownership record). */
  attached: boolean;
  /** Whether the server-side review watcher is now watching it. */
  watching: boolean;
}

/**
 * The PR-CREATION surface, bound by the broker when the project's workflow has
 * `requirePr`. This is the sanctioned path the guard redirects a raw
 * `gh pr create` to, and it exists because every one of the things it does was
 * something the hand-rolled command silently skipped:
 *
 *   push with upstream → create → REQUEST THE CONFIGURED REVIEWERS → record the
 *   PR on this chat (`Chat.prs`, the ownership record) → ARM THE WATCHER.
 */
export interface ManagerMcpPrCreate {
  /** Reviewers the project configured (`workflow.pr.reviewers`). */
  reviewers: readonly string[];
  /** Whether the project opens PRs as drafts by default. */
  draft: boolean;
  /**
   * Fresh branch state; null = the repo couldn't be resolved from this session.
   *
   * `cwd` overrides the directory inspected — see {@link PrCreateWhere}. The
   * resolved directory comes back on the state so every refusal can say WHERE it
   * looked, which is the difference between "get a worktree" (baffling, when you
   * are standing in one) and "I inspected X, which is on main".
   */
  preflight(base?: string, cwd?: string): Promise<PrCreateState | null>;
  /** Do all five steps. Throws with the underlying message when git/gh refuses. */
  create(input: {
    base?: string;
    title?: string;
    body?: string;
    draft: boolean;
    cwd?: string;
  }): Promise<PrCreateResult>;
}

/**
 * Why `create_pr` takes a directory at all.
 *
 * The binding's cwd is fixed when the SESSION is built — `session.worktreeCwd ??
 * project.repoPath`. That is right for a chat given a Dispatch worktree up front,
 * and wrong for every other way an agent legitimately ends up somewhere else:
 * the Claude Code harness's own `EnterWorktree` moves the agent into
 * `.claude/worktrees/<name>` without telling the server, and a session that
 * started in the primary checkout can be handed a worktree later.
 *
 * The failure this caused is not a refusal to work — it is a refusal that reads
 * as the OPPOSITE of the truth. On 2026-08-08 a complete, committed, tested
 * change sat on a task branch while `create_pr` reported `on-trunk` and
 * `no-commits`, because it had inspected the primary checkout. Both overrides it
 * named (`allowTrunk`, `allowNoCommits`) would have opened an EMPTY `main`→`main`
 * PR — the guard's own escape hatches pointed away from the fix.
 *
 * So: let the caller say where, and VALIDATE it — the directory must be a
 * worktree of the same repository the chat is bound to. That keeps the useful
 * case (this repo's other worktree) and refuses the dangerous one (some other
 * repo entirely, or another project's checkout).
 *
 * The validation is against a LIVE directory, which is not always the bound one:
 * a chat's worktree can be removed out from under it after a merge, and a
 * directory with no git identity answers "not the same repository" about
 * everything, so validating against one would reject every hint including the
 * right one. See `makeDirResolver` in session-broker.ts.
 *
 * In the corner where the chat has NO live directory at all — bound cwd dead,
 * every recorded worktree dead, project record missing — there is nothing left
 * to validate against and a hint that is itself a checkout is taken as given.
 * The `cwd` argument's description says so; the guarantee is real but
 * conditional, and stating it unconditionally would be the more dangerous
 * error.
 */
export type PrCreateWhere = string | undefined;

/**
 * Everything `approve_pr` needs to decide whether a PR may LAND — read fresh at
 * the moment of the call, never from what the session saw earlier. A merge
 * decision made on a stale snapshot is the one failure mode that actually costs
 * something here, so nothing in this shape is cached.
 */
export interface PrReadiness {
  number: number;
  url?: string;
  title?: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  /** GitHub's mergeability verdict; null/undefined = not computed yet. */
  mergeable?: boolean | null;
  /** Raw `mergeStateStatus` (CLEAN/BLOCKED/BEHIND/DIRTY/UNSTABLE), for reporting. */
  mergeStateStatus?: string;
  reviewDecision?: ReviewDecision | null;
  labels: string[];
  checks: CheckRun[];
  /** null = the threads couldn't be READ — a blocker, not an empty list. */
  threads: ReviewThread[] | null;
  /**
   * Reviewers with an OUTSTANDING request — asked, but they haven't reported.
   * Distinct from "nobody was ever asked", which is a different failure.
   *
   * `null` = the review state couldn't be READ, exactly like {@link threads}.
   * An unreadable state must not collapse into the empty list: empty means
   * "nobody was asked", which sends the agent off to re-open the PR through
   * `create_pr`, when the truth was a transient API failure (review caught
   * this). Both review fields go null together — they come from one call.
   */
  requestedReviewers: string[] | null;
  /** Reviews that have actually been SUBMITTED (author + state). `null` as above. */
  submittedReviews: Array<{ author: string; state: string }> | null;
  /**
   * Every review ever submitted by someone other than the PR's author — see
   * {@link PrReviewState.everReported}. `null` as above.
   *
   * Separate from {@link submittedReviews} because GitHub empties that list the
   * moment a reviewer is re-queued, and re-queueing is what the loop DOES:
   * `watch_pr` reports a finding, the agent fixes it and calls `request_review`,
   * and `approve_pr` then declared that nobody had ever reviewed a PR with two
   * reviews on it. That disagreement between the two tools is the bug this
   * field exists to end.
   */
  everSubmittedReviews: Array<{
    author: string;
    state: string;
    /**
     * They judged a commit that is no longer this PR's head. `undefined` = we
     * could not compare, which must not read as either — see
     * {@link PrReviewState.everReported}.
     */
    stale?: boolean;
  }> | null;
  /**
   * Dispatch's OWN reviewer on this PR: has it used every round it is allowed,
   * and did any of them actually file a review.
   *
   * The other half of the same disagreement. `watch_pr` reads this row to say
   * "the reviewer is DONE, go merge"; `approve_pr` read only GitHub and said
   * "nobody has reviewed". One of them had to start reading the other's
   * evidence, and the round record is the one that cannot be erased by a
   * re-request.
   *
   * `posted` is required for the bar and deliberately so: a cap spent by rounds
   * that all died before filing anything is a broken reviewer, not a completed
   * review, and merging on it would be the silent unreviewed merge this whole
   * policy exists to prevent. That case still raises `no-review` for the human.
   */
  reviewRounds: { roundsSpent: boolean; posted: boolean; round: number; maxRounds?: number } | null;
  /**
   * Why Dispatch's own reviewer cannot run on this project, when it cannot.
   *
   * Separate from {@link reviewRounds} because the two describe opposite states
   * and only one of them is a cap: rounds are about a reviewer that ran, this is
   * about one that never can. It is also why `reviewRounds` is `null` in this
   * case — `spentReviewRounds` answers null for a row with no cap recorded, so
   * without this field a reviewer blocked from ever starting looks exactly like
   * a project that never configured one.
   */
  reviewAgentProblem?: string | null;
}

/**
 * The project's landing policy, plus the per-call escape hatches. Passed in
 * rather than read from a module global so {@link prLandingBlockers} stays pure
 * and every combination is directly testable.
 */
export interface PrLandingPolicy {
  /** `workflow.pr.requireChecks` — zero checks reported is NOT green. */
  requireChecks?: boolean;
  /** `workflow.pr.requireReview` — a requested reviewer must have reported. */
  requireReview?: boolean;
  /**
   * `workflow.pr.reviewers` — who this project asks. Only used to make the
   * `no-review` blocker say the RIGHT thing: "waiting on X" and "nobody was
   * asked because this project configures no reviewers at all" are different
   * problems with different fixes, and telling an agent to re-open the PR when
   * the reviewer list is empty sends it round a loop that cannot terminate.
   */
  reviewers?: readonly string[];
  /** Caller override: land anyway on a repo that reports no checks. */
  allowNoChecks?: boolean;
  /** Caller override: land anyway with nobody having reviewed. */
  allowNoReview?: boolean;
}

/**
 * The PR-landing surface, bound by the broker ONLY when the project's workflow
 * has `autoMerge: "on-green"`. Omitted from the ctx → the `approve_pr` tool isn't
 * offered at all, which is the enforcement: a session on a project that hasn't
 * opted in has no way to merge anything (a raw `gh pr merge` is separately denied
 * by the trunk guard).
 */
/**
 * The PR catalog, as the manager tools need it.
 *
 * Deliberately narrow and deliberately best-effort: a tool's job is to open,
 * watch or land a pull request, and it must not fail because the catalog could
 * not be read. Every method may answer null, and every caller treats that as
 * "no card, just prose".
 */
export interface ManagerMcpPrRegistry {
  /** The PR as the catalog currently has it. */
  snapshot(prNumber: number, repo?: string): Promise<PrSnapshot | null>;
  /** Poll GitHub NOW, record it, and return the fresh snapshot. */
  refresh(prNumber: number, repo?: string): Promise<PrSnapshot | null>;
  /**
   * Report that an agent is blocked on this PR, which puts the background sweep
   * on its fast cadence. Called on every `watch_pr` poll — the window lapses on
   * its own, so a watch that dies with its session costs nothing.
   */
  noteWatched(prNumber: number, repo?: string): Promise<void>;
  /**
   * Poll and record the PR that owns this review THREAD.
   *
   * `resolve_thread` knows a thread id and nothing else — nobody asks the agent
   * which PR it belongs to. The catalog already holds every tracked PR's
   * threads, so it can answer, and that is what turns a resolve from an opaque
   * node id into a card about a pull request.
   */
  refreshByThread(threadId: string): Promise<PrSnapshot | null>;
  /**
   * The same lookup WITHOUT polling GitHub — for the paths that failed, or that
   * deliberately changed nothing. A card is still worth showing there; a GitHub
   * call to draw it is not.
   */
  snapshotByThread(threadId: string): Promise<PrSnapshot | null>;
  /**
   * Dispatch's own reviewer on this PR — the block `PrSnapshot` deliberately
   * omits, because it is bookkeeping rather than a picture of the PR.
   *
   * `watch_pr` needs it because the reviewer's round cap is a stop that GitHub
   * cannot see: the queue can hold a request that nothing will ever serve, so
   * every GitHub-side signal says "a review is coming" while the sweep has
   * permanently stopped spawning. Costs no GitHub call — the row already knows.
   */
  reviewAgent(prNumber: number, repo?: string): Promise<PrReviewAgentState | null>;
  /**
   * Raise THIS PR's review-round cap by `extra`, for the agent that has a real
   * reason to want another look after the project's allowance is spent.
   *
   * Per-PR rather than a config edit, and additive rather than absolute: the
   * project's `maxRounds` is standing policy, and one stubborn pull request is
   * not a reason to rewrite it for every future one. Optional so older fakes
   * stay valid — absent just means the override isn't offered.
   */
  raiseReviewRoundCap?(prNumber: number, repo: string | undefined, extra: number): Promise<void>;
  /**
   * Report that this session just posted a review on a PR, so the catalog can
   * tell a reviewer that FINISHED from one still reading the diff. The lease
   * that spawned the reviewer is taken minutes earlier, before the chat exists,
   * so it cannot answer that — see `PrReviewAgentStateSchema.postedAt`.
   */
  /**
   * Report what GitHub said about each reviewer it would NOT queue, so a refusal
   * outlives the tool result that mentioned it once. Passing an empty list is
   * the CLEAR — a request that refused nobody is what makes a recorded refusal
   * stale. The binding decides which of these is Dispatch's own reviewer.
   */
  noteReviewRequestError(
    prNumber: number,
    repo: string | undefined,
    failed: ReadonlyArray<{ reviewer: string; error: string }>,
  ): Promise<void>;
  notePostedReview(
    prNumber: number,
    repo: string | undefined,
    by: {
      findings?: number;
      event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
    },
  ): Promise<void>;
}

export interface ManagerMcpPrApproval {
  /** Fresh readiness snapshot; null = the PR/repo couldn't be resolved. */
  readiness(prNumber: number, repo?: string): Promise<PrReadiness | null>;
  /**
   * Submit an approving review. Best-effort: GitHub refuses self-approval, and
   * the PR is usually ours, so `approved:false` is an ordinary outcome that must
   * NOT stop the merge — it just changes what we tell the agent happened.
   */
  approve(
    prNumber: number,
    repo: string | undefined,
    body: string,
  ): Promise<{ approved: boolean; error?: string }>;
  /** Land the PR. Throws with gh's message when GitHub refuses. */
  merge(
    prNumber: number,
    repo: string | undefined,
    method: WorkflowMergeMethod,
  ): Promise<void>;
  /**
   * Put a load-bearing `allowNoChecks` / `allowNoReview` in front of the HUMAN
   * and block until they answer.
   *
   * This exists because of a specific merge that should not have happened: the
   * human said "pr it and merge", `approve_pr` correctly refused with
   * `no-review`, and the agent then re-called it with `allowNoReview: true`,
   * reasoning that "merge" had authorised an UNREVIEWED merge. It hadn't — the
   * reviewer reported two minutes after the branch was gone.
   *
   * The flaw was structural, not a lapse of judgement: an override whose whole
   * justification is "the human told me to" was self-certified by the one party
   * who cannot be a witness to that. So the flag no longer decides anything. It
   * asks, on the session's ordinary permission channel, and the merge waits.
   * Required rather than optional so no binder can quietly omit it; a denial
   * (or no live session to ask through) leaves the blocker standing.
   */
  confirmOverride(input: {
    number: number;
    title?: string;
    url?: string;
    /** The blockers the override would suppress — what the human is agreeing to. */
    blockers: PrLandingBlocker[];
  }): Promise<{ approved: boolean; message?: string }>;
  /** The project's configured merge strategy (the agent may override per call). */
  defaultMethod: WorkflowMergeMethod;
  /**
   * The project's declared landing bar (`workflow.pr.requireChecks` /
   * `requireReview`). Bound here rather than re-resolved in the tool so the
   * config the human authored is the config that gets enforced.
   */
  policy: PrLandingPolicy;
}

/** One reason a PR may not be landed, with the sentence shown to the agent. */
export interface PrLandingBlocker {
  code:
    | "not-open"
    | "draft"
    | "hold"
    | "changes-requested"
    | "checks-failing"
    | "checks-pending"
    | "threads-unreadable"
    | "unresolved-threads"
    | "conflict"
    /** `requireChecks` and NO check reported at all — green on no evidence. */
    | "no-checks"
    /** `requireReview` and no requested reviewer has reported yet. */
    | "no-review"
    /** `requireReview` and the review state couldn't be read — not the same as none. */
    | "review-state-unreadable";
  detail: string;
}

/**
 * Decide whether a PR may be landed, and say exactly why not.
 *
 * Pure and exhaustive on purpose: it returns EVERY blocker rather than the first,
 * so an agent that calls `approve_pr` too early gets one complete to-do list
 * instead of discovering the next obstacle per round-trip. The rules are the same
 * ones a careful human applies before clicking merge — plus {@link MERGE_HOLD_LABEL},
 * which is how a human parks one specific PR without switching the feature off.
 *
 * An unreadable thread list BLOCKS. Everywhere else in this file a failed read
 * degrades to "nothing new"; here it would mean merging over review comments we
 * simply couldn't see, so it's the one place that fails closed.
 *
 * Two of the rules exist because of a specific observed failure: on a repo with
 * ZERO checks reporting, "CI is green" was trivially true, so `autoMerge:
 * on-green` was a promise about nothing and this function would have waved a
 * PR through that no machine and no human had looked at. `requireChecks`
 * distinguishes "checks passed" from "no checks reported"; `requireReview`
 * distinguishes "review is clean" from "nobody has looked yet". Both are
 * overridable per call, because a repo that legitimately has no CI has to be
 * able to say so out loud rather than by the absence of evidence.
 */
/**
 * The card the human reads before an override lands a PR their project's own bar
 * says isn't ready.
 *
 * Pure and separate from the tool so the wording is directly testable — this is
 * the entire content of a decision that cannot be taken back, and "merge it
 * anyway?" with no statement of what "anyway" is covering would be a rubber
 * stamp with extra steps.
 */
export function overrideConsentPrompt(
  pr: { number: number; title?: string; url?: string },
  suppressed: PrLandingBlocker[],
): { title: string; description: string } {
  const codes = new Set(suppressed.map((b) => b.code));
  const what =
    codes.has("no-review") && codes.has("no-checks")
      ? "nobody has reviewed it and no CI reported"
      : codes.has("no-review")
        ? "nobody has reviewed it"
        : codes.has("no-checks")
          ? "no CI check reported"
          : "this project's landing bar isn't met";
  return {
    title: `Merge PR #${pr.number} even though ${what}?`,
    description: [
      pr.title ? `PR #${pr.number}: ${pr.title}` : `PR #${pr.number}`,
      pr.url,
      "",
      "The agent asked to override this project's landing bar:",
      ...suppressed.map((b) => `  · ${b.detail}`),
      "",
      "Say no to leave the PR open.",
    ]
      .filter((l) => l !== undefined)
      .join("\n"),
  };
}

/* ------------------------------------------------- guard-exemption consent */

/**
 * The three answers the exemption card offers.
 *
 * Exported constants rather than inline strings because the card BUILDS them and
 * the broker READS them back out of the human's answer — a typo that made those
 * two disagree would silently turn every "yes" into a denial, which is the one
 * failure mode a consent surface can't be allowed to have quietly.
 */
export const EXEMPTION_ANSWERS: Record<WorkflowExemptionLifetime | "no", string> = {
  once: "Just this once",
  session: "Rest of this chat",
  no: "No — keep the guard",
};

/**
 * The card the human reads before a guard stops applying to a chat.
 *
 * A QUESTION card, not the binary approve/deny one `approve_pr`'s override uses,
 * for one reason: the lifetime is part of the decision and only the human is in
 * a position to make it. "Just this once" and "rest of this chat" answer
 * different situations — a one-off vs. a sanctioned path that is down for the
 * session — and an agent allowed to propose which it needed would always propose
 * the generous one. Both ride the same permission channel, so this is still the
 * same Attention Queue entry, notifier webhook and teardown-denies-pending
 * behaviour as any tool prompt.
 *
 * Pure and separate from the tool so the wording is directly testable. The card
 * states the COMMAND and the agent's stated reason verbatim: "lift a guard?"
 * with neither of those is a rubber stamp with extra steps.
 */
export function exemptionConsentQuestion(input: {
  scope: WorkflowExemptionScope;
  command?: string;
  reason: string;
}): ManagerAskQuestion {
  const lines = [
    `The agent is blocked by Dispatch's workflow guard on ${describeExemptionScope(input.scope)}. ` +
      `Lift it for THIS CHAT only?`,
  ];
  // `all` is the one grant that covers guards nobody discussed, so it says so in
  // its own sentence rather than hiding inside a scope label.
  if (input.scope === "all") {
    lines.push(
      "⚠️ This is EVERY workflow guard at once — trunk commits, trunk pushes, hand " +
        "merges and hand-opened PRs all stop being refused in this chat.",
    );
  }
  if (input.command) lines.push(`It wants to run: ${clip(input.command, 300)}`);
  lines.push(`Its reason: ${clip(input.reason, 500)}`);
  lines.push(
    "Nothing outside this chat changes, and the grant dies with this session.",
  );
  return {
    header: "Lift a guard?",
    question: lines.join("\n\n"),
    options: [
      {
        label: EXEMPTION_ANSWERS.once,
        description:
          "Lifts it for the single next command that trips this guard, then it's gone.",
      },
      {
        label: EXEMPTION_ANSWERS.session,
        description:
          "Stays lifted until this session ends. Shown as a chip on the chat header, " +
          "where you can revoke it.",
      },
      {
        label: EXEMPTION_ANSWERS.no,
        description: "The refusal stands, and the agent is told not to re-ask.",
      },
    ],
  };
}

/**
 * Map the human's answer back to a lifetime, or null for "not granted".
 *
 * Anything that isn't one of the two YES labels is a NO — including the free-form
 * answer the question card always offers. That direction is deliberate: a human
 * who typed prose instead of picking an option has not agreed to a specific
 * scope, and reading their words as consent is exactly the inference that
 * produced the unreviewed merge `confirmOverride` exists to prevent. Their text
 * still reaches the agent as the reason it was refused.
 */
export function readExemptionAnswer(answer: string | undefined): WorkflowExemptionLifetime | null {
  // The card appends any note the human typed as `<label> — additional
  // instructions: …` (see `answerText`), so an exact-match read would turn
  // "Rest of this chat, but only for PR #93" into a silent DENIAL. Match the
  // chosen label instead. Safe because the three labels share no prefix.
  const picked = (answer ?? "").split(" — additional instructions:")[0]?.trim();
  if (picked === EXEMPTION_ANSWERS.once) return "once";
  if (picked === EXEMPTION_ANSWERS.session) return "session";
  return null;
}

/** Single-line clip for text quoted onto a consent card. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function prLandingBlockers(
  pr: PrReadiness,
  policy: PrLandingPolicy = {},
): PrLandingBlocker[] {
  const blockers: PrLandingBlocker[] = [];

  if (pr.state !== "open") {
    blockers.push({
      code: "not-open",
      detail: `PR #${pr.number} is already ${pr.state} — there's nothing to land.`,
    });
    // Everything below is about an open PR; piling on is just noise.
    return blockers;
  }
  if (pr.isDraft) {
    blockers.push({
      code: "draft",
      detail: "It's still a draft — mark it ready for review before landing it.",
    });
  }
  /**
   * Set when GitHub's aggregate says changes were requested. Emitted only after
   * the thread list is read — a stale verdict with an open thread behind it is
   * still an objection, and the thread count lives further down.
   */
  let changesRequested: { stale: boolean } | null = null;
  if (pr.labels.some((l) => l.toLowerCase() === MERGE_HOLD_LABEL)) {
    blockers.push({
      code: "hold",
      detail:
        `It carries the \`${MERGE_HOLD_LABEL}\` label — someone parked this PR deliberately. ` +
        "Leave it alone and say so; do not remove the label to get around this.",
    });
  }
  if (pr.reviewDecision === "changes_requested") {
    // `reviewDecision` is an AGGREGATE GitHub only clears when the same reviewer
    // submits a fresh APPROVED review. Dispatch's reviewer never submits one —
    // it posts COMMENT or REQUEST_CHANGES and nothing else — and it stops
    // permanently at its round cap. So on a PR it asked for changes on, this
    // blocker had no exit at all: no override takes it, no later round can clear
    // it, and the change simply cannot be landed. PR #149 hit exactly that,
    // with every finding fixed and every thread resolved.
    //
    // Two facts have to hold together to call it stale, and neither is enough
    // alone. The verdict must be about code that has since been REPLACED, and
    // nothing from it may still be open — `open.length` is computed below, so
    // the emit is deferred rather than the condition being duplicated here.
    const staleVerdicts =
      pr.everSubmittedReviews !== null &&
      pr.everSubmittedReviews.some((r) => r.state === "CHANGES_REQUESTED") &&
      pr.everSubmittedReviews
        .filter((r) => r.state === "CHANGES_REQUESTED")
        // `undefined` is "couldn't compare", which must not read as stale.
        .every((r) => r.stale === true);
    changesRequested = { stale: staleVerdicts };
  }

  const failing = pr.checks.filter(
    (c) => c.status === "completed" && c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion),
  );
  if (failing.length) {
    blockers.push({
      code: "checks-failing",
      detail: `${failing.length} check(s) failing: ${failing
        .map((c) => `${c.name} (${c.conclusion})`)
        .join(", ")}.`,
    });
  }
  const pending = pr.checks.filter((c) => c.status !== "completed");
  if (pending.length) {
    blockers.push({
      code: "checks-pending",
      detail: `${pending.length} check(s) still running: ${pending
        .map((c) => c.name)
        .join(", ")}. Call watch_pr until CI settles.`,
    });
  }
  // "No checks reported" is not "checks passed". Under `requireChecks` this repo
  // said it expects CI to have an opinion, so an empty rollup means the evidence
  // isn't in yet (a workflow that failed to trigger, a fork PR awaiting approval)
  // — not that everything is fine.
  if (policy.requireChecks && pr.checks.length === 0 && !policy.allowNoChecks) {
    blockers.push({
      code: "no-checks",
      detail:
        "No checks are reporting on this PR at all, so \"green\" here means nothing was " +
        "ever run. This project's workflow sets `pr.requireChecks`. Either get CI to " +
        "report on it, or pass `allowNoChecks: true` if this repo genuinely has no CI.",
    });
  }

  if (policy.requireReview && !policy.allowNoReview) {
    if (pr.submittedReviews === null || pr.requestedReviewers === null) {
      // Same rule as `threads === null`: an unreadable state is its own blocker.
      // Reporting it as "nobody was asked" would send the agent to re-open the
      // PR through `create_pr` to fix a problem that was a transient API error.
      blockers.push({
        code: "review-state-unreadable",
        detail:
          "Couldn't read this PR's review state, so there's no way to tell whether anyone " +
          "was asked or has reported. This project's workflow sets `pr.requireReview`. " +
          "Try again in a moment.",
      });
    } else {
      // Someone REPORTING is the bar — an outstanding request is the opposite of
      // a review, and the failure this guards against is a PR called done while
      // the reviewer had said nothing at all.
      //
      // Read from `everSubmittedReviews` and NOT from `submittedReviews`, which
      // is GitHub's `latestReviews` and goes empty the instant a reviewer is
      // re-queued. Dispatch's own loop re-queues on every round, so the live
      // list was empty on exactly the PRs that had been reviewed the most: #147
      // carried two `dispatch-review` reviews and was refused for `no-review`
      // two minutes after `watch_pr` said its reviewer was finished.
      const reported = (pr.everSubmittedReviews ?? pr.submittedReviews).filter(
        (r) => r.state !== "PENDING",
      );
      // Dispatch's own round record is the second, independent way the bar is
      // met — the one `request_review` cannot erase. Spent rounds ALONE are not
      // enough: a cap burned by rounds that never filed anything is a broken
      // reviewer, and merging on it is the unreviewed merge this bar exists to
      // stop. `posted` is what makes it evidence.
      const rounds = pr.reviewRounds;
      const roundsMetIt = rounds !== null && rounds.roundsSpent && rounds.posted;
      if (reported.length === 0 && !roundsMetIt) {
        // Three different problems wear the same "nobody has reviewed" face, and
        // only the first is a matter of waiting. Saying "re-open it through
        // create_pr" for all three is what sent an agent round a loop it could
        // not win on a project whose reviewer list was empty — there was no
        // reviewer for create_pr to ask, so the advice could never come true.
        const waiting = pr.reviewAgentProblem
          ? // FIRST, because it outranks every branch below: they all describe a
            // reviewer that could still arrive, and this one never will. It is
            // also the only case with no GitHub-side symptom at all — the queue
            // and the round record are both simply empty, which reads as "not
            // asked yet" right up until you notice it has read that way on every
            // PR the project has ever opened.
            `Dispatch's own reviewer is configured but cannot run: ${pr.reviewAgentProblem} ` +
            "Waiting or re-requesting will not change this — it is a config fix."
          : rounds?.roundsSpent
          ? // Every round claimed and none of them filed. Pointing at watch_pr
            // here is the dead wait `reviews-spent` was added to prevent: no
            // round can spawn, so nothing will ever arrive to change this.
            `Dispatch's reviewer claimed all ${rounds.round} of its ` +
            `${rounds.maxRounds ?? rounds.round} rounds and none of them posted a review — ` +
            "check the reviewer chat. No further round can spawn on its own; " +
            "`request_review` with `extraRounds` can buy one if the reviewer is healthy again."
          : pr.requestedReviewers.length
          ? `Waiting on: ${pr.requestedReviewers.join(", ")}. Call watch_pr until they report.`
          : policy.reviewers?.length
            ? // An OPEN PR with an empty queue is fixed by asking again, not by
              // re-opening it. Pointing at `create_pr` here sent an agent round a
              // loop it could not win: `create_pr` refuses a branch that already
              // has a PR, so the only advice on offer was impossible to take.
              `This project asks ${policy.reviewers.join(", ")} to review, but nobody is ` +
              "currently requested on this PR. Call `mcp__dispatch-github__request_review` to ask " +
              "them (GitHub clears a reviewer's request once they report, and new commits " +
              "do not re-queue them), then watch_pr until they report."
            : "This project configures NO reviewers (`workflow.pr.reviewers` in " +
              "`.dispatch/project.yaml`), so nobody will ever be asked and this PR cannot " +
              "satisfy its own bar. Fix the config rather than working around it.";
        blockers.push({
          code: "no-review",
          detail:
            "Nobody has reviewed this PR yet, and this project's workflow sets " +
            `\`pr.requireReview\`. ${waiting} \`allowNoReview: true\` does not settle this ` +
            "by itself — it puts the question to the human, who has to say yes.",
        });
      }
    }
  }

  if (pr.threads === null) {
    blockers.push({
      code: "threads-unreadable",
      detail:
        "Couldn't read this PR's review threads, so there's no way to tell whether review " +
        "is clean. Try again in a moment.",
    });
  } else {
    const open = pr.threads.filter((t) => !t.isResolved && !t.isOutdated);
    if (open.length) {
      blockers.push({
        code: "unresolved-threads",
        detail: `${open.length} unresolved review thread(s): ${open
          .map((t) => `${t.path ?? "PR"}${t.line ? `:${t.line}` : ""}`)
          .join(", ")}. Fix them and resolve the ones you actually fixed.`,
      });
    }
    // Now that the threads are known: a changes-requested verdict is spent only
    // if the code it judged has been replaced AND it left nothing open. Either
    // half alone is not enough — a stale verdict with an open thread behind it
    // is still an objection, and a resolved thread on the CURRENT head means
    // they asked for changes to code that is still there.
    if (changesRequested && !(changesRequested.stale && open.length === 0)) {
      blockers.push({
        code: "changes-requested",
        detail: "A reviewer requested changes — address them and get a fresh review first.",
      });
    }
  }
  // Threads unreadable: no way to tell whether anything is outstanding, so the
  // verdict stands. `threads-unreadable` is already blocking; this keeps the two
  // consistent rather than quietly forgiving one of them.
  if (changesRequested && pr.threads === null) {
    blockers.push({
      code: "changes-requested",
      detail: "A reviewer requested changes — address them and get a fresh review first.",
    });
  }

  if (pr.mergeable === false) {
    blockers.push({
      code: "conflict",
      detail: `It doesn't merge cleanly${
        pr.mergeStateStatus ? ` (${pr.mergeStateStatus})` : ""
      } — rebase on the trunk and push again.`,
    });
  }

  return blockers;
}

/** A launched subApp runner, as surfaced to the agent. */
export interface ManagerMcpRunnerState {
  subAppId: string;
  status: string;
  url?: string;
  branch?: string;
  port?: number;
}

/**
 * MCP-config editor for this session's project (omitted → no `mcp_*` tools).
 *
 * Backed by the SAME `@dispatch/cli/core` functions the `dispatch mcp` CLI uses, so an agent
 * adding a server in-session and a human adding one at the terminal produce
 * byte-identical config and share every validation rule.
 */
export interface ManagerMcpConfig {
  /** Every server configured in the project's `.dispatch/project.yaml`. */
  list(): Promise<ManifestMcpServer[]>;
  /** Add (or, with `force`, replace) one server. Rejects on a duplicate name. */
  add(
    server: ManifestMcpServer,
    opts: { force?: boolean },
  ): Promise<{ outcome: "added" | "replaced"; manifestPath: string }>;
  /** Remove a server by name; false when there was nothing to remove. */
  remove(name: string): Promise<boolean>;
}

/** SubApp launcher for this session's project (omitted → no `run_subapp` tool). */
export interface ManagerMcpRunner {
  /** SubApps, live runners, and branches for this session's project. */
  overview(chatId: string): Promise<{
    subApps: { id: string; name: string; ports?: number[] }[];
    running: ManagerMcpRunnerState[];
    branches: { name: string; current: boolean; hasWorktree: boolean }[];
  }>;
  /** Launch a subApp on a branch (default: the project's current branch). */
  launch(input: {
    chatId: string;
    subAppId: string;
    branch?: string;
  }): Promise<ManagerMcpRunnerState>;
  /** Stop a subApp's running instance (optionally scoped to a branch). */
  stop(input: { chatId: string; subAppId: string; branch?: string }): Promise<boolean>;
}

/**
 * On-demand MCP prewarm for this session's checkout (omitted → no
 * `prewarm_mcp` tool). Creating a worktree warms it automatically; this is the
 * re-warm for when the warmed server later died.
 */
export interface ManagerMcpPrewarm {
  /** Warm every server declaring a `prewarm`, in THIS chat's checkout. */
  run(): Promise<{ server: string; ok: boolean; error?: string }[]>;
}

/** What an agent asks for when it calls `spawn_chat`. */
export interface SpawnChatRequest {
  /** The first message the new chat receives (its whole brief). */
  prompt: string;
  title?: string;
  /** Target project; omitted → the caller's own. */
  projectId?: string;
  modeId?: string;
  agentId?: string;
  effort?: Effort;
  model?: string;
  /** Why the agent wants it — shown on the consent card, not sent to the chat. */
  reason?: string;
  /**
   * Leave the new chat at the sidebar's top level instead of filing it under
   * the caller.
   *
   * Opt-OUT rather than opt-in: a chat spawned BY a chat is a child of it, and
   * defaulting to detached is what put five spawned chats in the sidebar as five
   * unrelated rows. This is for the genuinely independent second workstream the
   * tool description talks about — the one whose life has nothing to do with the
   * caller's once it starts.
   *
   * A cross-project spawn detaches on its own regardless: the parent isn't in
   * the target project's list, so there is no row there to fold under.
   */
  detached?: boolean;
}

/** The project a spawn targets, resolved to a real record. */
export interface SpawnChatTarget {
  id: string;
  name: string;
}

/** The human's answer to a spawn request. */
export interface SpawnChatConsent {
  approved: boolean;
  /** True when a setting auto-approved it — nobody was actually asked. */
  auto: boolean;
  /** The decline reason (or allow note) the human typed, if any. */
  message?: string;
}

/** A chat `spawn_chat` actually created. */
export interface SpawnedChat {
  chatId: string;
  title: string;
  projectId: string;
  projectName: string;
}

/**
 * Chat-spawning surface for this session (omitted → no `spawn_chat` tool).
 *
 * Split into three calls rather than one because the CONSENT is the point: the
 * tool must be able to ask, be refused, and say so without a chat ever existing.
 * `consent` rides the broker's ordinary permission channel — the same card, the
 * same Attention Queue entry, the same resolve endpoint as any tool prompt — so
 * a spawn request can't be a surface nobody is watching. It auto-approves ONLY
 * where the human's own setting says so ({@link ManagerMcpChats.consent}); the
 * tool takes no bypass argument, so an agent cannot talk its way past the gate.
 */
export interface ManagerMcpChats {
  /**
   * The project a spawn would land in — the caller's own when `projectId` is
   * omitted. Null when the id names no project (the tool reports that rather
   * than silently spawning somewhere else).
   */
  resolveProject(projectId?: string): Promise<SpawnChatTarget | null>;
  /**
   * Whether the project's nesting cap lets this chat file another row under
   * itself (see `chat-nesting.ts`). Asked BEFORE `consent`, so a spawn the
   * project forbids never costs the human a card to answer.
   *
   * Optional so older fakes stay valid — absent means uncapped, which is the
   * right failure for a policy that is deliberately soft.
   */
  nesting?(input: {
    request: SpawnChatRequest;
    project: SpawnChatTarget;
  }): Promise<SpawnNestingVerdict>;
  /** Ask the human (or consult the auto-approve setting). Never throws on deny. */
  consent(input: {
    request: SpawnChatRequest;
    project: SpawnChatTarget;
  }): Promise<SpawnChatConsent>;
  /** Create the chat, start its session, and deliver the prompt. */
  spawn(input: {
    request: SpawnChatRequest;
    project: SpawnChatTarget;
  }): Promise<SpawnedChat>;
}

/**
 * Read-only inspection of OTHER chats, their images, and project config.
 *
 * Every method is a pure read — there is deliberately no write path on this
 * binding, so `chat_find`/`chat_read`/`project_info` cannot disturb a chat the
 * human is watching no matter how they're called.
 */
export interface ManagerMcpInspect {
  findChats(q: FindChatsQuery): Promise<FindChatsResult>;
  readChat(q: ReadChatQuery): Promise<ReadChatResult>;
  /** Project resolution falls back to the CALLER's project when none is named. */
  projectInfo(q: ProjectInfoQuery): Promise<ProjectInfoResult>;
}

/**
 * Chat→chat MESSAGING for this session (omitted → no `chat_send` / `chat_ask` /
 * `chat_reply` / `chat_state`).
 *
 * Unlike {@link ManagerMcpInspect}, which is deliberately read-only, this is a
 * WRITE PATH INTO ANOTHER CHAT: a message lands in somebody else's transcript
 * as a `user` turn and starts a turn there. Two properties make that safe
 * without a consent card, and both are enforced by the service beneath rather
 * than by the tools:
 *
 *   - ATTRIBUTION. The row carries the sending chat, so a human reading the
 *     target can always tell an agent said it. Without that a peer message is
 *     indistinguishable from one they typed themselves — a `user` turn is the
 *     only input channel a session has, so there is nowhere else to put it.
 *   - RATE LIMITS, per ordered pair and per target. Two chats that can message
 *     each other can ping-pong forever with nobody watching; subagents cannot
 *     do this, so it is a new failure mode and gets a real guard.
 *
 * A card per message was considered and rejected: a spawn is expensive and
 * irreversible where a message is neither, and prompting on every message would
 * make this unusable as the substrate for an agent project-manager layer.
 *
 * `from` is bound to the CALLING session on every method — there is no argument
 * for it, so a chat cannot send mail under another chat's name.
 */
export interface ManagerMcpMessaging {
  send(input: {
    to: string;
    message: string;
    delivery: PeerDelivery;
  }): Promise<PeerSendResult>;
  ask(input: {
    to: string;
    question: string;
    timeoutMs: number;
    /** Both the per-call and the session abort — see `ChatMessenger.ask`. */
    signals?: (AbortSignal | undefined)[];
    /** Fired once the ask is admitted and the wait has really begun. */
    onWaiting?: () => void;
  }): Promise<PeerAskResult>;
  /** Synchronous: answering is just resolving a promise the asker is holding. */
  reply(input: { askId: string; answer: string }): PeerReplyResult;
  /** Pure read — never wakes the chat it describes. */
  state(chatId: string): Promise<PeerChatState | null>;
}

/**
 * The guard-exemption surface for this session (omitted → no
 * `request_exemption` tool).
 *
 * One call, and it is the ASK — there is deliberately no "grant" method the tool
 * could reach on its own, for the same structural reason `approve_pr`'s
 * `allowNoReview` stopped deciding anything: an escape hatch whose entire
 * justification is "the situation warrants it" cannot be certified by the one
 * party who is not a witness to that. The agent supplies the scope, the command
 * and the reason; the human supplies the answer AND the lifetime.
 *
 * A refusal, a timeout, and no-live-session-to-ask-through all come back the
 * same way: not granted. Fail closed — the guard stands.
 */
export interface ManagerMcpExemptions {
  request(input: {
    scope: WorkflowExemptionScope;
    /** The command the agent intends to run, verbatim. Shown on the card. */
    command?: string;
    reason: string;
  }): Promise<
    | { granted: true; exemption: WorkflowExemption }
    | { granted: false; message?: string }
  >;
  /** Grants currently live on this chat — so the tool can report "already have one". */
  list(): readonly WorkflowExemption[];
}

/** Per-session context the factory closes over. */
export interface ManagerMcpContext {
  /** The chat this session drives (for the waiting status label). */
  chatId: string;
  bus: EventBus;
  broker: ManagerMcpBroker;
  /** Persistent-terminal runner for this session (omitted → no `terminal` tool). */
  terminals?: ManagerMcpTerminals;
  /** Worktree catalog for this session (omitted → no `worktree` tool). */
  worktrees?: ManagerMcpWorktrees;
  /** Project-memory runner for this session (omitted → no memory tools). */
  memory?: ManagerMcpMemory;
  /** GitHub PR watcher for this session (omitted → no `watch_pr` tool). */
  github?: ManagerMcpGitHub;
  /**
   * PR-landing surface for this session (omitted → no `approve_pr` tool). Bound
   * only when the project's workflow opts into auto-merge, so the tool's mere
   * PRESENCE is the permission.
   */
  prApproval?: ManagerMcpPrApproval;
  /**
   * PR-CREATION surface (omitted → no `create_pr` tool). Bound whenever the
   * project's workflow has `requirePr`, which is the same condition the trunk
   * guard uses to refuse a raw `gh pr create` — so the refusal always has
   * somewhere to point.
   */
  prCreate?: ManagerMcpPrCreate;
  /**
   * The tracked-PR catalog for this session.
   *
   * Every PR tool reads it to FREEZE a snapshot into its result, which is what
   * lets the transcript render a real card — title, diff size, per-job CI, who
   * is reviewing — instead of the model's prose about it. Optional: without it
   * the tools work exactly as before and their cards fall back to prose.
   */
  prRegistry?: ManagerMcpPrRegistry;
  /** SubApp launcher for this session (omitted → no `run_subapp` tool). */
  runner?: ManagerMcpRunner;
  /**
   * Names of the bundled browser MCP servers this session actually got, so
   * `run_subapp` can tell the agent HOW to look at what it just started.
   *
   * The tool has always claimed the agent could "actually SEE your change
   * running" and then returned a bare URL, which an agent has no way to open.
   * Naming the tool that opens it is the difference between a capability being
   * present and it being used. Empty/omitted → say nothing rather than point at
   * tools this session does not have.
   */
  browserServers?: string[];
  /** MCP prewarm for this session's checkout (omitted → no `prewarm_mcp` tool). */
  prewarm?: ManagerMcpPrewarm;
  /** Chat spawner for this session (omitted → no `spawn_chat` tool). */
  chats?: ManagerMcpChats;
  /** Project MCP-config editor for this session (omitted → no `mcp_*` tools). */
  mcpConfig?: ManagerMcpConfig;
  /** Instruction/skill authoring for this session (omitted → no `config_*` tools). */
  authoring?: ManagerMcpAuthoring;
  /** Cross-chat read surface (omitted → no `chat_find`/`chat_read`/`project_info`). */
  inspect?: ManagerMcpInspect;
  /** Cross-chat WRITE surface (omitted → no `chat_send`/`chat_ask`/`chat_reply`/`chat_state`). */
  messaging?: ManagerMcpMessaging;
  /**
   * Guard-exemption surface (omitted → no `request_exemption` tool). Bound
   * whenever the workflow guard is actually ENFORCING, which is the same
   * condition under which a refusal can strand a chat — so the escape hatch
   * exists exactly where the wall does.
   */
  exemptions?: ManagerMcpExemptions;
  /** The session's abort signal — cancels in-flight waits on stop/fork. */
  signal?: AbortSignal;
  now?: () => number;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Floor for `chat_ask`. Below this the question cannot be answered even in
 * principle — the target has to wake, read and compose — so a shorter request is
 * a mistake rather than an instruction.
 */
const MIN_ASK_SECONDS = 5;

function clampSeconds(value: unknown, cap: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(n, 0), cap);
}

/** Pull an AbortSignal out of the MCP handler's `extra` arg, if present. */
function extraSignal(extra: unknown): AbortSignal | undefined {
  const sig = (extra as { signal?: unknown } | undefined)?.signal;
  return sig instanceof AbortSignal ? sig : undefined;
}

/** One cancellation channel for both the MCP call and the owning chat session. */
function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  if (present.length < 2) return present[0];
  return AbortSignal.any(present);
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * A refused peer message.
 *
 * `isError: true` here, unlike the timeout path in `chat_ask`, and the two are
 * genuinely different questions. A timeout says the other chat did not answer —
 * the call worked. A refusal says this call will not happen, and every one of
 * them is something the CALLER can act on: fix the id, stop looping, wait for
 * the window. Reported as a plain result the model reads it as a delivered
 * message and moves on, which is the one outcome that must not happen.
 */
function peerRefusalResult(result: PeerSendResult): CallToolResult {
  return textResult(
    `${result.message ?? "The message was refused."}\n${JSON.stringify({
      ok: false,
      refusal: result.refusal,
      ...(result.retryAt ? { retryAt: result.retryAt } : {}),
    })}`,
    true,
  );
}

/**
 * A PR tool's result: prose for the model, plus one machine-readable line the
 * transcript renders as a card (see `@dispatch/shared/pr-tools`).
 *
 * The snapshot is taken HERE, at the moment the tool answers, and travels with
 * the result — it is not looked up again when the card renders. That is what
 * keeps a transcript a record of what happened rather than a live dashboard
 * that quietly restates last week's `create_pr` as today's CI.
 *
 * `outcome.ok` and `isError` are DIFFERENT questions and must not be conflated.
 * `ok` describes what happened to the pull request; `isError` describes the
 * tool CALL. "Not landing this yet, here is why" is a successful call reporting
 * a negative outcome, and flagging it as a tool error would tell the agent its
 * own request failed. The default is the common case; every refusal that is a
 * normal answer passes `isError: false` and says so.
 */
function prToolResult(
  tool: PrToolKind,
  outcome: PrToolOutcome,
  pr: PrSnapshot | null,
  opts: { isError?: boolean; text?: string } = {},
): CallToolResult {
  const prose = opts.text ?? [outcome.summary, ...outcome.details].filter(Boolean).join("\n");
  const payload = encodePrToolPayload({ v: 1, tool, outcome, pr: pr ?? undefined });
  return textResult(`${prose}\n${payload}`, opts.isError ?? !outcome.ok);
}

/**
 * Parse a time bound as either a relative age (`30m`, `6h`, `7d`, `2w`) or an
 * absolute date the `Date` constructor understands. Relative comes first because
 * "what happened since yesterday" is the question that actually gets asked, and
 * making the agent compute an epoch for it invites off-by-a-timezone answers.
 * Returns undefined for anything unparseable — the filter is then simply not
 * applied, which is the safe direction for a search.
 */
export function parseTimeBound(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
    return now - n * ms;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/* --------------------------------------------------- memory inventory rendering */

/**
 * The curation signals for one memory, on one line: what it costs, when it was
 * last written, whether anything has ever retrieved it, and who links to it.
 *
 * `never retrieved` is called out explicitly rather than shown as `0/0` because
 * it's the single most load-bearing signal in the whole row — and the one most
 * easily misread as "delete me". It isn't: the telemetry only counts accesses
 * since the stats file existed, so a never-retrieved memory is a CANDIDATE for
 * review, not a verdict.
 */
function inventoryLine(m: MemoryInventoryEntry): string {
  const bits = [`${m.type}`, `${m.chars} chars`];
  if (m.updatedAt) bits.push(new Date(m.updatedAt).toISOString().slice(0, 10));
  bits.push(
    m.surfaced === 0 && m.recalled === 0
      ? "never retrieved"
      : `${m.recalled} recalled / ${m.surfaced} surfaced`,
  );
  if (m.links.length) bits.push(`→ ${m.links.join(" ")}`);
  if (m.backlinks.length) bits.push(`← ${m.backlinks.join(" ")}`);
  return bits.join(" · ");
}

/** Order an inventory by the axis the caller is curating along. */
function sortInventory(
  rows: readonly MemoryInventoryEntry[],
  sort: "name" | "recent" | "oldest" | "size" | "unused",
): MemoryInventoryEntry[] {
  const byName = (a: MemoryInventoryEntry, b: MemoryInventoryEntry) =>
    a.name.localeCompare(b.name);
  const out = [...rows];
  switch (sort) {
    case "recent":
      return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || byName(a, b));
    case "oldest":
      // Undated files are the OLDEST thing in the store — they predate the
      // `updatedAt` frontmatter entirely — so they sort first, not last.
      return out.sort(
        (a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || byName(a, b),
      );
    case "size":
      return out.sort((a, b) => b.chars - a.chars || byName(a, b));
    case "unused": {
      // Same weighting as the ranking tie-break: an explicit recall is worth
      // more than a proactive surface, so least-useful-first means least of both.
      const score = (m: MemoryInventoryEntry) => m.recalled * 2 + m.surfaced;
      return out.sort((a, b) => score(a) - score(b) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || byName(a, b));
    }
    default:
      return out.sort(byName);
  }
}

/**
 * Sleep `ms`, resolving `"elapsed"` on completion or `"aborted"` if any of the
 * supplied signals fires first. Every timer/listener is torn down on settle, so
 * an aborting session never strands a timer.
 */
function sleep(
  ms: number,
  signals: (AbortSignal | undefined)[],
): Promise<"elapsed" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: (() => void)[] = [];
    const finish = (r: "elapsed" | "aborted"): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };
    const timer = setTimeout(() => finish("elapsed"), ms);
    cleanups.push(() => clearTimeout(timer));
    for (const sig of signals) {
      if (!sig) continue;
      if (sig.aborted) {
        finish("aborted");
        return;
      }
      const onAbort = (): void => finish("aborted");
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }
  });
}

interface WaitForChatOutcome {
  finalState: ChatStatus | "unknown";
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Resolve when `chatId` reaches a terminal broker state, its timeout fires, or a
 * signal aborts. Subscribes to `chat-status` BEFORE reading the current status
 * so a transition that lands between the two can't be missed.
 */
function waitForChatState(
  ctx: ManagerMcpContext,
  chatId: string,
  timeoutMs: number,
  signals: (AbortSignal | undefined)[],
): Promise<WaitForChatOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: (() => void)[] = [];
    const finish = (r: WaitForChatOutcome): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };

    const off = ctx.bus.on("chat-status", (e) => {
      if (e.chatId !== chatId) return;
      if (TERMINAL_STATES.has(e.status)) {
        finish({ finalState: e.status, timedOut: false, aborted: false });
      }
    });
    cleanups.push(off);

    const timer = setTimeout(() => {
      finish({
        finalState: ctx.broker.getStatus(chatId) ?? "unknown",
        timedOut: true,
        aborted: false,
      });
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));

    for (const sig of signals) {
      if (!sig) continue;
      if (sig.aborted) {
        finish({ finalState: "unknown", timedOut: false, aborted: true });
        return;
      }
      const onAbort = (): void =>
        finish({ finalState: "unknown", timedOut: false, aborted: true });
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }

    // Already at rest? Resolve now (subscribe-first guarantees no missed edge).
    const cur = ctx.broker.getStatus(chatId);
    if (cur && TERMINAL_STATES.has(cur)) {
      finish({ finalState: cur, timedOut: false, aborted: false });
    }
  });
}

/** One reportable change `watch_pr` surfaces to the agent. */
export type WatchPrEvent =
  | { type: "ci-failed"; name: string; conclusion?: string; url?: string }
  /**
   * Every check finished and none of them failed. Green is ACTIONABLE — it's the
   * moment the agent can merge — and reporting it is what stops a watch started
   * after CI already finished from blocking for the entire quiet window.
   */
  | { type: "ci-passed"; names: string[] }
  /** This PR has no checks at all (see {@link NO_CHECKS_GRACE_MS}). Reported once. */
  | { type: "no-checks" }
  /**
   * NOBODY is queued to review this PR — no outstanding review request. Waiting
   * is futile from here; the agent has to re-request or land it. `reported` names
   * anyone who already reviewed, which is what separates "the round is over,
   * re-request after your fixes" from "this PR was never sent to anyone".
   * Reported once per state (see {@link REVIEW_QUEUE_GRACE_MS}); a fresh request
   * followed by a fresh emptying re-fires.
   */
  | { type: "review-stalled"; reported: Array<{ author: string; state: string }> }
  /**
   * Dispatch's OWN reviewer has spent every round it is allowed on this PR, and
   * the last of them is over.
   *
   * A different fact from {@link WatchPrEvent} `review-stalled`, and the two need
   * opposite actions — which is the whole reason it is a separate event. A
   * stalled queue is fixed by `request_review`; a spent cap is not fixed by
   * anything, because `claimReviewAgent` refuses on the round count and a
   * re-request only puts a request in front of a sweep that will never serve it.
   * They are also independently true: on a dedicated-account project the
   * reviewer sits in GitHub's queue for as long as it never submits, so the
   * queue reads healthy while the cap is long gone. That combination is exactly
   * what left PRs #141 and #143 blocked on a review that could not arrive.
   */
  | {
      type: "reviews-spent";
      round: number;
      maxRounds: number;
      /**
       * A review actually landed. False = every round was claimed and none of
       * them filed anything, which is a real outcome and currently the common
       * one here (the reviewer credential 403s on post).
       */
      posted: boolean;
      /** CI green and no thread open: nothing but the merge is left to do. */
      landable: boolean;
    }
  | {
      type: "review-comment";
      threadId: string;
      path?: string;
      line?: number | null;
      author?: string;
      body?: string;
    };

/**
 * Per-(session, PR) dedup memory so each failing check and each review thread is
 * reported to the agent exactly ONCE. `checks` maps a check name → the last
 * conclusion/status we reported for it (so a red build fires once, and a
 * pass→fail flip re-fires); `threads` holds the ids of review threads already
 * surfaced. Held in the session-scoped factory closure, it survives across the
 * agent's repeated `watch_pr` calls — which is exactly what stops the "fixed the
 * comments, then went silent on the next round" failure mode.
 */
export interface WatchPrState {
  checks: Map<string, string>;
  threads: Set<string>;
  /**
   * Fingerprint of the all-green check set already reported. Green has to dedup
   * like everything else: the tool's contract is "call again until done:true",
   * so a success that re-fires on every call would turn that loop into a spin.
   * Keyed on the checks themselves, so a NEW workflow landing green later still
   * reports.
   */
  greenAt?: string;
  /** The "no checks configured" note has been delivered for this PR. */
  notedNoChecks?: boolean;
  /**
   * The empty-reviewer-queue note has been delivered. CLEARED again the moment a
   * request is outstanding, so the next round's stall reports too — a once-ever
   * flag would tell the agent about the dead queue in round 2 and then let it
   * block silently in rounds 3 and 4.
   */
  notedStalled?: boolean;
  /** First poll at which the reviewer queue was seen empty (drives the grace window). */
  queueEmptySince?: number;
  /**
   * The spent-round-cap note has been delivered for this PR.
   *
   * Once-ever, unlike {@link notedStalled}: the cap only moves in one direction,
   * so there is no later state for it to re-fire on. The LANDABLE case ignores
   * this flag on purpose — see where the event is pushed.
   */
  notedSpent?: boolean;
  /**
   * The spent cap as of the last poll, whether or not it was news this call.
   *
   * Separate from {@link notedSpent} because the ADVICE needs the standing fact
   * and the event only carries the news. Without it, a stalled queue reported
   * one call after the cap was announced would tell the agent to
   * `request_review` — putting a request in front of a sweep that can never
   * claim it, which is the exact dead end this whole signal exists to prevent.
   *
   * Only recorded once the final round is over (`inFlight` false), so "the
   * reviewer is DONE" is never said over a review being written right now.
   */
  spent?: SpentReviewRounds & { landable: boolean };
}

/**
 * A spent review cap, as `watch_pr` needs it: the counters to report, and
 * whether anything can still arrive from the final round.
 *
 * Only ever built for a cap that IS spent — the rule itself lives in
 * `prReviewAgentView`, so the tool and the PR row can never disagree about when
 * the reviewer is done.
 */
export interface SpentReviewRounds {
  round: number;
  maxRounds: number;
  posted: boolean;
  /**
   * The final round is claimed and hasn't posted, and its chat is (or may still
   * be) working. Nothing is reported while this holds: "no review is coming" is
   * a false claim about a review being written right now, and the watch has
   * something real to wait for.
   */
  inFlight: boolean;
}

type WatchPrOutcome =
  | { kind: "activity"; state: PrPollResult; events: WatchPrEvent[] }
  | { kind: "terminal"; state: PrPollResult }
  | { kind: "timeout"; state: PrPollResult }
  | { kind: "aborted" }
  | { kind: "error"; error: string };

/**
 * Poll a PR every `intervalMs` and RESOLVE the instant it needs the agent: a new
 * failing check, CI turning green, a new unresolved review thread, or a
 * merge/close. Polls immediately first (so a PR already carrying unaddressed
 * activity returns with zero wait), dedups against `st` so nothing
 * already-handled re-fires, and quits on abort or `timeoutMs`. A null merge-state
 * read ends the watch as an error; a transient null checks/threads read is
 * treated as "nothing new this poll" so one flaky `gh` call never aborts a long
 * watch.
 *
 * Green counts as activity on purpose. Watching only for FAILURE means a watch
 * started after CI has already finished — the common case for a fast run, or for
 * any watch that begins a moment too late — sits blocked until the quiet-window
 * timeout with the answer already sitting in front of it.
 */
async function watchForPrActivity(
  gh: ManagerMcpGitHub,
  number: number,
  repo: string | undefined,
  st: WatchPrState,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    signals: (AbortSignal | undefined)[];
    now: () => number;
    /**
     * Fired once per poll, before the read. This is how the catalog learns an
     * agent is BLOCKED on this PR — a single note at the start of the watch
     * would lapse long before a 15-minute watch returned, and the whole point
     * of the fast cadence is that it holds for as long as somebody is waiting.
     */
    onPoll?: () => void;
    /**
     * Dispatch's own reviewer on this PR, reduced to the one question GitHub
     * cannot answer: has the round cap been spent, and is the final round over?
     * Null = it hasn't (or there is no reviewer, or no catalog to ask).
     *
     * Called per POLL rather than once, because the round that spends the cap is
     * normally claimed by the background sweep while this watch is already
     * blocked. It reads a stored row and costs no GitHub call, which is what
     * makes that affordable.
     */
    reviewRounds?: () => Promise<SpentReviewRounds | null>;
  },
): Promise<WatchPrOutcome> {
  const started = opts.now();
  const deadline = started + opts.timeoutMs;
  const aborted = (): boolean => opts.signals.some((s) => s?.aborted);

  for (;;) {
    if (aborted()) return { kind: "aborted" };
    opts.onPoll?.();

    let merge: PrWatchSnapshot | null;
    try {
      merge = await gh.pollPrState(number, repo);
    } catch (err) {
      return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (aborted()) return { kind: "aborted" };
    if (merge === null) {
      return {
        kind: "error",
        error: "PR not found (unknown number or the repo could not be resolved)",
      };
    }
    if (merge.state === "merged" || merge.state === "closed") {
      return { kind: "terminal", state: merge };
    }

    // One read, so these arrive together. A `null` on any of them still means
    // "no read of that signal this poll" — see {@link PrWatchSnapshot} — which
    // every branch below already distinguishes from an empty read.
    const { checks, threads, review } = merge;

    const events: WatchPrEvent[] = [];
    const runs = checks ?? [];
    let anyFailing = false;
    for (const c of runs) {
      const conclusion = c.conclusion ?? undefined;
      const fingerprint = conclusion ?? c.status;
      const failing = conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
      if (failing) anyFailing = true;
      if (failing && st.checks.get(c.name) !== fingerprint) {
        events.push({ type: "ci-failed", name: c.name, conclusion, url: c.url });
      }
      st.checks.set(c.name, fingerprint);
    }

    // CI is green: every check has finished and none of them failed. A check
    // still queued/in_progress means the run isn't over, so keep waiting — the
    // agent must not be told "passing" while a job could still go red.
    const allGreen = runs.length > 0 && !anyFailing && runs.every((c) => c.status === "completed");
    if (allGreen) {
      const green = runs
        .map((c) => `${c.name}:${c.conclusion ?? "completed"}`)
        .sort()
        .join("|");
      if (st.greenAt !== green) {
        st.greenAt = green;
        events.push({ type: "ci-passed", names: runs.map((c) => c.name) });
      }
    }

    // `checks === null` is a failed read, NOT an empty check list — only a real
    // read of zero checks means the PR has no CI to wait for.
    if (
      checks !== null &&
      runs.length === 0 &&
      !st.notedNoChecks &&
      opts.now() - started >= NO_CHECKS_GRACE_MS
    ) {
      st.notedNoChecks = true;
      events.push({ type: "no-checks" });
    }
    // The reviewer queue. GitHub drops a reviewer's request the instant they
    // submit, and new commits do NOT re-queue them — so an open PR with an empty
    // queue is not "waiting for review", it is stopped. Report that rather than
    // burning the quiet window on a review that is never coming, which is the
    // whole reason this poll exists.
    if (!review) {
      // Couldn't read the queue this poll. Drop the timer: the grace window is a
      // claim about CONTINUOUS observation ("empty for a full minute"), and a
      // gap means we can't make it — the reviewer may well have been re-requested
      // while we were blind. Carrying the old timestamp lets the next readable
      // poll fire instantly off evidence we never actually had.
      st.queueEmptySince = undefined;
      // `notedStalled` deliberately survives. It is dedup memory for news already
      // delivered, and a read hiccup is not a reason to say the same thing twice.
    } else if (review.requested.length > 0) {
      // Someone IS on the hook: waiting is the right move, and the next time the
      // queue empties is news again.
      st.notedStalled = false;
      st.queueEmptySince = undefined;
    } else {
      st.queueEmptySince ??= opts.now();
      if (!st.notedStalled && opts.now() - st.queueEmptySince >= REVIEW_QUEUE_GRACE_MS) {
        st.notedStalled = true;
        events.push({ type: "review-stalled", reported: review.reported });
      }
    }

    // Dispatch's own reviewer stops on a per-PR ROUND CAP, and that stop is
    // permanent: once every round is claimed, `claimReviewAgent` refuses the
    // next one forever. Nothing above can see it. The reviewer queue can be full
    // of a request nothing will ever serve, so every GitHub-side signal reads
    // "a review is coming" while the sweep has quietly stopped spawning — and
    // the author blocks here for the whole window waiting on it.
    //
    // `undefined` = the row could not be read this poll. That is not the same
    // claim as "the cap is not spent", so the standing fact below is left
    // exactly as it was — same rule the reviewer queue follows for a blind poll.
    const spent = opts.reviewRounds ? await opts.reviewRounds().catch(() => undefined) : null;
    if (spent !== undefined) {
      // `null` threads is a failed read, not an empty list — claiming a PR is
      // landable off a thread list we never got would be a guess about the one
      // thing that blocks a merge.
      const openThreads = threads === null ? null : threads.filter((t) => !t.isResolved).length;
      const landable = allGreen && openThreads === 0;
      // The standing fact, refreshed every poll — the advice reads this even on
      // a call where the event below is deduped away.
      st.spent = spent && !spent.inFlight ? { ...spent, landable } : undefined;
      // Cleared together with it: a cap that is no longer spent (the human
      // raised it in project config) is news again the next time it fills.
      if (!st.spent) st.notedSpent = false;
      // Deduped differently in the two cases, on purpose.
      //
      // "The cap is spent and CI is still moving" is news exactly once: there is
      // still something real to wait for, so the watch says it and goes back to
      // waiting.
      //
      // "Spent AND landable" is not news, it is a STANDING state in which
      // nothing can arrive — no round can spawn, no check can change, no thread
      // can appear. Blocking on it would be a lie about what watching means, so
      // it re-reports on every call instead of going quiet for half an hour.
      if (st.spent && (landable || !st.notedSpent)) {
        st.notedSpent = true;
        const { round, maxRounds, posted } = st.spent;
        events.push({ type: "reviews-spent", round, maxRounds, posted, landable });
      }
    }

    for (const t of threads ?? []) {
      if (!t.isResolved && !st.threads.has(t.id)) {
        events.push({
          type: "review-comment",
          threadId: t.id,
          path: t.path,
          line: t.line ?? null,
          author: t.author,
          body: t.body,
        });
        st.threads.add(t.id);
      }
    }
    if (events.length) return { kind: "activity", state: merge, events };

    const remaining = deadline - opts.now();
    if (remaining <= 0) return { kind: "timeout", state: merge };
    if ((await sleep(Math.min(opts.intervalMs, remaining), opts.signals)) === "aborted") {
      return { kind: "aborted" };
    }
  }
}

/** A login as either half of a reviewer comparison may spell it. */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/** Copilot's review bot, under any of the spellings GitHub gives it. */
function isCopilotReviewer(login: string): boolean {
  return normalizeLogin(login).startsWith("copilot");
}

/**
 * Why is the review queue empty, in words an agent can act on.
 *
 * WHY this is a function rather than a string at each call site. Three separate
 * failures produce a byte-identical empty queue, and the tools used to print one
 * guess covering all of them: *"a bot reviewer often refuses a re-request on a
 * head it has already reviewed; ask a human, or land the PR on the review you
 * already have."* On `hivebreak` #192 every clause of that was false — nobody
 * had ever reviewed it, so there was no review to land on, and the reviewer had
 * been dropped because the account's Copilot budget was spent. The agent
 * followed the advice it was given and put an unreviewed merge in front of the
 * human as though a review had happened.
 *
 * So each cause gets named separately, and the one fact that decides what is
 * even POSSIBLE next — has anybody reviewed this at all — is stated rather than
 * assumed.
 */
async function explainEmptyReviewQueue(opts: {
  /** Logins this call asked GitHub for. */
  asked: readonly string[];
  /** Logins actually on the hook afterwards (already known to be missing some). */
  onHook: readonly string[];
  /** Has ANY review ever been submitted on this PR, by anyone but its author? */
  everReviewed: boolean;
  /** `resolveReviewer`'s complaint, when Dispatch's own reviewer cannot run here. */
  reviewAgentProblem?: string;
  /** Best-effort Copilot budget read — only consulted if Copilot was dropped. */
  copilotQuota?: () => Promise<CopilotQuotaFacts | null>;
  /**
   * GitHub refused one or more reviewers by name, rather than silently dropping
   * them. A different fix from everything else here — the list itself is wrong —
   * so the advice has to keep saying so.
   */
  hadFailures?: boolean;
}): Promise<{ causes: string[]; advice: string }> {
  const queued = new Set(opts.onHook.map(normalizeLogin));
  const dropped = opts.asked.filter((a) => !queued.has(normalizeLogin(a)));
  const causes: string[] = [];

  // First, because it is the only cause that is permanent AND fixable in this
  // repo's own config — every other line below describes something on GitHub.
  if (opts.reviewAgentProblem) {
    causes.push(`Dispatch's own reviewer cannot run here: ${opts.reviewAgentProblem}`);
  }

  const copilot = dropped.filter(isCopilotReviewer);
  if (copilot.length) {
    // Only NOW is the undocumented budget endpoint worth calling: we already
    // know a Copilot reviewer went missing, so a null read costs one wasted
    // `gh` call on a path that is already failing.
    const quota = await opts.copilotQuota?.().catch(() => null);
    if (quota?.exhausted) {
      const usage =
        quota.used != null && quota.entitlement != null
          ? ` (${quota.used} of ${quota.entitlement} used`
          : " (spent";
      causes.push(
        `${copilot.join(", ")} was dropped by GitHub because this account's Copilot ` +
          `premium-request budget is exhausted${usage}` +
          (quota.resetDate ? `, resets ${quota.resetDate}` : "") +
          "). Copilot code review costs one premium request per review, and with none left " +
          "GitHub accepts the request and queues nobody rather than refusing it. No Copilot " +
          "review can arrive until the budget resets, or until premium-request overage is " +
          "enabled in GitHub billing. This is NOT something to retry.",
      );
    } else {
      causes.push(
        `${copilot.join(", ")} was dropped by GitHub, which answers success either way. ` +
          "The usual causes, in order: the account's Copilot premium-request budget is spent " +
          "(github.com/settings/billing), Copilot code review is not enabled for this " +
          "repository, or the bot is declining to re-review a head it has already reported on.",
      );
    }
  }

  const humans = dropped.filter((d) => !isCopilotReviewer(d));
  if (humans.length) {
    causes.push(
      `${humans.join(", ")} ${humans.length === 1 ? "was" : "were"} not queued. GitHub only ` +
        "accepts a review request for a collaborator on the repo — check the account name and " +
        "its access.",
    );
  }

  // The load-bearing fact, and the one the old advice got wrong. Stated even
  // when nothing above could be diagnosed, because it decides what is possible
  // next regardless of WHY the queue is empty.
  causes.push(
    opts.everReviewed
      ? "This PR does already carry a submitted review, so the review bar may be met even " +
          "with the queue empty."
      : "NOBODY has reviewed this PR at any point — there is no existing review to fall back on.",
  );

  const advice =
    "Do NOT call watch_pr — it would block on an empty queue — and do NOT re-call " +
    "request_review, which will fail identically. " +
    // Kept verbatim from before this function existed: a NAMED refusal is the
    // one empty queue whose fix really is "the list is wrong", and folding it
    // into the generic advice below would lose the only actionable sentence.
    (opts.hadFailures || humans.length
      ? "Fix the reviewer names or the project's `workflow.pr.reviewers`; retrying the " +
        "same list will fail the same way. "
      : "") +
    (opts.everReviewed
      ? "If no threads are outstanding, land it on the review it already has."
      : "The review requirement cannot be met as things stand. Fix a cause above if you can; " +
        "otherwise put the waiver to the human with `mcp__dispatch-confirm__ask_user` and only " +
        "then call `approve_pr({ allowNoReview: true })` — telling them plainly that nobody " +
        "has reviewed this PR.");
  return { causes, advice };
}

/**
 * Reduce a PR row's reviewer state to {@link SpentReviewRounds} — or null,
 * meaning another round can still spawn and `watch_pr` should keep waiting the
 * way it always has.
 *
 * The cap rule itself is `prReviewAgentView`'s `roundsSpent`, not re-derived
 * here: the chip on the PR row and this tool have to mean the same thing by
 * "the reviewer is done", and two copies of `rounds >= maxRounds` would drift
 * the first time one of them grew a special case.
 */
export function spentReviewRounds(
  state: PrReviewAgentState | null,
  opts: { statusOf: (chatId: string) => ChatStatus | undefined; now: number },
): SpentReviewRounds | null {
  const v = prReviewAgentView(state ?? undefined);
  // No cap recorded on the row = no claim to make. Older rows predate it, and
  // inventing a denominator would report a permanent stop we cannot see.
  if (!v?.roundsSpent || v.maxRounds == null) return null;
  // `running` means a round is CLAIMED and nothing has been posted for it. The
  // row cannot tell a reviewer three minutes into the diff from one whose chat
  // died — and here the dead one is the normal case, because the reviewer
  // credential 403s on post — so ask the chat instead. A session we can see is
  // authoritative in both directions; one we can't gets the spawn window (see
  // {@link REVIEW_ROUND_GRACE_MS}) and nothing more.
  const live = v.chatId ? opts.statusOf(v.chatId) : undefined;
  const inFlight =
    v.phase === "running" &&
    (live !== undefined
      ? !TERMINAL_STATES.has(live)
      : opts.now - (v.at ?? 0) < REVIEW_ROUND_GRACE_MS);
  return { round: v.round, maxRounds: v.maxRounds, posted: v.posted, inFlight };
}

/** One-line, length-bounded rendering of a review comment body for the summary. */
function firstLine(body: string | undefined, max = 200): string {
  const line = (body ?? "").split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/* -------------------------------------------------------------------- tools */

/** The manager tool definitions, closed over one session's context. */
export function createManagerTools(ctx: ManagerMcpContext) {
  // Per-session dedup memory for watch_pr, keyed `${repo}#${number}`. Lives for
  // the life of this session's MCP server, so it survives the agent's repeated
  // watch_pr calls and never re-reports a check/comment it already handed over.
  const watchState = new Map<string, WatchPrState>();

  const askUser = tool(
    "ask_user",
    "Ask the human one to three structured questions and wait for their answer. " +
      "Use this when a choice materially changes the work and cannot be inferred. " +
      "Each question can be single-select (radio) or multi-select (checkbox); the UI " +
      "also offers a free-form answer. An optional inactivity timeout resets while the human " +
      "types or selects options. A decline is a final answer, not a reason to retry.",
    {
      questions: z
        .array(
          z.object({
            header: z
              .string()
              .min(1)
              .max(24)
              .describe("Short label shown above the question."),
            question: z.string().min(1).describe("The question shown to the human."),
            multiSelect: z
              .boolean()
              .optional()
              .describe("True for checkboxes; false or omitted for radio buttons."),
            options: z
              .array(
                z.object({
                  label: z.string().min(1).describe("Short choice label."),
                  description: z
                    .string()
                    .optional()
                    .describe("One sentence explaining the choice or tradeoff."),
                }),
              )
              .min(2)
              .max(5)
              .describe("Two to five choices. Dispatch also adds a free-form option."),
          }),
        )
        .min(1)
        .max(3)
        .describe("One to three questions presented in one card."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(ASK_USER_TIMEOUT_CAP_SECONDS)
        .optional()
        .describe(
          "Optional inactivity timeout in seconds. Typing or selecting an option resets it.",
        ),
    },
    async ({ questions, timeoutSeconds }, extra): Promise<CallToolResult> => {
      const result = await ctx.broker.askUser(
        ctx.chatId,
        questions,
        timeoutSeconds,
        combinedSignal(extraSignal(extra), ctx.signal),
      );
      if (result.status === "unavailable") {
        return textResult(
          `The question could not be shown to the human. ${result.message}\n` +
            JSON.stringify(result),
        );
      }
      if (result.status === "declined") {
        return textResult(
          `The human declined to answer.${result.message ? ` ${result.message}` : ""}\n` +
            JSON.stringify(result),
        );
      }
      if (result.status === "timed_out") {
        return textResult(`The question timed out without an answer. ${result.message}\n${JSON.stringify(result)}`);
      }
      return textResult(`The human answered:\n${JSON.stringify(result.answers, null, 2)}`);
    },
  );

  const wait = tool(
    "wait",
    "Pause yourself for a fixed duration before continuing. Use to self-pace " +
      "(e.g. let a build/CI settle, or space out polling). Caps at " +
      `${WAIT_CAP_SECONDS}s.`,
    {
      seconds: z.number().describe(`How long to wait (0–${WAIT_CAP_SECONDS}s).`),
      reason: z
        .string()
        .optional()
        .describe("Shown in the UI while paused, e.g. 'CI to finish'."),
    },
    async (args, extra): Promise<CallToolResult> => {
      const seconds = clampSeconds(args.seconds, WAIT_CAP_SECONDS);
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";

      // Surface the self-imposed pause via the working/typing status header.
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `waiting ${seconds}s${reason ? `: ${reason}` : ""}`,
          toolName: "wait",
        },
      });

      const outcome = await sleep(seconds * 1000, [ctx.signal, extraSignal(extra)]);
      if (outcome === "aborted") {
        return textResult(`Wait cancelled after being interrupted (was ${seconds}s).`);
      }
      return textResult(
        `Waited ${seconds}s${reason ? ` for: ${reason}` : ""}. Continuing.`,
      );
    },
  );

  const waitForChat = tool(
    "wait_for_chat",
    "Block until ANOTHER manager chat/session goes idle, done, or errors (or " +
      "until a timeout). Use to sequence work behind a subagent/sibling chat. " +
      "Returns that chat's final state.",
    {
      chatId: z.string().describe("The id of the chat/session to wait on."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(`Give up after this long (default/cap ${WAIT_CAP_SECONDS}s).`),
    },
    async (args, extra): Promise<CallToolResult> => {
      const chatId = typeof args.chatId === "string" ? args.chatId.trim() : "";
      if (!chatId) {
        return textResult("wait_for_chat requires a non-empty chatId.", true);
      }
      if (!ctx.broker.has(chatId)) {
        return textResult(
          `Unknown chatId "${chatId}" — no such session is registered with ` +
            "the manager, so there is nothing to wait on.",
          true,
        );
      }

      const timeoutMs =
        clampSeconds(args.timeoutSeconds ?? WAIT_CAP_SECONDS, WAIT_CAP_SECONDS) *
        1000;

      // Advertise the wait in the UI header (reuses the working-status surface).
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `waiting for chat ${chatId}`,
          toolName: "wait_for_chat",
        },
      });

      const outcome = await waitForChatState(ctx, chatId, timeoutMs, [
        ctx.signal,
        extraSignal(extra),
      ]);
      if (outcome.aborted) {
        return textResult(
          `Wait for chat ${chatId} was cancelled after being interrupted.`,
        );
      }
      const summary = outcome.timedOut
        ? `Timed out waiting for chat ${chatId} (last state: ${outcome.finalState}).`
        : `Chat ${chatId} reached state "${outcome.finalState}".`;
      return textResult(
        `${summary}\n${JSON.stringify({
          chatId,
          finalState: outcome.finalState,
          timedOut: outcome.timedOut,
        })}`,
      );
    },
  );

  const contextUsage = tool(
    "context_usage",
    "Report how full YOUR OWN context window is — total tokens used, the model's " +
      "window size, percent filled, and a per-category breakdown (system prompt, " +
      "tools, MCP tools, memory files, messages). Use it to decide whether to " +
      "compact before you run low. Prefer this over guessing from message counts.",
    {},
    async (): Promise<CallToolResult> => {
      const usage = await ctx.broker.getContextUsage(ctx.chatId);
      if (!usage) {
        return textResult(
          "Context usage is unavailable for this session right now (the " +
            "subprocess must be live to report it). Try again after a turn runs.",
          true,
        );
      }
      const pct = Math.round(usage.percentage);
      const cats = usage.categories
        .filter((c) => c.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
        .map((c) => `  ${c.name}: ${c.tokens.toLocaleString()}`)
        .join("\n");
      const summary =
        `Context: ${usage.totalTokens.toLocaleString()} / ` +
        `${usage.maxTokens.toLocaleString()} tokens (${pct}% full)` +
        (usage.model ? ` — ${usage.model}` : "");
      return textResult(
        `${summary}\n${cats ? `${cats}\n` : ""}${JSON.stringify({
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
        })}`,
      );
    },
  );

  const compactContext = tool(
    "compact_context",
    "Compact YOUR OWN context in place — summarize the conversation so far and " +
      "continue with a much smaller window, keeping the session. Use when " +
      "`context_usage` shows the window filling up (e.g. past ~80%) and you have " +
      "more work to do. Compaction runs right after the current turn ends.",
    {},
    async (): Promise<CallToolResult> => {
      ctx.broker.compact(ctx.chatId);
      return textResult(
        "Compaction requested — it will run after this turn ends. Your next turn " +
          "starts from a summarized, much smaller context.",
      );
    },
  );

  const watchPr = tool(
    "watch_pr",
    "Watch a GitHub pull request and RETURN THE INSTANT it needs you — a CI check " +
      "fails, ALL checks finish green, a new review comment/thread appears, or the " +
      "PR is merged/closed. This is the ONE correct way to wait on or react to a " +
      "PR: do NOT hand-roll a `gh pr view` / `gh pr checks` sleep loop, and do NOT " +
      "launch a background Bash or Monitor task to watch it. Safe to call AFTER CI " +
      "has already finished — it polls immediately and returns the current verdict " +
      "rather than waiting for the next change. Call it in a LOOP — it blocks until " +
      "something is actionable, then returns (done:false) with either work to do " +
      "(failing checks, new comments) or checksPassing:true meaning CI is green and " +
      "you can merge; act, then call watch_pr AGAIN. Each check result and comment " +
      "is reported only once, so repeated calls surface each NEW round instead of " +
      "going silent or re-firing the same news. It also watches the REVIEWER QUEUE: " +
      "if no reviewer is actually on the hook it returns reviewStalled:true rather " +
      "than blocking on a review that will never arrive (GitHub clears a reviewer's " +
      "request when they submit, and your fix commits do NOT re-queue them — use " +
      "request_review). It watches Dispatch's OWN reviewer too: when that reviewer " +
      "has spent its per-PR round cap it returns reviewsSpent:true, which is a " +
      "DIFFERENT problem with a different answer — no further round can ever spawn, " +
      "so request_review refuses there (and re-queueing a spent reviewer would only " +
      "hide the reviews it already filed), and if CI is green with no open thread it " +
      "also returns landableOnChecks:true, meaning go straight to approve_pr. " +
      "It returns done:true only when the PR merges or closes — " +
      "keep calling until then and you'll never miss a late review round.",
    {
      number: z.number().describe("The PR number to watch."),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(
          `Max quiet window before returning with no new activity (default ` +
            `${WATCH_PR_DEFAULT_TIMEOUT_SECONDS}s, cap ${WAIT_CAP_SECONDS}s). On a quiet ` +
            `timeout you get done:false/timedOut:true — just call watch_pr again to resume.`,
        ),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.github) {
        return textResult("The watch_pr tool is not available in this session.", true);
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("watch_pr requires a positive integer PR number.", true);
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const timeoutSeconds = clampSeconds(
        args.timeoutSeconds ?? WATCH_PR_DEFAULT_TIMEOUT_SECONDS,
        WAIT_CAP_SECONDS,
      );

      const key = `${repo ?? ""}#${number}`;
      let st = watchState.get(key);
      if (!st) {
        st = { checks: new Map(), threads: new Set() };
        watchState.set(key, st);
      }

      // Advertise the watch in the UI header (reuses the working-status surface).
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `watching PR #${number}${repo ? ` (${repo})` : ""}`,
          toolName: "watch_pr",
        },
      });

      const outcome = await watchForPrActivity(ctx.github, number, repo, st, {
        intervalMs: PR_POLL_INTERVAL_MS,
        timeoutMs: timeoutSeconds * 1000,
        signals: [ctx.signal, extraSignal(extra)],
        now: ctx.now ?? (() => Date.now()),
        onPoll: () => void ctx.prRegistry?.noteWatched(number, repo).catch(() => {}),
        reviewRounds: async () =>
          spentReviewRounds(
            (await ctx.prRegistry?.reviewAgent(number, repo).catch(() => null)) ?? null,
            {
              statusOf: (id) => ctx.broker.getStatus(id),
              now: (ctx.now ?? Date.now)(),
            },
          ),
      });

      /** The PR as it stands at the moment we answer — watch_pr's whole subject. */
      const snap = async (): Promise<PrSnapshot | null> =>
        (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null;

      if (outcome.kind === "aborted") {
        return prToolResult(
          "watch_pr",
          {
            summary: `Watch on PR #${number} was cancelled after being interrupted.`,
            ok: true,
            details: [],
          },
          await snap(),
        );
      }
      if (outcome.kind === "error") {
        return prToolResult(
          "watch_pr",
          { summary: `Could not watch PR #${number}`, ok: false, details: [outcome.error] },
          await snap(),
          {
            isError: true,
            text:
              `Could not watch PR #${number}: ${outcome.error}. Check the number and, ` +
              "if the repo can't be auto-detected here, pass `repo` as 'owner/name'.",
          },
        );
      }
      if (outcome.kind === "terminal") {
        const s = outcome.state;
        // The PR settled (merged/closed) — mark the chat so its dot reads green
        // ("PR done") once the agent finishes and returns to idle.
        ctx.broker.markPrWatched(ctx.chatId, {
          number: s.number,
          state: s.merged ? "merged" : "closed",
        });
        // A merge (usually the auto-merge job's, not ours) means the trunk moved;
        // tell the manager so the primary checkout can fast-forward to it.
        if (s.merged) ctx.github.notePrMerged?.();
        return prToolResult(
          "watch_pr",
          {
            summary: `PR #${s.number} ${s.merged ? "merged" : "closed"}`,
            ok: true,
            details: s.mergedAt ? [`Merged at ${s.mergedAt}`] : [],
          },
          // Refresh rather than read: the PR just reached a terminal state, and a
          // card still saying "open" on the very row announcing the merge is the
          // one bit of staleness nobody would forgive.
          (await ctx.prRegistry?.refresh(number, repo).catch(() => null)) ?? (await snap()),
          { text:
          `PR #${s.number} reached terminal state "${s.state}"${s.merged ? " (merged)" : ""}. ` +
            `Watch complete — no need to call watch_pr again.\n` +
            JSON.stringify({
              number: s.number,
              state: s.state,
              merged: s.merged,
              done: true,
              ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}),
            }) },
        );
      }
      if (outcome.kind === "timeout") {
        const s = outcome.state;
        return prToolResult(
          "watch_pr",
          {
            summary: `No new activity on PR #${number} for ${timeoutSeconds}s`,
            ok: true,
            details: [`Still ${s.state}.`],
          },
          await snap(),
          { text:
          `No new activity on PR #${number} in the last ${timeoutSeconds}s (still ` +
            `${s.state}). Call watch_pr again to keep watching until it merges.\n` +
            JSON.stringify({ number, state: s.state, done: false, timedOut: true, events: [] }) },
        );
      }

      // activity — new checks/comments to act on, or CI going green, then re-watch.
      const { state: s, events } = outcome;
      const failing = events.filter((e) => e.type === "ci-failed");
      const comments = events.filter((e) => e.type === "review-comment");
      const passed = events.find((e) => e.type === "ci-passed");
      const noChecks = events.some((e) => e.type === "no-checks");
      const stalled = events.find((e) => e.type === "review-stalled");
      const spentNews = events.find((e) => e.type === "reviews-spent");
      // Why Dispatch's own reviewer isn't coming, when it structurally can't.
      // Read only on a stall: it is the one moment "no review is arriving" is
      // the subject, and the row already holds the answer (`notePolicy` mirrors
      // `resolveReviewer`'s complaint onto it every sweep). Without this the
      // stall is reported as a fact of nature — see `explainEmptyReviewQueue`.
      const agentProblem = stalled
        ? prReviewAgentView(
            (await ctx.prRegistry?.reviewAgent(number, repo).catch(() => null)) ?? undefined,
          )?.problem
        : undefined;
      // The STANDING cap fact, not just this call's news. The advice has to know
      // the reviewer is finished on every call, or the round where only a stall
      // fires sends the agent to `request_review` and back into the dead wait.
      const spent = st.spent;
      const parts: string[] = [];
      if (failing.length) parts.push(`${failing.length} failing check(s)`);
      if (comments.length) parts.push(`${comments.length} new review comment(s)`);
      if (passed) parts.push(`all ${passed.names.length} check(s) passing`);
      if (noChecks) parts.push("no CI checks configured");
      if (stalled) parts.push("no reviewer is queued");
      if (spentNews) {
        parts.push(
          spentNews.landable
            ? "every review round is spent and the PR is landable on checks alone"
            : "every review round is spent",
        );
      }
      const lines = events.map((e) => {
        switch (e.type) {
          case "ci-failed":
            return `  ✗ check "${e.name}" ${e.conclusion ?? "failing"}${e.url ? ` — ${e.url}` : ""}`;
          case "ci-passed":
            return `  ✓ checks passed: ${e.names.join(", ")}`;
          case "no-checks":
            return `  · no checks are reporting on this PR`;
          case "review-stalled":
            return (
              (e.reported.length
                ? `  ⏸ nobody is queued to review — ${e.reported
                    .map((r) => `${r.author} already ${r.state.toLowerCase().replace(/_/g, " ")}`)
                    .join(", ")}. GitHub cleared their request when they reported, and your ` +
                  `commits since then did NOT re-queue them.`
                : `  ⏸ nobody is queued to review and nobody has reviewed — no review will ` +
                  `ever arrive on this PR as it stands.`) +
              // The cause, where there is one to name. Appended rather than
              // replacing the sentence above: the stall is still the news, this
              // is why it will not clear on its own.
              (agentProblem ? `\n     ⚠ ${agentProblem}` : "")
            );
          case "reviews-spent":
            return (
              `  ⏹ Dispatch's reviewer has spent all ${e.round} of ${e.maxRounds} rounds ` +
              `on this PR` +
              (e.posted
                ? "."
                : " and none of them posted a review (check the reviewer chat — a round " +
                  "is spent when it is claimed, whether or not it filed anything).") +
              ` No further round can spawn.`
            );
          default:
            // The threadId is here so `resolve_thread` is one obvious call away.
            // Replying without resolving is the failure mode; making the id
            // invisible is what caused it.
            return `  💬 ${e.author ?? "reviewer"} on ${e.path ?? "the PR"}${
              e.line ? `:${e.line}` : ""
            } — ${firstLine(e.body) || "(see thread)"}\n     thread: ${e.threadId}`;
        }
      });
      // Green (or an empty check list) is news, not a to-do list — telling the
      // agent to "address these" when nothing is wrong is what sends it hunting
      // for a problem that isn't there.
      const needsWork = failing.length > 0 || comments.length > 0;
      const adviceParts: string[] = [];
      if (needsWork) {
        adviceParts.push(
          "Address these, then call `mcp__dispatch-github__resolve_thread` for each comment you " +
            "actually fixed (pass the thread id above, and a `reply` saying what you did) " +
            "— an unresolved thread blocks the merge even after the code is fixed.",
        );
      } else if (!stalled && !spent) {
        adviceParts.push(
          "Nothing to fix. Merge it if you're ready, or call watch_pr again to wait for " +
            "the merge and any later review round.",
        );
      }
      // A spent cap SUPERSEDES the stalled-queue advice, and has to. Both are
      // routinely true at once — a reviewer that never submits is never
      // dequeued either, so the queue can read healthy or empty while the cap is
      // long gone — and `request_review` is the one action that cannot help
      // here. Emitting both would hand the agent a contradiction, and the half
      // it picked would send it straight back into the dead wait.
      if (spent) {
        adviceParts.push(
          `Dispatch's reviewer is DONE with this PR: the ${spent.maxRounds}-round cap is ` +
            "spent. Do not call `mcp__dispatch-github__request_review` — it refuses on a spent " +
            "cap, and if it did go through it would only re-queue the reviewer on GitHub, " +
            "which HIDES the reviews already filed and makes `approve_pr` refuse a PR " +
            "that is ready. Stop waiting for a review here.",
        );
        adviceParts.push(
          spent.landable
            ? (spent.posted
                ? "CI is green, no review thread is open, and the rounds that ran DID " +
                  "review this PR — so the project's review bar is met and " +
                  "`mcp__dispatch-github__approve_pr` is the next call. Do NOT call watch_pr " +
                  "again for a review, there is none coming."
                : "CI is green and no review thread is open, but none of those rounds " +
                  "actually posted a review — check the reviewer chat. `approve_pr` will " +
                  "refuse this for `no-review`, and that refusal is the human's to waive, " +
                  "not yours. Do NOT call watch_pr again, there is nothing coming.")
            : "Wait on CI instead — fix whatever is failing above, then call watch_pr " +
                "again for the checks and land it on those.",
        );
      } else if (stalled) {
        // A stalled queue is the one case where "call watch_pr again" is WRONG
        // advice — it would block for the full window on a review nobody is going
        // to write. Name the action instead.
        adviceParts.push(
          "Do NOT just call watch_pr again — with an empty queue it will sit until the " +
            "timeout for nothing. Either call `mcp__dispatch-github__request_review` to put a " +
            "reviewer back on the hook (do this once you've pushed your fixes, not before), " +
            "or land the PR if it's already been reviewed and there's nothing outstanding.",
        );
      } else if (needsWork) {
        adviceParts.push(
          "Then call watch_pr again — it keeps watching (reporting only NEW activity) " +
            "until the PR merges.",
        );
      }
      const advice = adviceParts.join(" ");
      return prToolResult(
        "watch_pr",
        {
          summary: `PR #${number} ${needsWork ? "needs attention" : "update"}: ${parts.join(" and ")}`,
          ok: true,
          // The event lines verbatim, minus the thread ids the model needs and a
          // human reading a card does not — those are in the drilldown.
          details: lines.map((line) => line.split("\n")[0]!.trim()),
        },
        await snap(),
        { text:
        `PR #${number} ${needsWork ? "needs attention" : "update"}: ${parts.join(" and ")}.\n` +
          `${lines.join("\n")}\n\n${advice}\n` +
          JSON.stringify({
            number,
            state: s.state,
            done: false,
            checksPassing: !!passed,
            reviewStalled: !!stalled,
            // Separate from `reviewStalled` because the actions are opposite:
            // a stalled queue is fixed by `request_review`, a spent cap by
            // nothing. Reported as a STANDING state rather than as news, so a
            // later call about something else still carries it.
            reviewsSpent: !!spent,
            ...(spent ? { landableOnChecks: spent.landable } : {}),
            events,
          }) },
      );
    },
  );

  const resolveThread = tool(
    "resolve_thread",
    "Mark a PR review thread RESOLVED, optionally replying in the thread first. " +
      "Use this for every review comment you actually addressed — fixing the code " +
      "and replying is not enough, an unresolved thread still reads as outstanding " +
      "to the reviewer and blocks the merge. Pass the `threadId` watch_pr reported " +
      "with the comment. Prefer this over a hand-rolled `gh api graphql` mutation. " +
      "If you did NOT fix it (you disagree, or it's out of scope), reply with " +
      "`resolve: false` and leave the thread open for the human.",
    {
      threadId: z
        .string()
        .describe("The review thread's node id, as reported by watch_pr ('thread: …')."),
      reply: z
        .string()
        .optional()
        .describe(
          "Posted IN the thread before resolving. Say what you changed — a thread " +
            "resolved in silence tells the reviewer nothing.",
        ),
      resolve: z
        .boolean()
        .optional()
        .describe("Default true. Pass false to reply WITHOUT resolving."),
    },
    async (args): Promise<CallToolResult> => {
      const gh = ctx.github;
      if (!gh?.resolveThread) {
        return textResult("The resolve_thread tool is not available in this session.", true);
      }
      const threadId = typeof args.threadId === "string" ? args.threadId.trim() : "";
      if (!threadId) {
        return textResult(
          "resolve_thread requires a threadId — watch_pr reports one with every review " +
            "comment (the 'thread: …' line).",
          true,
        );
      }
      const reply = typeof args.reply === "string" ? args.reply.trim() : "";
      const shouldResolve = args.resolve !== false;
      if (!reply && !shouldResolve) {
        return textResult(
          "resolve_thread with `resolve: false` and no `reply` would do nothing at all.",
          true,
        );
      }

      // Reply BEFORE resolving: if the resolve fails, the reviewer still has the
      // answer. The other order can leave a thread closed with no explanation.
      if (reply) {
        if (!gh.replyToThread) {
          return textResult("Replying in a thread is not available in this session.", true);
        }
        try {
          await gh.replyToThread(threadId, reply);
        } catch (err) {
          return textResult(
            `Could not reply in thread ${threadId}: ${
              err instanceof Error ? err.message : String(err)
            }. The thread was NOT resolved.`,
            true,
          );
        }
      }
      if (!shouldResolve) {
        return prToolResult(
          "resolve_thread",
          {
            summary: "Replied and left the thread OPEN, as asked",
            ok: true,
            details: ["It still counts as outstanding and will block the merge."],
          },
          (await ctx.prRegistry?.snapshotByThread(threadId).catch(() => null)) ?? null,
          {
            text:
              `Replied in thread ${threadId} and left it OPEN, as asked. It still counts as an ` +
              "outstanding thread and will block the merge until someone resolves it.",
          },
        );
      }
      let outcome: { dismissedReviews: number; dismissalError?: string };
      try {
        outcome = await gh.resolveThread(threadId);
      } catch (err) {
        return prToolResult(
          "resolve_thread",
          {
            summary: reply ? "Replied, but could not resolve the thread" : "Could not resolve the thread",
            ok: false,
            details: [err instanceof Error ? err.message : String(err)],
          },
          (await ctx.prRegistry?.snapshotByThread(threadId).catch(() => null)) ?? null,
          {
            isError: true,
            text:
              `${reply ? "Replied, but could not resolve" : "Could not resolve"} thread ` +
              `${threadId}: ${err instanceof Error ? err.message : String(err)}.`,
          },
        );
      }
      if (outcome.dismissalError) {
        return prToolResult(
          "resolve_thread",
          {
            summary: "Resolved the thread, but could not clear changes requested",
            ok: false,
            details: [outcome.dismissalError],
          },
          (await ctx.prRegistry?.refreshByThread(threadId).catch(() => null)) ?? null,
          {
            isError: true,
            text:
              `Resolved thread ${threadId}${reply ? " (reply posted)" : ""}, but could not ` +
              `clear Dispatch's changes-requested review: ${outcome.dismissalError}.`,
          },
        );
      }
      const cleared = outcome.dismissedReviews > 0;
      return prToolResult(
        "resolve_thread",
        {
          summary:
            `Resolved a review thread${reply ? " (reply posted)" : ""}` +
            (cleared ? " and cleared changes requested" : ""),
          ok: true,
          details: [
            ...(reply ? [reply] : []),
            ...(cleared
              ? [
                  `Dismissed ${outcome.dismissedReviews} internal changes-requested ` +
                    `review${outcome.dismissedReviews === 1 ? "" : "s"}.`,
                ]
              : []),
          ],
        },
        // Re-poll, not re-read: the resolve just happened, and a card that still
        // shows the thread outstanding is reporting the opposite of what the
        // tool just did.
        (await ctx.prRegistry?.refreshByThread(threadId).catch(() => null)) ?? null,
        {
          text:
            `Resolved thread ${threadId}${reply ? " (reply posted)" : ""}. ` +
            (cleared ? "Cleared Dispatch's changes-requested flag. " : "") +
            "Resolve every thread you fixed, then call watch_pr again.",
        },
      );
    },
  );

  const postReview = tool(
    "post_review",
    "Submit a REVIEW on a pull request: a verdict, a summary, and inline comments " +
      "on specific lines. This is how Dispatch's own reviewer speaks, and the " +
      "inline comments are the point — each one becomes a review THREAD, which is " +
      "what makes it visible to watch_pr, resolvable with resolve_thread, and " +
      "blocking for approve_pr. The same findings posted as one issue comment have " +
      "none of those properties and will be scrolled past. Prefer this over a " +
      "hand-rolled `gh api … /reviews`. Do not use it to reply to an existing " +
      "thread — that is resolve_thread's job.",
    {
      number: z.number().describe("The PR number being reviewed."),
      body: z
        .string()
        .describe(
          "The review summary. For what does not belong on a single line — a problem " +
            "whose shape spans files, or what you could not check. Keep it short; if " +
            "every finding is inline, one sentence is right. An empty review with " +
            "'nothing blocking' is a legitimate result.",
        ),
      event: z
        .enum(["comment", "request_changes"])
        .optional()
        .describe(
          "Default 'comment'. Use 'request_changes' only for something that will " +
            "actually break or that you would not want merged as-is. Approving is " +
            "deliberately not offered. Every blocking finding must also appear in " +
            "`comments`; the body may summarize them but must not add an unthreaded blocker.",
        ),
      comments: z
        .array(
          z.object({
            path: z.string().describe("Repo-relative path, exactly as it appears in the diff."),
            line: z
              .number()
              .describe(
                "Line in the NEW file. It must be a line this PR's diff actually " +
                  "touches — GitHub rejects anything else.",
              ),
            startLine: z
              .number()
              .optional()
              .describe("First line of a multi-line comment. Omit for a single line."),
            side: z
              .enum(["LEFT", "RIGHT"])
              .optional()
              .describe("Default RIGHT (the new file). LEFT comments on a removed line."),
            body: z
              .string()
              .describe(
                "The finding: what goes wrong, and the input or state that makes it " +
                  "go wrong. Not a summary of what the line does.",
              ),
          }),
        )
        .optional()
        .describe(
          "One entry per finding. A request_changes review must put EVERY blocking finding " +
            "here so resolving its threads can safely clear the verdict. For a cross-file " +
            "finding, choose the most relevant changed line and name the other files in body.",
        ),
      commitId: z
        .string()
        .optional()
        .describe("Head sha the review was written against, so GitHub dates it correctly."),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
    },
    async (args): Promise<CallToolResult> => {
      const gh = ctx.github;
      if (!gh?.submitReview) {
        return textResult(
          "The post_review tool is not available in this session. This project has no " +
            "Dispatch reviewer configured (`workflow.pr.reviewAgent` in " +
            "`.dispatch/project.yaml`).",
          true,
        );
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("post_review requires a positive integer PR number.", true);
      }
      const body = typeof args.body === "string" ? args.body.trim() : "";
      const comments = Array.isArray(args.comments) ? args.comments : [];
      // A review with neither a verdict sentence nor a finding says nothing at
      // all, and posting it would still clear `requireReview` — a rubber stamp
      // with a bot's name on it is worse than no review.
      if (!body && !comments.length) {
        return textResult(
          "post_review needs a `body`, inline `comments`, or both. An empty review would " +
            "still count as a review and clear this project's `requireReview` bar, which " +
            "makes it worse than not posting at all.",
          true,
        );
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const event = args.event === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
      if (event === "REQUEST_CHANGES" && !comments.length) {
        return textResult(
          "A request_changes review needs at least one inline comment, and every blocking " +
            "finding must be threaded. Attach a cross-file finding to its most relevant " +
            "changed line and name the other files in that comment.",
          true,
        );
      }

      let res: SubmitReviewOutcome;
      try {
        res = await gh.submitReview(number, {
          event,
          body: body || "No blocking findings.",
          comments,
          commitId: typeof args.commitId === "string" ? args.commitId : undefined,
        }, repo);
      } catch (err) {
        return textResult(
          `Could not post the review on PR #${number}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }

      if (!res.posted) {
        return prToolResult(
          "post_review",
          {
            summary: `Could not post the review on PR #${number}`,
            ok: false,
            details: [res.error ?? "GitHub refused the review"],
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          {
            isError: true,
            text:
              `Could not post the review on PR #${number}: ${res.error ?? "GitHub refused it"}. ` +
              "If it names a line, that line is not part of this PR's diff — re-check it " +
              "against the diff and post again. Do NOT fall back to `gh api`.",
          },
        );
      }

      // The row's completion signal. Best-effort and BEFORE the reporting below,
      // so a catalog write cannot change what the agent is told happened.
      await ctx.prRegistry
        ?.notePostedReview(number, repo, {
          findings: comments.length,
          event: res.event ?? event,
        })
        .catch(() => undefined);

      const details: string[] = [];
      // A downgrade is REPORTED, never silent: the agent asked to block a merge
      // and did not, and finding that out from the PR page later is the kind of
      // surprise that makes a tool untrustworthy.
      if (res.event && res.event !== event) {
        details.push(
          `posted as ${res.event.toLowerCase().replace(/_/g, " ")} rather than ` +
            `${event.toLowerCase().replace(/_/g, " ")} — GitHub does not allow that verdict ` +
            "on your own pull request",
        );
      }
      if (res.droppedComments) {
        details.push(
          `${res.droppedComments} finding(s) could not be attached to their lines and were ` +
            "folded into the summary — GitHub rejected the positions as outside the diff",
        );
      }
      if (comments.length && !res.droppedComments) {
        details.push(`${comments.length} inline comment(s), each now an open review thread`);
      }

      return prToolResult(
        "post_review",
        {
          summary: `Reviewed PR #${number}${
            comments.length ? ` — ${comments.length} finding(s)` : " — nothing blocking"
          }`,
          ok: true,
          details,
        },
        // Re-poll rather than re-read: the threads this review just created are
        // the whole result, and a card that doesn't show them is reporting the
        // state from before the tool ran.
        (await ctx.prRegistry?.refresh(number, repo).catch(() => null)) ?? null,
        {
          text:
            `Posted a ${(res.event ?? event).toLowerCase().replace(/_/g, " ")} review on PR ` +
            `#${number}${res.url ? ` (${res.url})` : ""}.` +
            (details.length ? `\n${details.map((d) => `  · ${d}`).join("\n")}` : "") +
            "\n\nYou are done with this PR. Do NOT resolve the threads you just opened — " +
            "that is the author's half of the loop.",
        },
      );
    },
  );

  const requestReview = tool(
    "request_review",
    "Put reviewers back on the hook for a PR. GitHub CLEARS a reviewer's request " +
      "the moment they submit a review, and pushing fix commits does NOT re-queue " +
      "them — so after you address a review round, nobody is waiting to look at it " +
      "and watch_pr will report reviewStalled:true. Call this AFTER pushing your " +
      "fixes and resolving the threads you addressed, then go back to watch_pr. " +
      "Do not call it before your fixes are pushed: you'd be asking for a review of " +
      "the code they already rejected. It RE-READS the queue afterwards and tells " +
      "you who is actually on the hook — GitHub can accept the request and queue " +
      "nobody, and going back to watch_pr on that is a guaranteed dead wait. " +
      "If Dispatch's reviewer has already spent its rounds on this PR, this REFUSES " +
      "and says so: the review requirement is met and the next call is approve_pr, " +
      "not another round. Pass `extraRounds` only if you genuinely need one more.",
    {
      number: z.number().describe("The PR number."),
      extraRounds: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe(
          "Buy N MORE review rounds on this PR after its cap is spent. Only needed " +
            "when this tool has already told you the rounds are spent — the cap is " +
            "there because two completed rounds ARE the requirement, so reach for " +
            "this when a round died without reviewing or the code changed " +
            "substantially since, not to keep asking until you like the answer. " +
            "Raises the cap for THIS PR only; the project's policy is untouched.",
        ),
      reviewers: z
        .array(z.string())
        .optional()
        .describe(
          "Logins or 'org/team' slugs. Defaults to this project's configured " +
            "reviewers (`workflow.pr.reviewers`).",
        ),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
    },
    async (args): Promise<CallToolResult> => {
      const gh = ctx.github;
      if (!gh?.requestReviewers) {
        return textResult("The request_review tool is not available in this session.", true);
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("request_review requires a positive integer PR number.", true);
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const askedAll = (
        Array.isArray(args.reviewers) && args.reviewers.length
          ? args.reviewers
          : (gh.defaultReviewers ?? [])
      )
        .map((r) => String(r).trim())
        .filter(Boolean);
      // Everyone on the list who is NOT Dispatch's own reviewer. The spent-cap
      // refusal below is about that one account, and must not swallow the rest:
      // on a project asking both a machine account and a human, a spent Dispatch
      // cap used to abort the whole call, report success, and never queue the
      // human the agent explicitly named.
      const mine = gh.reviewAgentLogin?.toLowerCase();
      const others = mine ? askedAll.filter((r) => r.toLowerCase() !== mine) : askedAll;

      // Dispatch's round cap, BEFORE anything is asked of GitHub.
      //
      // Re-queueing a reviewer whose rounds are spent is not merely futile, it
      // is destructive: the request lands on the row, `prReviewAgentView` reads
      // it as `queued`, and `watch_pr` then blocks on a round `claimReviewAgent`
      // will never grant. Worse, GitHub drops the reviews already filed out of
      // `latestReviews` the moment their author is re-requested — which is how
      // PR #147 went from "reviewed twice, landable" to `approve_pr` refusing it
      // for `no-review`. The cheapest fix for all of that is to not make the
      // request.
      const roundState = ctx.prRegistry?.reviewAgent
        ? await ctx.prRegistry.reviewAgent(number, repo).catch(() => null)
        : null;
      const roundView = prReviewAgentView(roundState ?? undefined);
      const extraRounds =
        typeof args.extraRounds === "number" && Number.isInteger(args.extraRounds)
          ? Math.min(3, Math.max(1, args.extraRounds))
          : 0;
      const capSpent = roundView?.roundsSpent === true && !extraRounds;
      // Refuse the CALL only when there is nobody else left to ask. With others
      // on the list the request still goes out — minus Dispatch's own reviewer,
      // whose re-queueing is the destructive part.
      if (capSpent && others.length === 0) {
        const cap = roundView.maxRounds ?? roundView.round;
        return prToolResult(
          "request_review",
          {
            summary: `PR #${number} has had every review round it gets`,
            ok: true,
            details: [
              `${roundView.round} of ${cap} rounds spent` +
                (roundView.posted ? "" : " — none of them posted a review"),
            ],
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          {
            text:
              `Not requesting another review on PR #${number}. Dispatch's reviewer has ` +
              `spent all ${cap} of its ${cap} rounds` +
              (roundView.posted
                ? `, and the review requirement for this PR is MET. Re-queueing the ` +
                  "reviewer now would only hide the reviews it already filed (GitHub " +
                  "drops a review from `latestReviews` the moment its author is " +
                  "re-requested) and make `approve_pr` refuse a PR that is ready.\n\n" +
                  "Address any open threads, then call `mcp__dispatch-github__approve_pr`."
                : " and none of them posted a review — check the reviewer chat. No " +
                  "further round can spawn on its own.") +
              "\n\nIf you genuinely need another round — a reviewer chat died, or the " +
              "code has changed substantially since — call this again with " +
              "`extraRounds: 1`. That raises the cap for THIS PR only.\n" +
              JSON.stringify({
                number,
                requested: [],
                reviewsSpent: true,
                rounds: roundView.round,
                maxRounds: cap,
                posted: roundView.posted,
                requirementMet: roundView.posted,
              }),
          },
        );
      }
      // A grant CLEARS the head dedup, which is what makes it work on the
      // unchanged head a dead reviewer leaves behind — and would also let a
      // second round spawn beside one still writing. So the one state it must
      // refuse is a round that is genuinely running: claimed, unposted, and a
      // reviewer chat we can still see. Waiting is the answer there, not a
      // second reviewer on the same diff.
      if (extraRounds && roundView?.phase === "running") {
        const live = roundView.chatId ? ctx.broker.getStatus(roundView.chatId) : undefined;
        if (live !== undefined && !TERMINAL_STATES.has(live)) {
          return prToolResult(
            "request_review",
            {
              summary: `A review round is already running on PR #${number}`,
              ok: false,
              details: [`round ${roundView.round} is claimed and still writing`],
            },
            (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
            {
              isError: true,
              text:
                `Not granting an extra round on PR #${number}: round ${roundView.round} is ` +
                "claimed and its reviewer chat is still running. A second round beside it " +
                "would put two reviewers on the same diff. Call `mcp__dispatch-github__watch_pr` " +
                "and wait for the one in flight; ask again only if it finishes without " +
                "posting.\n" +
                JSON.stringify({ number, requested: [], reviewRunning: true }),
            },
          );
        }
      }
      if (extraRounds && ctx.prRegistry?.raiseReviewRoundCap) {
        await ctx.prRegistry.raiseReviewRoundCap(number, repo, extraRounds).catch(() => {});
      }

      // With a spent cap we ask everyone EXCEPT Dispatch's own reviewer; that
      // one name is the whole reason the cap matters.
      const asked = capSpent ? others : askedAll;
      // Dispatch's own reviewer, where the project configured one with no GitHub
      // account to queue. Asked ALONGSIDE the GitHub reviewers rather than
      // instead of them: a project can genuinely want both, and it is the same
      // verb either way — which is the point of routing it through this tool
      // instead of adding a second one the loop instructions would have to teach.
      const local =
        gh.requestReviewAgent && !capSpent
          ? await gh.requestReviewAgent(number, repo).catch(() => ({
              ok: false,
              detail: "Dispatch's reviewer could not be asked",
            }))
          : null;
      // Said alongside whatever DID get requested, so a spent cap is never
      // silent just because somebody else was still askable.
      const spentNote = capSpent
        ? ` Dispatch's own reviewer was NOT asked: it has spent all ` +
          `${roundView?.maxRounds ?? roundView?.round} of its rounds on this PR` +
          (roundView?.posted
            ? ", so the review requirement is already met. Pass `extraRounds` if you " +
              "genuinely need another round from it."
            : " and none of them posted a review — check the reviewer chat.")
        : "";

      // An empty list is a CONFIG problem, not a call to retry with. Saying so
      // here stops the loop where an agent re-requests nothing and re-watches.
      // Unless Dispatch's own reviewer took it — then somebody IS on the hook,
      // and "nobody will ever be asked" would be false.
      if (!asked.length && local?.ok) {
        return prToolResult(
          "request_review",
          {
            summary: `Asked Dispatch's reviewer to look at PR #${number}`,
            ok: true,
            details: [local.detail],
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          {
            text:
              `Asked Dispatch's own reviewer to look at PR #${number}. ${local.detail}. ` +
              "Now call `mcp__dispatch-github__watch_pr` to wait for it to report.",
          },
        );
      }
      if (!asked.length) {
        return textResult(
          "No reviewers to request: none were passed and this project configures none " +
            "(`workflow.pr.reviewers` in `.dispatch/project.yaml`). Nobody will ever be " +
            "asked to review here — that's a config fix, not something to retry.",
          true,
        );
      }

      let res: { requested: string[]; failed: Array<{ reviewer: string; error: string }> };
      try {
        res = await gh.requestReviewers(number, asked, repo);
      } catch (err) {
        return prToolResult(
          "request_review",
          {
            summary: `Could not request review on PR #${number}`,
            ok: false,
            details: [err instanceof Error ? err.message : String(err)],
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          {
            isError: true,
            text: `Could not request review on PR #${number}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        );
      }
      const lines: string[] = [];
      for (const f of res.failed) {
        lines.push(`  · ⚠ could not ask ${f.reviewer}: ${f.error}`);
      }
      if (local) lines.push(`  · ${local.ok ? "" : "⚠ "}${local.detail}`);
      if (spentNote) lines.push(`  ·${spentNote}`);

      // VERIFY, don't trust the status code. GitHub answers 200 for this POST and
      // can still queue nobody — observed asking Copilot for a re-review after it
      // had already reported: exit 0, `requested_reviewers: []`. Reporting that as
      // success is the worst possible outcome here, because it sends the agent
      // back to watch_pr to wait on the empty queue this tool exists to refill.
      const queue = await gh.pollPrState(number, repo).catch(() => null);
      const onHook = queue?.review?.requested ?? null;
      // Built here because it needs `onHook`, and consumed by the advice below.
      // Undefined when the queue is not empty — there is nothing to explain.
      const emptyQueue =
        onHook !== null && !onHook.length
          ? await explainEmptyReviewQueue({
              asked,
              onHook,
              // Safe to read `reported` (newest-per-author) rather than the full
              // history here: GitHub only supersedes a review when its author is
              // re-queued, and this branch is the one where nobody was.
              everReviewed: (queue?.review?.reported ?? []).length > 0,
              reviewAgentProblem: roundView?.problem,
              copilotQuota: gh.copilotQuota?.bind(gh),
              hadFailures: res.failed.length > 0,
            })
          : undefined;
      if (onHook !== null) {
        if (onHook.length) {
          lines.push(`  · now awaiting review from ${onHook.join(", ")}`);
        } else {
          lines.push(
            "  · ⚠ the reviewer queue is STILL EMPTY — GitHub answered success and queued nobody",
          );
          for (const cause of emptyQueue?.causes ?? []) lines.push(`  · ${cause}`);
        }
      } else if (res.requested.length) {
        lines.push(`  · asked ${res.requested.join(", ")} (queue not re-read)`);
      }

      // Persist a refusal of OUR reviewer. `res.failed` is already the per-reviewer
      // verdict; the binding matches it against the configured login. Best-effort
      // — a catalog write must not change what the agent is told happened.
      await ctx.prRegistry
        ?.noteReviewRequestError(number, repo, res.failed)
        .catch(() => undefined);

      // Truth is what's on the hook now. Only fall back to "gh said ok" when the
      // queue genuinely couldn't be re-read. Dispatch's own reviewer counts as
      // on the hook even so: it never appears in GitHub's queue, and reading an
      // empty queue as "nobody is coming" while a reviewer is starting up is the
      // same false stall the queue code already exists to prevent.
      const ok =
        (onHook !== null ? onHook.length > 0 : res.requested.length > 0) || Boolean(local?.ok);
      const advice = ok
        ? "Now call `mcp__dispatch-github__watch_pr` again to wait for their review." +
          (spentNote && roundView?.posted
            ? " Do not wait on Dispatch's own reviewer — its rounds are spent and the " +
              "review bar is already met."
            : "")
        : (emptyQueue?.advice ??
          "Fix the reviewer names or the project's `workflow.pr.reviewers`; retrying the " +
            "same list will fail the same way.");
      return prToolResult(
        "request_review",
        {
          summary: ok
            ? `Review requested on PR #${number}`
            : `Nobody is queued on PR #${number}`,
          ok,
          details: lines.map((line) => line.replace(/^\s*·\s*/, "").trim()),
        },
        // Re-poll: the reviewer queue is the thing that just changed, and it is
        // the first thing the card shows.
        (await ctx.prRegistry?.refresh(number, repo).catch(() => null)) ?? null,
        {
          isError: !ok,
          text:
            `${ok ? `Review requested on PR #${number}.` : `Nobody is queued on PR #${number}.`}\n` +
            `${lines.join("\n")}\n\n${advice}\n` +
            JSON.stringify({
              number,
              requested: onHook ?? res.requested,
              failed: res.failed,
              verified: onHook !== null,
            }),
        },
      );
    },
  );

  const createPr = tool(
    "create_pr",
    "Open the pull request for the work in this chat — the ONLY sanctioned way to " +
      "create a PR on this project. Do NOT run `gh pr create` yourself: that's " +
      "refused, and it skips everything this does. In one call it pushes the branch " +
      "with an upstream, opens the PR, REQUESTS THE REVIEWERS this project " +
      "configured, records the PR on this chat, and arms the server-side watcher so " +
      "review comments and failing checks come back to you instead of sitting unseen " +
      "on a page nobody is looking at. It refuses on the mistakes that produce a " +
      "useless PR — you're on the trunk, the branch has no commits, the tree is " +
      "dirty, the branch's PR is on `hold` — and every refusal names the argument " +
      "that overrides it if you genuinely know better. If a PR already exists for " +
      "this branch it hands that one back rather than failing. It inspects the " +
      "chat's worktree (or project root) by default — if you moved since the chat " +
      "started, pass `cwd` so it opens the PR for the branch you actually " +
      "committed on rather than the one the STARTING directory is sitting on.",
    {
      title: z
        .string()
        .optional()
        .describe("PR title. Omit to derive title+body from the branch's commits."),
      body: z.string().optional().describe("PR body (markdown)."),
      base: z
        .string()
        .optional()
        .describe("Base branch to target; defaults to the project's trunk."),
      draft: z
        .boolean()
        .optional()
        .describe("Open as a draft. Defaults to the project's configured setting."),
      allowTrunk: z
        .boolean()
        .optional()
        .describe("Override: open the PR even though you're on the trunk branch."),
      allowNoCommits: z
        .boolean()
        .optional()
        .describe("Override: open the PR even with no commits ahead of the base."),
      allowDirty: z
        .boolean()
        .optional()
        .describe("Override: open the PR with uncommitted changes left out of it."),
      allowHold: z
        .boolean()
        .optional()
        .describe("Override: proceed even though this branch's PR carries `hold`."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Directory whose branch to open the PR for. Defaults to the chat's " +
            "worktree, or its project root. Pass this when you are working " +
            "somewhere the chat wasn't bound to at startup — e.g. a worktree you " +
            "entered mid-session, or when the chat's own directory was removed " +
            "after a merge — otherwise the PR is opened for whatever branch the " +
            "STARTING directory is on. While the chat still has a live directory " +
            "of its own, this must be a worktree of the same repository and " +
            "anything else is ignored in favour of the default; if the chat has " +
            "NO live directory left, a directory that is a checkout is used as " +
            "given, because there is nothing left to check it against.",
        ),
    },
    async (args): Promise<CallToolResult> => {
      const prCreate = ctx.prCreate;
      if (!prCreate) {
        return textResult(
          "The create_pr tool is not available in this session — this project's workflow " +
            "doesn't ship change through pull requests.",
          true,
        );
      }
      const base =
        typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined;

      const at = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;

      let st: PrCreateState | null;
      try {
        st = await prCreate.preflight(base, at);
      } catch (e) {
        return textResult(
          `Could not inspect this branch: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      if (!st) {
        // Two causes, and the remedy differs, so name both rather than the one
        // that used to be printed alone. "Make sure the chat has a worktree" was
        // the whole message for a year, and it was the WRONG advice in the case
        // that produced it most often: the chat had a worktree, and its bound
        // one had merely been reaped out from under it after a merge. An agent
        // told to get a worktree it already has has nowhere to go.
        return textResult(
          "Could not resolve this chat's repo or branch, so there's nothing to open a PR " +
            "from.\n" +
            "  · If you have committed work somewhere, pass `cwd` pointing at that " +
            "worktree — it is used as long as it belongs to this chat's repository.\n" +
            "  · Otherwise `gh` could not name the repository at all (not signed in, " +
            "no `origin`, or GitHub is down). `gh repo view` in your worktree says which.",
          true,
        );
      }
      // A `cwd` that was asked for but not honoured is the single most confusing
      // thing that can happen here — every downstream sentence would describe a
      // directory the caller didn't name. Say so before any of them are printed.
      const ignoredCwd = at && at !== st.cwd ? at : undefined;

      // An existing PR is an ANSWER, not an error: the agent asked for "the PR for
      // this branch to exist", and it does. Failing here would only push it back
      // toward the raw `gh` command to find out what already happened.
      if (st.existing && st.existing.state === "open") {
        return textResult(
          `PR #${st.existing.number} is already open for \`${st.branch}\` — reusing it ` +
            `rather than opening a second one.\n${st.existing.url}\n` +
            "Push more commits to update it, and use `mcp__dispatch-github__watch_pr` to follow " +
            "review.\n" +
            JSON.stringify({
              number: st.existing.number,
              url: st.existing.url,
              created: false,
              existing: true,
            }),
        );
      }

      const blockers = prCreateBlockers(st, {
        allowTrunk: args.allowTrunk === true,
        allowNoCommits: args.allowNoCommits === true,
        allowDirty: args.allowDirty === true,
        allowHold: args.allowHold === true,
      });
      if (blockers.length) {
        // Not an error — "not like this" is a normal, expected answer, and each
        // line already says which argument overrides it.
        //
        // The directory is named unconditionally. Every one of these refusals is
        // a statement ABOUT a checkout, and the expensive failure is a true
        // statement about the wrong one: `on-trunk` + `no-commits` reads as "you
        // haven't done the work" when the work is committed one directory over.
        return textResult(
          `Not opening a PR yet (inspected \`${st.cwd}\`):\n` +
            blockers.map((b) => `  · ${b.detail}`).join("\n") +
            (ignoredCwd
              ? `\n\nNOTE: you passed cwd \`${ignoredCwd}\`, which is NOT a worktree of ` +
                `this chat's repository, so it was ignored and the above describes ` +
                `\`${st.cwd}\` instead.`
              : "") +
            "\n\nIf that is not where your work is, pass `cwd` pointing at the worktree " +
            "you committed in — the default is where the chat STARTED, which is stale " +
            "if you moved since.\n" +
            "\n\nFix these (or pass the named override) and call create_pr again.\n" +
            JSON.stringify({
              created: false,
              blockers: blockers.map((b) => b.code),
              inspected: st.cwd,
              ...(ignoredCwd ? { ignoredCwd } : {}),
            }),
        );
      }

      const draft = typeof args.draft === "boolean" ? args.draft : prCreate.draft;
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `opening PR from ${st.branch}`,
          toolName: "create_pr",
        },
      });

      let res: PrCreateResult;
      try {
        res = await prCreate.create({
          base,
          title: typeof args.title === "string" ? args.title : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          draft,
          // The SAME directory preflight approved. Deciding from one checkout and
          // pushing from another is how you ship a branch nobody reviewed.
          cwd: st.cwd,
        });
      } catch (e) {
        return prToolResult(
          "create_pr",
          {
            summary: "Could not open the PR",
            ok: false,
            details: [e instanceof Error ? e.message : String(e)],
          },
          null,
          {
            isError: true,
            text: `Could not open the PR: ${e instanceof Error ? e.message : String(e)}`,
          },
        );
      }

      // Persist a refused reviewer BEFORE the summary is built. The warning line
      // below has always said this; what it could not do is survive being read
      // once. In `dedicated` mode a refused queue entry means no review will ever
      // start on this PR, and the row is where somebody goes to ask why.
      //
      // `create_pr` takes no repo argument — the binding resolves it from the
      // session's checkout, the same way every other PR tool here does.
      await ctx.prRegistry
        ?.noteReviewRequestError(res.number, undefined, res.reviewersFailed)
        .catch(() => undefined);

      const lines = [
        `Opened PR #${res.number} — ${res.url}`,
        `  · ${res.branch} → ${res.base}${res.draft ? " (draft)" : ""}`,
      ];
      if (res.reviewersRequested.length) {
        lines.push(`  · review requested from ${res.reviewersRequested.join(", ")}`);
      } else if (!prCreate.reviewers.length) {
        // Say it out loud. Silence here is exactly how a PR ends up with nobody
        // looking at it and everyone assuming somebody is.
        lines.push(
          "  · ⚠ no reviewers are configured for this project (`workflow.pr.reviewers` " +
            "in `.dispatch/project.yaml`), so NOBODY has been asked to look at this",
        );
      }
      for (const f of res.reviewersFailed) {
        lines.push(`  · ⚠ could not request ${f.reviewer}: ${f.error}`);
      }
      lines.push(
        res.attached
          ? "  · recorded on this chat"
          : "  · ⚠ could not record the PR on this chat",
        res.watching
          ? "  · watching for review activity — a new review, comment or failing check will " +
              "come back to this chat on its own"
          : "  · ⚠ the review watcher is not running; call `mcp__dispatch-github__watch_pr` yourself",
      );
      return prToolResult(
        "create_pr",
        {
          summary: `Opened PR #${res.number}`,
          ok: true,
          details: lines.slice(1).map((line) => line.replace(/^\s*·\s*/, "").trim()),
        },
        // The very first poll of a PR that did not exist a second ago. `create`
        // already recorded the ref; this is what fills the card with a title,
        // a diff size and whoever was just asked to review.
        (await ctx.prRegistry?.refresh(res.number).catch(() => null)) ?? null,
        {
          text:
            `${lines.join("\n")}\n\nNow call \`mcp__dispatch-github__watch_pr\` in a loop to work the ` +
            `review round.\n` +
            JSON.stringify({
              number: res.number,
              url: res.url,
              created: true,
              draft: res.draft,
              reviewersRequested: res.reviewersRequested,
              watching: res.watching,
            }),
        },
      );
    },
  );

  const approvePr = tool(
    "approve_pr",
    "Approve and MERGE a pull request — the sanctioned way to land your own work " +
      "on a project whose workflow has auto-merge enabled. It re-reads the PR's " +
      "state, checks, review threads and labels at the moment you call it, refuses " +
      "with a complete list of reasons if anything isn't ready, and otherwise " +
      "approves, merges (squash by default), deletes the branch, and syncs the " +
      "trunk. Do NOT run `gh pr merge` yourself — that's refused, and it skips " +
      "every check this does. Default behaviour once watch_pr reports CI green and " +
      "no open threads is to CALL THIS AND MOVE ON: on this project, finishing a " +
      "task means the change is merged, not that a link is waiting for someone. " +
      "The one exception is when the human said otherwise — if they asked you to " +
      "leave it open, to let them review it, to just ship the PR, or to not merge, " +
      "then DON'T call this tool; say the PR is ready and stop. A `hold` label " +
      "means the same thing and is enforced here.",
    {
      number: z.number().describe("The PR number to approve and merge."),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
      method: WorkflowMergeMethodSchema.optional().describe(
        "Merge strategy. Defaults to the project's configured method (usually squash).",
      ),
      note: z
        .string()
        .optional()
        .describe("Optional one-line body for the approving review (what you verified)."),
      allowNoChecks: z
        .boolean()
        .optional()
        .describe(
          "ASK the human to land it even though NO check reported. This does not " +
            "grant itself — it puts a card in front of them and waits, and their no " +
            "is final. Only when you believe this repo genuinely has no CI.",
        ),
      allowNoReview: z
        .boolean()
        .optional()
        .describe(
          "ASK the human to land it even though nobody has reviewed. This does not " +
            "grant itself — it puts a card in front of them and waits, and their no " +
            "is final. A general 'merge it' is NOT permission to merge unreviewed: " +
            "the normal move is to wait for the reviewer with watch_pr.",
        ),
    },
    async (args): Promise<CallToolResult> => {
      const approval = ctx.prApproval;
      if (!approval) {
        return textResult(
          "The approve_pr tool is not available in this session — this project hasn't " +
            "enabled auto-merge. Ship the PR and leave it for review.",
          true,
        );
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("approve_pr requires a positive integer PR number.", true);
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const method = args.method ?? approval.defaultMethod;

      let pr: PrReadiness | null;
      try {
        pr = await approval.readiness(number, repo);
      } catch (e) {
        return prToolResult(
          "approve_pr",
          {
            summary: `Could not read PR #${number}`,
            ok: false,
            details: [e instanceof Error ? e.message : String(e)],
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          {
            isError: true,
            text: `Could not read PR #${number}: ${e instanceof Error ? e.message : String(e)}`,
          },
        );
      }
      if (!pr) {
        return textResult(
          `Could not resolve PR #${number}. Check the number and, if the repo can't be ` +
            "auto-detected here, pass `repo` as 'owner/name'.",
          true,
        );
      }

      // Two verdicts: what the project's bar says on its own, and what it says
      // with the caller's overrides applied. The DIFFERENCE is what an override
      // is actually buying — and that's the only thing worth waking the human
      // for. An `allowNoReview` on a PR a reviewer already approved suppresses
      // nothing and asks nothing.
      const strict = prLandingBlockers(pr, approval.policy);
      const blockers = prLandingBlockers(pr, {
        ...approval.policy,
        allowNoChecks: args.allowNoChecks === true,
        allowNoReview: args.allowNoReview === true,
      });
      if (blockers.length) {
        // Not an error — being told "not yet" is a normal, expected answer.
        const isDone = blockers.some((b) => b.code === "not-open");
        return prToolResult(
          "approve_pr",
          {
            summary: isDone ? "Nothing to do" : `Not landing PR #${number} yet`,
            ok: false,
            details: blockers.map((b) => b.detail),
          },
          (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
          // Being told "not yet" is a normal, expected answer — see prToolResult.
          { isError: false, text:
          `${isDone ? "Nothing to do" : `Not landing PR #${number} yet`}:\n` +
            blockers.map((b) => `  · ${b.detail}`).join("\n") +
            (isDone ? "" : "\n\nFix these, then call approve_pr again.") +
            "\n" +
            JSON.stringify({
              number,
              merged: false,
              blockers: blockers.map((b) => b.code),
            }) },
        );
      }

      // Nothing else stands in the way — so if an override is what got us here,
      // the human has to say so themselves. See `confirmOverride`'s docblock for
      // the merge that produced this gate.
      const remaining = new Set(blockers.map((b) => b.code));
      const suppressed = strict.filter((b) => !remaining.has(b.code));
      if (suppressed.length) {
        const prompt = overrideConsentPrompt(pr, suppressed);
        let verdict: { approved: boolean; message?: string };
        try {
          verdict = await approval.confirmOverride({
            number,
            title: pr.title,
            url: pr.url,
            blockers: suppressed,
          });
        } catch (e) {
          // Fail CLOSED: an unanswerable question is not a yes.
          verdict = { approved: false, message: e instanceof Error ? e.message : String(e) };
        }
        if (!verdict.approved) {
          return prToolResult(
            "approve_pr",
            {
              summary: `Not landing PR #${number} — the human declined the override`,
              ok: false,
              details: suppressed.map((b) => b.detail),
            },
            (await ctx.prRegistry?.snapshot(number, repo).catch(() => null)) ?? null,
            // The human said no. That is an answer, not a tool failure.
            { isError: false, text:
            `Not landing PR #${number} — the human did not approve the override:\n` +
              suppressed.map((b) => `  · ${b.detail}`).join("\n") +
              (verdict.message ? `\n\nThey said: ${verdict.message}` : "") +
              "\n\nThis is their call, not yours: don't re-ask, and don't reach for " +
              "`gh pr merge`. Say the PR is ready and waiting, and stop.\n" +
              JSON.stringify({
                number,
                merged: false,
                blockers: suppressed.map((b) => b.code),
                overrideDeclined: true,
              }) },
          );
        }
        ctx.bus.publish({
          type: "notice",
          chatId: ctx.chatId,
          level: "warn",
          text: `${prompt.title} — approved, landing PR #${number}`,
        });
      }

      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: { state: "tool", label: `merging PR #${number}`, toolName: "approve_pr" },
      });

      const body =
        typeof args.note === "string" && args.note.trim()
          ? args.note.trim()
          : "Checks green and review threads resolved — approved by Dispatch.";
      // Approval first so the record shows WHY it merged, but never a gate: an
      // author can't approve their own PR, and that's the usual case here.
      const approved = await approval
        .approve(number, repo, body)
        .catch((e) => ({ approved: false, error: e instanceof Error ? e.message : String(e) }));

      try {
        await approval.merge(number, repo, method);
      } catch (e) {
        return textResult(
          `PR #${number} passed every readiness check but GitHub refused the merge: ` +
            `${e instanceof Error ? e.message : String(e)}\n` +
            "That's usually branch protection (a required approval or check that isn't " +
            "reporting). Don't work around it — report it and stop.\n" +
            JSON.stringify({ number, merged: false, blockers: ["merge-refused"] }),
          true,
        );
      }

      // Same bookkeeping a watch_pr-observed merge does: the chat's dot goes
      // green, and the manager fast-forwards the primary checkout to the trunk.
      ctx.broker.markPrWatched(ctx.chatId, { number, state: "merged" });
      const noChecks = pr.checks.length === 0 ? " (this PR had no CI checks reporting)" : "";
      return prToolResult(
        "approve_pr",
        {
          summary: `Merged PR #${number} (${method}${approved.approved ? ", approved" : ""})`,
          ok: true,
          details: noChecks ? ["This PR had no CI checks reporting."] : [],
        },
        // The merge just landed; re-poll so the card says merged rather than
        // showing the open PR it was a moment ago.
        (await ctx.prRegistry?.refresh(number, repo).catch(() => null)) ?? null,
        { text:
        `Merged PR #${number} (${method}${approved.approved ? ", approved" : ""})${noChecks}. ` +
          "The branch is deleted and the trunk will fast-forward — the task is done, so " +
          "don't watch it or open anything else.\n" +
          JSON.stringify({ number, merged: true, method, approved: approved.approved }) },
      );
    },
  );

  const requestExemption = tool(
    "request_exemption",
    "ASK THE HUMAN to lift one of Dispatch's command guards for THIS CHAT ONLY — the " +
      "escape hatch for when the sanctioned path a guard redirects you to is genuinely " +
      "BROKEN and you are stuck between a tool that won't work and a refusal. This is a " +
      "request, not a decision: the call blocks while a card sits in front of the human, " +
      "THEY choose whether it covers one command or the rest of this chat, and a refusal " +
      "is final — do not re-ask, and do not try to route around the guard another way. " +
      "Nothing outside this chat is affected and the grant dies with the session, so it " +
      "is never a substitute for fixing the underlying problem. Name the specific guard " +
      "you tripped (the refusal message tells you which); `all` is for the rare case " +
      "where a compound command trips more than one.",
    {
      guard: WorkflowExemptionScopeSchema.describe(
        "Which guard to lift. Use the exact kind named in the refusal you got; `all` " +
          "lifts every workflow guard and is much harder to justify.",
      ),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why the sanctioned path cannot be used right now — what you tried and how it " +
            "failed. This is the whole basis for the human's decision; 'it's faster' is not one.",
        ),
      command: z
        .string()
        .optional()
        .describe("The exact command you intend to run. Shown on the card."),
    },
    async (args): Promise<CallToolResult> => {
      const exemptions = ctx.exemptions;
      if (!exemptions) {
        return textResult(
          "There is no guard to lift in this session — request_exemption isn't available here.",
          true,
        );
      }
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!reason) {
        return textResult(
          "request_exemption requires a reason — it is the only thing the human has to " +
            "decide on.",
          true,
        );
      }
      const scope = args.guard;
      const command =
        typeof args.command === "string" ? args.command.trim() || undefined : undefined;

      // Already covered → don't spend a card on a question that's been answered.
      // An agent that re-asks after being granted reads to the human as one that
      // didn't notice the first yes, and each extra card makes the next one
      // cheaper to wave through.
      const existing = exemptions.list().find((e) => e.scope === "all" || e.scope === scope);
      if (existing) {
        return textResult(
          `Already exempt: the human granted ${describeExemptionScope(existing.scope)} ` +
            `(${existing.lifetime === "once" ? "one command only" : "for this chat"}). ` +
            "Just run your command.\n" +
            JSON.stringify({ granted: true, scope: existing.scope, lifetime: existing.lifetime }),
        );
      }

      let verdict: Awaited<ReturnType<ManagerMcpExemptions["request"]>>;
      try {
        verdict = await exemptions.request({ scope, command, reason });
      } catch (e) {
        // Fail CLOSED, exactly as the approve_pr override does: a question that
        // couldn't be asked is not a yes.
        verdict = { granted: false, message: e instanceof Error ? e.message : String(e) };
      }

      if (!verdict.granted) {
        // Not an error: a refusal is a legitimate answer, and flagging it as one
        // pushes the model into retrying the thing it was just told not to do.
        return textResult(
          `Not granted — the guard on ${describeExemptionScope(scope)} stands.` +
            `${verdict.message ? ` They said: ${verdict.message}` : ""}\n` +
            "This is their call, not yours: don't re-ask and don't work around the guard. " +
            "Report that you're blocked, say what you'd need, and stop.\n" +
            JSON.stringify({ granted: false, scope }),
        );
      }

      const { exemption } = verdict;
      const span =
        exemption.lifetime === "once"
          ? "for the NEXT command that trips it only — one shot, so get it right"
          : "for the rest of this session";
      return textResult(
        `Granted: ${describeExemptionScope(exemption.scope)} is lifted for this chat, ` +
          `${span}. It's visible on the chat header and can be revoked there. Use it for ` +
          "what you asked for and nothing else.\n" +
          JSON.stringify({
            granted: true,
            scope: exemption.scope,
            lifetime: exemption.lifetime,
          }),
      );
    },
  );

  const terminal = tool(
    "terminal",
    "Run a shell command in a NAMED, PERSISTENT terminal whose working directory " +
      "and environment SURVIVE between calls (unlike Bash, which resets each time). " +
      "Reuse the same `name` to keep a cwd (e.g. `cd` once, then run builds from " +
      "there) or an env var across commands. Returns the command output, its exit " +
      "code, and the terminal's current working directory. " +
      "For anything that does NOT return on its own — a dev server, a watcher — pass " +
      "`background: true` and give it its own `name`: the call returns immediately, " +
      "the process is tracked against this chat (visible and killable in Ports & " +
      "processes, reaped with the chat), and you read its output with terminal_output. " +
      "This is the ONLY sanctioned way to start a long-running process: a " +
      "Bash/PowerShell `run_in_background` is invisible to Dispatch and orphans onto " +
      "its port when the session ends.",
    {
      name: z
        .string()
        .describe("Terminal name to run in (created on first use, e.g. 'build')."),
      command: z.string().describe("The shell command to execute."),
      timeoutMs: z
        .number()
        .optional()
        .describe("Give up waiting after this long (the command keeps running)."),
      background: z
        .boolean()
        .optional()
        .describe(
          "Start it and return immediately — for a server/watcher that never exits. " +
            "Use a dedicated terminal name; this one stays busy until it stops.",
        ),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.terminals) {
        return textResult("The terminal tool is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const command = typeof args.command === "string" ? args.command : "";
      if (!name) return textResult("terminal requires a non-empty name.", true);
      if (!command.trim()) return textResult("terminal requires a command.", true);

      const res = await ctx.terminals.run({
        name,
        command,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        signal: extraSignal(extra) ?? ctx.signal,
        background: args.background === true,
      });

      if (res.backgrounded) {
        return textResult(
          `[${name}] started in the background (cwd=${res.cwd}). ` +
            `Read its output with terminal_output({ name: "${name}" }). ` +
            `It is tracked against this chat and stops when the chat is torn down.`,
        );
      }

      const header = `[${name}] cwd=${res.cwd} exit=${res.exitCode ?? "n/a"}`;
      const body = res.output ? `\n${res.output}` : "";
      const note = res.error ? `\n(${res.error})` : "";
      return textResult(`${header}${body}${note}`, !!res.error && !res.timedOut);
    },
  );

  const terminalOutput = tool(
    "terminal_output",
    "Read the recent output of a named terminal — how you check on a command you " +
      "started with `terminal({ background: true })` (did the dev server come up? " +
      "what did the watcher print?). Returns the tail of that shell's output.\n" +
      "Narrow it rather than reading 50 lines and hoping: `grep` for a substring, " +
      "`since` for an epoch-ms watermark ('what's new since I last looked'), " +
      "`stream: \"stderr\"` for errors only. Omit `name` to list this chat's " +
      "terminals instead — including ones whose shell has exited, whose output is " +
      "still readable.",
    {
      name: z
        .string()
        .optional()
        .describe("The terminal name to read. Omit to list terminals instead."),
      lines: z
        .number()
        .optional()
        .describe("How many trailing lines to return (default 50)."),
      grep: z.string().optional().describe("Only lines containing this substring."),
      since: z
        .number()
        .optional()
        .describe("Only lines at or after this epoch-ms timestamp."),
      stream: z
        .enum(["stdout", "stderr"])
        .optional()
        .describe("Restrict to one stream — 'stderr' to see just the errors."),
      scope: z
        .enum(["chat", "project", "all"])
        .optional()
        .describe("When listing: how wide. Default 'chat'."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.terminals) {
        return textResult("The terminal tool is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        const rows = ctx.terminals.list({ scope: args.scope, q: args.grep });
        if (rows.length === 0) {
          return textResult(`No terminals for scope '${args.scope ?? "chat"}'.`);
        }
        return textResult(
          `${rows.length} terminal(s):\n${JSON.stringify(
            rows.map((t) => ({
              name: t.name,
              chatId: t.chatId,
              cwd: t.cwd,
              status: t.status,
              archived: t.archived,
              busy: t.busy,
              background: t.background?.command,
              lastCommand: t.lastCommand,
              lastExitCode: t.lastExitCode,
              lines: t.lines,
            })),
            null,
            2,
          )}`,
        );
      }
      const res = await ctx.terminals.tail({
        name,
        lines: typeof args.lines === "number" ? args.lines : undefined,
        q: args.grep,
        since: typeof args.since === "number" ? args.since : undefined,
        stream: args.stream,
      });
      if (!res.found) {
        return textResult(`No terminal named '${name}' in this chat.`, true);
      }
      return textResult(res.output ? `[${name}]\n${res.output}` : `[${name}] (no output matched)`);
    },
  );

  const worktree = tool(
    "worktree",
    "Create, list or remove a git worktree — the ONLY way to do so in Dispatch " +
      "(`git worktree add` in a shell is refused). A worktree created here is " +
      "recorded against THIS chat the moment it exists, so it shows up correlated " +
      "in the Workspace view instead of as somebody's anonymous directory.\n" +
      "  action='create' — cuts <branch> off the project's default base and " +
      "returns its path. Work there; it is not this session's cwd.\n" +
      "  action='list'   — this chat's worktrees by default; scope='project' or " +
      "'all' to see everyone's, with `q` as a substring filter over path/branch/label.\n" +
      "  action='remove' — removes the worktree at `path` (use force for a dirty tree).",
    {
      action: z
        .enum(["create", "list", "remove"])
        .describe("What to do. Defaults to 'list'.")
        .optional(),
      branch: z.string().optional().describe("Branch to cut (action='create')."),
      base: z
        .string()
        .optional()
        .describe("Base ref to branch from. Default: the project's default branch on origin."),
      label: z
        .string()
        .optional()
        .describe("Short human label for what this worktree is for."),
      path: z.string().optional().describe("Worktree path (action='remove')."),
      force: z
        .boolean()
        .optional()
        .describe("Remove even with uncommitted changes (action='remove')."),
      scope: z
        .enum(["chat", "project", "all"])
        .optional()
        .describe("How wide to list. Default 'chat'."),
      q: z.string().optional().describe("Substring filter over path, branch and label."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.worktrees) {
        return textResult("The worktree tool is not available in this session.", true);
      }
      const action = args.action ?? "list";
      try {
        if (action === "create") {
          const branch = typeof args.branch === "string" ? args.branch.trim() : "";
          if (!branch) return textResult("worktree create requires a branch.", true);
          const info = await ctx.worktrees.create({
            branch,
            base: args.base,
            label: args.label,
          });
          return textResult(
            `Created worktree for ${info.branch} at ${info.path} (base ${info.base ?? "default"}). ` +
              `It is recorded against this chat. Run commands there with ` +
              `terminal({ name: "…", command: "cd '${info.path}' && …" }).`,
          );
        }
        if (action === "remove") {
          const path = typeof args.path === "string" ? args.path.trim() : "";
          if (!path) return textResult("worktree remove requires a path.", true);
          await ctx.worktrees.remove({ path, force: args.force === true });
          return textResult(`Removed worktree ${path}.`);
        }
        const list = await ctx.worktrees.list({ scope: args.scope, q: args.q });
        if (list.length === 0) {
          return textResult(
            `No worktrees for scope '${args.scope ?? "chat"}'${args.q ? ` matching '${args.q}'` : ""}.`,
          );
        }
        const rows = list.map((w) => ({
          path: w.path,
          branch: w.branch,
          chatId: w.chatId,
          origin: w.origin,
          label: w.label,
          mine: w.chatId === ctx.chatId || undefined,
          primary: w.isPrimary,
        }));
        return textResult(
          `${rows.length} worktree(s):\n${JSON.stringify(rows, null, 2)}`,
        );
      } catch (err) {
        return textResult(
          `worktree ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const remember = tool(
    "remember",
    "Record a DURABLE fact about THIS project that should survive across chats — a " +
      "user preference, a correction/lesson, an architecture decision, or a pointer " +
      "to reference material. Reach for this WHENEVER you learn something you'd want " +
      "a future session to know without being re-told: it's saved to the project's " +
      "shared memory, listed in its index, and the relevant ones are auto-surfaced " +
      "in later turns. Keep each memory ONE focused fact. Reuse the same `name` to " +
      "UPDATE (it overwrites). Keep `description` to one line; put detail in `body`.",
    {
      name: z
        .string()
        .describe("Short kebab-case identity, e.g. 'deploy-runbook'. Reusing it overwrites."),
      description: z
        .string()
        .describe(
          "One-line summary — this is the retrieval signal shown in the index and " +
            "matched against future turns, so make it specific and searchable.",
        ),
      type: MemoryTypeSchema.describe(
        "user = a durable preference; feedback = a correction/lesson; project = a " +
          "codebase/architecture fact; reference = a pointer to docs/material.",
      ),
      body: z
        .string()
        .describe(
          "The full fact, in markdown. For feedback/project, follow it with a **Why:** " +
            "line so the rationale survives. Link related memories with [[their-name]].",
        ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("remember requires a non-empty name.", true);
      try {
        const description = typeof args.description === "string" ? args.description : "";
        const body = typeof args.body === "string" ? args.body : "";
        const memory = await ctx.memory.remember({ name, description, type: args.type, body });

        // Dedup nudge: if this closely resembles an existing (differently-named)
        // memory, the fact was likely already recorded — steer toward consolidating
        // rather than accumulating a near-duplicate. Best-effort; never blocks the
        // save that already succeeded.
        let nudge = "";
        try {
          const similar =
            (await ctx.memory.findSimilar?.({ name: memory.name, description, body })) ?? [];
          if (similar.length) {
            const list = similar
              .map((s) => `\`${s.name}\` (${Math.round(s.similarity * 100)}% similar)`)
              .join(", ");
            nudge =
              `\n\n⚠️ This looks like it may duplicate existing memory: ${list}. ` +
              "If it's the SAME fact, consolidate to keep memory lean — fold the detail " +
              `into one and \`forget\` the other (reuse a name to overwrite). If "${memory.name}" ` +
              "is genuinely distinct, ignore this.";
          }
        } catch {
          /* dedup hint is best-effort — a lookup failure never fails the remember */
        }

        return textResult(
          `Remembered "${memory.name}" (${memory.type}). It's saved to project memory ` +
            "and will be injected into future sessions. Use recall to read it back." +
            nudge,
        );
      } catch (err) {
        return textResult(
          `Could not record that memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const recall = tool(
    "recall",
    "Look up this project's durable memory. With no query you get the index (one " +
      "line per memory); with a query you get the FULL body of the most RELEVANT " +
      "memories, ranked (plus any they `[[link]]` to) — use it to pull a fact on " +
      "demand. Confidently-relevant memories are already surfaced in full as you " +
      "work, but weaker matches are offered as just a name + one-line description: " +
      "pass such a name as the query to read the whole thing. Also call this to dig " +
      "deeper, or when you need a fact that wasn't surfaced at all.",
    {
      query: z
        .string()
        .optional()
        .describe("Optional search term; omit to just list the memory index."),
      type: MemoryTypeSchema.optional().describe(
        "Optionally restrict to one kind: user | feedback | project | reference.",
      ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const type = args.type;
      try {
        const { index, matches } = await ctx.memory.recall(query || undefined, { type });
        if (!query) return textResult(index);
        if (!matches.length) {
          return textResult(`No memories matched "${query}".\n\n${index}`);
        }
        // Render within a total char budget so a broad query over a large memory
        // store can never exceed the MCP tool-result token cap. Bodies are clamped
        // individually; once the budget runs out the rest are listed by name only.
        const MAX_TOTAL = 24000;
        const MAX_BODY = 5000;
        const sections: string[] = [];
        const omitted: string[] = [];
        let budget = MAX_TOTAL;
        for (const m of matches) {
          const linked = (m as { linked?: boolean }).linked ? " — linked" : "";
          const head = `### ${m.name} (${m.type})${linked}\n${m.description}`;
          const section = `${head}\n\n${clampBody(m.body, MAX_BODY)}`;
          if (section.length <= budget) {
            sections.push(section);
            budget -= section.length;
          } else {
            omitted.push(m.name);
          }
        }
        const tail = omitted.length
          ? `\n\n---\n\n_${omitted.length} more match(es) omitted to stay within the size limit: ` +
            `${omitted.join(", ")}. Narrow your query or recall by name/type._`
          : "";
        return textResult(
          `${matches.length} match(es) for "${query}":\n\n${sections.join("\n\n---\n\n")}${tail}`,
        );
      } catch (err) {
        return textResult(
          `Could not recall memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const forget = tool(
    "forget",
    "Delete a durable project memory by name. Use when a recorded fact is wrong or " +
      "no longer relevant so it stops being injected into future sessions.",
    {
      name: z.string().describe("The memory's name (as shown by recall)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("forget requires a non-empty name.", true);
      try {
        const removed = await ctx.memory.forget(name);
        return removed
          ? textResult(`Forgot memory "${name}".`)
          : textResult(`No memory named "${name}" to forget.`, true);
      } catch (err) {
        return textResult(
          `Could not forget that memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  /* ------------------------------------------------------- memory curation
   * `recall` is built for an agent mid-task: fuzzy, ranked, and deliberately
   * bounded to the few facts most relevant right now. That is exactly wrong for
   * curating the store, where the questions are exhaustive rather than
   * best-effort — "show me all 141 with their age and usage", "which ones still
   * mention `taskkill`", "when was this written and what else was retired". Each
   * of those has ONE correct answer, and a relevance ranking that returns the
   * best six actively hides it. Hence a separate read surface. */

  const memoryList = tool(
    "memory_list",
    "Inventory this project's durable memories with the signals that decide whether " +
      "each still belongs: size, last write, how often it's actually been retrieved, " +
      "and its `[[link]]` neighbours in both directions. Unlike `recall` this is " +
      "EXHAUSTIVE and unranked — use it to audit or curate the store, not to look up " +
      "a fact. `sort: 'unused'` surfaces prune candidates; `sort: 'oldest'` surfaces " +
      "what may have gone stale.",
    {
      type: MemoryTypeSchema.optional().describe(
        "Restrict to one kind: user | feedback | project | reference.",
      ),
      prefix: z
        .string()
        .optional()
        .describe("Only names starting with this, e.g. 'steam' for the steam-* area."),
      names: z
        .array(z.string())
        .optional()
        .describe("Only these exact memories — the way to read a known set in one call."),
      sort: z
        .enum(["name", "recent", "oldest", "size", "unused"])
        .optional()
        .describe(
          "name (default) | recent (newest first) | oldest | size (biggest first) | " +
            "unused (never-recalled and least-used first).",
        ),
      includeBody: z
        .boolean()
        .optional()
        .describe("Include each full body. Costly over a whole store — pair with names/prefix."),
      limit: z.number().int().positive().optional().describe("Max rows (default 200)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory?.inventory) {
        return textResult("Memory inventory is not available in this session.", true);
      }
      try {
        const rows = await ctx.memory.inventory({
          ...(args.type ? { type: args.type } : {}),
          ...(args.prefix ? { prefix: args.prefix } : {}),
          ...(args.names?.length ? { names: args.names } : {}),
        });
        if (!rows.length) return textResult("No memories match that filter.");

        const sorted = sortInventory(rows, args.sort ?? "name");
        const limit = Math.max(1, Math.min(500, args.limit ?? 200));
        const shown = sorted.slice(0, limit);
        const header =
          `${rows.length} memor${rows.length === 1 ? "y" : "ies"}` +
          (shown.length < sorted.length ? ` (showing ${shown.length})` : "") +
          `, sorted by ${args.sort ?? "name"}:`;

        if (args.includeBody) {
          // Budgeted the same way `recall` is — a whole store with bodies would
          // blow the tool-result cap, and a silent clip reads as "that's all".
          const MAX_TOTAL = 24000;
          const sections: string[] = [];
          const omitted: string[] = [];
          let budget = MAX_TOTAL;
          for (const m of shown) {
            const section = `### ${m.name} (${m.type})\n${inventoryLine(m)}\n${
              m.description
            }\n\n${clampBody(m.body, 4000)}`;
            if (section.length <= budget) {
              sections.push(section);
              budget -= section.length;
            } else omitted.push(m.name);
          }
          const tail = omitted.length
            ? `\n\n---\n\n_${omitted.length} body/bodies omitted to stay within the size ` +
              `limit: ${omitted.join(", ")}. Narrow with names/prefix._`
            : "";
          return textResult(`${header}\n\n${sections.join("\n\n---\n\n")}${tail}`);
        }

        // Even one line per memory adds up: a 300-fact store with long
        // descriptions and dense link lists clears the tool-result cap on its
        // own, and a listing that silently stops reads as "that's the store".
        const MAX_TOTAL = 24000;
        const lines: string[] = [];
        let budget = MAX_TOTAL;
        let dropped = 0;
        for (const m of shown) {
          const line = `- \`${m.name}\` — ${inventoryLine(m)}\n  ${m.description}`;
          if (line.length > budget) {
            dropped = shown.length - lines.length;
            break;
          }
          lines.push(line);
          budget -= line.length;
        }
        const tail = dropped
          ? `\n\n_${dropped} more row(s) omitted to stay within the size limit. ` +
            "Narrow with `type`/`prefix`, or page with `limit`._"
          : "";
        return textResult(`${header}\n\n${lines.join("\n")}${tail}`);
      } catch (err) {
        return textResult(
          `Could not list memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const memorySearch = tool(
    "memory_search",
    "Find EVERY memory containing a literal string (or regex) — the exact-match " +
      "counterpart to `recall`'s fuzzy ranking. Returns one hit per matching line " +
      "with its location, so you get evidence rather than whole bodies. Use it when " +
      "the question is 'which memories still mention X' and a partial answer would " +
      "be wrong: auditing a renamed API, a retired tool, a path that moved.",
    {
      pattern: z.string().describe("Literal substring by default; a JS regex with regex: true."),
      regex: z.boolean().optional().describe("Treat the pattern as a regular expression."),
      caseSensitive: z.boolean().optional().describe("Default false — matching ignores case."),
      field: z
        .enum(["name", "description", "body"])
        .optional()
        .describe("Restrict to one field; default searches all three."),
      limit: z.number().int().positive().optional().describe("Max hits (default 100)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory?.grep) {
        return textResult("Memory search is not available in this session.", true);
      }
      try {
        const { matches, truncated, timedOut, scanned } = await ctx.memory.grep({
          pattern: args.pattern,
          ...(args.regex === undefined ? {} : { regex: args.regex }),
          ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
          ...(args.field ? { field: args.field } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        if (!matches.length) {
          return textResult(`No memory matches ${JSON.stringify(args.pattern)} (${scanned} scanned).`);
        }
        // Grouped by memory: the useful reading is "these 4 facts mention it",
        // not a flat list where one memory's six lines look like six memories.
        const byName = new Map<string, MemoryGrepMatch[]>();
        for (const m of matches) {
          const list = byName.get(m.name);
          if (list) list.push(m);
          else byName.set(m.name, [m]);
        }
        const blocks = [...byName.entries()].map(([name, hits]) => {
          const type = hits[0]?.type ?? "project";
          const lines = hits.map(
            (h) => `  ${h.field}${h.line ? `:${h.line}` : ""} — ${h.text}`,
          );
          return `\`${name}\` (${type})\n${lines.join("\n")}`;
        });
        // A timed-out scan is NOT a complete answer, and this tool's whole
        // value is that its answer is exhaustive — so say which kind of
        // incomplete it is rather than letting it read as "that's all of them".
        const tail = timedOut
          ? "\n\n_⚠ The scan hit its time budget and stopped early — this is a PARTIAL " +
            "result. A `regex: true` pattern that backtracks is the usual cause; a literal " +
            "search over this store should be instant._"
          : truncated
            ? "\n\n_Result truncated — raise `limit` or narrow the pattern._"
            : "";
        return textResult(
          `${matches.length} hit(s) in ${byName.size} memor${byName.size === 1 ? "y" : "ies"} ` +
            `(${scanned} scanned):\n\n${blocks.join("\n\n")}${tail}`,
        );
      } catch (err) {
        return textResult(
          `Could not search memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const memoryHistory = tool(
    "memory_history",
    "Read the git history of this project's memory: when a fact was first written, " +
      "how often it's been rewritten since, and — with no `name` — which memories " +
      "were DELETED and when. Check this before retiring a fact (was it just " +
      "written?) and before adding one (was it deliberately retired already?). A " +
      "memory's `updatedAt` only tells you the last write; this tells you the shape " +
      "of the argument behind it.",
    {
      name: z
        .string()
        .optional()
        .describe("One memory's history (follows renames). Omit for the whole memory dir."),
      limit: z.number().int().positive().optional().describe("Max commits (default 20)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory?.history) {
        return textResult("Memory history is not available in this session.", true);
      }
      try {
        const res: MemoryHistoryResult = await ctx.memory.history({
          ...(args.name ? { name: args.name } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        if (!res.available) {
          return textResult(`No memory history available: ${res.reason ?? "unknown reason"}`);
        }
        if (!res.commits.length) {
          return textResult(res.reason ?? "No commits touch this memory yet.");
        }
        const lines = res.commits.map((c) => {
          const when = c.date.slice(0, 10) || c.date;
          const head = `${when}  ${c.sha.slice(0, 8)}  ${c.subject}`;
          if (!c.files.length) return head;
          const files = c.files
            .filter((f) => f.name !== "MEMORY") // the generated index churns every commit
            .map((f) => (f.from ? `${f.kind} ${f.from}→${f.name}` : `${f.kind} ${f.name}`));
          return files.length ? `${head}\n    ${files.join(", ")}` : head;
        });
        const scope = args.name ? `\`${args.name}\`` : "the memory dir";
        return textResult(`${res.commits.length} commit(s) touching ${scope}:\n\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(
          `Could not read memory history: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const memorySimilar = tool(
    "memory_similar",
    "Find memories that look like the SAME FACT as a given one (or as a passage of " +
      "text) — the duplicate detector behind the `remember` nudge, callable " +
      "directly. Scores blended name/description/body overlap. Use it to confirm a " +
      "suspected duplicate before merging, and to sweep for near-duplicates a " +
      "keyword search would miss because the two copies share no vocabulary in " +
      "their names.",
    {
      name: z.string().optional().describe("Compare against this existing memory."),
      text: z
        .string()
        .optional()
        .describe("Compare against arbitrary text instead (e.g. a draft you're about to save)."),
      threshold: z
        .number()
        .optional()
        .describe("Minimum similarity 0–1. Default 0.35; drop to ~0.25 to sweep wider."),
      limit: z.number().int().positive().optional().describe("Max matches (default 5)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory?.findSimilar) {
        return textResult("Memory similarity is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!name && !text) {
        return textResult("memory_similar needs either a `name` or some `text`.", true);
      }
      try {
        let candidate: { name: string; description?: string; body?: string };
        if (name) {
          const existing = await ctx.memory.read?.(name);
          if (!existing) return textResult(`No memory named "${name}".`, true);
          candidate = {
            name: existing.name,
            description: existing.description,
            body: existing.body,
          };
        } else {
          // A free-text probe has no name/description of its own, and the blend
          // weights name at 0.45 — leaving those empty would cap every score at
          // 0.55 and hide real duplicates under any sane threshold. Comparing the
          // text against all three fields is the honest reading of "how much does
          // this passage overlap with that memory".
          candidate = { name: text, description: text, body: text };
        }
        const threshold = typeof args.threshold === "number" ? args.threshold : 0.35;
        const limit = Math.max(1, args.limit ?? 5);
        const matches = await ctx.memory.findSimilar(candidate, { threshold, limit });
        // Belt and braces: an implementation that ignores the opts (the interface
        // allows it) must not silently return the 3 defaults as if they were the
        // answer to a wider sweep.
        const kept = matches.filter((m) => m.similarity >= threshold).slice(0, limit);
        if (!kept.length) {
          return textResult(
            `Nothing resembles ${name ? `"${name}"` : "that text"} at or above ${threshold}.`,
          );
        }
        const lines = kept.map(
          (m) => `- \`${m.name}\` (${Math.round(m.similarity * 100)}% similar) — ${m.description}`,
        );
        return textResult(
          `${kept.length} possible duplicate(s) of ${name ? `\`${name}\`` : "that text"}:\n\n` +
            `${lines.join("\n")}\n\n_Similarity is a lexical signal, not a verdict — read both ` +
            "bodies before merging._",
        );
      } catch (err) {
        return textResult(
          `Could not compare memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const spawnChat = tool(
    "spawn_chat",
    "Start a NEW Dispatch chat to carry work that shouldn't ride in yours — a long " +
      "independent task, a second workstream, a job for another project. THE HUMAN " +
      "MUST CONSENT: this call blocks while an approval prompt sits in front of them, " +
      "and returns 'declined' if they say no. There is no argument that skips the " +
      "prompt (only their own setting can), so ask for what you actually need and " +
      "explain it in `reason`. On approval the chat is created, started, and handed " +
      "your `prompt` as its first message — write that prompt as a complete, " +
      "standalone brief, because the new chat inherits NONE of this conversation. " +
      "The new chat is FILED UNDER YOURS in the sidebar, so a handful of them fold " +
      "into your row instead of scattering across the list — pass detached: true " +
      "only for work whose life has nothing to do with this chat's. Projects cap how " +
      "deep that filing goes (usually one level), so if YOU are already a spawned " +
      "chat this call is refused and says so — do the work yourself instead. " +
      "Returns the new chatId; pass it to wait_for_chat to sequence behind it.",
    {
      prompt: z
        .string()
        .describe(
          "The new chat's first message — a complete, self-contained brief (it " +
            "cannot see this conversation).",
        ),
      title: z.string().optional().describe("Title for the new chat. Omit to auto-title it."),
      projectId: z
        .string()
        .optional()
        .describe("Project to spawn in. Defaults to this chat's own project."),
      modeId: z.string().optional().describe("Mode id for the new chat (default: your project's)."),
      agentId: z.string().optional().describe("Custom agent id to run the new chat as."),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning effort for the new chat (default: medium)."),
      model: z.string().optional().describe("Model id override for the new chat."),
      reason: z
        .string()
        .optional()
        .describe("Why you want this chat — shown to the human on the approval prompt."),
      detached: z
        .boolean()
        .optional()
        .describe(
          "Leave the new chat at the sidebar's top level instead of folding it under " +
            "yours. Default false — a chat you spawned is normally a child of yours. " +
            "Use it for a genuinely independent workstream.",
        ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.chats) {
        return textResult("The spawn_chat tool is not available in this session.", true);
      }
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return textResult(
          "spawn_chat requires a non-empty prompt — the new chat starts with no " +
            "context but that message.",
          true,
        );
      }
      const request: SpawnChatRequest = {
        prompt,
        title: typeof args.title === "string" ? args.title.trim() || undefined : undefined,
        projectId:
          typeof args.projectId === "string" ? args.projectId.trim() || undefined : undefined,
        modeId: typeof args.modeId === "string" ? args.modeId.trim() || undefined : undefined,
        agentId: typeof args.agentId === "string" ? args.agentId.trim() || undefined : undefined,
        effort: args.effort as Effort | undefined,
        model: typeof args.model === "string" ? args.model.trim() || undefined : undefined,
        reason: typeof args.reason === "string" ? args.reason.trim() || undefined : undefined,
        detached: args.detached === true,
      };

      const project = await ctx.chats.resolveProject(request.projectId);
      if (!project) {
        return textResult(
          request.projectId
            ? `No project "${request.projectId}" — check the id, or omit projectId to ` +
                "spawn in this chat's own project."
            : "This session has no project, so there is nowhere to spawn a chat. Pass " +
                "an explicit projectId.",
          true,
        );
      }

      // The nesting cap, BEFORE consent: a spawn this project forbids should not
      // cost the human a card to say no to. A thrown lookup is treated as no cap
      // rather than as a refusal — the policy is soft by design, and failing it
      // closed would take spawning down with the chat store.
      const nesting = ctx.chats.nesting
        ? await ctx.chats.nesting({ request, project }).catch(() => null)
        : null;
      if (nesting && !nesting.allowed) {
        // Not flagged as an error, for the same reason the decline below isn't:
        // "no" is a legitimate answer, and an error pushes the model into
        // retrying the exact call it was just refused.
        // `maxDepth: 0` is a different refusal and must not be told to work
        // around itself: `detached: true` is the right advice when the cap is
        // about DEPTH, and exactly the wrong advice for a project that has
        // asked for no agent-started chats at all.
        const banned = nesting.maxDepth <= 0;
        return textResult(
          (banned
            ? `Not spawned — ${project.name} does not allow chats to start other ` +
              "chats at all. Do NOT retry it, with detached or otherwise.\n" +
              "Carry the work here, or ask the human to open the chat themselves.\n"
            : `Not spawned — this chat is itself ${nesting.depth} level${
                nesting.depth === 1 ? "" : "s"
              } deep in ${project.name}'s sidebar, and this project nests spawned ` +
              `chats at most ${nesting.maxDepth} deep. Do NOT retry it.\n` +
              "A chat at this depth can still pick up PR reviewers — those are filed " +
              "underneath it — but it cannot start chats of its own. Carry the work " +
              "here, or hand it back to the chat that spawned you. If it is genuinely " +
              "independent of this one, spawn it with detached: true and it starts at " +
              "the top level instead of under you.\n") +
            "(The human sets this per project: spawnChat.maxDepth in .dispatch/project.yaml.)\n" +
            JSON.stringify({
              approved: false,
              reason: banned ? "spawning-disabled" : "nesting-depth",
              depth: nesting.depth,
              maxDepth: nesting.maxDepth,
              projectId: project.id,
            }),
        );
      }

      let consent: SpawnChatConsent;
      try {
        consent = await ctx.chats.consent({ request, project });
      } catch (err) {
        return textResult(
          `Could not ask for approval to spawn a chat: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }
      if (!consent.approved) {
        // Not an error: a refusal is a legitimate answer, and flagging it as one
        // pushes the model into retrying the thing it was just told not to do.
        return textResult(
          `Declined — the human did not approve spawning a chat in ${project.name}.` +
            `${consent.message ? ` They said: ${consent.message}` : ""}\n` +
            "Do NOT retry it; carry on here, or ask them what they'd prefer.\n" +
            JSON.stringify({ approved: false, projectId: project.id }),
        );
      }

      try {
        const spawned = await ctx.chats.spawn({ request, project });
        return textResult(
          `Spawned chat "${spawned.title}" in ${spawned.projectName} and sent it the ` +
            `brief${consent.auto ? " (auto-approved by your settings)" : ""}. It runs ` +
            "independently of this one — use wait_for_chat if you need to sequence " +
            "behind it.\n" +
            JSON.stringify({
              approved: true,
              autoApproved: consent.auto,
              chatId: spawned.chatId,
              title: spawned.title,
              projectId: spawned.projectId,
            }),
        );
      } catch (err) {
        return textResult(
          `Approved, but the chat could not be created: ${
            err instanceof Error ? err.message : String(err)
          }`,
          true,
        );
      }
    },
  );

  const runSubapp = tool(
    "run_subapp",
    "Launch one of THIS project's apps and get back a live localhost URL so you can " +
      "actually SEE your change running — preview a UI tweak, verify a fix end-to-end, " +
      "or hand the user a working link. STRONGLY prefer this over telling the user to " +
      "start the app themselves; running the real thing is the fastest way to confirm " +
      "your work. Call with NO args to list the apps, their run state, and the branches " +
      "available. Pass `subApp` (and optionally `branch`) to start it — each branch runs " +
      "isolated in its own worktree, created automatically if needed. Pass `stop: true` " +
      "to stop it.",
    {
      subApp: z
        .string()
        .optional()
        .describe("SubApp id to start/stop (e.g. 'game'). Omit to just list."),
      branch: z
        .string()
        .optional()
        .describe("Branch to run on. Defaults to the project's current branch."),
      stop: z.boolean().optional().describe("Stop the running instance instead of starting."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.runner) {
        return textResult("The run_subapp tool is not available in this session.", true);
      }
      const subApp = typeof args.subApp === "string" ? args.subApp.trim() : "";
      const branch = typeof args.branch === "string" ? args.branch.trim() : undefined;

      // No subApp → list what's available + what's running.
      if (!subApp) {
        try {
          const ov = await ctx.runner.overview(ctx.chatId);
          const apps = ov.subApps.length
            ? ov.subApps.map((a) => `  • ${a.id} (${a.name})`).join("\n")
            : "  (none configured)";
          const running = ov.running.length
            ? ov.running
                .map(
                  (r) =>
                    `  • ${r.subAppId} — ${r.status}${r.branch ? ` on ${r.branch}` : ""}${
                      r.url ? ` → ${r.url}` : ""
                    }`,
                )
                .join("\n")
            : "  (nothing running)";
          const branches = ov.branches
            .slice(0, 12)
            .map(
              (b) =>
                `  • ${b.name}${b.current ? " (current)" : ""}${b.hasWorktree ? " [worktree]" : ""}`,
            )
            .join("\n");
          return textResult(
            `Apps:\n${apps}\n\nRunning:\n${running}\n\nBranches:\n${branches}\n\n` +
              `Start one with run_subapp({ subApp: "<id>", branch?: "<branch>" }).`,
          );
        } catch (err) {
          return textResult(
            `Could not read subApps: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      }

      try {
        if (args.stop) {
          const stopped = await ctx.runner.stop({ chatId: ctx.chatId, subAppId: subApp, branch });
          return stopped
            ? textResult(`Stopped ${subApp}${branch ? ` on ${branch}` : ""}.`)
            : textResult(`No running ${subApp}${branch ? ` on ${branch}` : ""} to stop.`, true);
        }
        const r = await ctx.runner.launch({ chatId: ctx.chatId, subAppId: subApp, branch });
        const where = r.branch ? ` on ${r.branch}` : "";
        // Point at the eyes, not just the address. See `browserServers`.
        const look = r.url && ctx.browserServers?.length
          ? ctx.browserServers.includes("playwright")
            ? `Look at it before calling this done: mcp__playwright__browser_navigate to that URL, ` +
              `then mcp__playwright__browser_snapshot (cheap, tells you what is on the page) or ` +
              `mcp__playwright__browser_take_screenshot (when the question is visual).`
            : `Look at it before calling this done: mcp__chrome-devtools__navigate_page to that URL, ` +
              `then mcp__chrome-devtools__take_screenshot.`
          : "";
        // The URL ends its line with NO trailing punctuation: a period directly
        // after it gets swallowed into the link by most auto-linkers, so the
        // thing the agent is being told to open is the thing it can copy.
        return textResult(
          r.url
            ? `Started ${r.subAppId}${where} — ${r.status}. Open it at ${r.url}` +
              (look ? `

${look}` : "")
            : `Started ${r.subAppId}${where} — ${r.status} (no URL yet; give it a moment and list again).`,
        );
      } catch (err) {
        return textResult(
          `Could not launch ${subApp}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  /* ------------------------------------------------------- MCP config */

  const mcpList = tool(
    "mcp_list",
    "List the MCP servers configured for THIS project in `.dispatch/project.yaml`. " +
      "Call this before adding one so you don't duplicate a server the project already has, " +
      "and to see the exact names the project's tools are addressed under (`mcp__<name>__<tool>`). " +
      "Note this lists CONFIGURED servers; the manager UI's MCP catalog shows each one's live " +
      "connection status and full tool list.",
    {},
    async (): Promise<CallToolResult> => {
      if (!ctx.mcpConfig) {
        return textResult("MCP config editing is not available in this session.", true);
      }
      try {
        const servers = await ctx.mcpConfig.list();
        if (!servers.length) {
          return textResult(
            "This project has no MCP servers configured yet.\n" +
              "Add one with mcp_add (or `dispatch mcp add` in a terminal).",
          );
        }
        const lines = servers.map((s) => {
          const t = s.transport;
          const detail =
            t.type === "stdio"
              ? `stdio: ${[t.command, ...(t.args ?? [])].join(" ")}${
                  t.env ? ` (env: ${Object.keys(t.env).join(", ")})` : ""
                }`
              : `${t.type}: ${t.url}${
                  t.headers ? ` (headers: ${Object.keys(t.headers).join(", ")})` : ""
                }`;
          return `  • ${s.name} — ${detail}`;
        });
        return textResult(`${servers.length} configured MCP server(s):\n${lines.join("\n")}`);
      } catch (err) {
        return textResult(
          `Could not read the MCP config: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const prewarmMcp = tool(
    "prewarm_mcp",
    "Boot the dev servers this project's MCP servers depend on, in THIS chat's " +
      "checkout, on the ports this checkout leased. Creating a worktree already does " +
      "this automatically — reach for it when a warmed server has since died, or when " +
      "you want the next MCP tool call to be fast instead of paying a cold boot. " +
      "Safe to call repeatedly: a server that adopts an already-healthy one is a no-op.",
    {},
    async (): Promise<CallToolResult> => {
      if (!ctx.prewarm) {
        return textResult("The prewarm_mcp tool is not available in this session.", true);
      }
      try {
        const results = await ctx.prewarm.run();
        if (!results.length) {
          return textResult(
            "No MCP server in this project declares a `prewarm` command, so there is " +
              "nothing to warm. Add one under its `mcpServers` entry in .dispatch/project.yaml.",
          );
        }
        const lines = results.map((r) =>
          r.ok ? `  • ${r.server}: warmed` : `  • ${r.server}: FAILED — ${r.error ?? "unknown"}`,
        );
        return textResult(
          `Prewarmed ${results.filter((r) => r.ok).length}/${results.length}:\n${lines.join("\n")}`,
          results.some((r) => !r.ok),
        );
      } catch (err) {
        return textResult(
          `Prewarm failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const mcpAdd = tool(
    "mcp_add",
    "Add an MCP server to THIS project's `.dispatch/project.yaml` — the committable " +
      "config every session in the project loads. Use this whenever the user wants to install, " +
      "add, or connect an MCP server; it is the supported path. Do NOT hand-edit project.yaml, " +
      "`.mcp.json`, or `~/.claude.json` to do this. " +
      "For a local subprocess server pass `command` (+ `args`/`env`); for a remote one pass " +
      "`url` (+ `headers`) and set `transport` to http or sse. " +
      "NEVER put a real API key in a value — write a `${VAR}` placeholder instead (e.g. " +
      '`"Bearer ${LINEAR_API_KEY}"`), which the manager expands from its environment at ' +
      "session launch so the file stays safe to commit. The change takes effect in NEW turns " +
      "without a restart; the tools appear as `mcp__<name>__<tool>`.",
    {
      name: z
        .string()
        .describe("Server name — letters/digits/-/_ only. Becomes the `mcp__<name>__` prefix."),
      transport: z
        .enum(["stdio", "http", "sse"])
        .optional()
        .describe("Defaults to stdio when `command` is given, http when `url` is given."),
      command: z.string().optional().describe("Executable for a stdio server, e.g. 'npx'."),
      args: z.array(z.string()).optional().describe("Args for a stdio server, e.g. ['-y','pkg']."),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Env vars for a stdio server. Use ${VAR} placeholders for secrets."),
      url: z.string().optional().describe("Endpoint for an http/sse server."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Headers for an http/sse server. Use ${VAR} placeholders for secrets."),
      force: z
        .boolean()
        .optional()
        .describe("Replace an existing server with this name instead of failing."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.mcpConfig) {
        return textResult("MCP config editing is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("mcp_add requires a name.", true);

      // Infer the transport exactly the way the CLI does, so both entry points
      // accept the same loosely-specified input.
      const kind = args.transport ?? (args.url ? "http" : "stdio");
      let transport;
      try {
        transport =
          kind === "stdio"
            ? ManifestMcpTransportSchema.parse({
                type: "stdio",
                command: args.command,
                ...(args.args?.length ? { args: args.args } : {}),
                ...(args.env && Object.keys(args.env).length ? { env: args.env } : {}),
              })
            : ManifestMcpTransportSchema.parse({
                type: kind,
                url: args.url,
                ...(args.headers && Object.keys(args.headers).length
                  ? { headers: args.headers }
                  : {}),
              });
      } catch {
        return textResult(
          kind === "stdio"
            ? "A stdio server needs a `command` (e.g. 'npx' with args ['-y','some-mcp'])."
            : `A ${kind} server needs a \`url\`.`,
          true,
        );
      }

      try {
        const { outcome, manifestPath } = await ctx.mcpConfig.add(
          { name, transport },
          { force: args.force === true },
        );
        const verb = outcome === "replaced" ? "Replaced" : "Added";
        return textResult(
          `${verb} MCP server "${name}" in ${manifestPath}.\n` +
            `Its tools are available to new turns as \`mcp__${name}__<tool>\` — no restart needed. ` +
            `Open the manager's MCP catalog to see the tools it actually exposes and whether it connected.`,
        );
      } catch (err) {
        return textResult(
          `Could not add "${name}": ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const mcpRemove = tool(
    "mcp_remove",
    "Remove an MCP server from THIS project's `.dispatch/project.yaml`. Use when a server " +
      "is obsolete, broken, or was added by mistake. This edits committed project config that " +
      "affects every teammate — only do it when the user asked for it.",
    {
      name: z.string().describe("The server's name, as shown by mcp_list."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.mcpConfig) {
        return textResult("MCP config editing is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("mcp_remove requires a name.", true);
      try {
        const removed = await ctx.mcpConfig.remove(name);
        return removed
          ? textResult(`Removed MCP server "${name}" from this project's config.`)
          : textResult(`No MCP server named "${name}" is configured.`, true);
      } catch (err) {
        return textResult(
          `Could not remove "${name}": ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  /* --------------------------------------------------- authored guidance
   * Memory records what this project KNOWS. These four record how work is DONE
   * here — the prose in `instructions/` and the procedures in `skills/` — and
   * they exist because that half was previously read-only to an agent: the
   * guidance arrived in the system prompt, but writing a new piece of it meant
   * hand-placing a file AND hand-editing `project.yaml`. See `authored-config.ts`
   * for the three scopes and why `shipped` is not writable. */

  const kindArg = AuthoredKindSchema.describe(
    "instruction = always-on prose injected into every session's system prompt " +
      "(house rules, conventions, gotchas). skill = an on-demand procedure the " +
      "model loads only when its description matches the task, and which the human " +
      "can invoke by typing /<name>. Prefer a SKILL for anything task-specific: an " +
      "instruction costs prompt budget on every single turn, forever.",
  );

  const scopeArg = AuthoredScopeSchema.optional().describe(
    "project = committed in this repo's .dispatch/ (the default, and the only one " +
      "teammates get). global = this machine only, applies to every project here. " +
      "shipped = built into Dispatch; readable, never writable.",
  );

  const configList = tool(
    "config_list",
    "List the INSTRUCTIONS and SKILLS in effect for this session — the authored " +
      "guidance shaping how work is done here, across all three scopes (this repo's " +
      "committed `.dispatch/`, this machine's global config, and what Dispatch ships). " +
      "Call this before writing one so you extend what exists instead of adding a " +
      "near-duplicate, and to find the exact name to pass to `config_read`.",
    {
      kind: AuthoredKindSchema.optional().describe("Omit to list both kinds."),
      scope: scopeArg,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.authoring) {
        return textResult("Config authoring is not available in this session.", true);
      }
      try {
        const kinds: AuthoredKind[] = args.kind ? [args.kind] : ["instruction", "skill"];
        const sections: string[] = [];
        let total = 0;
        for (const kind of kinds) {
          const items = (await ctx.authoring.list(kind)).filter(
            (i) => !args.scope || i.scope === args.scope,
          );
          total += items.length;
          const lines = items.map((i) => {
            const flags: string[] = [i.scope];
            if (!i.writable) flags.push("read-only");
            // An instruction file the manifest doesn't list is never injected.
            // Saying so is the whole point — nothing else reports it.
            if (i.kind === "instruction" && !i.active) flags.push("INACTIVE: not listed in project.yaml");
            return `  • ${i.name} (${flags.join(", ")})${i.description ? ` — ${i.description}` : ""}`;
          });
          sections.push(
            `${kind === "skill" ? "Skills" : "Instructions"} (${items.length}):\n` +
              (lines.length ? lines.join("\n") : "  (none)"),
          );
        }
        const hint = total
          ? "\n\nRead one in full with config_read; create or replace one with config_write."
          : "\n\nNothing authored yet. config_write creates the file (and registers an " +
            "instruction in project.yaml so it's actually injected).";
        return textResult(`${sections.join("\n\n")}${hint}`);
      } catch (err) {
        return textResult(
          `Could not list authored config: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const configRead = tool(
    "config_read",
    "Read one instruction or skill in full, by name. Use it before editing so a " +
      "`config_write` extends the existing text rather than silently replacing it — " +
      "a write REPLACES the whole file.",
    {
      kind: kindArg,
      name: z.string().describe("The item's name, as shown by config_list."),
      scope: scopeArg,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.authoring) {
        return textResult("Config authoring is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("config_read requires a name.", true);
      try {
        const found = await ctx.authoring.read(args.kind, name, args.scope);
        if (!found) {
          return textResult(
            `No ${args.kind} named "${name}"${args.scope ? ` in the ${args.scope} scope` : ""}. ` +
              "Call config_list to see what exists.",
            true,
          );
        }
        return textResult(
          `### ${name} (${args.kind}, ${found.scope})\n${found.path}\n\n` +
            clampBody(found.text, 24000),
        );
      } catch (err) {
        return textResult(
          `Could not read that ${args.kind}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const configWrite = tool(
    "config_write",
    "Create or REPLACE an instruction or skill. Reach for this when you've worked " +
      "out a procedure worth keeping — the build-and-verify dance for this repo, the " +
      "steps to cut a release — so the next session is told instead of rediscovering " +
      "it. Writing an instruction also REGISTERS it in `project.yaml`, which is the " +
      "step that makes it actually inject; a file written any other way is inert. " +
      "This edits COMMITTED config every teammate gets, so write project scope when " +
      "the user asked for a project rule, and global scope for their personal habits. " +
      "The whole file is replaced — config_read first if you mean to extend one.",
    {
      kind: kindArg,
      name: z
        .string()
        .describe(
          "Kebab-case identity, e.g. 'release-checklist'. Becomes the filename, and " +
            "for a skill the /command the human types. Reusing it overwrites.",
        ),
      description: z
        .string()
        .optional()
        .describe(
          "One line. REQUIRED IN PRACTICE for a skill: it is the only thing the model " +
            "sees before deciding whether to load the skill, so a vague one means the " +
            "skill is never used. Say when to reach for it, not what it contains.",
        ),
      body: z
        .string()
        .describe(
          "The full markdown body (no frontmatter — it's generated). For a skill, " +
            "write the PROCEDURE: the steps, the commands, the traps.",
        ),
      scope: scopeArg,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.authoring) {
        return textResult("Config authoring is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("config_write requires a name.", true);
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim()) return textResult("config_write requires a non-empty body.", true);
      const scope = args.scope ?? (ctx.authoring.hasProject ? "project" : "global");
      if (!isWritableScope(scope)) {
        return textResult(
          "The `shipped` scope is built into Dispatch and delivered by an app upgrade — " +
            "a write here would be overwritten by the next publish. Write to `project` " +
            "(committed in this repo) or `global` (this machine) instead.",
          true,
        );
      }
      if (scope === "project" && !ctx.authoring.hasProject) {
        return textResult(
          "This session has no project, so there is no `.dispatch/` to write to. " +
            "Use scope:'global' to author for this machine instead.",
          true,
        );
      }
      if (args.kind === "skill" && !(args.description ?? "").trim()) {
        return textResult(
          "A skill needs a `description` — it is the only text the model sees when " +
            "deciding whether to load the skill, so one without it is never reached for.",
          true,
        );
      }
      try {
        const result = await ctx.authoring.write({
          kind: args.kind,
          scope,
          name,
          description: args.description,
          body,
        });
        const registered = result.registered
          ? " and registered it in project.yaml, so it injects from the next turn"
          : args.kind === "instruction"
            ? " (already listed in project.yaml)"
            : "";
        const invoke =
          args.kind === "skill"
            ? ` The human can now run it as \`/${name}\`, and it loads automatically when the task matches its description.`
            : "";
        return textResult(
          `Wrote the ${scope} ${args.kind} "${name}" to ${result.path}${registered}.${invoke}`,
        );
      } catch (err) {
        return textResult(
          `Could not write that ${args.kind}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const configDelete = tool(
    "config_delete",
    "Delete an instruction or skill so it stops being injected/offered. For an " +
      "instruction this also drops its `project.yaml` entry — leaving one behind " +
      "makes every later config load report a missing file. This removes COMMITTED " +
      "config other people rely on; only do it when the user asked.",
    {
      kind: kindArg,
      name: z.string().describe("The item's name, as shown by config_list."),
      scope: scopeArg,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.authoring) {
        return textResult("Config authoring is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("config_delete requires a name.", true);
      const scope = args.scope ?? (ctx.authoring.hasProject ? "project" : "global");
      if (!isWritableScope(scope)) {
        return textResult(
          "The `shipped` scope is built into Dispatch and cannot be deleted at runtime.",
          true,
        );
      }
      try {
        const removed = await ctx.authoring.remove(args.kind, name, scope);
        return removed
          ? textResult(`Deleted the ${scope} ${args.kind} "${name}".`)
          : textResult(`No ${scope} ${args.kind} named "${name}".`, true);
      } catch (err) {
        return textResult(
          `Could not delete that ${args.kind}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  /* ------------------------------------------------------------ inspection
   * Acquiring context on work that happened in ANOTHER chat used to mean asking
   * the human to paste it. These three read the store directly: find the chat,
   * read what it decided, and pull the project's config — all read-only, so
   * they're safe to reach for without checking first. */

  const inspectInstance = z
    .enum(["self", "stable"])
    .optional()
    .describe(
      "Which instance's data to read. Omit for this server's own store (the " +
        "normal case). 'stable' reads the INSTALLED app's store — use it only " +
        "from a dev server that needs to see production chats.",
    );

  const chatFind = tool(
    "chat_find",
    "Search ACROSS every chat in the store and get back the few that matter, newest " +
      "first — the fast way to answer \"which chat was that\" or \"has anyone hit this " +
      "error before\". `query` is matched against transcript CONTENT (and titles), so " +
      "a file path, an error string or a PR number all work. Returns each hit as a " +
      "one-line snippet with the chat id and row id, which feed straight into " +
      "`chat_read`. Filter with `project`/`since` to keep a broad query fast. This is " +
      "a read — it never touches a running chat.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Text to look for inside transcripts. Case-insensitive substring, not regex. " +
            "Omit to just list chats matching the filters.",
        ),
      project: z
        .string()
        .optional()
        .describe("Project id, or part of its name (case-insensitive)."),
      since: z
        .string()
        .optional()
        .describe(
          "Only chats active since then: a relative age like '6h', '7d', '2w', or a date.",
        ),
      before: z.string().optional().describe("Only chats active BEFORE then (same formats)."),
      status: z.string().optional().describe("Only chats in this status, e.g. 'running'."),
      archived: z.boolean().optional().describe("Include archived chats (default false)."),
      kinds: z
        .array(z.string())
        .optional()
        .describe(
          "Row kinds to search. Default ['user','assistant'] — the conversation. Add " +
            "'tool_use'/'tool_result' to search what tools actually did (file paths, " +
            "commands, output), which is much slower but finds things the prose never names.",
        ),
      limit: z.number().optional().describe("Max chats to return (default 20)."),
      hitsPerChat: z.number().optional().describe("Max snippets per chat (default 3)."),
      instance: inspectInstance,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.inspect) {
        return textResult("Chat inspection is not available in this session.", true);
      }
      const now = ctx.now?.() ?? Date.now();
      try {
        const result = await ctx.inspect.findChats({
          query: args.query,
          project: args.project,
          status: args.status,
          archived: args.archived,
          since: parseTimeBound(args.since, now),
          before: parseTimeBound(args.before, now),
          kinds: args.kinds,
          limit: args.limit,
          hitsPerChat: args.hitsPerChat,
          instance: args.instance,
        });
        return textResult(renderFind(result, args.query));
      } catch (err) {
        return textResult(
          `Could not search chats: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const chatRead = tool(
    "chat_read",
    "Read ONE chat's transcript. Three views: 'digest' (default) is the catch-up — " +
      "what the human asked in their own words, the errors, the latest activity, and " +
      "every image; 'grep' finds `query` inside just this chat; 'messages' pages the " +
      "raw rows. Images come back as ABSOLUTE PATHS — read them with the file tools to " +
      "actually see a screenshot the other chat took. Page long transcripts with " +
      "`beforeId` (the oldest row id shown) rather than raising `limit`.",
    {
      chatId: z.string().describe("The chat's id, as reported by `chat_find`."),
      view: z
        .enum(["digest", "messages", "grep"])
        .optional()
        .describe("digest = catch up (default); grep = search inside; messages = raw rows."),
      query: z.string().optional().describe("Required for view 'grep': text to find."),
      kinds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict rows to these kinds: user, assistant, tool_use, tool_result, " +
            "result, system, permission, task_status, notice.",
        ),
      limit: z.number().optional().describe("Max rows (default 30 digest / 60 otherwise)."),
      beforeId: z.string().optional().describe("Page backwards: rows before this row id."),
      afterId: z.string().optional().describe("Page forwards: rows after this row id."),
      full: z
        .boolean()
        .optional()
        .describe("Keep tool payloads verbatim instead of clipping them. Expensive."),
      instance: inspectInstance,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.inspect) {
        return textResult("Chat inspection is not available in this session.", true);
      }
      if (args.view === "grep" && !args.query?.trim()) {
        return textResult("view: 'grep' needs a `query` to search for.", true);
      }
      try {
        const result = await ctx.inspect.readChat({
          chatId: args.chatId,
          view: args.view,
          query: args.query,
          kinds: args.kinds,
          limit: args.limit,
          beforeId: args.beforeId,
          afterId: args.afterId,
          full: args.full,
          instance: args.instance,
        });
        return textResult(renderRead(result));
      } catch (err) {
        return textResult(
          `Could not read that chat: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const projectInfo = tool(
    "project_info",
    "Everything Dispatch knows about a project in one call: its repo path, workflow " +
      "profile and default branch, the committable `.dispatch/` config (instructions, " +
      "agents, modes, skills, MCP servers) with any config ERRORS, its subApps and " +
      "ports, optionally its durable memory index, and its most recent chats. Use it " +
      "before working in an unfamiliar project instead of reading its config files one " +
      "at a time. Omit `project` to describe this chat's own.",
    {
      project: z
        .string()
        .optional()
        .describe("Project id or part of its name. Omit for this chat's own project."),
      memory: z
        .boolean()
        .optional()
        .describe("Include the project's memory index (one line per recorded fact)."),
      chats: z.number().optional().describe("How many recent chats to list (default 5)."),
      instance: inspectInstance,
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.inspect) {
        return textResult("Chat inspection is not available in this session.", true);
      }
      try {
        const result = await ctx.inspect.projectInfo({
          project: args.project,
          memory: args.memory,
          chats: args.chats,
          instance: args.instance,
        });
        return textResult(renderProject(result));
      } catch (err) {
        return textResult(
          `Could not describe that project: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const chatSend = tool(
    "chat_send",
    "Send a message to ANOTHER Dispatch chat — hand a task to a chat that is already " +
      "set up for it, give one new information, or tell one you are done with the thing " +
      "it was waiting on. It arrives in that chat as a message ATTRIBUTED TO YOU, and it " +
      "starts a turn there, so write it as a complete instruction: the other chat cannot " +
      "see this conversation. A chat that has finished is woken up to receive it. This " +
      "does NOT wait for a response — use chat_ask when you need an answer back. Find " +
      "ids with chat_find; check what a chat is doing first with chat_state.",
    {
      chatId: z.string().describe("The chat to message, as reported by chat_find."),
      message: z
        .string()
        .describe(
          "What to say — self-contained, since the other chat has none of your context.",
        ),
      delivery: z
        .enum(["queue", "interrupt"])
        .optional()
        .describe(
          "queue (default) waits for the chat's current turn to finish. interrupt " +
            "injects into the running turn, which can derail what it is in the middle " +
            "of — and is NOT a guarantee it acts on it, since a chat inside a long " +
            "tool call routinely finishes what it was doing first. Prefer queue.",
        ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.messaging) {
        return textResult("The chat_send tool is not available in this session.", true);
      }
      const to = typeof args.chatId === "string" ? args.chatId.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!to) return textResult("chat_send requires a non-empty chatId.", true);
      if (!message) {
        return textResult(
          "chat_send requires a non-empty message — an empty turn tells the other " +
            "chat nothing and still costs it a turn.",
          true,
        );
      }
      const result = await ctx.messaging.send({
        to,
        message,
        delivery: args.delivery === "interrupt" ? "interrupt" : "queue",
      });
      if (!result.ok) return peerRefusalResult(result);
      // Every branch has to be true of what actually happened. An `interrupt`
      // into a live turn used to fall through to "It was idle", which flatly
      // contradicts the `chat_state` the model may have run a second earlier;
      // and `woke` says only that there was no live session, which a chat that
      // has never run and a chat that finished both satisfy.
      const how = result.held
        ? "It is mid-turn, so the message is queued and will be delivered the moment " +
          "that turn ends"
        : result.interrupted
          ? "It was mid-turn and you chose interrupt, so the message was injected into " +
            "the turn it is running now"
          : result.woke
            ? "It had no live session, so one was started to receive it"
            : "It was idle, so it has the message now";
      return textResult(
        `Sent to chat ${to}. ${how}.\n` +
          JSON.stringify({
            ok: true,
            chatId: to,
            held: Boolean(result.held),
            interrupted: Boolean(result.interrupted),
            woke: Boolean(result.woke),
          }),
      );
    },
  );

  const chatAsk = tool(
    "chat_ask",
    "Ask ANOTHER Dispatch chat a question and WAIT for its answer. Use when you need " +
      "something only that chat knows — what it decided, whether it is done, what it " +
      "found — and cannot continue without it. The question arrives attributed to you " +
      "and the other chat answers with chat_reply; this call blocks until it does or " +
      "the timeout expires. A timeout is a normal answer, not an error: it means nobody " +
      "replied, so carry on without it rather than asking again. Ask ONE clear question " +
      "— the other chat cannot see your context.",
    {
      chatId: z.string().describe("The chat to ask, as reported by chat_find."),
      question: z
        .string()
        .describe("The question — self-contained, and answerable on its own."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(`Give up waiting after this long (default/cap ${WAIT_CAP_SECONDS}s).`),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.messaging) {
        return textResult("The chat_ask tool is not available in this session.", true);
      }
      const to = typeof args.chatId === "string" ? args.chatId.trim() : "";
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!to) return textResult("chat_ask requires a non-empty chatId.", true);
      if (!question) return textResult("chat_ask requires a non-empty question.", true);

      // Floored, not just capped. `clampSeconds` bottoms out at 0 and the schema
      // has no minimum, so `timeoutSeconds: 0` would deliver the question —
      // costing the target a whole turn — and then expire before any answer
      // could physically arrive. Nobody means that.
      const timeoutMs =
        Math.max(
          MIN_ASK_SECONDS,
          clampSeconds(args.timeoutSeconds ?? WAIT_CAP_SECONDS, WAIT_CAP_SECONDS),
        ) * 1000;

      const result = await ctx.messaging.ask({
        to,
        question,
        timeoutMs,
        // BOTH, the way `wait_for_chat` passes both to `waitForChatState`. With
        // `??` the session abort was dropped whenever the MCP call carried one
        // of its own, so stopping the chat left the ask running.
        signals: [extraSignal(extra), ctx.signal],
        // Advertise the wait the way `wait_for_chat` does, so a chat blocked on a
        // peer doesn't look like one that has hung — but only once the ask is
        // actually admitted. Published unconditionally up front, a refused call
        // (a self-send, an unknown id) flashed a wait that never happened.
        onWaiting: () =>
          ctx.bus.publish({
            type: "chat-status",
            chatId: ctx.chatId,
            status: "running",
            activity: { state: "tool", label: `asking chat ${to}`, toolName: "chat_ask" },
          }),
      });
      if (!result.ok) return peerRefusalResult(result);
      if (result.answered) {
        return textResult(
          `Chat ${to} answered:\n${result.answer}\n` +
            JSON.stringify({ answered: true, chatId: to }),
        );
      }
      // NOT an error. A timeout means the other chat did not answer, which is a
      // fact about the world rather than a failed call — flagging it as an error
      // pushes the model into re-asking, which is the one thing that cannot help.
      const why =
        result.reason === "cancelled"
          ? "the wait was interrupted"
          : `no answer within ${timeoutMs / 1000}s`;
      // "Nobody answered" and "it never arrived" call for different next moves,
      // so say which happened: a withdrawn question was still queued behind that
      // chat's current turn and has been pulled back rather than left to land on
      // a chat nobody is waiting for.
      const fate = result.withdrawn
        ? " It was still queued behind that chat's current turn, so it was withdrawn " +
          "and never reached them"
        : "";
      return textResult(
        `No answer from chat ${to} — ${why}.${fate}. Do NOT just ask again; check ` +
          "what it is doing with chat_state, or carry on without it.\n" +
          JSON.stringify({
            answered: false,
            reason: result.reason,
            withdrawn: Boolean(result.withdrawn),
            chatId: to,
          }),
      );
    },
  );

  const chatReply = tool(
    "chat_reply",
    "Answer a question another chat asked you with chat_ask. That chat is BLOCKED " +
      "waiting on this call, so answer as soon as you can. The askId is in the message " +
      "that asked you. Answering is the whole response — the asking chat sees your " +
      "`answer` text and nothing else, so make it stand on its own.",
    {
      askId: z.string().describe("The askId carried by the question you were sent."),
      answer: z.string().describe("Your answer, complete in itself."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.messaging) {
        return textResult("The chat_reply tool is not available in this session.", true);
      }
      const askId = typeof args.askId === "string" ? args.askId.trim() : "";
      const answer = typeof args.answer === "string" ? args.answer.trim() : "";
      if (!askId) return textResult("chat_reply requires the askId you were sent.", true);
      if (!answer) return textResult("chat_reply requires a non-empty answer.", true);

      const result = ctx.messaging.reply({ askId, answer });
      if (result.ok) {
        return textResult(
          `Answer delivered to chat ${result.askerChatId}, which was waiting on it.\n` +
            JSON.stringify({ ok: true, chatId: result.askerChatId }),
        );
      }
      // A dead askId is reported as a plain result rather than a tool error for
      // the same reason a declined spawn is: the obvious repair for an error is
      // to try again, and retrying is guaranteed to fail the same way. Naming the
      // tool that CAN still get the words there is the useful answer.
      return textResult(
        `${result.message}\n${JSON.stringify({ ok: false, reason: result.reason })}`,
      );
    },
  );

  const chatState = tool(
    "chat_state",
    "One cheap look at what ANOTHER chat is doing: its status, whether it is blocked " +
      "waiting on a HUMAN, when it was last active, the PRs it opened, and how full its " +
      "context window is. This is the tool to poll when you are coordinating several " +
      "chats — it is a pure read and never wakes or disturbs the chat it describes. Use " +
      "it before chat_send to see whether a chat is mid-turn, and instead of chat_ask " +
      "when all you need is whether it is still working.",
    {
      chatId: z.string().describe("The chat to describe, as reported by chat_find."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.messaging) {
        return textResult("The chat_state tool is not available in this session.", true);
      }
      const chatId = typeof args.chatId === "string" ? args.chatId.trim() : "";
      if (!chatId) return textResult("chat_state requires a non-empty chatId.", true);
      const state = await ctx.messaging.state(chatId);
      if (!state) {
        return textResult(
          `No chat "${chatId}" exists. Find the right id with chat_find.`,
          true,
        );
      }
      const lines = [
        `${state.title ?? "(untitled)"} — ${state.chatId}`,
        `  status: ${state.status}${state.dormant ? " (dormant — no live session)" : ""}`,
        `  blocked on a human: ${state.blockedOnHuman ? "YES" : "no"}`,
        `  last user message: ${
          state.lastUserMessageAt
            ? new Date(state.lastUserMessageAt).toISOString()
            : "never"
        }`,
        `  last updated: ${new Date(state.updatedAt).toISOString()}`,
      ];
      if (state.prs.length) {
        lines.push(`  PRs: ${state.prs.map((pr) => `${pr.repo}#${pr.number}`).join(", ")}`);
      }
      if (state.reviewOf) lines.push(`  reviewing: ${state.reviewOf}`);
      if (state.contextPercent !== undefined) {
        lines.push(`  context: ${state.contextPercent}% full`);
      }
      if (state.heldMessages) {
        lines.push(`  peer messages queued for it: ${state.heldMessages}`);
      }
      return textResult(`${lines.join("\n")}\n${JSON.stringify(state)}`);
    },
  );

  return {
    askUser,
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    watchPr,
    resolveThread,
    postReview,
    requestReview,
    createPr,
    approvePr,
    requestExemption,
    terminal,
    terminalOutput,
    worktree,
    remember,
    recall,
    forget,
    memoryList,
    memorySearch,
    memoryHistory,
    memorySimilar,
    runSubapp,
    prewarmMcp,
    spawnChat,
    mcpList,
    mcpAdd,
    mcpRemove,
    configList,
    configRead,
    configWrite,
    configDelete,
    chatFind,
    chatRead,
    chatSend,
    chatAsk,
    chatReply,
    chatState,
    projectInfo,
  };
}

/* ------------------------------------------------------------- catalog */

/** The complete set of tool definitions the factory builds. */
type ManagerTools = ReturnType<typeof createManagerTools>;

/** A property name on {@link ManagerTools} — `askUser`, `watchPr`, … */
type ManagerToolKey = keyof ManagerTools;

/**
 * The wire name of every tool the factory builds, keyed by the factory's own
 * property name.
 *
 * This is the join that makes the partition TOTAL AT COMPILE TIME, in both
 * directions: `Record<ManagerToolKey, …>` means a tool added to
 * `createManagerTools` with no line here fails the build, and `ManagerToolName`
 * means a line naming a tool the shared registry doesn't know fails it too. The
 * failure being prevented is a tool that compiles, ships, and is served under no
 * server at all — invisible until an agent reaches for it and it isn't there.
 *
 * The literals are checked against the running `tool(...)` definitions by
 * `manager-mcp.test.ts`, which is what catches a typo that is merely a
 * *different* valid name.
 */
const TOOL_WIRE_NAME: Record<ManagerToolKey, ManagerToolName> = {
  askUser: "ask_user",
  wait: "wait",
  waitForChat: "wait_for_chat",
  contextUsage: "context_usage",
  compactContext: "compact_context",
  watchPr: "watch_pr",
  resolveThread: "resolve_thread",
  postReview: "post_review",
  requestReview: "request_review",
  createPr: "create_pr",
  approvePr: "approve_pr",
  requestExemption: "request_exemption",
  terminal: "terminal",
  terminalOutput: "terminal_output",
  worktree: "worktree",
  remember: "remember",
  recall: "recall",
  forget: "forget",
  memoryList: "memory_list",
  memorySearch: "memory_search",
  memoryHistory: "memory_history",
  memorySimilar: "memory_similar",
  runSubapp: "run_subapp",
  prewarmMcp: "prewarm_mcp",
  spawnChat: "spawn_chat",
  mcpList: "mcp_list",
  mcpAdd: "mcp_add",
  mcpRemove: "mcp_remove",
  configList: "config_list",
  configRead: "config_read",
  configWrite: "config_write",
  configDelete: "config_delete",
  chatFind: "chat_find",
  chatRead: "chat_read",
  chatSend: "chat_send",
  chatAsk: "chat_ask",
  chatReply: "chat_reply",
  chatState: "chat_state",
  projectInfo: "project_info",
};

/**
 * Which session binding gates a manager tool being OFFERED to the agent (see
 * {@link boundTools}). `null` = always offered. The catalog view reads this to
 * mark each tool `available` for a given session's bindings.
 *
 * Spelled as a COMPLETE record over {@link ManagerToolName}: an omitted tool used
 * to read as `null`/always-available, so a newly gated tool would quietly report
 * itself available on a session that could not call it.
 */
const MANAGER_TOOL_GATE: Record<ManagerToolName, ManagerToolBinding | null> = {
  ask_user: null,
  wait: null,
  wait_for_chat: null,
  context_usage: null,
  compact_context: null,
  watch_pr: "github",
  resolve_thread: "github",
  post_review: "github",
  request_review: "github",
  create_pr: "prCreate",
  approve_pr: "prApproval",
  request_exemption: "exemptions",
  terminal: "terminals",
  terminal_output: "terminals",
  worktree: "worktrees",
  remember: "memory",
  recall: "memory",
  forget: "memory",
  memory_list: "memory",
  memory_search: "memory",
  memory_history: "memory",
  memory_similar: "memory",
  run_subapp: "runner",
  prewarm_mcp: "prewarm",
  spawn_chat: "chats",
  mcp_list: "mcpConfig",
  mcp_add: "mcpConfig",
  mcp_remove: "mcpConfig",
  config_list: "authoring",
  config_read: "authoring",
  config_write: "authoring",
  config_delete: "authoring",
  chat_find: "inspect",
  chat_read: "inspect",
  chat_send: "messaging",
  chat_ask: "messaging",
  chat_reply: "messaging",
  chat_state: "messaging",
  project_info: "inspect",
};

/** The session bindings that gate manager tools. */
export type ManagerToolBinding =
  | "github"
  | "prApproval"
  | "prCreate"
  | "exemptions"
  | "terminals"
  | "worktrees"
  | "memory"
  | "runner"
  | "prewarm"
  | "chats"
  | "mcpConfig"
  | "authoring"
  | "inspect"
  | "messaging";

/** Which bindings a session has — decides which tools are offered/available. */
export type ManagerToolBindings = Partial<Record<ManagerToolBinding, boolean>>;

/**
 * Which tools this session can actually be offered — each is only meaningful
 * when its backing service is wired in, so a dead one is omitted rather than
 * offered and then refused.
 *
 * FINER than {@link MANAGER_TOOL_GATE} on purpose: the catalog answers "does this
 * kind of session have GitHub", while registration answers "does THIS GitHub
 * surface implement `resolveThread`". A total record rather than the array of
 * conditional spreads it replaces, so a new tool cannot be built by the factory
 * and then silently left out of every server.
 */
function boundTools(ctx: ManagerMcpContext): Record<ManagerToolName, boolean> {
  const github = Boolean(ctx.github);
  return {
    ask_user: true,
    wait: true,
    wait_for_chat: true,
    context_usage: true,
    compact_context: true,
    watch_pr: github,
    // Working a review round needs BOTH halves: resolving what you fixed, and
    // re-queueing the reviewer afterwards. Each is gated on its own binding so a
    // GitHub surface missing one still offers the other.
    resolve_thread: Boolean(ctx.github?.resolveThread),
    request_review: Boolean(ctx.github?.requestReviewers),
    // Bound only where the project configured a Dispatch reviewer — the same
    // shape as `approve_pr`'s auto-merge gate, so the ability to speak AS a
    // reviewer is absent (not merely discouraged) everywhere it wasn't asked for.
    post_review: Boolean(ctx.github?.submitReview),
    // Only on a project whose change ships through PRs — which is also the only
    // place the guard refuses a raw `gh pr create`, so the two stay in step.
    create_pr: Boolean(ctx.prCreate),
    // Only when the project opted into auto-merge — no binding, no way to merge.
    approve_pr: Boolean(ctx.prApproval),
    // Bound only where a guard is actually ENFORCING — the escape hatch exists
    // exactly where the wall does, and nowhere else offers it as a thing to try.
    request_exemption: Boolean(ctx.exemptions),
    terminal: Boolean(ctx.terminals),
    terminal_output: Boolean(ctx.terminals),
    // Bound whenever the session has a project to cut trees in — and the shell
    // guard's refusal of a raw `git` tree-cut points here, so the two ship together.
    worktree: Boolean(ctx.worktrees),
    // The write surface plus the curation reads — all bound to the same project,
    // so a session either has memory or it doesn't.
    remember: Boolean(ctx.memory),
    recall: Boolean(ctx.memory),
    forget: Boolean(ctx.memory),
    memory_list: Boolean(ctx.memory),
    memory_search: Boolean(ctx.memory),
    memory_history: Boolean(ctx.memory),
    memory_similar: Boolean(ctx.memory),
    run_subapp: Boolean(ctx.runner),
    prewarm_mcp: Boolean(ctx.prewarm),
    // Spawning a sibling chat needs a project to spawn INTO and a live session to
    // route the consent prompt through; both are bound together or not at all.
    spawn_chat: Boolean(ctx.chats),
    mcp_list: Boolean(ctx.mcpConfig),
    mcp_add: Boolean(ctx.mcpConfig),
    mcp_remove: Boolean(ctx.mcpConfig),
    // Authoring instructions + skills. All four together: listing without
    // reading, or writing without deleting, is half a curation surface.
    config_list: Boolean(ctx.authoring),
    config_read: Boolean(ctx.authoring),
    config_write: Boolean(ctx.authoring),
    config_delete: Boolean(ctx.authoring),
    // Read-only cross-chat inspection. Bound together because they're one
    // workflow — find the chat, read it, then read its project's config.
    chat_find: Boolean(ctx.inspect),
    chat_read: Boolean(ctx.inspect),
    project_info: Boolean(ctx.inspect),
    // Cross-chat MESSAGING — the write path. All four together: a chat that can
    // ask must be able to reply, or the other half of every conversation is a
    // chat holding an askId with no tool that takes one.
    chat_send: Boolean(ctx.messaging),
    chat_ask: Boolean(ctx.messaging),
    chat_reply: Boolean(ctx.messaging),
    chat_state: Boolean(ctx.messaging),
  };
}

/** A catalog descriptor for one manager tool (no live session needed). */
export interface ManagerToolDescriptor {
  /** Bare tool name, e.g. "wait". */
  name: string;
  /** Category server serving it, e.g. "session". */
  category: ManagerCategory;
  /** Fully-qualified name the agent sees, e.g. "mcp__dispatch-session__wait". */
  qualifiedName: string;
  description: string;
  /** JSON Schema (draft 2020-12) of the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Whether the tool is offered given the supplied session bindings. */
  available: boolean;
}

/** No-op bus/broker for descriptor extraction — the tool factory only READS the
 *  static metadata (name/description/schema) at build time; no handler runs, so
 *  these are never actually invoked. */
const NOOP_DESCRIPTOR_CTX = {
  chatId: "",
  bus: { publish() {}, subscribe: () => () => {}, on: () => () => {} } as unknown as EventBus,
  broker: {
    has: () => false,
    getStatus: () => undefined,
    getContextUsage: async () => null,
    compact: () => {},
    markPrWatched: () => {},
    askUser: async () => ({ status: "declined" as const }),
  } as ManagerMcpBroker,
} satisfies ManagerMcpContext;

/**
 * Enumerate every manager tool as a catalog descriptor — the SINGLE SOURCE the
 * MCP catalog endpoint consumes, derived from the very same {@link createManagerTools}
 * definitions the SDK registration uses (name/description/`inputSchema` come off
 * each `tool(...)` result, so the two can never drift). `createManagerTools`
 * always builds every definition regardless of ctx — the ctx bindings only
 * decide which are REGISTERED — so a no-op ctx yields every tool's static shape.
 * `bindings` reflects which backing services the session has, so gated tools
 * (watch_pr/terminal/remember/recall/forget/run_subapp) report the right `available`.
 */
export function managerToolDescriptors(
  bindings: ManagerToolBindings = {},
): ManagerToolDescriptor[] {
  const tools = createManagerTools(NOOP_DESCRIPTOR_CTX);
  return (Object.keys(tools) as ManagerToolKey[]).map((key) => {
    const name = TOOL_WIRE_NAME[key];
    const gate = MANAGER_TOOL_GATE[name];
    return {
      name,
      category: MANAGER_TOOL_CATEGORY[name],
      qualifiedName: managerToolQualifiedName(name),
      description: tools[key].description,
      inputSchema: z.toJSONSchema(z.object(tools[key].inputSchema as z.ZodRawShape)) as Record<
        string,
        unknown
      >,
      available: gate === null ? true : Boolean(bindings[gate]),
    };
  });
}

/**
 * Build Dispatch's own MCP servers for one session — one per {@link ManagerCategory},
 * keyed by the server name the SDK should register it under.
 *
 * A PARTITION, not eight factories: `createManagerTools` still holds every
 * definition and every shared helper (`textResult`, the binding checks, the PR
 * renderers), and this only decides which server each one is handed to. Splitting
 * the factory itself would let those helpers drift apart file by file.
 *
 * Spread the result into `Options.mcpServers` — the SDK exposes the tools as
 * `mcp__dispatch-session__wait`, `mcp__dispatch-github__create_pr`, and so on.
 * A category with no bound tool on this session is omitted entirely rather than
 * registered empty, so a session without GitHub advertises no `dispatch-github`
 * at all.
 */
export function createManagerMcpServers(
  ctx: ManagerMcpContext,
): Record<string, McpSdkServerConfigWithInstance> {
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const [category, categoryTools] of boundToolsByCategory(ctx)) {
    servers[managerServerName(category)] = buildCategoryServer(ctx, category, categoryTools);
  }
  return servers;
}

/** This session's bound tools, grouped by the category that serves them. */
function boundToolsByCategory(
  ctx: ManagerMcpContext,
): Map<ManagerCategory, ManagerTools[ManagerToolKey][]> {
  const tools = createManagerTools(ctx);
  const bound = boundTools(ctx);
  const byCategory = new Map<ManagerCategory, ManagerTools[ManagerToolKey][]>();
  for (const key of Object.keys(tools) as ManagerToolKey[]) {
    const name = TOOL_WIRE_NAME[key];
    if (!bound[name]) continue;
    const category = MANAGER_TOOL_CATEGORY[name];
    const list = byCategory.get(category);
    if (list) list.push(tools[key]);
    else byCategory.set(category, [tools[key]]);
  }
  return byCategory;
}

function buildCategoryServer(
  ctx: ManagerMcpContext,
  category: ManagerCategory,
  categoryTools: ManagerTools[ManagerToolKey][],
): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer({
    name: managerServerName(category),
    version: "1.0.0",
    tools: categoryTools,
  });
  // Non-enumerable host metadata, on EVERY category server. The Claude SDK only
  // sees the ordinary MCP config, while the harness broker can recover the SAME
  // live context and put it behind ManagerMcpBridge for Codex. This avoids
  // duplicating the manager tool wiring (terminals, memory, GitHub, runners,
  // spawn consent) per runtime.
  Object.defineProperty(server, MANAGER_CONTEXT, { value: ctx });
  return server;
}

/**
 * Build ONE category server for a session — the Codex bridge's entry point,
 * which serves a single category per HTTP path.
 *
 * Constructs ONLY the category asked for. Going through
 * {@link createManagerMcpServers} and discarding the rest would build eight MCP
 * `Server` instances per Codex tool call and leak seven of them: the bridge
 * closes the one it returns when the response closes, and nothing ever closes
 * the others.
 *
 * Returns undefined when this session has no bound tool in that category, which
 * the bridge answers as a 404 rather than as an empty server that lists nothing.
 */
export function createManagerCategoryServer(
  ctx: ManagerMcpContext,
  category: ManagerCategory,
): McpSdkServerConfigWithInstance | undefined {
  const categoryTools = boundToolsByCategory(ctx).get(category);
  return categoryTools?.length ? buildCategoryServer(ctx, category, categoryTools) : undefined;
}

const MANAGER_CONTEXT = Symbol("dispatch.managerMcpContext");

/** Recover the live context attached by {@link createManagerMcpServers}. */
export function managerMcpContextOf(value: unknown): ManagerMcpContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { [MANAGER_CONTEXT]?: ManagerMcpContext })[MANAGER_CONTEXT];
}
