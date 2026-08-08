/**
 * manager-mcp — the in-process "manager" SDK MCP server.
 *
 * Registered on EVERY live session (see `SessionBroker.buildOptions` →
 * `Options.mcpServers.manager`), so its tools appear to the agent as
 * `mcp__manager__<tool>`. It lets a chat pace ITSELF against the manager's own
 * state:
 *
 *   - `mcp__manager__wait({ seconds, reason? })` — sleep for up to
 *     {@link WAIT_CAP_SECONDS}. While parked it publishes a `chat-status`
 *     "waiting Ns: <reason>" activity so the UI shows the self-imposed pause
 *     (reusing the working/typing header mechanism).
 *   - `mcp__manager__wait_for_chat({ chatId, timeoutSeconds? })` — block until
 *     ANOTHER chat's broker state reaches a terminal state (idle/done/error),
 *     or the timeout fires. Returns the final state. An unknown chatId yields an
 *     informative (error-flagged) result rather than throwing.
 *   - `mcp__manager__watch_pr({ number, repo?, timeoutSeconds? })` — watch a
 *     GitHub PR (via {@link ManagerMcpGitHub}, reusing GitHubService's `gh`) and
 *     RETURN THE INSTANT it needs attention: a CI check fails, a new review
 *     thread/comment appears, or it merges/closes. Per-session dedup state means
 *     each new signal is reported exactly once, so an agent calling it in a loop
 *     (fix → watch again) never misses a later round of review comments and never
 *     hand-rolls a `gh pr view` / `gh pr checks` sleep loop or a background watcher.
 *   - `mcp__manager__create_pr({ title?, body?, base?, draft? })` — OPEN the PR
 *     (via {@link ManagerMcpPrCreate}): push with upstream, create, request the
 *     reviewers the project's `workflow.pr.reviewers` declares, write a `PRRef`
 *     onto this chat, and arm the review watcher. Offered whenever the workflow
 *     has `requirePr`, which is the same condition under which the trunk guard
 *     REFUSES a raw `gh pr create` — the two are deliberately symmetric with the
 *     long-standing `gh pr merge` → `approve_pr` pair. Its refusals (on the
 *     trunk, no commits, dirty tree, `hold`) each name an override argument.
 *   - `mcp__manager__approve_pr({ number, repo?, method?, note? })` — approve and
 *     MERGE a PR (via {@link ManagerMcpPrApproval}), but only after re-reading its
 *     state/checks/threads/labels and finding nothing blocking ({@link prLandingBlockers}).
 *     Offered ONLY when the project's workflow sets `autoMerge: "on-green"`, which
 *     is what makes "the agent lands its own work" a per-project decision rather
 *     than something every session can do. A raw `gh pr merge` stays denied.
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
  WorkflowMergeMethodSchema,
  type ChatStatus,
  type CheckRun,
  type ContextUsage,
  type ManifestMcpServer,
  type ProjectMemory,
  type ReviewDecision,
  type ReviewThread,
  type WorkflowMergeMethod,
} from "@dispatch/shared";
import type { EventBus } from "../../bus.js";
import { clampBody } from "../memory.js";

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
  /** Flag that a `watch_pr` on this chat hit a terminal PR state (drives the green "PR done" dot). */
  markPrWatched(chatId: string): void;
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
  }): Promise<{
    output: string;
    exitCode: number | null;
    cwd: string;
    error?: string;
    timedOut?: boolean;
  }>;
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
  findSimilar?(candidate: {
    name: string;
    description?: string;
    body?: string;
  }): Promise<Array<{ name: string; description: string; similarity: number }>>;
}

/** Merge/close-state view of a PR the `watch_pr` tool polls on. */
export interface PrPollResult {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
}

