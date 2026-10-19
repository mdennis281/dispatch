/**
 * CI/CD domain types — the wire shapes behind the project-level CI/CD page
 * (`/api/projects/:projectId/ci/*`).
 *
 * Provider-neutral on purpose: the page talks about workflows, runs, jobs and
 * artifacts, not "GitHub Actions". GitHub Actions is the only backend today, and
 * `provider` says so on every summary, so a second backend slots in behind the
 * same routes without the client learning a new vocabulary.
 *
 * These are deliberately separate from `WorkflowRunSchema` in ./domain.ts. That
 * one is what `gh run list --json` can express and what the right panel's
 * live `workflow-update` events carry; the page needs more than `gh run list`
 * offers (run number, attempt, actor, head sha, PR links, pagination totals),
 * so it reads the REST API directly and has its own shapes.
 */
import * as z from "zod";

export const CiProviderSchema = z.enum(["github-actions"]);
export type CiProvider = z.infer<typeof CiProviderSchema>;

export const CiStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);
export type CiStatus = z.infer<typeof CiStatusSchema>;

export const CiConclusionSchema = z.enum([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
]);
export type CiConclusion = z.infer<typeof CiConclusionSchema>;

/** Which CI system backs a project, and where it lives. */
export const CiSummarySchema = z.object({
  provider: CiProviderSchema,
  /** `owner/name`. */
  repo: z.string(),
  /** The provider's own page for this project's CI. */
  url: z.string(),
});
export type CiSummary = z.infer<typeof CiSummarySchema>;

export const CiRunSchema = z.object({
  id: z.number().int(),
  /** Per-workflow sequence number (`#1124`). */
  number: z.number().int(),
  attempt: z.number().int(),
  workflowId: z.number().int(),
  /** The workflow's name. */
  workflowName: z.string(),
  /** What the run is ABOUT — the PR title or commit subject. */
  title: z.string(),
  status: CiStatusSchema,
  conclusion: CiConclusionSchema.nullable(),
  event: z.string(),
  branch: z.string().nullable(),
  sha: z.string(),
  actor: z.string().nullable(),
  prNumbers: z.array(z.number().int()),
  url: z.string(),
  createdAt: z.string(),
  /** When the CURRENT attempt started — a re-run resets it. */
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type CiRun = z.infer<typeof CiRunSchema>;

export const CiWorkflowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Repo-relative file, or a `dynamic/...` path for provider-managed ones. */
  path: z.string(),
  /** e.g. `active`, `disabled_manually`. */
  state: z.string(),
  /** Provider-managed (Copilot, Dependabot, default CodeQL) — no file to dispatch. */
  managed: z.boolean(),
  url: z.string().nullable(),
  /**
   * Latest run, when it is inside the recent-runs window the server looked at.
   * `null` = the window was read and this workflow has no run in it; absent =
   * the window couldn't be read at all. The client must not render absent as
   * "never run" — it is "don't know".
   */
  lastRun: CiRunSchema.nullable().optional(),
});
export type CiWorkflow = z.infer<typeof CiWorkflowSchema>;

export const CiRunPageSchema = z.object({
  runs: z.array(CiRunSchema),
  totalCount: z.number().int(),
  page: z.number().int(),
  perPage: z.number().int(),
});
export type CiRunPage = z.infer<typeof CiRunPageSchema>;

export const CiStepSchema = z.object({
  number: z.number().int(),
  name: z.string(),
  status: CiStatusSchema,
  conclusion: CiConclusionSchema.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type CiStep = z.infer<typeof CiStepSchema>;

export const CiJobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: CiStatusSchema,
  conclusion: CiConclusionSchema.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  url: z.string().nullable(),
  runnerName: z.string().nullable(),
  labels: z.array(z.string()),
  steps: z.array(CiStepSchema),
});
export type CiJob = z.infer<typeof CiJobSchema>;

export const CiArtifactSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  sizeBytes: z.number(),
  expired: z.boolean(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type CiArtifact = z.infer<typeof CiArtifactSchema>;

/**
 * One job's log. `available: false` while a job is still running (the provider
 * only serves a log once the job finishes) — a state, not an error.
 */
export const CiJobLogSchema = z.object({
  available: z.boolean(),
  text: z.string(),
  /** The head was dropped to stay under the size cap; `text` is the TAIL. */
  truncated: z.boolean(),
});
export type CiJobLog = z.infer<typeof CiJobLogSchema>;

/** A workflow's manual-trigger form: whether it can be run by hand, and its inputs. */
export const CiDispatchInfoSchema = z.object({
  dispatchable: z.boolean(),
  inputs: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      type: z.enum(["string", "boolean", "choice", "number", "environment"]).optional(),
      required: z.boolean().optional(),
      default: z.string().optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
});
export type CiDispatchInfo = z.infer<typeof CiDispatchInfoSchema>;

/** Run-history filter. `status` takes a status OR a conclusion, as the API does. */
export const CiRunFilterSchema = z.object({
  workflowId: z.number().int().optional(),
  branch: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});
export type CiRunFilter = z.infer<typeof CiRunFilterSchema>;

/** Is a run/job/step still going? Every non-`completed` status counts. */
export function ciIsActive(x: { status: CiStatus }): boolean {
  return x.status !== "completed";
}

/** Did it end badly enough to be worth a red mark and a "re-run failed"? */
export function ciIsFailed(x: { status: CiStatus; conclusion: CiConclusion | null }): boolean {
  return x.status === "completed" && (x.conclusion === "failure" || x.conclusion === "timed_out");
}
