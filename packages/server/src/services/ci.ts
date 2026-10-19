/**
 * CiService — the read/act layer behind the project-level CI/CD page.
 *
 * GitHub Actions is the only backend, reached through `gh api` (the REST API,
 * with the user's own `gh` auth) rather than `gh run list --json`. The CLI's
 * JSON fields can't express what the page needs — run number and attempt, the
 * actor, the head sha, linked PRs, a total for pagination, jobs with their
 * steps, artifacts — and the REST endpoints carry all of it.
 *
 * Every method is ONE concern and one-or-two API calls, never a fan-out over
 * workflows. That is what lets the page load in pieces: the workflow rail, the
 * run list, a run's jobs and its artifacts are separate requests, so a slow or
 * failing one costs its own section and nothing else. `workflowsWithLastRun`
 * on GitHubService is the counter-example — one `gh run list` per workflow,
 * sequentially, which is fine for the side panel's handful but would put the
 * whole page behind the slowest of ten round-trips.
 */
import type {
  CiArtifact,
  CiDispatchInfo,
  CiJob,
  CiJobLog,
  CiRun,
  CiRunFilter,
  CiRunPage,
  CiStatus,
  CiSummary,
  CiWorkflow,
  Project,
} from "@dispatch/shared";
import { execBinary } from "./exec-binary.js";
import { parseWorkflowDispatch, type ExecaLike } from "./github.js";

const defaultExec: ExecaLike = (file, args = [], options) =>
  execBinary(file, args as string[], {
    cwd: options?.cwd,
    reject: options?.reject,
    env: options?.env,
  }) as unknown as ReturnType<ExecaLike>;

/**
 * How long a project's `owner/name` is trusted. Resolving it is a `gh repo view`
 * — a network round-trip — and the page fires four or five requests at once on
 * open, then polls. Uncached, every one of those paid it again before doing the
 * thing it was asked.
 */
const REPO_TTL_MS = 5 * 60_000;

/**
 * Logs are returned whole by the API and can run to tens of MB for a chatty
 * test job. Keep the TAIL — a failure is almost always at the end, and a
 * browser asked to lay out 40MB of `<pre>` stops being a browser.
 */
export const LOG_CAP_BYTES = 2 * 1024 * 1024;

/** A request the provider refused as "not found" — mapped to a 404, not a 502. */
export class CiNotFoundError extends Error {}

/** The project has no repository the provider knows about (no GitHub remote). */
export class CiUnavailableError extends Error {}

export interface CiServiceDeps {
  /** owner/name for a project's checkout. */
  resolveRepo: (project: Project) => Promise<string>;
  exec?: ExecaLike;
  now?: () => number;
}

/* ------------------------------------------------------------- raw shapes */

interface RawRun {
  id: number;
  run_number: number;
  run_attempt?: number;
  workflow_id: number;
  name?: string | null;
  display_title?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  actor?: { login?: string } | null;
  triggering_actor?: { login?: string } | null;
  pull_requests?: { number: number }[] | null;
  html_url?: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
}

interface RawWorkflow {
  id: number;
  name: string;
  path: string;
  state?: string | null;
  html_url?: string | null;
}

interface RawStep {
  number: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface RawJob {
  id: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  runner_name?: string | null;
  labels?: string[] | null;
  steps?: RawStep[] | null;
}

interface RawArtifact {
  id: number;
  name: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string | null;
  expires_at?: string | null;
}

/* ---------------------------------------------------------------- mapping */

const STATUSES = new Set<CiStatus>([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);

const CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
]);

/** Unknown statuses read as `pending` — still going, rather than falsely done. */
function status(s: string | null | undefined): CiStatus {
  const v = String(s ?? "").toLowerCase() as CiStatus;
  return STATUSES.has(v) ? v : "pending";
}

function conclusion(c: string | null | undefined): CiRun["conclusion"] {
  const v = String(c ?? "").toLowerCase();
  return CONCLUSIONS.has(v) ? (v as NonNullable<CiRun["conclusion"]>) : null;
}

export function mapRun(r: RawRun): CiRun {
  return {
    id: r.id,
    number: r.run_number,
    attempt: r.run_attempt ?? 1,
    workflowId: r.workflow_id,
    workflowName: r.name ?? "",
    title: r.display_title ?? r.name ?? "",
    status: status(r.status),
    conclusion: conclusion(r.conclusion),
    event: r.event ?? "",
    branch: r.head_branch ?? null,
    sha: r.head_sha ?? "",
    actor: r.triggering_actor?.login ?? r.actor?.login ?? null,
    prNumbers: (r.pull_requests ?? []).map((p) => p.number),
    url: r.html_url ?? "",
    createdAt: r.created_at,
    startedAt: r.run_started_at ?? null,
    updatedAt: r.updated_at,
  };
}

