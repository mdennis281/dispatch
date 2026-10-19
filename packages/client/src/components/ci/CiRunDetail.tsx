/**
 * One run, drilled into: what it was, what it did, and the buttons to do it
 * again.
 *
 * Three independent sections — the run itself, its jobs, its artifacts — each
 * from its own request. The header paints instantly from the row the list
 * already had (`placeholder`) and refines when the full read lands; jobs and
 * artifacts skeleton and fail on their own.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Ban,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  MoreHorizontal,
  Package,
  RotateCcw,
  User,
} from "lucide-react";
import type { CiArtifact, CiJob, CiRun } from "@dispatch/shared";
import { ciIsActive, ciIsFailed } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { bytes, dur, relTime } from "../../lib/format.js";
import { useNotices } from "../../stores/notices.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { IconButton } from "../ui/IconButton.js";
import { MenuItem, Popover } from "../ui/Popover.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { Spinner } from "../ui/Spinner.js";
import { RowButton } from "../ui/RowButton.js";
import { CiSectionError, CiSectionLabel, CiSkeleton, CiStatusIcon } from "./CiBits.js";
import { CiLogViewer } from "./CiLogViewer.js";
import { ciElapsed, ciVisual, runElapsed } from "./ciModel.js";
import { useResource, type Resource } from "./useResource.js";

/** How often a live run, and its jobs, are re-read. */
const LIVE_POLL_MS = 5_000;

/** The repo's web root, from a run's URL — for commit and PR links. */
function repoWeb(run: CiRun): string | null {
  const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\//.exec(run.url);
  return m?.[1] ?? null;
}

