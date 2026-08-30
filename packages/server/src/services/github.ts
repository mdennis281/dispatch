/**
 * GitHubService — the GitHub control plane. Wraps the `gh` CLI via execa,
 * reusing the exact command shapes proven in scripts/agent/{ship,auto-merge}.mjs
 * (Copilot review request, graphql review-thread queries, squash-merge + delete).
 *
 * Design notes
 * ------------
 * - Every external call goes through `gh` with an **argv array** (execa, no shell)
 *   so nothing in owner/repo/branch/label can be reinterpreted by a shell.
 * - owner/repo is validated strictly (alnum . _ - only, exactly one "/") before it
 *   is ever interpolated into a GraphQL query — mirrors auto-merge.mjs.
 * - GraphQL uses typed VARIABLES (`-f owner=…`, `-F number=…`) rather than string
 *   interpolation wherever a value could be attacker-influenced (thread ids).
 * - Read methods (`prForBranch`, `prList`, `prChecks`, `reviewThreads`, `comments`)
 *   are pure — they fetch + parse + return, with NO bus side effects. Mutating ops
 *   (`ship`, `merge`, `setLabel`/`hold`, `requestReview`, `rerun*`, `resolveThread`,
 *   `addComment`, `dispatch`, `getRun`) publish domain events on the EventBus.
 * - execa is injectable (`deps.exec`) so tests assert exact argv construction and
 *   drive JSON parsing without any real `gh`/network calls.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import type {
  GhCliStatus,
  Project,
  PRInfo,
  PRRef,
  CheckRun,
  ReviewThread,
  ReviewDecision,
  PrReviewer,
  PrReviewerKind,
  PrReviewerState,
  WorkflowDef,
  WorkflowRun,
  WorkflowWithLastRun,
  WorkflowInput,
} from "@dispatch/shared";
import {
  PRInfoSchema,
  CheckRunSchema,
  ReviewThreadSchema,
  WorkflowDefSchema,
  WorkflowRunSchema,
  WorkflowWithLastRunSchema,
  WorkflowInputSchema,
  COPILOT_LOGIN,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";

/* ------------------------------------------------------------------ execa seam */

/** Result surface we depend on from an execa call. */
export interface ExecResult {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  failed?: boolean;
}

