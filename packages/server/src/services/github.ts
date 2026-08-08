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
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import type {
  Project,
  PRInfo,
  PRRef,
  CheckRun,
  ReviewThread,
  ReviewDecision,
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

/** The reviewer login ship requests (matches ship.mjs / auto-merge.mjs). */
export const COPILOT_LOGIN = "copilot-pull-request-reviewer[bot]";

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

/** A PR's review state: who was asked, and who has actually reported. */
export interface PrReviewState {
  /** Reviewers with an OUTSTANDING request (they haven't reported yet). */
  requested: string[];
  /** Reviews that have been submitted, newest-per-author. */
  reported: Array<{ author: string; state: string }>;
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
  comments?: { nodes?: Array<{ author?: { login?: string } | null; body?: string }> };
}
interface RawGraphqlThreads {
  data?: {
    repository?: {
      pullRequest?: { reviewThreads?: { nodes?: RawThreadNode[] } } | null;
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
    status: mapCheckStatus(e.status),
    conclusion: mapConclusionString(e.conclusion),
    url: e.detailsUrl || undefined,
  });
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
    const commonDir = async (dir: string): Promise<string | null> => {
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
    };
    const [x, y] = await Promise.all([commonDir(a), commonDir(b)]);
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
   * not "ready to land" — it's "not started". Best-effort; a failed read yields
   * empty lists, and the caller decides what that means.
   */
  async prReviewState(repo: string, prNumber: number): Promise<PrReviewState> {
    const raw = await this.ghJson<{
      reviewRequests?: Array<{ login?: string; name?: string; slug?: string } | string>;
      latestReviews?: Array<{ author?: { login?: string } | null; state?: string }>;
    }>(
      [
        "pr", "view", String(prNumber), "--repo", this.assertRepo(repo),
        "--json", "reviewRequests,latestReviews",
      ],
      { allowFail: true },
    );
    const requested = (raw?.reviewRequests ?? [])
      .map((x) => (typeof x === "string" ? x : (x.login ?? x.slug ?? x.name ?? "")))
      .filter(Boolean);
    const reported = (raw?.latestReviews ?? [])
      .map((x) => ({ author: x.author?.login ?? "", state: String(x.state ?? "").toUpperCase() }))
      .filter((x) => x.author);
    return { requested, reported };
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

  /** Resolve a review thread (global node id) via GraphQL mutation. */
  async resolveThread(threadId: string, opts: OpCtx = {}): Promise<void> {
    if (!threadId || typeof threadId !== "string") {
      throw new Error("resolveThread: threadId required");
    }
    const mutation =
      "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
    await this.gh(["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${threadId}`]);
    this.emitNotice(`Resolved review thread`, "info", opts.chatId);
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
