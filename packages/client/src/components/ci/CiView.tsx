/**
 * CiView — the project's CI/CD page: every workflow, its run history, and any
 * run drilled into down to the step and its log, with re-run / cancel / run
 * workflow on hand.
 *
 * Named for the job, not the vendor: GitHub Actions is the only backend today
 * (the header says so), and the page speaks workflows/runs/jobs so a second
 * provider would not need a second page.
 *
 * LOADING. Nothing here waits on anything else. The summary, the workflow
 * list, the run list and — once a run is picked — the run, its jobs and its
 * artifacts are each their own request with their own skeleton and their own
 * error. The one cross-section rule: a 409 from the summary means the project
 * has no GitHub repository at all, and that replaces the page with an empty
 * state, because every other section would fail the same way.
 *
 * LAYOUT, by width (see useBreakpoint):
 *   lg  workflow rail │ run list │ run detail
 *   md                  run list │ run detail   (workflows become a Select)
 *   sm  run list, OR run detail with a back button — a drill-down, the way
 *       Settings works at this width. The list stays mounted underneath so
 *       coming back keeps its filters, pages and scroll.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Play, RefreshCw, Workflow } from "lucide-react";
import type { CiRun } from "@dispatch/shared";
import { isGlobalProject, type Project } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { useActiveProject } from "../../stores/projects.js";
import { useLayoutMode } from "../../stores/layout.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Spinner } from "../ui/Spinner.js";
import { CiDispatchModal } from "./CiDispatchModal.js";
import { CiRunDetail } from "./CiRunDetail.js";
import { CiRunList } from "./CiRunList.js";
import { CiWorkflowRail, CiWorkflowSelect } from "./CiWorkflowRail.js";
import { useResource } from "./useResource.js";

/** Workflow statuses go stale slower than runs; the run list has its own poll. */
const WORKFLOWS_POLL_MS = 60_000;

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center bg-app px-6 text-center">
      <Workflow className="mb-2 size-6 text-faint" />
      <p className="text-base font-medium text-secondary">{title}</p>
      <p className="mt-0.5 max-w-sm text-xs text-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function CiView() {
  const project = useActiveProject();
  if (!project) {
    return <EmptyState title="No project selected" body="Pick a project to see its CI/CD runs." />;
  }
  if (isGlobalProject(project.id)) {
    return (
      <EmptyState
        title="No repository here"
        body="CI/CD belongs to a project with a repository. Switch to one to see its workflows."
      />
    );
  }
  // Keyed so switching projects starts every section from scratch instead of
  // briefly showing one project's runs under another's name.
  return <CiPage key={project.id} project={project} />;
}