/** Re-render once a second while something is live, so durations count up. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function CiRunDetail({
  projectId,
  runId,
  placeholder,
  compact,
  onBack,
  onChanged,
}: {
  projectId: string;
  runId: number;
  placeholder?: CiRun;
  compact: boolean;
  onBack?: () => void;
  /** Something was re-run / cancelled — the list should look again. */
  onChanged: () => void;
}) {
  const runRes = useResource(`${projectId}:${runId}`, () => api.ci.run(projectId, runId), {
    placeholder,
  });
  const run = runRes.data;
  const live = !!run && ciIsActive(run);
  // Polling is driven from here rather than `pollMs` so the run and its jobs
  // tick together, and stop together the moment the run completes.
  const jobsRes = useResource(`${projectId}:${runId}:${run?.attempt ?? 0}`, () =>
    api.ci.jobs(projectId, runId),
  );
  // Artifacts are uploaded as jobs finish; re-read once when the run does.
  const artifactsRes = useResource(`${projectId}:${runId}:${live ? "live" : "done"}`, () =>
    api.ci.artifacts(projectId, runId),
  );

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void runRes.reload();
      void jobsRes.reload();
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // The last poll can see the run complete before its jobs do — read them once
  // more on the way out so the job list doesn't freeze on a spinner.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void jobsRes.reload();
    wasLive.current = live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const now = useTicker(live);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await fn();
      useNotices.getState().push({ level: "info", text: done });
      onChanged();
      // GitHub takes a beat to flip the run's state after accepting the
      // request; reading straight back usually shows the OLD state.
      setTimeout(() => {
        void runRes.reload();
        void jobsRes.reload();
      }, 2000);
    } catch (err) {
      useNotices.getState().push({
        level: "error",
        text: `${label} failed`,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  if (!run) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        {compact && onBack && <BackBar onBack={onBack} />}
        <div className="p-4">
          {runRes.error ? (
            <CiSectionError message={runRes.error} onRetry={() => void runRes.reload()} />
          ) : (
            <CiSkeleton rows={4} />
          )}
        </div>
      </div>
    );
  }

  const visual = ciVisual(run);
  const web = repoWeb(run);
  const elapsed = runElapsed(run, now);
  const failed = ciIsFailed(run);
  const jobs = jobsRes.data;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {compact && onBack && <BackBar onBack={onBack} />}
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("mx-auto w-full max-w-[920px]", compact ? "px-3 py-3" : "px-5 py-4")}>
          {/* ---------------------------------------------------------- header */}
          <div className="flex items-start gap-3">
            <CiStatusIcon x={run} size={20} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <h2 className="line-clamp-2 break-words text-lg font-semibold leading-snug text-primary">
                {run.title || run.workflowName}
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                <span className="text-secondary">{run.workflowName}</span>
                <span className="cm-mono"> #{run.number}</span>
                {run.attempt > 1 && <span> · attempt {run.attempt}</span>}
                <span className={cn("ml-1.5", visual.color)}>· {visual.label}</span>
              </p>
            </div>
            {runRes.refreshing && <Spinner size={12} className="mt-1 text-faint" />}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {run.branch && (
              <Chip tone="info" mono icon={<GitBranch />} className="max-w-full">
                <span className="truncate">{run.branch}</span>
              </Chip>
            )}
            {run.sha && (
              <a
                href={web ? `${web}/commit/${run.sha}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:opacity-80"
              >
                <Chip tone="neutral" mono icon={<GitCommitHorizontal />}>
                  {run.sha.slice(0, 7)}
                </Chip>
              </a>
            )}
            {run.prNumbers.map((n) => (
              <a
                key={n}
                href={web ? `${web}/pull/${n}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:opacity-80"
              >
                <Chip tone="agent" icon={<GitPullRequest />}>
                  #{n}
                </Chip>
              </a>
            ))}
            <Chip tone="muted" mono>
              {run.event.replace(/_/g, " ")}
            </Chip>
            {run.actor && (
              <Chip tone="muted" icon={<User />}>
                {run.actor}
              </Chip>
            )}
            <span className="text-2xs text-faint">
              {relTime(Date.parse(run.startedAt ?? run.createdAt), now)}
              {elapsed !== undefined && <> · {live ? "running " : "took "}{dur(elapsed)}</>}
            </span>
          </div>

          {/* --------------------------------------------------------- actions */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {live ? (
              <Button
                variant="danger"
                size="sm"
                leftIcon={busy === "Cancel" ? <Spinner size={12} /> : <Ban />}
                disabled={!!busy}
                onClick={() =>
                  void act("Cancel", () => api.ci.cancel(projectId, run.id), `Cancelling run #${run.number}`)
                }
              >
                Cancel run
              </Button>
            ) : (
              <>
                {failed && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={busy === "Re-run" ? <Spinner size={12} /> : <RotateCcw />}
                    disabled={!!busy}
                    onClick={() =>
                      void act(
                        "Re-run",
                        () => api.ci.rerun(projectId, run.id, { failedOnly: true }),
                        `Re-running failed jobs of #${run.number}`,
                      )
                    }
                  >
                    Re-run failed jobs
                  </Button>
                )}
                <Button
                  variant={failed ? "default" : "primary"}
                  size="sm"
                  leftIcon={busy === "Re-run all" ? <Spinner size={12} /> : <RotateCcw />}
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      "Re-run all",
                      () => api.ci.rerun(projectId, run.id),
                      `Re-running all jobs of #${run.number}`,
                    )
                  }
                >
                  Re-run all jobs
                </Button>
              </>
            )}
            <a
              href={run.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-primary [&_svg]:size-3.5"
            >
              <ExternalLink />
              {compact ? "GitHub" : "Open on GitHub"}
            </a>
          </div>

          {/* ------------------------------------------------------------ jobs */}
          <section className="mt-6">
            <CiSectionLabel
              right={jobsRes.refreshing && !live ? <Spinner size={11} className="text-faint" /> : null}
            >
              Jobs{jobs ? ` · ${jobs.length}` : ""}
            </CiSectionLabel>
            {jobsRes.error && jobs && (
              <div className="mb-2">
                <CiSectionError message={jobsRes.error} onRetry={() => void jobsRes.reload()} slim />
              </div>
            )}
            {!jobs ? (
              jobsRes.error ? (
                <CiSectionError message={jobsRes.error} onRetry={() => void jobsRes.reload()} />
              ) : (
                <CiSkeleton rows={3} />
              )
            ) : jobs.length === 0 ? (
              <p className="text-xs text-faint">
                {live ? "Waiting for jobs to be scheduled…" : "This run has no jobs."}
              </p>
            ) : (
              <JobList
                projectId={projectId}
                jobs={jobs}
                now={now}
                runLive={live}
                busy={busy}
                onRerunJob={(job) =>
                  void act("Re-run job", () => api.ci.rerunJob(projectId, job.id), `Re-running ${job.name}`)
                }
              />
            )}
          </section>

          {/* ------------------------------------------------------- artifacts */}
          <ArtifactsSection run={run} res={artifactsRes} web={web} />
        </div>
      </ScrollArea>
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-1.5 cm-hairline-b">
      <Button variant="ghost" size="md" leftIcon={<ArrowLeft />} onClick={onBack}>
        Runs
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------- jobs */

function JobList({
  projectId,
  jobs,
  now,
  runLive,
  busy,
  onRerunJob,
}: {
  projectId: string;
  jobs: CiJob[];
  now: number;
  runLive: boolean;
  busy: string | null;
  onRerunJob: (job: CiJob) => void;
}) {
  // Open what's interesting without being asked: the first failed job, with
  // its log at the failed step — "why is it red" is why most people click in.
  const firstFailed = jobs.find((j) => ciIsFailed(j));
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(firstFailed ? [firstFailed.id] : jobs.length === 1 && jobs[0] ? [jobs[0].id] : []),
  );
  const [logFor, setLogFor] = useState<{ jobId: number; step: number | null } | null>(() => {
    if (!firstFailed) return null;
    const step = firstFailed.steps.find((s) => ciIsFailed(s));
    return { jobId: firstFailed.id, step: step?.number ?? null };
  });

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-surface">
      {jobs.map((job) => {
        const open = expanded.has(job.id);
        const active = ciIsActive(job);
        const elapsed = ciElapsed(job.startedAt, job.completedAt, active, now);
        const showLog = logFor?.jobId === job.id;
        return (
          <div key={job.id}>
            <div className="flex items-center gap-1 pr-1.5">
              <RowButton
                type="button"
                onClick={() => toggle(job.id)}
                aria-expanded={open}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left hover:bg-hover/50"
              >
                <ChevronRight
                  className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")}
                />
                <CiStatusIcon x={job} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-primary">{job.name}</span>
                  {job.runnerName && (
                    <span className="block truncate text-2xs text-faint">{job.runnerName}</span>
                  )}
                </span>
                {elapsed !== undefined && (
                  <span className="cm-mono shrink-0 text-2xs text-muted">{dur(elapsed)}</span>
                )}
              </RowButton>
              <IconButton
                tip={showLog ? "Hide log" : "View log"}
                active={showLog}
                onClick={() => {
                  setLogFor(showLog ? null : { jobId: job.id, step: null });
                  if (!showLog) setExpanded((s) => new Set(s).add(job.id));
                }}
              >
                <FileText />
              </IconButton>
              <Popover
                align="end"
                width={200}
                trigger={({ toggle: t, open: o }) => (
                  <IconButton tip="Job actions" onClick={t} active={o}>
                    <MoreHorizontal />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div className="p-1">
                    <MenuItem
                      icon={<RotateCcw />}
                      // GitHub refuses a job re-run while its run is still going.
                      disabled={runLive || active || !!busy}
                      onClick={() => {
                        close();
                        onRerunJob(job);
                      }}
                    >
                      Re-run this job
                    </MenuItem>
                    {job.url && (
                      <MenuItem
                        icon={<ExternalLink />}
                        onClick={() => {
                          close();
                          window.open(job.url!, "_blank", "noopener,noreferrer");
                        }}
                      >
                        Open on GitHub
                      </MenuItem>
                    )}
                  </div>
                )}
              </Popover>
            </div>

            {open && (
              <div className="border-t border-line-soft bg-app/40 px-3 pb-3 pt-1.5">
                {job.steps.length === 0 ? (
                  <p className="py-1 pl-6 text-xs text-faint">
                    {active ? "Waiting for a runner…" : "No steps reported."}
                  </p>
                ) : (
                  <ol className="py-0.5">
                    {job.steps.map((step) => {
                      const sActive = ciIsActive(step);
                      const sElapsed = ciElapsed(step.startedAt, step.completedAt, sActive, now);
                      const focused = showLog && logFor?.step === step.number;
                      return (
                        <li key={step.number}>
                          <RowButton
                            type="button"
                            onClick={() => setLogFor({ jobId: job.id, step: step.number })}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded px-1.5 py-1 text-left text-xs hover:bg-hover",
                              focused && "bg-accent-ghost",
                            )}
                            title="Show this step in the log"
                          >
                            <span className="cm-mono w-4 shrink-0 text-right text-2xs text-faint">
                              {step.number}
                            </span>
                            <CiStatusIcon x={step} size={12} />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate",
                                step.conclusion === "skipped" ? "text-faint" : "text-secondary",
                              )}
                            >
                              {step.name}
                            </span>
                            {sElapsed !== undefined && (
                              <span className="cm-mono shrink-0 text-2xs text-faint">{dur(sElapsed)}</span>
                            )}
                          </RowButton>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {showLog && (
                  <div className="mt-2">
                    <CiLogViewer projectId={projectId} job={job} focusStep={logFor?.step ?? null} />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- artifacts */

function ArtifactsSection({
  run,
  res,
  web,
}: {
  run: CiRun;
  res: Resource<CiArtifact[]>;
  web: string | null;
}) {
  const list = res.data;
  // An empty, settled list isn't worth a heading — most runs upload nothing.
  if (list && list.length === 0 && !res.error) return null;
  return (
    <section className="mt-6">
      <CiSectionLabel>Artifacts{list ? ` · ${list.length}` : ""}</CiSectionLabel>
      {!list ? (
        res.error ? (
          <CiSectionError message={res.error} onRetry={() => void res.reload()} />
        ) : (
          <CiSkeleton rows={1} />
        )
      ) : (
        <div className="divide-y divide-line-soft overflow-hidden rounded-md border border-line bg-surface">
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-2.5 px-3 py-2">
              <Package className="size-3.5 shrink-0 text-muted" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  a.expired ? "text-faint line-through" : "text-secondary",
                )}
              >
                {a.name}
              </span>
              <span className="cm-mono shrink-0 text-2xs text-faint">{bytes(a.sizeBytes)}</span>
              {a.expired ? (
                <Chip tone="muted">expired</Chip>
              ) : (
                web && (
                  <a
                    // GitHub's own download route: it needs the user's browser
                    // session, which is exactly what this link carries and the
                    // API's token-only zip URL does not.
                    href={`${web}/actions/runs/${run.id}/artifacts/${a.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download from GitHub"
                    aria-label={`Download ${a.name}`}
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary [&_svg]:size-3.5"
                  >
                    <Download />
                  </a>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