/**
 * The narrow GitHub surface the manager MCP needs to watch a PR — its merge/close
 * state, its CI checks, and its review threads — already bound to this session's
 * default repo (its worktree cwd, else the project root) by the broker. `repo` is
 * an optional `owner/name` override.
 *
 * `prMergeState` null = the PR/repo couldn't be resolved (unknown PR / gh error)
 * and ENDS the watch as an error. `prChecks`/`reviewThreads` null = that signal
 * couldn't be read THIS poll (a transient gh hiccup); the watch treats it as "no
 * new activity of that kind" and keeps going rather than aborting. Omitted from
 * the ctx → the `watch_pr` tool isn't offered.
 */
export interface ManagerMcpGitHub {
  prMergeState(prNumber: number, repo?: string): Promise<PrPollResult | null>;
  prChecks(prNumber: number, repo?: string): Promise<CheckRun[] | null>;
  reviewThreads(prNumber: number, repo?: string): Promise<ReviewThread[] | null>;
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
  /** Fresh branch state; null = the repo couldn't be resolved from this session. */
  preflight(base?: string): Promise<PrCreateState | null>;
  /** Do all five steps. Throws with the underlying message when git/gh refuses. */
  create(input: {
    base?: string;
    title?: string;
    body?: string;
    draft: boolean;
  }): Promise<PrCreateResult>;
}

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
  if (pr.labels.some((l) => l.toLowerCase() === MERGE_HOLD_LABEL)) {
    blockers.push({
      code: "hold",
      detail:
        `It carries the \`${MERGE_HOLD_LABEL}\` label — someone parked this PR deliberately. ` +
        "Leave it alone and say so; do not remove the label to get around this.",
    });
  }
  if (pr.reviewDecision === "changes_requested") {
    blockers.push({
      code: "changes-requested",
      detail: "A reviewer requested changes — address them and get a fresh review first.",
    });
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
      const reported = pr.submittedReviews.filter((r) => r.state !== "PENDING");
      if (reported.length === 0) {
        const waiting = pr.requestedReviewers.length
          ? `Waiting on: ${pr.requestedReviewers.join(", ")}.`
          : "No reviewer has even been requested — open it through `mcp__manager__create_pr` " +
            "so the configured reviewers are asked.";
        blockers.push({
          code: "no-review",
          detail:
            "Nobody has reviewed this PR yet, and this project's workflow sets " +
            `\`pr.requireReview\`. ${waiting} Pass \`allowNoReview: true\` only if the human ` +
            "told you to land it unreviewed.",
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

/** Per-session context the factory closes over. */
export interface ManagerMcpContext {
  /** The chat this session drives (for the waiting status label). */
  chatId: string;
  bus: EventBus;
  broker: ManagerMcpBroker;
  /** Persistent-terminal runner for this session (omitted → no `terminal` tool). */
  terminals?: ManagerMcpTerminals;
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
  /** SubApp launcher for this session (omitted → no `run_subapp` tool). */
  runner?: ManagerMcpRunner;
  /** Project MCP-config editor for this session (omitted → no `mcp_*` tools). */
  mcpConfig?: ManagerMcpConfig;
  /** The session's abort signal — cancels in-flight waits on stop/fork. */
  signal?: AbortSignal;
  now?: () => number;
}

/* ------------------------------------------------------------------ helpers */

function clampSeconds(value: unknown, cap: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(n, 0), cap);
}

/** Pull an AbortSignal out of the MCP handler's `extra` arg, if present. */
function extraSignal(extra: unknown): AbortSignal | undefined {
  const sig = (extra as { signal?: unknown } | undefined)?.signal;
  return sig instanceof AbortSignal ? sig : undefined;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
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
  },
): Promise<WatchPrOutcome> {
  const started = opts.now();
  const deadline = started + opts.timeoutMs;
  const aborted = (): boolean => opts.signals.some((s) => s?.aborted);

  for (;;) {
    if (aborted()) return { kind: "aborted" };

    let merge: PrPollResult | null;
    try {
      merge = await gh.prMergeState(number, repo);
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

    // Checks + threads are best-effort: a transient gh failure on either yields
    // null, which we treat as "no new activity of that kind" (not fatal).
    const [checks, threads] = await Promise.all([
      gh.prChecks(number, repo).catch(() => null),
      gh.reviewThreads(number, repo).catch(() => null),
    ]);

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
    if (runs.length > 0 && !anyFailing && runs.every((c) => c.status === "completed")) {
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
      "going silent or re-firing the same news. It returns done:true only when the " +
      "PR merges or closes — keep calling until then and you'll never miss a late " +
      "review round.",
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
      });

      if (outcome.kind === "aborted") {
        return textResult(`Watch on PR #${number} was cancelled after being interrupted.`);
      }
      if (outcome.kind === "error") {
        return textResult(
          `Could not watch PR #${number}: ${outcome.error}. Check the number and, ` +
            "if the repo can't be auto-detected here, pass `repo` as 'owner/name'.",
          true,
        );
      }
      if (outcome.kind === "terminal") {
        const s = outcome.state;
        // The PR settled (merged/closed) — mark the chat so its dot reads green
        // ("PR done") once the agent finishes and returns to idle.
        ctx.broker.markPrWatched(ctx.chatId);
        // A merge (usually the auto-merge job's, not ours) means the trunk moved;
        // tell the manager so the primary checkout can fast-forward to it.
        if (s.merged) ctx.github.notePrMerged?.();
        return textResult(
          `PR #${s.number} reached terminal state "${s.state}"${s.merged ? " (merged)" : ""}. ` +
            `Watch complete — no need to call watch_pr again.\n` +
            JSON.stringify({
              number: s.number,
              state: s.state,
              merged: s.merged,
              done: true,
              ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}),
            }),
        );
      }
      if (outcome.kind === "timeout") {
        const s = outcome.state;
        return textResult(
          `No new activity on PR #${number} in the last ${timeoutSeconds}s (still ` +
            `${s.state}). Call watch_pr again to keep watching until it merges.\n` +
            JSON.stringify({ number, state: s.state, done: false, timedOut: true, events: [] }),
        );
      }

      // activity — new checks/comments to act on, or CI going green, then re-watch.
      const { state: s, events } = outcome;
      const failing = events.filter((e) => e.type === "ci-failed");
      const comments = events.filter((e) => e.type === "review-comment");
      const passed = events.find((e) => e.type === "ci-passed");
      const noChecks = events.some((e) => e.type === "no-checks");
      const parts: string[] = [];
      if (failing.length) parts.push(`${failing.length} failing check(s)`);
      if (comments.length) parts.push(`${comments.length} new review comment(s)`);
      if (passed) parts.push(`all ${passed.names.length} check(s) passing`);
      if (noChecks) parts.push("no CI checks configured");
      const lines = events.map((e) => {
        switch (e.type) {
          case "ci-failed":
            return `  ✗ check "${e.name}" ${e.conclusion ?? "failing"}${e.url ? ` — ${e.url}` : ""}`;
          case "ci-passed":
            return `  ✓ checks passed: ${e.names.join(", ")}`;
          case "no-checks":
            return `  · no checks are reporting on this PR`;
          default:
            return `  💬 ${e.author ?? "reviewer"} on ${e.path ?? "the PR"}${
              e.line ? `:${e.line}` : ""
            } — ${firstLine(e.body) || "(see thread)"}`;
        }
      });
      // Green (or an empty check list) is news, not a to-do list — telling the
      // agent to "address these" when nothing is wrong is what sends it hunting
      // for a problem that isn't there.
      const needsWork = failing.length > 0 || comments.length > 0;
      const advice = needsWork
        ? `Address these, then call watch_pr again — it keeps watching (reporting only ` +
          `NEW activity) until the PR merges.`
        : `Nothing to fix. Merge it if you're ready, or call watch_pr again to wait ` +
          `for the merge and any later review round.`;
      return textResult(
        `PR #${number} ${needsWork ? "needs attention" : "update"}: ${parts.join(" and ")}.\n` +
          `${lines.join("\n")}\n\n${advice}\n` +
          JSON.stringify({
            number,
            state: s.state,
            done: false,
            checksPassing: !!passed,
            events,
          }),
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
      "this branch it hands that one back rather than failing.",
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

      let st: PrCreateState | null;
      try {
        st = await prCreate.preflight(base);
      } catch (e) {
        return textResult(
          `Could not inspect this branch: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      if (!st) {
        return textResult(
          "Could not resolve this chat's repo or branch, so there's nothing to open a PR " +
            "from. Make sure the chat has a worktree.",
          true,
        );
      }

      // An existing PR is an ANSWER, not an error: the agent asked for "the PR for
      // this branch to exist", and it does. Failing here would only push it back
      // toward the raw `gh` command to find out what already happened.
      if (st.existing && st.existing.state === "open") {
        return textResult(
          `PR #${st.existing.number} is already open for \`${st.branch}\` — reusing it ` +
            `rather than opening a second one.\n${st.existing.url}\n` +
            "Push more commits to update it, and use `mcp__manager__watch_pr` to follow " +
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
        return textResult(
          `Not opening a PR yet:\n` +
            blockers.map((b) => `  · ${b.detail}`).join("\n") +
            "\n\nFix these (or pass the named override) and call create_pr again.\n" +
            JSON.stringify({ created: false, blockers: blockers.map((b) => b.code) }),
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
        });
      } catch (e) {
        return textResult(
          `Could not open the PR: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }

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
          : "  · ⚠ the review watcher is not running; call `mcp__manager__watch_pr` yourself",
      );
      return textResult(
        `${lines.join("\n")}\n\nNow call \`mcp__manager__watch_pr\` in a loop to work the ` +
          `review round.\n` +
          JSON.stringify({
            number: res.number,
            url: res.url,
            created: true,
            draft: res.draft,
            reviewersRequested: res.reviewersRequested,
            watching: res.watching,
          }),
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
          "Override: land it even though NO check reported. Only when this repo " +
            "genuinely has no CI — say so in your report when you use it.",
        ),
      allowNoReview: z
        .boolean()
        .optional()
        .describe(
          "Override: land it even though nobody has reviewed. Only when the human " +
            "told you to land it unreviewed.",
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
        return textResult(
          `Could not read PR #${number}: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      if (!pr) {
        return textResult(
          `Could not resolve PR #${number}. Check the number and, if the repo can't be ` +
            "auto-detected here, pass `repo` as 'owner/name'.",
          true,
        );
      }

      const blockers = prLandingBlockers(pr, {
        ...approval.policy,
        allowNoChecks: args.allowNoChecks === true,
        allowNoReview: args.allowNoReview === true,
      });
      if (blockers.length) {
        // Not an error — being told "not yet" is a normal, expected answer.
        const isDone = blockers.some((b) => b.code === "not-open");
        return textResult(
          `${isDone ? "Nothing to do" : `Not landing PR #${number} yet`}:\n` +
            blockers.map((b) => `  · ${b.detail}`).join("\n") +
            (isDone ? "" : "\n\nFix these, then call approve_pr again.") +
            "\n" +
            JSON.stringify({
              number,
              merged: false,
              blockers: blockers.map((b) => b.code),
            }),
        );
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
      ctx.broker.markPrWatched(ctx.chatId);
      const noChecks = pr.checks.length === 0 ? " (this PR had no CI checks reporting)" : "";
      return textResult(
        `Merged PR #${number} (${method}${approved.approved ? ", approved" : ""})${noChecks}. ` +
          "The branch is deleted and the trunk will fast-forward — the task is done, so " +
          "don't watch it or open anything else.\n" +
          JSON.stringify({ number, merged: true, method, approved: approved.approved }),
      );
    },
  );

  const terminal = tool(
    "terminal",
    "Run a shell command in a NAMED, PERSISTENT terminal whose working directory " +
      "and environment SURVIVE between calls (unlike Bash, which resets each time). " +
      "Reuse the same `name` to keep a cwd (e.g. `cd` once, then run builds from " +
      "there) or an env var across commands. Returns the command output, its exit " +
      "code, and the terminal's current working directory.",
    {
      name: z
        .string()
        .describe("Terminal name to run in (created on first use, e.g. 'build')."),
      command: z.string().describe("The shell command to execute."),
      timeoutMs: z
        .number()
        .optional()
        .describe("Give up waiting after this long (the command keeps running)."),
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
      });

      const header = `[${name}] cwd=${res.cwd} exit=${res.exitCode ?? "n/a"}`;
      const body = res.output ? `\n${res.output}` : "";
      const note = res.error ? `\n(${res.error})` : "";
      return textResult(`${header}${body}${note}`, !!res.error && !res.timedOut);
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
        return textResult(
          r.url
            ? `Started ${r.subAppId}${where} — ${r.status}. Open it at ${r.url}`
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

  return {
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    watchPr,
    createPr,
    approvePr,
    terminal,
    remember,
    recall,
    forget,
    runSubapp,
    mcpList,
    mcpAdd,
    mcpRemove,
  };
}

/* ------------------------------------------------------------- catalog */

/**
 * Which session binding gates a manager tool being OFFERED to the agent (see the
 * `createManagerMcpServer` tools array). `null` = always offered. The catalog
 * view reads this to mark each tool `available` for a given session's bindings.
 */
const MANAGER_TOOL_GATE: Record<string, ManagerToolBinding | null> = {
  wait: null,
  wait_for_chat: null,
  context_usage: null,
  compact_context: null,
  watch_pr: "github",
  create_pr: "prCreate",
  approve_pr: "prApproval",
  terminal: "terminals",
  remember: "memory",
  recall: "memory",
  forget: "memory",
  run_subapp: "runner",
  mcp_list: "mcpConfig",
  mcp_add: "mcpConfig",
  mcp_remove: "mcpConfig",
};

/** The session bindings that gate manager tools. */
export type ManagerToolBinding =
  | "github"
  | "prApproval"
  | "prCreate"
  | "terminals"
  | "memory"
  | "runner"
  | "mcpConfig";

/** Which bindings a session has — decides which tools are offered/available. */
export type ManagerToolBindings = Partial<Record<ManagerToolBinding, boolean>>;

/** A catalog descriptor for one manager tool (no live session needed). */
export interface ManagerToolDescriptor {
  /** Bare tool name, e.g. "wait". */
  name: string;
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
  return Object.values(tools).map((t) => {
    const gate = MANAGER_TOOL_GATE[t.name] ?? null;
    const available = gate === null ? true : Boolean(bindings[gate]);
    return {
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape)) as Record<
        string,
        unknown
      >,
      available,
    };
  });
}

/**
 * Build the in-process "manager" MCP server for one session. Drop the result
 * into `Options.mcpServers.manager` — the SDK exposes its tools to the agent as
 * `mcp__manager__wait` / `mcp__manager__wait_for_chat`.
 */
export function createManagerMcpServer(
  ctx: ManagerMcpContext,
): McpSdkServerConfigWithInstance {
  const {
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    watchPr,
    createPr,
    approvePr,
    terminal,
    remember,
    recall,
    forget,
    runSubapp,
    mcpList,
    mcpAdd,
    mcpRemove,
  } = createManagerTools(ctx);
  // Each tool is only meaningful when its backing service is wired in; omit the
  // dead ones so the agent isn't offered a tool it can't use.
  const tools = [
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    ...(ctx.github ? [watchPr] : []),
    // Only on a project whose change ships through PRs — which is also the only
    // place the guard refuses a raw `gh pr create`, so the two stay in step.
    ...(ctx.prCreate ? [createPr] : []),
    // Only when the project opted into auto-merge — no binding, no way to merge.
    ...(ctx.prApproval ? [approvePr] : []),
    ...(ctx.terminals ? [terminal] : []),
    ...(ctx.memory ? [remember, recall, forget] : []),
    ...(ctx.runner ? [runSubapp] : []),
    ...(ctx.mcpConfig ? [mcpList, mcpAdd, mcpRemove] : []),
  ];
  return createSdkMcpServer({
    name: "manager",
    version: "1.0.0",
    tools,
  });
}
