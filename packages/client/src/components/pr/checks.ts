/**
 * What a pull request's check runs ADD UP TO — the one definition, for every
 * surface that shows CI without showing the job list.
 *
 * It was four: the PRs panel's rollup line, the Workspace roster's chip, the
 * transcript's job rows and (as this was written) the homepage. Each spelled
 * "this check is a failure" as its own four-way `||`, which is the shape that
 * drifts — `action_required` was in three of them and the fourth read a
 * cancelled job as green. A PR that is failing in one list and passing in
 * another is worse than either answer, so the predicate lives here.
 *
 * The PRESENTATION deliberately does not: the Workspace chip counts
 * ("3 failed"), the panel states a verdict ("failing"), and a row with 90px of
 * width can afford neither. Only the arithmetic is shared.
 */
import type { CheckRun } from "@dispatch/shared";

/**
 * A COMPLETED check that needs attention.
 *
 * `status === "completed"` is load-bearing: GitHub reports a queued job with a
 * null conclusion, and a predicate that only looked at the conclusion would
 * read "hasn't started" as "didn't fail" — true, but it is the running count
 * that should own that job, not the passing one.
 *
 * `cancelled` and `action_required` count as failing because both mean the
 * change cannot land as it stands, which is the only thing a one-word verdict
 * is for. `skipped` and `neutral` do not — they are checks that chose not to
 * have an opinion.
 */
export function checkIsFailing(c: CheckRun): boolean {
  return (
    c.status === "completed" &&
    (c.conclusion === "failure" ||
      c.conclusion === "timed_out" ||
      c.conclusion === "cancelled" ||
      c.conclusion === "action_required")
  );
}

export interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  neutral: number;
  total: number;
}

/** Fold a check list into pass/fail/pending/neutral counts. */
export function summarizeChecks(checks: readonly CheckRun[]): CheckSummary {
  const s: CheckSummary = { passed: 0, failed: 0, pending: 0, neutral: 0, total: checks.length };
  for (const c of checks) {
    if (c.status !== "completed") s.pending++;
    else if (c.conclusion === "success") s.passed++;
    else if (checkIsFailing(c)) s.failed++;
    else s.neutral++; // skipped / neutral / stale / null
  }
  return s;
}

/**
 * The one-word rollup verdict + tone.
 *
 * `total === 0` is "no checks", NOT green: a PR opened a minute ago has no runs
 * yet, and a tick there is a claim about CI that has not started. Failing wins
 * over running, because a job still going beside a failed one does not change
 * what the author has to do next.
 */
export function checksVerdict(s: CheckSummary): {
  tone: "muted" | "danger" | "warn" | "success";
  label: string;
} {
  if (s.total === 0) return { tone: "muted", label: "no checks" };
  if (s.failed > 0) return { tone: "danger", label: "failing" };
  if (s.pending > 0) return { tone: "warn", label: "running" };
  return { tone: "success", label: "passing" };
}