function CiPage({ project }: { project: Project }) {
  const mode = useLayoutMode();
  const compact = mode === "sm";
  const projectId = project.id;

  const summary = useResource(projectId, () => api.ci.summary(projectId));
  const workflows = useResource(projectId, () => api.ci.workflows(projectId), {
    pollMs: WORKFLOWS_POLL_MS,
  });

  const [workflowId, setWorkflowId] = useState<number | null>(null);
  // The whole row, not just its id: the detail header paints from it while
  // the full read is in flight.
  const [selected, setSelected] = useState<CiRun | null>(null);
  const [tick, setTick] = useState(0);
  const [dispatchFor, setDispatchFor] = useState<{ workflowId: number | null } | null>(null);

  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (followUp.current) clearTimeout(followUp.current);
  }, []);

  const refreshAll = () => {
    setTick((t) => t + 1);
    void summary.reload();
    void workflows.reload();
  };

  // After an action GitHub accepts the request before the new state is
  // readable — look now, and once more shortly after.
  const changed = useCallback(() => {
    setTick((t) => t + 1);
    void workflows.reload();
    if (followUp.current) clearTimeout(followUp.current);
    followUp.current = setTimeout(() => {
      setTick((t) => t + 1);
      void workflows.reload();
    }, 3500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (summary.errorStatus === 409) {
    return (
      <EmptyState
        title="No CI/CD for this project"
        body={`Dispatch reads CI from GitHub Actions, and couldn't find a GitHub repository for ${project.name}. Add a GitHub remote to the checkout and try again.`}
        action={
          <Button size="sm" leftIcon={<RefreshCw />} onClick={() => void summary.reload()}>
            Check again
          </Button>
        }
      />
    );
  }

  const busy = summary.refreshing || workflows.refreshing;
  const showRail = mode === "lg";
  const showList = !compact || !selected;
  const showDetail = !compact || !!selected;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      {/* ----------------------------------------------------------- header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Workflow className="size-4 shrink-0 text-muted" />
        <span className="text-base font-semibold text-primary">CI/CD</span>
        {summary.data ? (
          <a
            href={summary.data.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on GitHub"
            className="ml-1 hidden min-w-0 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-0.5 text-xs text-secondary transition-colors hover:border-line-strong hover:text-primary sm:inline-flex [&_svg]:size-3"
          >
            <span className="text-faint">GitHub Actions</span>
            <span className="cm-mono truncate">{summary.data.repo}</span>
            <ExternalLink className="shrink-0 text-faint" />
          </a>
        ) : summary.loading ? (
          <span className="ml-1 hidden h-5 w-44 animate-pulse rounded-md bg-panel-2 sm:block" />
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <IconButton tip="Refresh" onClick={refreshAll}>
            {busy ? <Spinner size={12} /> : <RefreshCw />}
          </IconButton>
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Play />}
            disabled={!workflows.data}
            onClick={() => setDispatchFor({ workflowId })}
            aria-label="Run workflow"
          >
            {compact ? "Run" : "Run workflow"}
          </Button>
        </div>
      </div>

      {summary.error && summary.errorStatus !== 409 && !summary.data && (
        <div className="shrink-0 bg-danger-ghost px-3 py-1.5 text-xs text-danger">
          Couldn't reach GitHub: {summary.error}
        </div>
      )}

      {/* ------------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        {showRail && (
          <CiWorkflowRail
            res={workflows}
            selected={workflowId}
            onSelect={setWorkflowId}
            onRun={(id) => setDispatchFor({ workflowId: id })}
          />
        )}

        <div
          className={cn(
            "flex min-h-0 flex-col bg-surface",
            compact ? "w-full" : mode === "md" ? "w-[340px] shrink-0 border-r border-line" : "w-[380px] shrink-0 border-r border-line",
            !showList && "hidden",
          )}
        >
          <CiRunList
            projectId={projectId}
            workflowId={workflowId}
            selectedRunId={selected?.id ?? null}
            onSelect={setSelected}
            refreshTick={tick}
            compact={compact}
            header={
              showRail ? undefined : (
                <CiWorkflowSelect res={workflows} selected={workflowId} onSelect={setWorkflowId} />
              )
            }
          />
        </div>

        {showDetail &&
          (selected ? (
            <CiRunDetail
              // Fresh state per run: expanded jobs and open logs belong to the
              // run they were opened on.
              key={selected.id}
              projectId={projectId}
              runId={selected.id}
              placeholder={selected}
              compact={compact}
              onBack={() => setSelected(null)}
              onChanged={changed}
            />
          ) : (
            <EmptyState
              title="Select a run"
              body="Pick a run to see its jobs, step-by-step logs and artifacts — and to re-run or cancel it."
            />
          ))}
      </div>

      <CiDispatchModal
        open={dispatchFor !== null}
        onClose={() => setDispatchFor(null)}
        projectId={projectId}
        workflows={workflows.data ?? []}
        initialWorkflowId={dispatchFor?.workflowId ?? null}
        defaultRef={project.defaultBranch || "main"}
        onDispatched={(id) => {
          // Show the workflow that was just started, so the new run lands in view.
          setWorkflowId(id);
          changed();
        }}
      />
    </div>
  );
}