/** The execa-shaped function this service calls. Injectable for tests. */
export type ExecaLike = (
  file: string,
  args?: readonly string[],
  options?: { cwd?: string; reject?: boolean; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

/** Default: the real execa, with reject:false handling delegated to callers. */
const defaultExec: ExecaLike = (file, args = [], options) =>
  execa(file, args as string[], {
    cwd: options?.cwd,
    reject: options?.reject,
    env: options?.env,
  }) as unknown as Promise<ExecResult>;

/* --------------------------------------------------------------------- consts */

/** owner/repo shape — GitHub-valid chars only (alnum . _ -). Strict on purpose. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Marks a blocking review whose findings are all represented by inline threads.
 * Old reviews and degraded reviews without threads intentionally lack it, so
 * resolving a thread can never erase a body-only blocker it cannot represent.
 */
const THREADED_CHANGE_REQUEST_MARKER = "<!-- dispatch:threaded-change-request -->";

/**
 * The reviewer login ship requests (matches ship.mjs / auto-merge.mjs).
 * Re-exported so the existing `from "./github.js"` importers keep working; the
 * definition lives in `@dispatch/shared` because the `review` profile's default
 * reviewer list needs it too.
 */
export { COPILOT_LOGIN };

/** `--json` field list for a rich PR view/list. */
const PR_JSON_FIELDS =
  "number,url,title,state,headRefName,baseRefName,isDraft,author,body,mergeable,mergeStateStatus,labels,additions,deletions,updatedAt,createdAt";

/**
 * `--json` field list for the GLOBAL open-PR list (`projectOpenPrs`). Adds the
 * `statusCheckRollup` (inline per-check status, so we don't fan out one
 * `pr checks` call per PR), `reviewDecision`, and `comments` (mapped to a count).
 */
const PR_LIST_JSON_FIELDS =
  "number,title,headRefName,state,isDraft,statusCheckRollup,reviewDecision,comments,updatedAt,url,labels";

/**
 * `--json` field list for a single PR's rich detail (`prDetail`): the full PR
 * view plus the inline check rollup, review decision, and comments (count).
 */
const PR_DETAIL_JSON_FIELDS =
  "number,url,title,state,headRefName,baseRefName,isDraft,author,body,mergeable,mergeStateStatus,labels,additions,deletions,updatedAt,createdAt,statusCheckRollup,reviewDecision,comments";

/** `--json` field list for `gh pr checks`. */
const CHECK_JSON_FIELDS = "name,state,bucket,link,workflow";

/** `--json` field list for `gh run list` / `gh run view`. */
const RUN_JSON_FIELDS =
  "databaseId,name,workflowName,status,conclusion,event,headBranch,url,createdAt,updatedAt";

const RUN_STATUSES = new Set<WorkflowRun["status"]>([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);

/** Merge strategies (gh flags). */
export type MergeMethod = "squash" | "merge" | "rebase";

/** A PR issue-comment (no @dispatch/shared schema — light shape). */
export interface PRComment {
  id: string;
  author?: string;
  body: string;
  createdAt?: string;
  url?: string;
}

/**
 * The minimal terminal-state view of a PR the `watch_pr` MCP tool polls on —
 * just enough to decide "still open" vs "merged / closed" without a full detail
 * fetch. `mergedAt` is present only when the PR actually merged.
 */
export interface PRMergeState {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
}

/** Optional per-call context threaded onto published events. */
export interface OpCtx {
  chatId?: string;
}

/** What resolving a thread also cleaned up from Dispatch's own blocking review. */
export interface ResolveThreadOutcome {
  /** Number of CHANGES_REQUESTED reviews dismissed after the final internal thread closed. */
  dismissedReviews: number;
  /** The thread resolved, but the follow-up review-state cleanup could not finish. */
  dismissalError?: string;
}

/**
 * Everything the sanctioned create path needs to know about a branch BEFORE it
 * opens a PR on it — read fresh from the working directory, never from what the
 * session believed earlier.
 *
 * `aheadOfBase` is null when we genuinely could not tell (no local ref for the
 * base, a shallow clone). That distinction matters: the refusals below only fire
 * when they CAN tell, the same rule the trunk guard follows — a check that
 * blocks legitimate work on a false positive gets routed around, which is worse
 * than one that occasionally misses.
 */
export interface PrCreatePreflight {
  /** The branch checked out in the create cwd, or null when detached. */
  branch: string | null;
  /** The protected trunk (project `defaultBranch`). */
  trunk: string;
  /** The base the PR would target. */
  base: string;
  /** Commits on this branch that the base doesn't have; null = couldn't tell. */
  aheadOfBase: number | null;
  /** True when the working tree has uncommitted (tracked or untracked) changes. */
  dirty: boolean;
  /** An open/closed PR that already exists for this branch, if any. */
  existing: PRInfo | null;
}

/**
 * ONE poll of a PR — everything the watchers and the PR registry need, read in a
 * single GraphQL round trip.
 *
 * Before this, the same information cost FIVE `gh` subprocess spawns per PR per
 * poll (`pr view` for merge state, `pr checks`, a graphql call for threads, and
 * a graphql + `pr view` pair for the review queue), through two code paths —
 * `watch_pr`'s and `PrReviewWatcher`'s — that had drifted into two dedup
 * memories over the same four questions. One query, measured, costs 1 point of
 * GitHub's 5000/hr GraphQL budget.
 *
 * It also reaches something the old reads could not see at all: see
 * {@link PrReviewerState}'s `in_progress`.
 */
export interface PrPollSnapshot {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
  closedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  isDraft: boolean;
  author?: string;
  labels: string[];
  /** false = merge CONFLICTS; null = GitHub hasn't computed it yet (`UNKNOWN`). */
  mergeable: boolean | null;
  mergeStateStatus?: string;
  reviewDecision: ReviewDecision | null;
  headRefOid?: string;
  /** Diff size — "how big is this change" without opening GitHub. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewers: PrReviewer[];
  threads: ReviewThread[];
  checks: CheckRun[];
  commentCount?: number;
  /**
   * Logins with an OUTSTANDING review request, and the newest submitted review
   * per author. Carried alongside `reviewers` because `watch_pr`'s stalled-queue
   * signal is defined in exactly these terms — see {@link PrReviewState}.
   */
  requested: string[];
  reported: Array<{ author: string; state: string }>;
}

/**
 * The account's Copilot premium-request budget, reduced to what a silently
 * dropped reviewer needs to explain itself. See {@link GitHubService.copilotQuota}.
 */
export interface CopilotQuota {
  /** e.g. `individual_pro`. */
  plan?: string;
  /** Premium requests included in the plan this cycle. */
  entitlement?: number;
  /** Premium requests consumed this cycle — CAN exceed the entitlement. */
  used?: number;
  /** What's left; negative once the budget is overrun. */
  remaining?: number;
  /** `YYYY-MM-DD` the budget refills. */
  resetDate?: string;
  /** The budget is spent AND no overage is permitted — nothing premium will run. */
  exhausted: boolean;
}

/** A PR's review state: who was asked, and who has actually reported. */
export interface PrReviewState {
  /** Reviewers with an OUTSTANDING request (they haven't reported yet). */
  requested: string[];
  /** Reviews that have been submitted, newest-per-author. */
  reported: Array<{ author: string; state: string }>;
  /**
   * Every review EVER submitted on this PR by someone other than its author,
   * newest first — the fact `reported` structurally cannot carry.
   *
   * GitHub's `latestReviews` applies supersede-on-re-request: the moment a
   * reviewer is put back in the queue, the review they already filed drops out
   * of it. That is the right semantics for "what is their live position", and
   * the wrong one for "has anybody looked at this", which is what
   * `requireReview` actually asks. `request_review` made it fire on every PR
   * Dispatch's own loop touched — fix the finding, re-queue the reviewer, and
   * `approve_pr` now reports that nobody has ever reviewed a PR carrying two
   * reviews (#147).
   *
   * The PR's OWN author is excluded, and that exclusion is load-bearing rather
   * than tidy: `resolve_thread` posts its reply as a `PullRequestReview` by the
   * author, so counting those would let a PR clear its own review bar by
   * answering itself. `latestReviews` drops author reviews for us; this list
   * has to do it by hand.
   */
  everReported: Array<{
    author: string;
    state: string;
    submittedAt?: string;
    /**
     * They reviewed a commit that is no longer this PR's head, so their verdict
     * is about code you have since replaced. `undefined` = we could not compare
     * (an absent head or review commit), which must not read as either.
     */
    stale?: boolean;
  }>;
}

/** One inline comment on a submitted review — a file, a line, and what's wrong. */
export interface ReviewComment {
  /** Repo-relative path, exactly as it appears in the diff. */
  path: string;
  /** Line in the HEAD file. GitHub rejects a line not present in the diff. */
  line: number;
  /** First line of a multi-line comment; omit for a single line. */
  startLine?: number;
  /** Which side of the diff `line` refers to. Defaults to the new file. */
  side?: "LEFT" | "RIGHT";
  body: string;
}

/** A review to submit: the verdict, the summary, and the inline comments. */
export interface SubmitReviewInput {
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  body: string;
  comments?: readonly ReviewComment[];
  /** Head sha the review was written against, so GitHub dates it correctly. */
  commitId?: string;
}

/**
 * What actually landed. Never throws: a review that GitHub refuses is a thing
 * the caller has to REPORT, not a crash — see `submitReview` for the refusals
 * that are entirely expected.
 */
export interface SubmitReviewResult {
  posted: boolean;
  /** The submitted review's html url, when GitHub gave us one. */
  url?: string;
  /** The event GitHub actually accepted (may be downgraded — see `submitReview`). */
  event?: SubmitReviewInput["event"];
  /** Inline comments GitHub dropped because their line isn't in the diff. */
  droppedComments?: number;
  error?: string;
}

/** Outcome of requesting a batch of reviewers (some may not exist / lack access). */
export interface RequestReviewersResult {
  requested: string[];
  failed: Array<{ reviewer: string; error: string }>;
}

/* ----------------------------------------------------------------- raw shapes */

interface RawPr {
  number: number;
  url: string;
  title?: string;
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  body?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  labels?: Array<{ name: string }>;
  /** Present only when `statusCheckRollup` was requested (list/detail). */
  statusCheckRollup?: RawRollupEntry[] | null;
  /** Present only when `comments` was requested — we keep just the count. */
  comments?: unknown[];
  additions?: number;
  deletions?: number;
  updatedAt?: string;
  createdAt?: string;
}
/** One entry of a PR's `statusCheckRollup` — either a CheckRun or a StatusContext. */
interface RawRollupEntry {
  __typename?: string;
  // CheckRun shape
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  workflowName?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** GraphQL nests the workflow name this deep; REST-ish reads flatten it. */
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
  // StatusContext shape
  context?: string;
  state?: string;
  targetUrl?: string;
}
interface RawCheck {
  name: string;
  state?: string;
  bucket?: string;
  link?: string;
}
interface RawThreadNode {
  id: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  comments?: {
    nodes?: Array<{
      author?: { login?: string } | null;
      body?: string;
      url?: string;
      createdAt?: string;
    }>;
  };
}
/** `reviewRequests` via GraphQL — the only source that surfaces BOT reviewers. */
interface RawGraphqlReviewRequests {
  /**
   * GraphQL reports failures IN the payload. `gh api graphql` exits non-zero for
   * these but still prints `{"errors":[…]}` on stdout, so under `allowFail` the
   * body parses fine with NO `data` — and `data?.…nodes ?? []` would read as an
   * empty reviewer queue. That is the false stall this whole file is about, so
   * the errors have to be modelled rather than optimistically ignored.
   */
  errors?: unknown[];
  data?: {
    repository?: {
      pullRequest?: {
        author?: { login?: string } | null;
        headRefOid?: string;
        reviews?: {
          nodes?: Array<{
            author?: { login?: string } | null;
            state?: string;
            isMinimized?: boolean;
            submittedAt?: string | null;
            commit?: { oid?: string } | null;
          } | null>;
        };
        reviewRequests?: {
          nodes?: Array<{
            requestedReviewer?: { __typename?: string; login?: string; slug?: string } | null;
          } | null>;
        };
      } | null;
    } | null;
  };
}
interface RawGraphqlThreads {
  data?: {
    repository?: {
      pullRequest?: { reviewThreads?: { nodes?: RawThreadNode[] } } | null;
    } | null;
  };
}
/** One reviewer union member, fragmented so BOTS and MANNEQUINS keep their login. */
interface RawRequestedReviewer {
  __typename?: string;
  login?: string;
  slug?: string;
}
/** A submitted OR pending review. `state: "PENDING"` is the in-progress signal. */
interface RawReviewNode {
  author?: { login?: string } | null;
  state?: string;
  isMinimized?: boolean;
  submittedAt?: string | null;
  commit?: { oid?: string } | null;
}
/**
 * `copilot_internal/user`, as far as {@link GitHubService.copilotQuota} reads it.
 *
 * Every field optional on purpose: this is an undocumented payload and the only
 * safe assumption about it is that it may change shape.
 */
interface RawCopilotUser {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: {
    premium_interactions?: {
      entitlement?: number;
      credits_used?: number;
      remaining?: number;
      has_quota?: boolean;
      unlimited?: boolean;
      overage_permitted?: boolean;
    };
  };
}

/** The whole PR poll payload — see {@link PrPollSnapshot}. */
interface RawGraphqlPoll {
  errors?: unknown[];
  data?: {
    repository?: {
      pullRequest?: {
        number?: number;
        title?: string;
        url?: string;
        state?: string;
        isDraft?: boolean;
        merged?: boolean;
        mergedAt?: string | null;
        closedAt?: string | null;
        createdAt?: string | null;
        updatedAt?: string | null;
        headRefOid?: string;
        headRefName?: string;
        baseRefName?: string;
        mergeable?: string;
        mergeStateStatus?: string;
        reviewDecision?: string | null;
        additions?: number;
        deletions?: number;
        changedFiles?: number;
        author?: { login?: string } | null;
        labels?: { nodes?: Array<{ name?: string }> };
        reviewRequests?: { nodes?: Array<{ requestedReviewer?: RawRequestedReviewer | null } | null> };
        reviews?: { nodes?: RawReviewNode[] };
        latestReviews?: { nodes?: RawReviewNode[] };
        reviewThreads?: { nodes?: RawThreadNode[] };
        comments?: { totalCount?: number };
        commits?: {
          nodes?: Array<{
            commit?: { statusCheckRollup?: { contexts?: { nodes?: RawRollupEntry[] } } | null };
          }>;
        };
      } | null;
    } | null;
  };
}
interface RawWorkflow {
  id: number;
  name: string;
  path: string;
  state?: string;
}
interface RawRun {
  databaseId: number;
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  headBranch?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}
interface RawComment {
  id?: string | number;
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  url?: string;
}

/* -------------------------------------------------------------------- mappers */

function mapMergeable(m: unknown): boolean | null {
  const v = String(m ?? "").toUpperCase();
  if (v === "MERGEABLE") return true;
  if (v === "CONFLICTING") return false;
  return null;
}

function mapCheckStatus(state: unknown): CheckRun["status"] {
  const v = String(state ?? "").toUpperCase();
  if (v === "QUEUED") return "queued";
  if (v === "IN_PROGRESS" || v === "PENDING" || v === "WAITING") return "in_progress";
  return "completed";
}

function mapCheckConclusion(bucket: unknown, state: unknown): CheckRun["conclusion"] {
  switch (String(bucket ?? "").toLowerCase()) {
    case "pass":
      return "success";
    case "fail":
      return "failure";
    case "skipping":
      return "skipped";
    case "cancel":
      return "cancelled";
    case "pending":
      return null;
  }
  // Fall back to the raw state for anything the bucket didn't classify.
  const s = String(state ?? "").toLowerCase();
  if (s === "success") return "success";
  if (s === "failure" || s === "error") return "failure";
  if (s === "skipped") return "skipped";
  if (s === "cancelled") return "cancelled";
  if (s === "timed_out") return "timed_out";
  if (s === "neutral") return "neutral";
  if (s === "action_required") return "action_required";
  if (s === "stale") return "stale";
  return null;
}

function normalizeRunStatus(s: unknown): WorkflowRun["status"] {
  const v = String(s ?? "").toLowerCase().replace(/\s+/g, "_") as WorkflowRun["status"];
  return RUN_STATUSES.has(v) ? v : "pending";
}

/** GitHub `reviewDecision` (uppercase) → our lowercase enum, or null when unset. */
function mapReviewDecision(v: unknown): ReviewDecision | null {
  switch (String(v ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

/**
 * Normalize a raw conclusion/state string (from a rollup CheckRun conclusion or a
 * StatusContext state) to our CheckRun["conclusion"] enum (null = still pending).
 */
function mapConclusionString(v: unknown): CheckRun["conclusion"] {
  switch (String(v ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
    case "startup_failure":
      return "failure";
    case "neutral":
      return "neutral";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "timed_out":
      return "timed_out";
    case "action_required":
      return "action_required";
    case "stale":
      return "stale";
    default:
      // pending / expected / "" / anything unknown → not concluded yet.
      return null;
  }
}

/** Map one `statusCheckRollup` entry (CheckRun or StatusContext) to a CheckRun. */
function mapRollupEntry(e: RawRollupEntry): CheckRun {
  // A StatusContext has `context`/`state` (legacy commit statuses); a CheckRun
  // has `name`/`status`/`conclusion`. Disambiguate on the typename or shape.
  const isContext =
    e.__typename === "StatusContext" || (e.context !== undefined && e.name === undefined);
  if (isContext) {
    const state = String(e.state ?? "").toUpperCase();
    const status: CheckRun["status"] =
      state === "PENDING" || state === "EXPECTED" ? "in_progress" : "completed";
    return CheckRunSchema.parse({
      name: e.context ?? "status",
      status,
      conclusion: mapConclusionString(e.state),
      url: e.targetUrl || undefined,
    });
  }
  return CheckRunSchema.parse({
    name: e.name || e.workflowName || "check",
    // The workflow is the GROUPING a human already has in their head from the
    // Actions tab; without it, three jobs of one workflow read as three
    // unrelated failures.
    workflowName: e.checkSuite?.workflowRun?.workflow?.name || e.workflowName || undefined,
    status: mapCheckStatus(e.status),
    conclusion: mapConclusionString(e.conclusion),
    url: e.detailsUrl || undefined,
    startedAt: e.startedAt || undefined,
    completedAt: e.completedAt || undefined,
  });
}

/** GraphQL `__typename` of a requested reviewer → our reviewer kind. */
function mapReviewerKind(typename: unknown): PrReviewerKind {
  switch (String(typename ?? "")) {
    case "Bot":
      return "bot";
    case "Team":
      return "team";
    case "Mannequin":
      return "mannequin";
    default:
      return "user";
  }
}

/** A submitted review's GraphQL state → our reviewer state. `PENDING` never
 *  reaches here — it means "in progress" and is handled by the caller. */
function mapSubmittedReviewState(state: unknown): PrReviewerState {
  switch (String(state ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "DISMISSED":
      return "dismissed";
    default:
      return "commented";
  }
}

/**
 * Fold GitHub's three reviewer sources into one list, per login.
 *
 * The three disagree on purpose and each is load-bearing:
 *   - `reviewRequests` — who is ON THE HOOK. The ONLY source that reports bot
 *     reviewers; `gh pr view --json reviewRequests` silently drops them, which
 *     is the bug documented at length on {@link GitHubService.prReviewState}.
 *   - `reviews` with `state: "PENDING"` — a review BEGUN and not submitted. This
 *     is the "Copilot is reviewing…" spinner, and GraphQL is the only API that
 *     shows another author's pending review at all (REST omits it).
 *   - `latestReviews` — the newest SUBMITTED verdict per author, with GitHub's
 *     own supersede-on-re-request semantics, which is what `approve_pr` wants.
 *
 * An in-progress review wins over a stale submitted one: "they're looking at it
 * again" is more actionable than "they said something about an older commit".
 */
function foldReviewers(
  requests: Array<{ requestedReviewer?: RawRequestedReviewer | null } | null>,
  allReviews: RawReviewNode[],
  latest: RawReviewNode[],
  headRefOid?: string,
): PrReviewer[] {
  const out = new Map<string, PrReviewer>();

  for (const n of requests) {
    const r = n?.requestedReviewer;
    const login = r?.login ?? r?.slug;
    if (!login) continue;
    out.set(login, { login, kind: mapReviewerKind(r?.__typename), state: "requested" });
  }

  for (const r of latest) {
    const login = r.author?.login;
    if (!login) continue;
    // A minimized review has been folded away as outdated on the PR page; it is
    // not the reviewer's live position and must not be rendered as one.
    if (r.isMinimized) continue;
    const prev = out.get(login);
    out.set(login, {
      login,
      kind: prev?.kind ?? "user",
      state: mapSubmittedReviewState(r.state),
      submittedAt: r.submittedAt ?? undefined,
      // Only claim staleness when we can actually compare — an absent head sha
      // or an absent review commit means "don't know", which must not read as
      // "up to date" OR as "stale".
      stale:
        headRefOid && r.commit?.oid ? r.commit.oid !== headRefOid : undefined,
    });
  }

  for (const r of allReviews) {
    if (String(r.state ?? "").toUpperCase() !== "PENDING") continue;
    const login = r.author?.login;
    if (!login) continue;
    const prev = out.get(login);
    out.set(login, {
      login,
      kind: prev?.kind ?? "user",
      state: "in_progress",
      // Keep what they last SAID; the point of this row is that they're saying
      // something new, not that the old verdict vanished.
      submittedAt: prev?.submittedAt,
    });
  }

  return [...out.values()];
}

/** Whitelist a raw `workflow_dispatch` input type; unknown → undefined. */
function normalizeInputType(t: unknown): WorkflowInput["type"] | undefined {
  switch (String(t ?? "").toLowerCase()) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "choice":
      return "choice";
    case "number":
      return "number";
    case "environment":
      return "environment";
    default:
      return undefined;
  }
}

/**
 * Parse a workflow YAML string into its `workflow_dispatch` inputs. Best-effort:
 * returns [] on a parse failure or when the workflow declares no dispatch inputs.
 *
 * Uses the YAML 1.2 core schema (the `yaml` package's default), which — unlike
 * YAML 1.1 / js-yaml — keeps the bare `on:` key as the STRING "on" rather than
 * coercing it to a boolean, so `doc.on.workflow_dispatch` resolves correctly.
 */
function parseWorkflowInputs(yamlText: string): WorkflowInput[] {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const on = (doc as Record<string, unknown>).on;
  // `on` may be a scalar/array (no dispatch config) or a map holding it.
  if (!on || typeof on !== "object" || Array.isArray(on)) return [];
  const wd = (on as Record<string, unknown>).workflow_dispatch;
  if (!wd || typeof wd !== "object") return [];
  const inputs = (wd as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== "object") return [];
  const out: WorkflowInput[] = [];
  for (const [name, raw] of Object.entries(inputs as Record<string, unknown>)) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    out.push(
      WorkflowInputSchema.parse({
        name,
        description: typeof s.description === "string" ? s.description : undefined,
        type: normalizeInputType(s.type),
        required: typeof s.required === "boolean" ? s.required : undefined,
        default: s.default !== undefined ? String(s.default) : undefined,
        options: Array.isArray(s.options) ? s.options.map((o) => String(o)) : undefined,
      }),
    );
  }
  return out;
}

/* ==================================================================== service */

export interface GitHubServiceDeps {
  bus: EventBus;
  store?: Store;
  /** Injectable execa (tests). Defaults to the real execa. */
  exec?: ExecaLike;
}

export class GitHubService {
  private readonly bus: EventBus;
  private readonly store?: Store;
  private readonly exec: ExecaLike;

  constructor(deps: GitHubServiceDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.exec = deps.exec ?? defaultExec;
  }

  /* -------------------------------------------------------- repo resolution */

  /** Validate + return an owner/repo slug, throwing on anything malformed. */
  assertRepo(repo: string): string {
    if (!REPO_RE.test(repo)) {
      throw new Error(`GitHubService: invalid repo "${repo}" (expected owner/repo)`);
    }
    return repo;
  }

  private splitRepo(repo: string): { owner: string; name: string } {
    const [owner, name] = this.assertRepo(repo).split("/");
    return { owner, name };
  }

  /** Discover owner/repo from a working directory via `gh repo view`. */
  async resolveRepo(cwd: string): Promise<string> {
    const out = await this.gh(
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd },
    );
    return this.assertRepo(out.trim());
  }

  /**
   * The repository a directory belongs to, as its absolute `--git-common-dir`;
   * `null` for anything that isn't a checkout.
   *
   * The identity primitive behind {@link sameRepository} and
   * {@link isRepository} — one `git rev-parse`, one place that knows how to read
   * it. Never throws: an unreadable, missing or non-git directory is `null`.
   */
  async gitCommonDir(dir: string): Promise<string | null> {
    const r = await this.exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: dir, reject: false },
    ).catch(() => null);
    if (!r || r.exitCode !== 0) return null;
    const out = r.stdout.trim();
    if (!out) return null;
    // Resolve symlinks: on macOS a temp dir reached two ways is the same repo
    // but two different strings, and this comparison decides whether a PR opens.
    return await realpath(out).catch(() => resolve(out));
  }

  /**
   * Does this directory still have a git identity?
   *
   * Exists because "the directory is there" and "the directory is a checkout"
   * came apart on Windows: `git worktree remove` unlinks the worktree's `.git`
   * FIRST and then chokes on `node_modules`, leaving a full directory that no
   * git command will answer for (see the worktree reaper's notes). Anything
   * holding such a path — a session's bound cwd, a chat's `worktrees[]` — is
   * holding a dead pointer, and needs to be able to find that out.
   *
   * DELIBERATELY loose about WHERE in a checkout `dir` is: an agent that hands
   * `create_pr` a subdirectory of its worktree has named a directory git will
   * answer for, and every command run there works. Use
   * {@link isRepositoryRoot} where the difference matters.
   */
  async isRepository(dir: string): Promise<boolean> {
    return (await this.gitCommonDir(dir)) !== null;
  }

  /**
   * Is this directory the ROOT of a checkout — the repo itself, or a worktree —
   * rather than merely somewhere inside one?
   *
   * The distinction is load-bearing and cost a review round to spot.
   * `git rev-parse` WALKS UP the parent chain, so a directory with no `.git` of
   * its own still answers, with its parent's, and exits 0. That makes
   * {@link isRepository} say `true` for a reaped worktree that happens to sit
   * INSIDE the repository — which is not an exotic layout: `.worktrees/` is the
   * default `worktreeRoot` for a new project, and the Claude Code harness cuts
   * its own trees into `<repo>/.claude/worktrees/`. A husk there would be judged
   * alive, and git would then answer every question about it with the MAIN
   * checkout's state — reporting `on-trunk` for a chat whose commits are one
   * directory over, which is the exact class of lie this whole area exists to
   * stop telling.
   *
   * `--show-toplevel` is the fix because it names the enclosing worktree's root
   * from anywhere inside it, so comparing it to `dir` distinguishes "this IS a
   * checkout" from "this is under one".
   */
  async isRepositoryRoot(dir: string): Promise<boolean> {
    const r = await this.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      reject: false,
    }).catch(() => null);
    if (!r || r.exitCode !== 0) return false;
    const out = r.stdout.trim();
    if (!out) return false;
    // `resolve` before comparing: git answers with forward slashes even on
    // Windows (`C:/Users/...`), and `realpath` returns backslashes. Comparing
    // the raw strings would reject every candidate on the platform this bug
    // lives on.
    const canonical = async (p: string): Promise<string> =>
      await realpath(resolve(p)).catch(() => resolve(p));
    const [top, self] = await Promise.all([canonical(out), canonical(dir)]);
    return top === self;
  }

  /**
   * Are two directories checkouts of the SAME repository (any worktree of it)?
   *
   * `--git-common-dir` rather than a path-prefix test, deliberately: every linked
   * worktree shares one common dir wherever it physically sits, so this both
   * ACCEPTS a worktree parked outside the repo and REJECTS an unrelated repo
   * nested inside it. A prefix test gets each of those backwards.
   *
   * Never throws — an unreadable or non-git directory is simply "no".
   */
  async sameRepository(a: string, b: string): Promise<boolean> {
    const [x, y] = await Promise.all([this.gitCommonDir(a), this.gitCommonDir(b)]);
    return !!x && !!y && x === y;
  }

  /** owner/repo for a project (from its checkout). */
  repoForProject(project: Project): Promise<string> {
    return this.resolveRepo(project.repoPath);
  }

  /** owner/repo for a project id (reads the project via Store). */
  async repoForProjectId(projectId: string): Promise<string> {
    if (!this.store) throw new Error("GitHubService: no Store configured");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`GitHubService: project "${projectId}" not found`);
    return this.repoForProject(project);
  }

  /** Worktree path for a branch (slug = branch with "/" flattened to "-"). */
  worktreePath(project: Project, branch: string): string {
    // Mirror WorktreeService: resolve a relative worktreeRoot against the repo,
    // not process.cwd(), so ship()'s fallback cwd points at the real worktree.
    return join(resolve(project.repoPath, project.worktreeRoot), branch.replace(/\//g, "-"));
  }

  /* ---------------------------------------------------------- gh primitives */

  /**
   * The environment that makes `gh` act as somebody else.
   *
   * `GH_TOKEN` and nothing else: it takes precedence over both `GITHUB_TOKEN`
   * and the `hosts.yml` login, so one variable is enough to switch identity
   * without touching the human's `gh auth` state — which matters because this
   * process shares that state with every other thing the human runs.
   *
   * Returns `undefined` for an absent token so the caller spreads nothing and
   * the child simply inherits, rather than being handed a scrubbed environment.
   */
  private tokenEnv(token?: string): NodeJS.ProcessEnv | undefined {
    return token ? { ...process.env, GH_TOKEN: token } : undefined;
  }

  /**
   * Which account is this? With a token, whose token is it; without one, who is
   * `gh` logged in as.
   *
   * Both halves of reviewer setup need this and they need it to be the SAME
   * call: the check that actually catches a mistake is comparing the two logins,
   * and comparing answers from two different code paths is how you get a
   * comparison that passes on a technicality.
   *
   * `gh api user` is the cheapest call that proves authentication AND names the
   * account — worth more than a boolean, because the mistake people really make
   * is pasting a token for the wrong account and then getting reviews from
   * themselves wearing a bot's name.
   *
   * Never throws: a bad token is the expected answer here, not an exception.
   */
  async whoami(token?: string): Promise<{ login?: string; error?: string }> {
    const env = this.tokenEnv(token);
    const res = await this.exec("gh", ["api", "user", "--jq", ".login"], {
      reject: false,
      ...(env ? { env } : {}),
    }).catch((e: unknown) => ({
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 1,
    }));
    if (res.exitCode !== 0) {
      return { error: (res.stderr || res.stdout || "gh could not authenticate").trim().slice(0, 300) };
    }
    const login = (res.stdout ?? "").trim();
    return login ? { login } : { error: "GitHub accepted the token but named no account" };
  }

  /**
   * Is `gh` installed, and is it logged in? The first-run setup check.
   *
   * Two probes rather than one because they are two different problems with two
   * different fixes, and `gh api user` cannot distinguish them: a missing binary
   * and a logged-out one both come back as a non-zero exit with a message, and
   * telling someone to run `gh auth login` when `gh` isn't installed sends them
   * in a circle. So `--version` establishes presence, and only then does the
   * authentication question get asked.
   *
   * `whoami()`, deliberately, rather than `gh auth status`: it is the same call
   * the reviewer setup makes, and it answers with the account NAME. "Logged in"
   * is not the useful fact — "logged in as which account" is, because the PR
   * workflow acts as whoever this is.
   *
   * Never throws. Every failure here is an expected answer about the machine,
   * not an exception: an install with no `gh` is a supported install.
   */
  async cliStatus(): Promise<GhCliStatus> {
    const probe = await this.exec("gh", ["--version"], { reject: false }).catch((e: unknown) => ({
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 1,
    }));
    if (probe.exitCode !== 0) {
      return {
        installed: false,
        authenticated: false,
        error: (probe.stderr || probe.stdout || "gh is not on PATH").trim().slice(0, 300),
      };
    }
    // `gh version 2.62.0 (2024-11-14)` — first dotted number on the first line.
    const version = /(\d+\.\d+\.\d+\S*)/.exec((probe.stdout ?? "").split("\n", 1)[0] ?? "")?.[1];
    const who = await this.whoami();
    return {
      installed: true,
      ...(version ? { version } : {}),
      authenticated: !!who.login,
      ...(who.login ? { login: who.login } : {}),
      ...(who.error ? { error: who.error } : {}),
    };
  }

  /**
   * Is this login a collaborator on this repo?
   *
   * The second half of reviewer setup, and the one nobody remembers: GitHub
   * refuses `requested_reviewers` for a non-collaborator with *"Reviews may only
   * be requested from collaborators"*, and that error arrives at the first PR —
   * long after the setup panel said everything was fine. **Read** access is
   * enough, which is the whole point of checking rather than telling people to
   * grant write.
   *
   * Runs as the HUMAN, not as the reviewer: reading a repo's collaborator list
   * is a permission the reviewer's own narrow token is not expected to have.
   * `null` = could not tell, which the caller must not report as "not a
   * collaborator".
   */
  async isCollaborator(repo: string, login: string): Promise<boolean | null> {
    const r = this.assertRepo(repo);
    const res = await this.exec(
      "gh",
      ["api", `repos/${r}/collaborators/${encodeURIComponent(login)}`, "--silent"],
      { reject: false },
    ).catch(() => null);
    if (!res) return null;
    if (res.exitCode === 0) return true;
    // 404 is the documented "not a collaborator" answer. Anything else (403 on a
    // repo we can't read, a network failure) is genuinely unknown.
    return /HTTP 404|Not Found/i.test(res.stderr || res.stdout || "") ? false : null;
  }

  /**
   * Can the REVIEWER's own token see this repository at all?
   *
   * The gate `isCollaborator` cannot answer, because they are two independent
   * grants that look identical from the setup panel. Adding the machine account
   * as a collaborator is what lets GitHub QUEUE it as a reviewer; a fine-grained
   * PAT additionally lists the repositories it may touch, and adding the account
   * to a repo does not retroactively widen a token that was minted for another
   * one. So the account is a collaborator, `isCollaborator` says yes — it runs
   * as the human — and the review still dies at `post_review`.
   *
   * GitHub answers **404, not 403**, for a repo a token cannot see, so the
   * failure reads as "no such pull request" and sends you hunting through line
   * anchors and PR numbers. Observed on mdennis281/the-salesman #134: the
   * reviewer was queued, claimed its round, read the diff, wrote the review, and
   * three `post_review` attempts — including a body-only one with no inline
   * comments at all — came back 404.
   *
   * `null` = could not tell, which the caller must not report as "no access".
   */
  async canReadRepoAs(repo: string, token: string): Promise<boolean | null> {
    const r = this.assertRepo(repo);
    const env = this.tokenEnv(token);
    const res = await this.exec("gh", ["api", `repos/${r}`, "--silent"], {
      reject: false,
      ...(env ? { env } : {}),
    }).catch(() => null);
    if (!res) return null;
    if (res.exitCode === 0) return true;
    // The 404-for-403 substitution is the whole reason this check exists, so
    // both are a definite "no". Anything else is genuinely unknown.
    return /HTTP 404|Not Found|HTTP 403|Forbidden/i.test(res.stderr || res.stdout || "")
      ? false
      : null;
  }

  /** Run `gh <args>`; throw on non-zero unless allowFail. Returns trimmed stdout. */
  private async gh(
    args: string[],
    opts: { cwd?: string; allowFail?: boolean } = {},
  ): Promise<string> {
    const res = await this.exec("gh", args, { cwd: opts.cwd, reject: false });
    if (!opts.allowFail && res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      throw new Error(`gh ${args.join(" ")} failed (exit ${res.exitCode}): ${detail}`);
    }
    return (res.stdout ?? "").trim();
  }

  /** Run gh and JSON.parse stdout (null when empty). */
  private async ghJson<T>(
    args: string[],
    opts: { cwd?: string; allowFail?: boolean } = {},
  ): Promise<T | null> {
    const out = await this.gh(args, opts);
    if (!out) return null;
    try {
      return JSON.parse(out) as T;
    } catch (e) {
      throw new Error(`gh ${args.slice(0, 2).join(" ")}: invalid JSON (${String(e)})`);
    }
  }

  /* ------------------------------------------------------------------- READ */

  /**
   * The account's Copilot premium-request budget, or null if it can't be read.
   *
   * WHY this exists. Copilot code review costs one premium request per review,
   * and when that budget is spent GitHub does not refuse the review request — it
   * answers **201 Created**, queues nobody, and writes no `review_requested`
   * event. At the API that is indistinguishable from "the bot declined to
   * re-review a head it has already seen", which is the guess `request_review`
   * used to print. The guess is worse than no guess: it sent an agent to
   * `approve_pr` with `allowNoReview` and the words "land the PR on the review
   * you already have" on a pull request nobody had ever reviewed.
   *
   * `copilot_internal/user` is UNDOCUMENTED — it is the endpoint the editor
   * plugins call, and GitHub may change it without notice. So this is strictly
   * best-effort and never load-bearing: every failure path returns null and the
   * caller falls back to naming the possible causes instead of one. It is only
   * called once a Copilot reviewer has ALREADY been observed vanishing from the
   * queue, so it costs nothing on the path where reviews work.
   */
  async copilotQuota(): Promise<CopilotQuota | null> {
    // `allowFail` AND a catch: a non-zero exit gives `ghJson` a non-JSON error
    // body to parse, which throws rather than returning null.
    const raw = await this.ghJson<RawCopilotUser>(["api", "copilot_internal/user"], {
      allowFail: true,
    }).catch(() => null);
    const pi = raw?.quota_snapshots?.premium_interactions;
    if (!pi) return null;
    return {
      plan: raw?.copilot_plan,
      entitlement: pi.entitlement,
      used: pi.credits_used,
      remaining: pi.remaining,
      resetDate: raw?.quota_reset_date,
      // `has_quota` is the flag GitHub itself gates on, but it is absent on
      // older payloads — so fall back to the arithmetic. `unlimited` wins over
      // both: a plan with no cap reports `remaining: 0` forever, and reading
      // that as exhausted would blame the quota on every unlimited account.
      exhausted:
        !pi.unlimited &&
        (pi.has_quota === false || (typeof pi.remaining === "number" && pi.remaining <= 0)) &&
        pi.overage_permitted !== true,
    };
  }

  /** Most-recent PR for a branch (open or closed), or null. */
  async prForBranch(repo: string, branch: string): Promise<PRInfo | null> {
    const r = this.assertRepo(repo);
    const raw =
      (await this.ghJson<RawPr[]>([
        "pr", "list", "--repo", r, "--head", branch,
        "--state", "all", "--json", PR_JSON_FIELDS, "--limit", "1",
      ])) ?? [];
    return raw.length ? this.mapPr(raw[0]) : null;
  }

  /** List PRs (default: open, 30). */
  async prList(
    repo: string,
    opts: { state?: "open" | "closed" | "merged" | "all"; base?: string; limit?: number } = {},
  ): Promise<PRInfo[]> {
    const r = this.assertRepo(repo);
    const args = [
      "pr", "list", "--repo", r,
      "--state", opts.state ?? "open",
      "--json", PR_JSON_FIELDS,
      "--limit", String(opts.limit ?? 30),
    ];
    if (opts.base) args.push("--base", opts.base);
    const raw = (await this.ghJson<RawPr[]>(args)) ?? [];
    return raw.map((p) => this.mapPr(p));
  }

  /**
   * ALL open PRs for the project — the GLOBAL project PR view (not per-chat).
   * Uses the inline `statusCheckRollup` so each PR carries its check status
   * without a per-PR `pr checks` fan-out; also folds in reviewDecision + a
   * comment count. Pure read (no bus side effects).
   */
  async projectOpenPrs(repo: string): Promise<PRInfo[]> {
    const r = this.assertRepo(repo);
    const raw =
      (await this.ghJson<RawPr[]>([
        "pr", "list", "--repo", r,
        "--state", "open",
        "--json", PR_LIST_JSON_FIELDS,
        "--limit", "100",
      ])) ?? [];
    return raw.map((p) => this.mapPr(p));
  }

  /**
   * Rich detail for ONE PR: check rollup (per-check name/status/conclusion),
   * review decision, review threads + comment count, and mergeable/mergeState.
   * Pure read (no bus emit) — the GET endpoint the detail view calls. Checks come
   * from the inline rollup; if that's empty we fall back to `pr checks`.
   */
  async prDetail(repo: string, prNumber: number): Promise<PRInfo | null> {
    const r = this.assertRepo(repo);
    const raw = await this.ghJson<RawPr>(
      ["pr", "view", String(prNumber), "--repo", r, "--json", PR_DETAIL_JSON_FIELDS],
      { allowFail: true },
    );
    if (!raw) return null;
    const pr = this.mapPr(raw);
    // Rollup can be empty (e.g. no required checks configured yet) — fall back to
    // `gh pr checks` so the detail view still shows in-flight/failed CI.
    if (pr.checks.length === 0) {
      try {
        pr.checks = await this.prChecks(r, prNumber);
      } catch {
        /* keep [] */
      }
    }
    try {
      pr.reviewThreads = await this.reviewThreads(r, prNumber);
    } catch {
      /* threads optional */
    }
    return pr;
  }

  /** Fetch a single PR by number (lightweight — no checks/threads). */
  async getPr(repo: string, prNumber: number): Promise<PRInfo | null> {
    const raw = await this.ghJson<RawPr>(
      ["pr", "view", String(prNumber), "--repo", this.assertRepo(repo), "--json", PR_JSON_FIELDS],
      { allowFail: true },
    );
    return raw ? this.mapPr(raw) : null;
  }

  /**
   * Poll a single PR's merge/close state — the minimal `{ number, state, merged,
   * mergedAt }` the `watch_pr` MCP tool loops on. Runs `gh pr view <n> --json
   * number,state,merged,mergedAt`, auto-detecting the repo from `opts.cwd` (the
   * chat's worktree, else the project repo root) UNLESS an explicit `owner/name`
   * `opts.repo` override is given. Returns null when the PR can't be resolved
   * (unknown number, an unresolvable/absent repo, or a gh error) so the caller
   * can surface an informative result instead of hanging. Pure read (no bus emit).
   */
  async prMergeState(
    prNumber: number,
    opts: { repo?: string; cwd?: string } = {},
  ): Promise<PRMergeState | null> {
    // NB: `gh pr view` has no `merged` boolean field — merged-ness is derived
    // from `state` below. Requesting it makes gh exit non-zero ("Unknown JSON
    // field"), which allowFail turns into a null → a spurious "PR not found".
    const args = ["pr", "view", String(prNumber), "--json", "number,state,mergedAt"];
    // Explicit override → validate + scope to it; otherwise let gh auto-detect
    // the repo from the working directory.
    if (opts.repo) args.push("--repo", this.assertRepo(opts.repo));
    const raw = await this.ghJson<{
      number?: number;
      state?: string;
      mergedAt?: string | null;
    }>(args, { cwd: opts.cwd, allowFail: true });
    if (!raw || typeof raw.number !== "number") return null;
    const state = String(raw.state ?? "").toLowerCase();
    const merged = state === "merged";
    return {
      number: raw.number,
      state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      merged,
      // gh emits a zero-time sentinel ("0001-01-01T00:00:00Z") for un-merged PRs.
      mergedAt:
        merged && raw.mergedAt && !raw.mergedAt.startsWith("0001-01-01")
          ? raw.mergedAt
          : undefined,
    };
  }

  /**
   * ONE poll of a PR — {@link PrPollSnapshot}, in a single GraphQL round trip.
   *
   * This is THE poll body: `watch_pr` and the background `PrReviewWatcher` both
   * run it, so the app and the agent can no longer hold different beliefs about
   * the same PR. It replaces five `gh` subprocess spawns with one, and costs 1
   * point of a 5000/hr GraphQL budget (measured).
   *
   * Returns **null** when no snapshot could be produced — an unknown PR, an
   * unresolvable repo, a `gh` failure, or a GraphQL `errors` payload. Callers
   * treat that exactly as they always treated a null {@link prMergeState}: as
   * fatal to this watch, not as an empty read. That is deliberate and is not a
   * regression in tolerance — `prMergeState` was ALREADY the read whose failure
   * ended a watch, and it went through this same subprocess and network path;
   * the secondary reads that used to degrade to "no news" now simply travel with
   * it. `watch_pr`'s contract is "call again", so a transient failure costs one
   * round trip, not the watch.
   *
   * `opts.cwd` is passed to `gh` only so it can pick up repo-local auth config;
   * the repo itself is always explicit here, because GraphQL cannot auto-detect
   * it the way `gh pr view` can.
   */
  async pollPrState(
    repo: string,
    prNumber: number,
    opts: { cwd?: string } = {},
  ): Promise<PrPollSnapshot | null> {
    const { owner, name } = this.splitRepo(repo);
    // `reviews` is fetched IN FULL (not just `latestReviews`) for one reason:
    // it is the only place a PENDING — begun, unsubmitted — review appears.
    const query =
      "query($owner:String!,$repo:String!,$number:Int!)" +
      "{repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
      "number title url state isDraft merged mergedAt closedAt createdAt updatedAt " +
      "headRefOid headRefName baseRefName mergeable mergeStateStatus reviewDecision " +
      "additions deletions changedFiles " +
      "author{login} labels(first:50){nodes{name}} " +
      "reviewRequests(first:50){nodes{requestedReviewer{__typename " +
      "... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}}}} " +
      "reviews(first:100){nodes{author{login} state isMinimized submittedAt commit{oid}}} " +
      "latestReviews(first:50){nodes{author{login} state isMinimized submittedAt commit{oid}}} " +
      "reviewThreads(first:100){nodes{id isResolved isOutdated path line " +
      "comments(first:1){nodes{author{login} body url createdAt}}}} " +
      "comments(first:1){totalCount} " +
      "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename " +
      "... on CheckRun{name status conclusion detailsUrl startedAt completedAt " +
      "checkSuite{workflowRun{workflow{name}}}} " +
      "... on StatusContext{context state targetUrl}}}}}}}" +
      "}}}";
    const raw = await this.ghJson<RawGraphqlPoll>(
      [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${name}`,
        "-F", `number=${prNumber}`,
      ],
      { cwd: opts.cwd, allowFail: true },
    ).catch(() => null);
    // Same rule `prReviewState` documents: GraphQL reports failures IN the
    // payload, and a body with `errors` and no `data` parses perfectly well
    // while meaning "we learned nothing".
    if (!raw || raw.errors?.length) return null;
    const pr = raw.data?.repository?.pullRequest;
    if (!pr || typeof pr.number !== "number") return null;

    const rawState = String(pr.state ?? "").toUpperCase();
    const merged = rawState === "MERGED" || !!pr.merged;
    const state: PrPollSnapshot["state"] =
      merged ? "merged" : rawState === "CLOSED" ? "closed" : "open";

    const rollup =
      pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    let checks = rollup.map(mapRollupEntry);
    // An empty rollup is ambiguous — no CI configured, or a rollup GitHub hasn't
    // populated. `gh pr checks` disambiguates, and `watch_pr`'s "no checks
    // configured" note is only honest once we've asked it. Same fallback
    // `prDetail` makes, for the same reason.
    if (checks.length === 0) {
      checks = await this.prChecks(repo, prNumber).catch(() => []);
    }

    const allReviews = pr.reviews?.nodes ?? [];
    const latestReviews = pr.latestReviews?.nodes ?? [];
    const reviewers = foldReviewers(
      pr.reviewRequests?.nodes ?? [],
      allReviews,
      latestReviews,
      pr.headRefOid,
    );

    return {
      repo: this.assertRepo(repo),
      number: pr.number,
      url: pr.url ?? "",
      title: pr.title ?? "",
      branch: pr.headRefName ?? "",
      baseBranch: pr.baseRefName ?? "main",
      state,
      merged,
      // gh/GitHub emit a zero-time sentinel for un-merged PRs; keep the same
      // guard `prMergeState` uses so "merged at year 1" never reaches a UI.
      mergedAt:
        merged && pr.mergedAt && !pr.mergedAt.startsWith("0001-01-01")
          ? pr.mergedAt
          : undefined,
      closedAt: pr.closedAt && !pr.closedAt.startsWith("0001-01-01") ? pr.closedAt : undefined,
      createdAt: pr.createdAt ?? undefined,
      updatedAt: pr.updatedAt ?? undefined,
      isDraft: !!pr.isDraft,
      author: pr.author?.login ?? undefined,
      labels: (pr.labels?.nodes ?? []).map((l) => l?.name ?? "").filter(Boolean),
      mergeable: mapMergeable(pr.mergeable),
      mergeStateStatus: pr.mergeStateStatus ?? undefined,
      reviewDecision: mapReviewDecision(pr.reviewDecision),
      headRefOid: pr.headRefOid || undefined,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewers,
      threads: (pr.reviewThreads?.nodes ?? []).map((t) => {
        const first = t.comments?.nodes?.[0];
        return ReviewThreadSchema.parse({
          id: t.id,
          isResolved: !!t.isResolved,
          isOutdated: t.isOutdated ?? undefined,
          path: t.path ?? undefined,
          line: t.line ?? null,
          author: first?.author?.login ?? undefined,
          body: first?.body ?? undefined,
          url: first?.url ?? undefined,
          createdAt: first?.createdAt ?? undefined,
        });
      }),
      checks,
      commentCount: pr.comments?.totalCount,
      requested: reviewers.filter((r) => r.state === "requested").map((r) => r.login),
      reported: latestReviews
        .filter((r) => !r.isMinimized)
        .map((r) => ({
          author: r.author?.login ?? "",
          state: String(r.state ?? "").toUpperCase(),
        }))
        .filter((r) => r.author),
    };
  }

  /** CI checks for a PR. `gh pr checks` exits non-zero while pending → allowFail. */
  async prChecks(repo: string, prNumber: number): Promise<CheckRun[]> {
    const raw =
      (await this.ghJson<RawCheck[]>(
        ["pr", "checks", String(prNumber), "--repo", this.assertRepo(repo), "--json", CHECK_JSON_FIELDS],
        { allowFail: true },
      )) ?? [];
    return raw.map((c) =>
      CheckRunSchema.parse({
        name: c.name,
        status: mapCheckStatus(c.state),
        conclusion: mapCheckConclusion(c.bucket, c.state),
        url: c.link || undefined,
      }),
    );
  }

  /** Review threads (with resolve state) via GraphQL — typed variables, no interpolation of ids. */
  async reviewThreads(repo: string, prNumber: number): Promise<ReviewThread[]> {
    const { owner, name } = this.splitRepo(repo);
    const query =
      "query($owner:String!,$repo:String!,$number:Int!)" +
      "{repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
      "reviewThreads(first:100){nodes{id isResolved isOutdated path line " +
      "comments(first:1){nodes{author{login} body}}}}}}}";
    const data = await this.ghJson<RawGraphqlThreads>([
      "api", "graphql",
      "-f", `query=${query}`,
      "-f", `owner=${owner}`,
      "-f", `repo=${name}`,
      "-F", `number=${prNumber}`,
    ]);
    const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.map((t) =>
      ReviewThreadSchema.parse({
        id: t.id,
        isResolved: !!t.isResolved,
        isOutdated: t.isOutdated ?? undefined,
        path: t.path ?? undefined,
        line: t.line ?? null,
        author: t.comments?.nodes?.[0]?.author?.login ?? undefined,
        body: t.comments?.nodes?.[0]?.body ?? undefined,
      }),
    );
  }

  /** Issue comments on a PR. */
  async comments(repo: string, prNumber: number): Promise<PRComment[]> {
    const data = await this.ghJson<{ comments?: RawComment[] }>([
      "pr", "view", String(prNumber), "--repo", this.assertRepo(repo), "--json", "comments",
    ]);
    return (data?.comments ?? []).map((c) => ({
      id: String(c.id ?? ""),
      author: c.author?.login ?? undefined,
      body: c.body ?? "",
      createdAt: c.createdAt ?? undefined,
      url: c.url ?? undefined,
    }));
  }

  /* -------------------------------------------------------------------- ACT */

  /**
   * Ship a branch. Runs `project.shipCmd` in the worktree when set (Hivebreak →
   * `pnpm ship`, which pushes + opens the PR + requests Copilot). Otherwise
   * `gh pr create --base <default> --head <branch> --fill` then requests Copilot.
   * Emits pr-update with the enriched PR.
   */
  /**
   * The PR's unified diff, as the reviewer will read it.
   *
   * Capped, because the cap is the honest part: a 2MB generated-file diff would
   * either blow the reviewer's context or get silently trimmed by whatever
   * truncates last, and a reviewer that quietly saw half a PR reports a clean
   * bill of health on the half it read. Returning `truncated` lets the briefing
   * SAY so and tell the agent to fetch the rest itself.
   *
   * `null` = the diff could not be read at all, which is different from empty.
   */
  async prDiff(
    repo: string,
    prNumber: number,
    maxBytes = 400_000,
  ): Promise<{ text: string; truncated: boolean } | null> {
    const out = await this.gh(
      ["pr", "diff", String(prNumber), "--repo", this.assertRepo(repo)],
      { allowFail: true },
    ).catch(() => "");
    if (!out) return null;
    return out.length > maxBytes
      ? { text: out.slice(0, maxBytes), truncated: true }
      : { text: out, truncated: false };
  }

  async ship(
    project: Project,
    branch: string,
    opts: { cwd?: string; chatId?: string } = {},
  ): Promise<PRInfo | null> {
    const chatId = opts.chatId;
    const cwd = opts.cwd ?? this.worktreePath(project, branch);
    const repo = await this.resolveRepo(project.repoPath);

    if (project.shipCmd) {
      await this.runCommand(project.shipCmd, cwd);
      this.emitNotice(`Ran ship command \`${project.shipCmd}\` for ${branch}`, "info", chatId);
    } else {
      const base = project.defaultBranch ?? "main";
      await this.gh(
        ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--fill"],
        { cwd, allowFail: true },
      );
    }

    const pr = await this.prForBranch(repo, branch);
    if (!pr) {
      this.emitNotice(`Ship ran for ${branch} but no PR was found`, "warn", chatId);
      return null;
    }
    // `gh pr create` path requests the review itself; shipCmd already did.
    if (!project.shipCmd) await this.requestReview(repo, pr.number, COPILOT_LOGIN, { chatId });
    const full = await this.enrich(repo, pr, chatId);
    // Persist the PR onto the chat so the per-chat PRs panel (and the PR badge /
    // header chip) can scope to it. Without this the chat's `prs` stayed `[]` in
    // production and the whole panel was unreachable — the pr-update event only
    // feeds the GLOBAL panel roster, never the chat record.
    if (chatId) await this.attachPrToChat(chatId, full, repo);
    this.emitNotice(`Shipped PR #${pr.number}`, "info", chatId);
    return full;
  }

  /**
   * Attach (or update, deduped by number) a lightweight PRRef on a chat and fan out
   * `chat-update` so every client scopes the per-chat PRs panel to it. Best-effort:
   * a store/chat miss must never fail the ship. No-op without a Store (unit tests).
   */
  private async attachPrToChat(chatId: string, pr: PRInfo, repo: string): Promise<void> {
    if (!this.store) return;
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat) return;
      const ref: PRRef = {
        number: pr.number,
        url: pr.url,
        branch: pr.branch,
        repo,
        title: pr.title,
        state: pr.state,
      };
      const others = (chat.prs ?? []).filter((p) => p.number !== pr.number);
      const saved = await this.store.saveChat({
        ...chat,
        prs: [ref, ...others],
        updatedAt: Date.now(),
      });
      this.bus.publish({ type: "chat-update", chat: saved });
    } catch {
      /* best-effort — a chat-attach failure shouldn't fail the ship */
    }
  }

  /* ------------------------------------------------------------ create_pr */

  /**
   * Read the branch state `create_pr` refuses on. Never throws — every probe
   * degrades to "couldn't tell", which the refusal rules treat as "don't block".
   */
  async prCreatePreflight(
    repo: string,
    opts: { cwd: string; trunk: string; base?: string },
  ): Promise<PrCreatePreflight> {
    const base = opts.base || opts.trunk;
    const git = async (args: string[]): Promise<{ out: string; ok: boolean }> => {
      const r = await this.exec("git", args, { cwd: opts.cwd, reject: false }).catch(() => null);
      return { out: (r?.stdout ?? "").trim(), ok: !!r && r.exitCode === 0 };
    };

    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    // `HEAD` is what rev-parse prints for a detached checkout — not a branch.
    const branch = head.ok && head.out && head.out !== "HEAD" ? head.out : null;

    const dirtyProbe = await git(["status", "--porcelain"]);
    const dirty = dirtyProbe.ok && dirtyProbe.out.length > 0;

    // Prefer the REMOTE base: a stale local `main` would report commits the base
    // already has, i.e. a false "you have work here". Fall back to the local ref,
    // then to null (a shallow clone / brand-new repo can answer neither).
    let aheadOfBase: number | null = null;
    for (const ref of [`origin/${base}`, base]) {
      const probe = await git(["rev-list", "--count", `${ref}..HEAD`]);
      if (probe.ok && /^\d+$/.test(probe.out)) {
        aheadOfBase = Number(probe.out);
        break;
      }
    }

    const existing = branch ? await this.prForBranch(repo, branch).catch(() => null) : null;
    return { branch, trunk: opts.trunk, base, aheadOfBase, dirty, existing };
  }

  /**
   * Push the branch with an upstream and open the PR. One call, because the two
   * halves are not independently useful and splitting them is how you end up
   * with a pushed branch and no PR (or a PR the agent forgot to request review
   * on). Returns the created PR, or null when `gh` opened one we then couldn't
   * read back.
   */
  async createPr(
    repo: string,
    input: {
      cwd: string;
      branch: string;
      base: string;
      title?: string;
      body?: string;
      draft?: boolean;
      chatId?: string;
    },
  ): Promise<PRInfo | null> {
    const r = this.assertRepo(repo);
    // `--set-upstream` unconditionally: re-pushing an already-tracked branch with
    // it is a no-op, whereas a missing upstream is a silent failure mode later
    // (every subsequent bare `git push` in that worktree fails).
    const pushed = await this.exec(
      "git",
      ["push", "--set-upstream", "origin", input.branch],
      { cwd: input.cwd, reject: false },
    );
    if (pushed.exitCode !== 0) {
      const detail = (pushed.stderr || pushed.stdout || "").trim().slice(0, 500);
      throw new Error(`git push --set-upstream origin ${input.branch} failed: ${detail}`);
    }

    const args = [
      "pr", "create", "--repo", r,
      "--base", input.base,
      "--head", input.branch,
    ];
    if (input.title?.trim()) args.push("--title", input.title.trim());
    if (input.body?.trim()) args.push("--body", input.body.trim());
    // `--fill` derives title/body from the commits — the right default when the
    // caller supplied neither, and illegal alongside an explicit --title.
    if (!input.title?.trim()) args.push("--fill");
    else if (!input.body?.trim()) args.push("--body", "");
    if (input.draft) args.push("--draft");
    await this.gh(args, { cwd: input.cwd });

    const pr = await this.prForBranch(r, input.branch);
    if (pr) this.emitNotice(`Opened PR #${pr.number}`, "info", input.chatId);
    return pr;
  }

  /**
   * Request several reviewers at once, reporting per-reviewer failure rather
   * than throwing. A reviewer that doesn't exist (or can't be assigned — a bot
   * that isn't installed, a team you can't reach) must not sink the PR that was
   * already opened; the caller says which ones landed so the agent knows whether
   * anyone is actually going to look at it.
   *
   * An `org/team` entry goes on `team_reviewers[]`; anything else is a user login.
   */
  async requestReviewers(
    repo: string,
    prNumber: number,
    reviewers: readonly string[],
    opts: OpCtx = {},
  ): Promise<RequestReviewersResult> {
    const r = this.assertRepo(repo);
    const out: RequestReviewersResult = { requested: [], failed: [] };
    for (const reviewer of reviewers) {
      const name = reviewer.trim();
      if (!name) continue;
      // `org/team` → the team slug on the team_reviewers key. GitHub rejects a
      // slashed value on `reviewers[]` outright, so guessing wrong is loud.
      const isTeam = name.includes("/");
      const field = isTeam ? "team_reviewers[]" : "reviewers[]";
      const value = isTeam ? (name.split("/").pop() ?? name) : name;
      const res = await this.exec(
        "gh",
        [
          "api", "--method", "POST",
          `repos/${r}/pulls/${prNumber}/requested_reviewers`,
          "-f", `${field}=${value}`,
        ],
        { reject: false },
      ).catch((e: unknown) => ({
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
      }));
      if (res.exitCode === 0) out.requested.push(name);
      else {
        out.failed.push({
          reviewer: name,
          error: (res.stderr || res.stdout || `gh exited ${res.exitCode}`).trim().slice(0, 200),
        });
      }
    }
    if (out.requested.length) {
      this.emitNotice(
        `Requested review from ${out.requested.join(", ")} on PR #${prNumber}`,
        "info",
        opts.chatId,
      );
    }
    return out;
  }

  /**
   * Who was asked to review, and who has actually reported.
   *
   * `approve_pr` needs the distinction: an outstanding review REQUEST with no
   * submitted review means nobody has looked yet, which under `requireReview` is
   * not "ready to land" — it's "not started".
   *
   * Returns **null** when the state could not be read. NOT empty lists: callers
   * (`watch_pr`'s stall signal, `approve_pr`'s review gate) rely on null meaning
   * "unreadable", because an empty queue reported for a failed read is exactly
   * the false stall that hung every chat.
   */
  async prReviewState(repo: string, prNumber: number): Promise<PrReviewState | null> {
    const { owner, name } = this.splitRepo(repo);
    // The queue comes from GraphQL, NOT `gh pr view --json reviewRequests`.
    //
    // `gh pr view --json reviewRequests` SILENTLY DROPS BOT REVIEWERS. Measured
    // against a PR with a live, outstanding Copilot request:
    //
    //   graphql (fragments below) → [{__typename:"Bot", login:"copilot-…"}]
    //   gh pr view --json reviewRequests → []
    //   REST /pulls/N/requested_reviewers → {"users":[],"teams":[]}   (no bots key at all)
    //
    // Copilot is the reviewer this whole workflow runs on, so `requested` was
    // ALWAYS empty — and `watch_pr` read that as "nobody is queued" roughly a
    // minute after every `create_pr`, while Copilot was still working (it takes
    // ~4 minutes to report). Every chat then re-requested, got another empty
    // read, went to `approve_pr`, hit `no-review`, and escalated to a human
    // override card. The whole cascade was this one field.
    //
    // The `Mannequin` fragment is here because GitHub has represented Copilot as
    // both a Bot and a Mannequin depending on how the request was made; an
    // unfragmented union member decodes to a login-less node and vanishes the
    // same way.
    //
    // `reviews` and `author` ride along on the same query so `everReported` can
    // be built — see {@link PrReviewState.everReported} for why `latestReviews`
    // alone is not enough, and why the author has to be known to exclude them.
    const query =
      "query($owner:String!,$repo:String!,$number:Int!)" +
      "{repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
      "author{login} headRefOid " +
      "reviews(first:100){nodes{author{login} state isMinimized submittedAt commit{oid}}} " +
      "reviewRequests(first:100){nodes{requestedReviewer{__typename " +
      "... on User{login} ... on Bot{login} ... on Mannequin{login} " +
      "... on Team{slug}}}}}}}";
    const [reqRaw, revRaw] = await Promise.all([
      this.ghJson<RawGraphqlReviewRequests>(
        [
          "api", "graphql",
          "-f", `query=${query}`,
          "-f", `owner=${owner}`,
          "-f", `repo=${name}`,
          "-F", `number=${prNumber}`,
        ],
        { allowFail: true },
      ),
      // `latestReviews` stays on `gh pr view` — it reports bot reviews correctly,
      // and its "supersede on re-request" semantics are what `approve_pr` wants.
      this.ghJson<{
        latestReviews?: Array<{ author?: { login?: string } | null; state?: string }>;
      }>(
        [
          "pr", "view", String(prNumber), "--repo", this.assertRepo(repo),
          "--json", "latestReviews",
        ],
        { allowFail: true },
      ),
    ]);
    // A PR with nobody requested still answers with empty NODES, so the only
    // thing that may produce an empty queue here is a genuine read. Anything
    // else — no output, a GraphQL `errors` payload, a missing `data` — is
    // "couldn't read" and must come back as null: passing a failure off as an
    // empty queue is indistinguishable from "nobody is queued", which is
    // precisely the false alarm `watch_pr`'s stall signal must never raise.
    if (!reqRaw || !revRaw) return null;
    if (reqRaw.errors?.length || !reqRaw.data) return null;
    const requested = (
      reqRaw.data.repository?.pullRequest?.reviewRequests?.nodes ?? []
    )
      .map((n) => n?.requestedReviewer?.login ?? n?.requestedReviewer?.slug ?? "")
      .filter(Boolean);
    const reported = (revRaw.latestReviews ?? [])
      .map((x) => ({ author: x.author?.login ?? "", state: String(x.state ?? "").toUpperCase() }))
      .filter((x) => x.author);
    const prAuthor = (
      reqRaw.data.repository?.pullRequest?.author?.login ?? ""
    ).toLowerCase();
    const head = reqRaw.data.repository?.pullRequest?.headRefOid;
    const everReported = (reqRaw.data.repository?.pullRequest?.reviews?.nodes ?? [])
      .filter((n): n is NonNullable<typeof n> => Boolean(n?.author?.login))
      // A minimized review has been folded away as outdated on the PR page, and
      // a PENDING one has been begun and not submitted — neither is somebody
      // having reported.
      .filter((n) => !n.isMinimized && String(n.state ?? "").toUpperCase() !== "PENDING")
      .filter((n) => (n.author?.login ?? "").toLowerCase() !== prAuthor)
      .map((n) => ({
        author: n.author?.login ?? "",
        state: String(n.state ?? "").toUpperCase(),
        submittedAt: n.submittedAt ?? undefined,
        // Only claim staleness when we can actually compare — an absent head or
        // review commit means "don't know", which must not read as "current"
        // OR as "stale". Same rule `foldReviewers` follows.
        stale: head && n.commit?.oid ? n.commit.oid !== head : undefined,
      }))
      .reverse();
    return { requested, reported, everReported };
  }

  /**
   * Attach a PR to a chat's `prs` — the ownership record the review watcher and
   * the per-chat PRs panel both read. Public because `create_pr` needs it: a PR
   * opened without this entry is invisible to everything downstream, which is
   * precisely what a hand-rolled `gh pr create` produced.
   */
  async attachPr(chatId: string, pr: PRInfo, repo: string): Promise<void> {
    return this.attachPrToChat(chatId, pr, repo);
  }

  /** Request a review from a reviewer (defaults to Copilot). Mirrors ship.mjs. */
  async requestReview(
    repo: string,
    prNumber: number,
    reviewer: string = COPILOT_LOGIN,
    opts: OpCtx = {},
  ): Promise<void> {
    const r = this.assertRepo(repo);
    await this.gh(
      [
        "api", "--method", "POST",
        `repos/${r}/pulls/${prNumber}/requested_reviewers`,
        "-f", `reviewers[]=${reviewer}`,
      ],
      { allowFail: true },
    );
    this.emitNotice(`Requested review from ${reviewer} on PR #${prNumber}`, "info", opts.chatId);
  }

  /**
   * Submit a review on a PR — a verdict, a summary, and inline comments.
   *
   * This is how Dispatch's own reviewer speaks. The inline comments are the
   * point: they become real review THREADS, which means everything downstream
   * already works on them — `watch_pr` reports them, `resolve_thread` closes
   * them, and `approve_pr` refuses to merge while any is open. The same review
   * posted as one issue comment would have none of those properties.
   *
   * Sent through a temp FILE rather than `-f` fields because `comments` is an
   * array of objects, which `gh api`'s field flags cannot express at all.
   *
   * Never throws, and degrades twice rather than losing the work:
   *
   *   - **Self-review.** GitHub refuses `APPROVE`/`REQUEST_CHANGES` on your own
   *     pull request, and while Dispatch posts under the human's own token that
   *     is the ordinary case, not an error. It retries as `COMMENT` and reports
   *     the downgrade. The inline comments still land, and open threads still
   *     block the merge — so the review keeps its teeth without the verdict.
   *   - **A line that isn't in the diff.** GitHub rejects the WHOLE review over
   *     one bad line number, which would throw away a good review for a
   *     misremembered offset. It retries with the findings folded into the
   *     summary body and reports how many it had to move.
   */
  async submitReview(
    repo: string,
    prNumber: number,
    input: SubmitReviewInput,
    opts: OpCtx & { token?: string } = {},
  ): Promise<SubmitReviewResult> {
    const r = this.assertRepo(repo);
    const comments = (input.comments ?? []).filter((c) => c.path && c.body);
    // The dedicated reviewer's token, when there is one. This is the ONLY call
    // in this service that runs as somebody other than the human — everything
    // else (requesting the reviewer, merging, labelling) is an action the human
    // is taking, and doing those as the bot would misattribute them.
    const env = this.tokenEnv(opts.token);

    const post = async (
      event: SubmitReviewInput["event"],
      body: string,
      inline: readonly ReviewComment[],
    ): Promise<{ ok: boolean; url?: string; detail: string }> => {
      const threadedBody =
        event === "REQUEST_CHANGES" && inline.length
          ? `${body}\n\n${THREADED_CHANGE_REQUEST_MARKER}`
          : body;
      const payload: Record<string, unknown> = { event, body: threadedBody };
      if (input.commitId) payload.commit_id = input.commitId;
      if (inline.length) {
        payload.comments = inline.map((c) => ({
          path: c.path,
          line: c.line,
          ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine } : {}),
          side: c.side ?? "RIGHT",
          body: c.body,
        }));
      }
      // A temp DIR, removed whole: the payload carries the entire review text,
      // and leaving that lying in the system temp dir is a small but real leak
      // of whatever the reviewer had to say about a private repo.
      const dir = await mkdtemp(join(tmpdir(), "dispatch-review-"));
      const file = join(dir, "review.json");
      try {
        await writeFile(file, JSON.stringify(payload), "utf8");
        const res = await this.exec(
          "gh",
          ["api", "--method", "POST", `repos/${r}/pulls/${prNumber}/reviews`, "--input", file],
          { reject: false, ...(env ? { env } : {}) },
        ).catch((e: unknown) => ({
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          exitCode: 1,
        }));
        const detail = (res.stderr || res.stdout || `gh exited ${res.exitCode}`).trim();
        if (res.exitCode !== 0) return { ok: false, detail };
        let url: string | undefined;
        try {
          url = (JSON.parse(res.stdout) as { html_url?: string }).html_url;
        } catch {
          /* a 200 with unparseable output still posted the review */
        }
        return { ok: true, url, detail };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    let event = input.event;
    let attempt = await post(event, input.body, comments);

    // GitHub's wording has varied ("Can not approve your own pull request",
    // "Can not request changes on your own pull request"), so match the shape
    // rather than the sentence.
    if (!attempt.ok && event !== "COMMENT" && /your own pull request/i.test(attempt.detail)) {
      event = "COMMENT";
      attempt = await post(event, input.body, comments);
    }

    // One bad line number sinks the whole review. Keep the findings, move them.
    if (
      !attempt.ok &&
      comments.length &&
      /part of the diff|must be part of|start_line|invalid.*position/i.test(attempt.detail)
    ) {
      const folded = [
        input.body,
        "",
        "---",
        "",
        "_These findings could not be attached to their lines — GitHub rejected the " +
          "positions as outside this PR's diff._",
        "",
        ...comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body}`),
      ].join("\n");
      attempt = await post(event, folded, []);
      if (attempt.ok) {
        this.emitNotice(
          `Posted a ${event.toLowerCase().replace(/_/g, " ")} review on PR #${prNumber} with ` +
            `${comments.length} finding(s) folded into the summary — GitHub rejected their ` +
            "line positions",
          "warn",
          opts.chatId,
        );
        return { posted: true, url: attempt.url, event, droppedComments: comments.length };
      }
    }

    if (!attempt.ok) return { posted: false, error: attempt.detail.slice(0, 400) };

    this.emitNotice(
      `Posted a ${event.toLowerCase().replace(/_/g, " ")} review on PR #${prNumber}` +
        (comments.length ? ` (${comments.length} inline)` : ""),
      "info",
      opts.chatId,
    );
    return { posted: true, url: attempt.url, event };
  }

  /**
   * Submit an APPROVING review on a PR. Best-effort by design: GitHub refuses to
   * let an author approve their own pull request, and when Dispatch ships a
   * PR under the human's own token that's exactly the case — so a rejection here
   * is expected and NOT an error. Returns whether the approval actually landed,
   * so the caller can say which happened rather than claiming a review it didn't
   * get. The merge is the operation that matters; this is the paper trail.
   */
  async approve(
    repo: string,
    prNumber: number,
    body?: string,
    opts: OpCtx = {},
  ): Promise<{ approved: boolean; error?: string }> {
    const r = this.assertRepo(repo);
    const args = ["pr", "review", String(prNumber), "--repo", r, "--approve"];
    if (body?.trim()) args.push("--body", body.trim());
    const res = await this.exec("gh", args, { reject: false });
    if (res.exitCode !== 0) {
      const error = (res.stderr || res.stdout || "").trim() || `gh exited ${res.exitCode}`;
      return { approved: false, error };
    }
    this.emitNotice(`Approved PR #${prNumber}`, "info", opts.chatId);
    return { approved: true };
  }

  /** Re-run a single run's failed jobs (default) or the whole run. */
  async rerunRun(
    repo: string,
    runId: number,
    opts: { failedOnly?: boolean; chatId?: string } = {},
  ): Promise<void> {
    const r = this.assertRepo(repo);
    const args = ["run", "rerun", String(runId), "--repo", r];
    if (opts.failedOnly !== false) args.push("--failed");
    await this.gh(args);
    this.emitNotice(
      `Re-ran ${opts.failedOnly === false ? "" : "failed jobs of "}run ${runId}`,
      "info",
      opts.chatId,
    );
    const run = await this.getRun(repo, runId, { chatId: opts.chatId });
    if (run) this.emitRun(run, opts.chatId);
  }

  /** Re-run the failed workflow runs on a PR's head branch. Returns count. */
  async rerunFailedChecks(
    repo: string,
    prNumber: number,
    opts: { limit?: number; chatId?: string } = {},
  ): Promise<number> {
    const pr = await this.getPr(repo, prNumber);
    if (!pr) throw new Error(`rerunFailedChecks: PR #${prNumber} not found`);
    const runs = await this.listRuns(repo, undefined, {
      branch: pr.branch,
      limit: opts.limit ?? 20,
    });
    const failed = runs.filter(
      (x) =>
        x.conclusion === "failure" ||
        x.conclusion === "cancelled" ||
        x.conclusion === "timed_out",
    );
    for (const run of failed) {
      await this.gh(["run", "rerun", String(run.id), "--repo", this.assertRepo(repo), "--failed"]);
    }
    this.emitNotice(
      `Re-ran ${failed.length} failed run(s) on PR #${prNumber}`,
      "info",
      opts.chatId,
    );
    return failed.length;
  }

  /**
   * Resolve a review thread (global node id) via GraphQL mutation.
   *
   * A submitted REQUEST_CHANGES review keeps GitHub's PR-level red flag even
   * after every inline thread is resolved. When the thread belongs to
   * Dispatch's configured reviewer, closing its final open thread dismisses
   * that reviewer's remaining CHANGES_REQUESTED reviews as the human account.
   * The author check is load-bearing: resolving a human review comment must not
   * silently overrule that human's verdict.
   */
  async resolveThread(
    threadId: string,
    opts: OpCtx & { reviewAgentLogin?: string } = {},
  ): Promise<ResolveThreadOutcome> {
    if (!threadId || typeof threadId !== "string") {
      throw new Error("resolveThread: threadId required");
    }
    const mutation =
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{" +
      "id isResolved pullRequest{number repository{nameWithOwner}} " +
      "comments(first:1){nodes{author{login}}}}}}";
    const raw = await this.ghJson<{
      data?: {
        resolveReviewThread?: {
          thread?: {
            pullRequest?: { number?: number; repository?: { nameWithOwner?: string } };
            comments?: { nodes?: Array<{ author?: { login?: string } }> };
          };
        };
      };
      errors?: Array<{ message?: string }>;
    }>(["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${threadId}`]);
    this.emitNotice(`Resolved review thread`, "info", opts.chatId);

    const reviewer = opts.reviewAgentLogin?.trim().toLowerCase();
    if (!reviewer) return { dismissedReviews: 0 };
    if (raw?.errors?.length) {
      return {
        dismissedReviews: 0,
        dismissalError: raw.errors.map((e) => e.message ?? "GraphQL error").join("; "),
      };
    }
    const thread = raw?.data?.resolveReviewThread?.thread;
    const author = thread?.comments?.nodes?.[0]?.author?.login?.toLowerCase();
    const repo = thread?.pullRequest?.repository?.nameWithOwner;
    const prNumber = thread?.pullRequest?.number;
    if (author !== reviewer || !repo || typeof prNumber !== "number") {
      return { dismissedReviews: 0 };
    }

    try {
      const hasOpenInternalThread = await this.hasOpenReviewThread(repo, prNumber, reviewer);
      if (hasOpenInternalThread) return { dismissedReviews: 0 };

      const reviews = await this.changeRequestReviews(repo, prNumber, reviewer);
      let dismissedReviews = 0;
      for (const reviewId of reviews) {
        const dismiss =
          "mutation($id:ID!,$message:String!){dismissPullRequestReview(" +
          "input:{pullRequestReviewId:$id,message:$message}){pullRequestReview{id state}}}";
        await this.gh([
          "api", "graphql",
          "-f", `query=${dismiss}`,
          "-f", `id=${reviewId}`,
          "-f", "message=All Dispatch review threads were resolved.",
        ]);
        dismissedReviews += 1;
      }
      if (dismissedReviews) {
        this.emitNotice(
          `Cleared changes requested after Dispatch's final review thread was resolved`,
          "info",
          opts.chatId,
        );
      }
      return { dismissedReviews };
    } catch (err) {
      return {
        dismissedReviews: 0,
        dismissalError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** True when Dispatch's reviewer still owns any unresolved inline thread. */
  private async hasOpenReviewThread(
    repo: string,
    prNumber: number,
    reviewer: string,
  ): Promise<boolean> {
    const { owner, name } = this.splitRepo(repo);
    let after: string | undefined;
    do {
      const query =
        "query($owner:String!,$repo:String!,$number:Int!,$after:String){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "reviewThreads(first:100,after:$after){nodes{isResolved comments(first:1){" +
        "nodes{author{login}}}} pageInfo{hasNextPage endCursor}}}}}";
      const args = [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${name}`,
        "-F", `number=${prNumber}`,
      ];
      if (after) args.push("-f", `after=${after}`);
      const raw = await this.ghJson<{
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  isResolved?: boolean;
                  comments?: { nodes?: Array<{ author?: { login?: string } }> };
                }>;
                pageInfo?: { hasNextPage?: boolean; endCursor?: string };
              };
            };
          };
        };
        errors?: Array<{ message?: string }>;
      }>(args);
      if (raw?.errors?.length) {
        throw new Error(raw.errors[0]?.message ?? "Could not read review threads");
      }
      const connection = raw?.data?.repository?.pullRequest?.reviewThreads;
      if (
        connection?.nodes?.some(
          (thread) =>
            !thread.isResolved &&
            thread.comments?.nodes?.[0]?.author?.login?.toLowerCase() === reviewer,
        )
      ) {
        return true;
      }
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
    } while (after);
    return false;
  }

  /**
   * Active change requests whose blockers are all represented by threads.
   *
   * Reviews without the marker may carry a cross-file/body-only blocker. There
   * is no thread whose resolution can prove that finding was addressed, so the
   * resolve path must leave that verdict for a later review to supersede.
   */
  private async changeRequestReviews(
    repo: string,
    prNumber: number,
    reviewer: string,
  ): Promise<string[]> {
    const { owner, name } = this.splitRepo(repo);
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const query =
        "query($owner:String!,$repo:String!,$number:Int!,$after:String){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "reviews(first:100,after:$after){nodes{id state body author{login}} " +
        "pageInfo{hasNextPage endCursor}}}}}";
      const args = [
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${name}`,
        "-F", `number=${prNumber}`,
      ];
      if (after) args.push("-f", `after=${after}`);
      const raw = await this.ghJson<{
        data?: {
          repository?: {
            pullRequest?: {
              reviews?: {
                nodes?: Array<{
                  id?: string;
                  state?: string;
                  body?: string;
                  author?: { login?: string };
                }>;
                pageInfo?: { hasNextPage?: boolean; endCursor?: string };
              };
            };
          };
        };
        errors?: Array<{ message?: string }>;
      }>(args);
      if (raw?.errors?.length) {
        throw new Error(raw.errors[0]?.message ?? "Could not read reviews");
      }
      const connection = raw?.data?.repository?.pullRequest?.reviews;
      for (const review of connection?.nodes ?? []) {
        if (
          review.id &&
          review.state === "CHANGES_REQUESTED" &&
          review.body?.includes(THREADED_CHANGE_REQUEST_MARKER) &&
          review.author?.login?.toLowerCase() === reviewer
        ) {
          ids.push(review.id);
        }
      }
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
    } while (after);
    return ids;
  }

  /**
   * Reply IN a review thread (not as a new top-level PR comment) via GraphQL.
   *
   * Exists because "answer the reviewer" and "answer the reviewer where they
   * asked" are different things, and only the second one closes the loop:
   * `addComment` posts to the PR conversation, leaving the inline thread looking
   * untouched to both the reviewer and to `reviewThreads`. Paired with
   * {@link resolveThread} by the `resolve_thread` tool, which is how an agent
   * says what it did and marks it handled in one step.
   */
  async replyToThread(threadId: string, body: string, opts: OpCtx = {}): Promise<void> {
    if (!threadId || typeof threadId !== "string") {
      throw new Error("replyToThread: threadId required");
    }
    const mutation =
      "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(" +
      "input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";
    await this.gh([
      "api", "graphql",
      "-f", `query=${mutation}`,
      "-f", `id=${threadId}`,
      "-f", `body=${body}`,
    ]);
    this.emitNotice(`Replied to a review thread`, "info", opts.chatId);
  }

  /** Post a comment on a PR. */
  async addComment(
    repo: string,
    prNumber: number,
    body: string,
    opts: OpCtx = {},
  ): Promise<void> {
    await this.gh([
      "pr", "comment", String(prNumber), "--repo", this.assertRepo(repo), "--body", body,
    ]);
    this.emitNotice(`Commented on PR #${prNumber}`, "info", opts.chatId);
  }

  /** Merge a PR (default squash + delete branch). Emits the merged PR. */
  async merge(
    repo: string,
    prNumber: number,
    method: MergeMethod = "squash",
    opts: { deleteBranch?: boolean; chatId?: string } = {},
  ): Promise<PRInfo | null> {
    const r = this.assertRepo(repo);
    const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
    const args = ["pr", "merge", String(prNumber), "--repo", r, flag];
    if (opts.deleteBranch !== false) args.push("--delete-branch");
    await this.gh(args);
    this.emitNotice(`Merged PR #${prNumber} (${method})`, "info", opts.chatId);
    this.notePrMerged(opts.chatId);
    return this.refreshPr(repo, prNumber, { chatId: opts.chatId });
  }

  /**
   * Announce that a PR has landed. Called both when WE merge it and when
   * `watch_pr` observes someone else's merge (the auto-merge job, a human) — the
   * container hooks this up to the trunk sync, so the primary checkout follows
   * the trunk regardless of who clicked merge.
   */
  notePrMerged(chatId?: string): void {
    this.onMerged?.({ chatId });
  }

  /** Set by the container; fires whenever a PR is known to have merged. */
  onMerged?: (evt: { chatId?: string }) => void;

  /** Add or remove a label. Emits the refreshed PR. */
  async setLabel(
    repo: string,
    prNumber: number,
    label: string,
    on: boolean = true,
    opts: OpCtx = {},
  ): Promise<PRInfo | null> {
    const r = this.assertRepo(repo);
    const args = ["pr", "edit", String(prNumber), "--repo", r];
    args.push(on ? "--add-label" : "--remove-label", label);
    await this.gh(args);
    this.emitNotice(
      `${on ? "Added" : "Removed"} label "${label}" ${on ? "on" : "from"} PR #${prNumber}`,
      "info",
      opts.chatId,
    );
    return this.refreshPr(repo, prNumber, { chatId: opts.chatId });
  }

  /** Hold / un-hold a PR (the `hold` label the auto-merge gate honours). */
  hold(repo: string, prNumber: number, on: boolean = true, opts: OpCtx = {}): Promise<PRInfo | null> {
    return this.setLabel(repo, prNumber, "hold", on, opts);
  }

  /** Fetch a PR by number, enrich with checks + threads, and emit pr-update. */
  async refreshPr(repo: string, prNumber: number, opts: OpCtx = {}): Promise<PRInfo | null> {
    const pr = await this.getPr(repo, prNumber);
    if (!pr) return null;
    return this.enrich(repo, pr, opts.chatId);
  }

  /* -------------------------------------------------------------- ACTIONS */

  /** List a repo's GitHub Actions workflows. */
  async listWorkflows(repo: string): Promise<WorkflowDef[]> {
    const raw =
      (await this.ghJson<RawWorkflow[]>([
        "workflow", "list", "--repo", this.assertRepo(repo), "--json", "id,name,path,state",
      ])) ?? [];
    return raw.map((w) =>
      WorkflowDefSchema.parse({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state ?? undefined,
      }),
    );
  }

  /**
   * Every workflow paired with its LATEST run (status/conclusion/branch/time/url)
   * — the default Actions view (replaces a flat chronological run history). One
   * `run list --limit 1` per workflow; a workflow that has never run → lastRun
   * null. Pure read (no bus emit).
   */
  async workflowsWithLastRun(repo: string): Promise<WorkflowWithLastRun[]> {
    const r = this.assertRepo(repo);
    const workflows = await this.listWorkflows(r);
    const out: WorkflowWithLastRun[] = [];
    for (const workflow of workflows) {
      // `gh run list --workflow` takes the file basename (or id); path is the
      // repo-relative ".github/workflows/<file>".
      const file = workflow.path.split("/").pop() || String(workflow.id);
      let lastRun: WorkflowRun | null = null;
      try {
        const runs = await this.listRuns(r, file, { limit: 1 });
        lastRun = runs[0] ?? null;
      } catch {
        lastRun = null;
      }
      out.push(WorkflowWithLastRunSchema.parse({ workflow, lastRun }));
    }
    return out;
  }

  /**
   * The `workflow_dispatch` input schema for a workflow (name/type/required/
   * default/options) so the client can render a real Run form. Reads the YAML via
   * `gh workflow view <file> --yaml` and parses it. Best-effort: returns [] when
   * the workflow has no dispatch inputs or the fetch/parse fails.
   */
  async workflowInputs(repo: string, workflowFile: string): Promise<WorkflowInput[]> {
    const r = this.assertRepo(repo);
    // Reject a leading `-` so the value can't be reinterpreted by gh as a flag.
    if (!workflowFile || workflowFile.startsWith("-")) {
      throw new Error(`workflowInputs: invalid workflow "${workflowFile}"`);
    }
    const yamlText = await this.gh(
      ["workflow", "view", workflowFile, "--repo", r, "--yaml"],
      { allowFail: true },
    );
    if (!yamlText) return [];
    return parseWorkflowInputs(yamlText);
  }

  /** Dispatch a workflow (`gh workflow run`) with `-f key=value` inputs. */
  async dispatch(
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string> = {},
    opts: OpCtx = {},
  ): Promise<void> {
    const r = this.assertRepo(repo);
    // `workflow` is the first positional; reject a leading `-` so a value like
    // `--help` / `-R other/repo` can't be reinterpreted by gh as a flag.
    if (workflow.startsWith("-")) {
      throw new Error(`dispatch: invalid workflow "${workflow}"`);
    }
    const args = ["workflow", "run", workflow, "--repo", r, "--ref", ref];
    for (const [k, v] of Object.entries(inputs)) args.push("-f", `${k}=${v}`);
    await this.gh(args);
    this.emitNotice(`Dispatched workflow "${workflow}" on ${ref}`, "info", opts.chatId);
  }

  /** List workflow runs (optionally filtered by workflow file/name or branch). */
  async listRuns(
    repo: string,
    workflow?: string,
    opts: { branch?: string; limit?: number } = {},
  ): Promise<WorkflowRun[]> {
    const r = this.assertRepo(repo);
    const args = ["run", "list", "--repo", r, "--json", RUN_JSON_FIELDS, "--limit", String(opts.limit ?? 20)];
    if (workflow) args.push("--workflow", workflow);
    if (opts.branch) args.push("--branch", opts.branch);
    const raw = (await this.ghJson<RawRun[]>(args)) ?? [];
    return raw.map((x) => this.mapRun(x));
  }

  /** View one run by id. Emits workflow-update. */
  async getRun(repo: string, runId: number, opts: OpCtx = {}): Promise<WorkflowRun | null> {
    const raw = await this.ghJson<RawRun>(
      ["run", "view", String(runId), "--repo", this.assertRepo(repo), "--json", RUN_JSON_FIELDS],
      { allowFail: true },
    );
    if (!raw) return null;
    const run = this.mapRun(raw);
    this.emitRun(run, opts.chatId);
    return run;
  }

  /* --------------------------------------------------------------- internals */

  /** Enrich a PR with CI checks + review threads (best-effort), emit, return. */
  private async enrich(repo: string, pr: PRInfo, chatId?: string): Promise<PRInfo> {
    try {
      pr.checks = await this.prChecks(repo, pr.number);
    } catch {
      /* keep default [] */
    }
    try {
      pr.reviewThreads = await this.reviewThreads(repo, pr.number);
    } catch {
      /* threads optional */
    }
    this.emitPr(pr, chatId);
    return pr;
  }

  /** Run a whitespace-split shell-style command line via execa (argv array, no shell). */
  private async runCommand(cmdline: string, cwd: string): Promise<void> {
    const parts = cmdline.trim().split(/\s+/);
    const [cmd, ...args] = parts;
    if (!cmd) throw new Error("runCommand: empty command");
    const res = await this.exec(cmd, args, { cwd, reject: false });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || "").trim().slice(0, 500);
      throw new Error(`command \`${cmdline}\` failed (exit ${res.exitCode}): ${detail}`);
    }
  }

  private mapPr(p: RawPr): PRInfo {
    return PRInfoSchema.parse({
      number: p.number,
      url: p.url,
      title: p.title ?? "",
      state: String(p.state ?? "OPEN").toLowerCase(),
      branch: p.headRefName ?? "",
      baseBranch: p.baseRefName ?? "main",
      isDraft: !!p.isDraft,
      author: p.author?.login ?? undefined,
      body: p.body ?? undefined,
      mergeable: mapMergeable(p.mergeable),
      mergeStateStatus: p.mergeStateStatus ?? undefined,
      // Only set when the caller requested `reviewDecision` (list/detail) — a
      // bare `pr view` omits it, so leave it absent rather than forcing null.
      reviewDecision: p.reviewDecision !== undefined ? mapReviewDecision(p.reviewDecision) : undefined,
      labels: (p.labels ?? []).map((l) => l.name),
      // `statusCheckRollup` (requested by list/detail) folds inline into checks;
      // the plain PR fetch omits it and enriches via `prChecks` instead.
      checks: p.statusCheckRollup ? p.statusCheckRollup.map(mapRollupEntry) : [],
      commentCount: p.comments !== undefined ? p.comments.length : undefined,
      additions: p.additions ?? undefined,
      deletions: p.deletions ?? undefined,
      updatedAt: p.updatedAt ?? undefined,
      createdAt: p.createdAt ?? undefined,
    });
  }

  private mapRun(x: RawRun): WorkflowRun {
    return WorkflowRunSchema.parse({
      id: x.databaseId,
      name: x.name || x.workflowName || String(x.databaseId),
      workflowName: x.workflowName ?? undefined,
      status: normalizeRunStatus(x.status),
      conclusion: x.conclusion ? String(x.conclusion).toLowerCase() : null,
      event: x.event ?? undefined,
      headBranch: x.headBranch ?? undefined,
      url: x.url ?? undefined,
      createdAt: x.createdAt ?? undefined,
      updatedAt: x.updatedAt ?? undefined,
    });
  }

  /* ----------------------------------------------------------------- events */

  private emitPr(pr: PRInfo, chatId?: string): void {
    this.bus.publish({ type: "pr-update", chatId, pr });
  }
  private emitRun(run: WorkflowRun, chatId?: string): void {
    this.bus.publish({ type: "workflow-update", chatId, run });
  }
  private emitNotice(text: string, level: "info" | "warn" | "error", chatId?: string): void {
    this.bus.publish({ type: "notice", chatId, level, text });
  }
}

/** Convenience factory (matches the DI shape used elsewhere). */
export function createGitHubService(deps: GitHubServiceDeps): GitHubService {
  return new GitHubService(deps);
}