export function mapJob(j: RawJob): CiJob {
  return {
    id: j.id,
    name: j.name,
    status: status(j.status),
    conclusion: conclusion(j.conclusion),
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
    url: j.html_url ?? null,
    runnerName: j.runner_name ?? null,
    labels: j.labels ?? [],
    steps: (j.steps ?? []).map((s) => ({
      number: s.number,
      name: s.name,
      status: status(s.status),
      conclusion: conclusion(s.conclusion),
      startedAt: s.started_at ?? null,
      completedAt: s.completed_at ?? null,
    })),
  };
}

/** Positive integer id, or throw — every id here is interpolated into a URL path. */
function id(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${what} id "${n}"`);
  return n;
}

/* ---------------------------------------------------------------- service */

export class CiService {
  private readonly exec: ExecaLike;
  private readonly resolveRepo: (project: Project) => Promise<string>;
  private readonly now: () => number;
  private readonly repos = new Map<string, { key: string; repo: string; at: number }>();

  constructor(deps: CiServiceDeps) {
    this.exec = deps.exec ?? defaultExec;
    this.resolveRepo = deps.resolveRepo;
    this.now = deps.now ?? Date.now;
  }

  /** `owner/name` for a project, cached. A failure is never cached. */
  async repo(project: Project): Promise<string> {
    const key = project.repoPath;
    const hit = this.repos.get(project.id);
    if (hit && hit.key === key && this.now() - hit.at < REPO_TTL_MS) return hit.repo;
    let repo: string;
    try {
      repo = await this.resolveRepo(project);
    } catch (err) {
      throw new CiUnavailableError(
        `No GitHub repository for this project (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      );
    }
    this.repos.set(project.id, { key, repo, at: this.now() });
    return repo;
  }

  async summary(project: Project): Promise<CiSummary> {
    const repo = await this.repo(project);
    return { provider: "github-actions", repo, url: `https://github.com/${repo}/actions` };
  }

  /**
   * Every workflow, with its latest run where one is in the newest 100.
   *
   * The two reads are independent and run together; if the run read fails the
   * workflows still come back, with `lastRun` left absent — "unknown" — rather
   * than the whole rail failing over a status dot.
   */
  async workflows(project: Project): Promise<CiWorkflow[]> {
    const repo = await this.repo(project);
    const [wfRes, runRes] = await Promise.allSettled([
      this.api<{ workflows: RawWorkflow[] }>(`repos/${repo}/actions/workflows?per_page=100`),
      this.api<{ workflow_runs: RawRun[] }>(`repos/${repo}/actions/runs?per_page=100`),
    ]);
    if (wfRes.status === "rejected") throw wfRes.reason;
    const latest = new Map<number, CiRun>();
    if (runRes.status === "fulfilled") {
      // Newest first from the API, so the first run seen per workflow wins.
      for (const raw of runRes.value.workflow_runs ?? []) {
        if (!latest.has(raw.workflow_id)) latest.set(raw.workflow_id, mapRun(raw));
      }
    }
    const known = runRes.status === "fulfilled";
    return (wfRes.value.workflows ?? []).map((w) => {
      const managed = !w.path.startsWith(".github/");
      return {
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state ?? "active",
        managed,
        url: managed ? null : (w.html_url ?? null),
        ...(known ? { lastRun: latest.get(w.id) ?? null } : {}),
      };
    });
  }

  async runs(project: Project, filter: CiRunFilter = {}): Promise<CiRunPage> {
    const repo = await this.repo(project);
    const perPage = Math.min(Math.max(filter.perPage ?? 25, 1), 100);
    const page = Math.max(filter.page ?? 1, 1);
    const q = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (filter.branch) q.set("branch", filter.branch);
    if (filter.event) q.set("event", filter.event);
    if (filter.status) q.set("status", filter.status);
    const base =
      filter.workflowId !== undefined
        ? `repos/${repo}/actions/workflows/${id(filter.workflowId, "workflow")}/runs`
        : `repos/${repo}/actions/runs`;
    const raw = await this.api<{ total_count: number; workflow_runs: RawRun[] }>(
      `${base}?${q.toString()}`,
    );
    return {
      runs: (raw.workflow_runs ?? []).map(mapRun),
      totalCount: raw.total_count ?? 0,
      page,
      perPage,
    };
  }

  async run(project: Project, runId: number): Promise<CiRun> {
    const repo = await this.repo(project);
    return mapRun(await this.api<RawRun>(`repos/${repo}/actions/runs/${id(runId, "run")}`));
  }

  /** The jobs of the run's LATEST attempt, with their steps. */
  async jobs(project: Project, runId: number): Promise<CiJob[]> {
    const repo = await this.repo(project);
    const raw = await this.api<{ jobs: RawJob[] }>(
      `repos/${repo}/actions/runs/${id(runId, "run")}/jobs?filter=latest&per_page=100`,
    );
    return (raw.jobs ?? []).map(mapJob);
  }

  async artifacts(project: Project, runId: number): Promise<CiArtifact[]> {
    const repo = await this.repo(project);
    const raw = await this.api<{ artifacts: RawArtifact[] }>(
      `repos/${repo}/actions/runs/${id(runId, "run")}/artifacts?per_page=100`,
    );
    return (raw.artifacts ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      sizeBytes: a.size_in_bytes ?? 0,
      expired: !!a.expired,
      createdAt: a.created_at ?? null,
      expiresAt: a.expires_at ?? null,
    }));
  }

  /**
   * One job's log, tail-capped. A job that hasn't finished has no log yet —
   * the API 404s — which is reported as `available: false`, not an error, so
   * the page can say "waiting for the job to finish" instead of painting red.
   */
  async jobLog(project: Project, jobId: number): Promise<CiJobLog> {
    const repo = await this.repo(project);
    let text: string;
    try {
      text = await this.ghRaw(["api", `repos/${repo}/actions/jobs/${id(jobId, "job")}/logs`]);
    } catch (err) {
      if (err instanceof CiNotFoundError) return { available: false, text: "", truncated: false };
      throw err;
    }
    // A BOM rides on the first line of every Actions log.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const truncated = text.length > LOG_CAP_BYTES;
    if (truncated) {
      text = text.slice(text.length - LOG_CAP_BYTES);
      // Start on a whole line rather than mid-timestamp.
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return { available: true, text, truncated };
  }

  /** Whether a workflow can be run by hand, and its inputs. */
  async dispatchInfo(project: Project, workflowId: number): Promise<CiDispatchInfo> {
    const repo = await this.repo(project);
    const wf = await this.api<RawWorkflow>(
      `repos/${repo}/actions/workflows/${id(workflowId, "workflow")}`,
    );
    // Provider-managed workflows (Copilot, Dependabot, default CodeQL) have no
    // file to read and can never be dispatched.
    if (!wf.path.startsWith(".github/")) return { dispatchable: false, inputs: [] };
    let yaml: string;
    try {
      yaml = await this.ghRaw([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repo}/contents/${wf.path.split("/").map(encodeURIComponent).join("/")}`,
      ]);
    } catch (err) {
      if (err instanceof CiNotFoundError) return { dispatchable: false, inputs: [] };
      throw err;
    }
    return parseWorkflowDispatch(yaml);
  }

  /* ----------------------------------------------------------------- acts */

  async dispatch(
    project: Project,
    workflowId: number,
    ref: string,
    inputs: Record<string, string> = {},
  ): Promise<void> {
    const repo = await this.repo(project);
    if (!ref.trim()) throw new Error("dispatch: a ref is required");
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${repo}/actions/workflows/${id(workflowId, "workflow")}/dispatches`,
      // `-f` (raw string), never `-F`: workflow_dispatch inputs are strings on
      // the wire, and `-F` would turn a "true" or "42" into JSON types.
      "-f",
      `ref=${ref.trim()}`,
    ];
    for (const [k, v] of Object.entries(inputs)) {
      if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new Error(`dispatch: invalid input name "${k}"`);
      args.push("-f", `inputs[${k}]=${v}`);
    }
    await this.ghRaw(args);
  }

  /** Re-run a whole run, or only its failed jobs (and what they depend on). */
  async rerun(project: Project, runId: number, opts: { failedOnly?: boolean } = {}): Promise<void> {
    const repo = await this.repo(project);
    const suffix = opts.failedOnly ? "rerun-failed-jobs" : "rerun";
    await this.ghRaw(["api", "-X", "POST", `repos/${repo}/actions/runs/${id(runId, "run")}/${suffix}`]);
  }

  async rerunJob(project: Project, jobId: number): Promise<void> {
    const repo = await this.repo(project);
    await this.ghRaw(["api", "-X", "POST", `repos/${repo}/actions/jobs/${id(jobId, "job")}/rerun`]);
  }

  async cancel(project: Project, runId: number): Promise<void> {
    const repo = await this.repo(project);
    await this.ghRaw(["api", "-X", "POST", `repos/${repo}/actions/runs/${id(runId, "run")}/cancel`]);
  }

  /* ------------------------------------------------------------- internals */

  private async api<T>(path: string): Promise<T> {
    const out = await this.ghRaw(["api", path]);
    try {
      return JSON.parse(out) as T;
    } catch (e) {
      throw new Error(`gh api ${path}: invalid JSON (${String(e)})`);
    }
  }

  private async ghRaw(args: string[]): Promise<string> {
    const res = await this.exec("gh", args, { reject: false });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      if (/HTTP 404|Not Found/i.test(detail)) throw new CiNotFoundError(detail.split("\n")[0]);
      // gh prints the API's own message ("Cannot cancel a workflow run that is
      // completed.") — that, not the argv, is what the human needs to read.
      const msg = /^gh: (.*)$/m.exec(detail)?.[1] ?? detail.split("\n")[0];
      throw new Error(msg || `gh ${args[0]} failed (exit ${res.exitCode})`);
    }
    return res.stdout ?? "";
  }
}
