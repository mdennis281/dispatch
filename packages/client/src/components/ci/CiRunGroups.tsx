/**
 * "All workflows", grouped: one section per workflow, each with its latest
 * few runs and a way into that workflow's full history.
 *
 * Grouped rather than one merged timeline because the question this page gets
 * asked is "is each of my workflows OK?" — and in a merged timeline a busy CI
 * workflow pushes the nightly release or the weekly retention job off the
 * first page entirely, so its last (possibly failed) run is simply not there.
 *
 * Each group is its OWN request (`runs?workflowId=…`), not a slice of one
 * shared read of recent runs, for the same reason: a slice of the latest 100
 * shows a rarely-run workflow as empty when it isn't. It also keeps the
 * page's partial-load rule — one workflow's read failing is that group's
 * error, not the list's. A collapsed group fetches nothing; its header paints
 * from the workflow list's `lastRun`.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Play, Workflow } from "lucide-react";
import type { CiRun, CiWorkflow } from "@dispatch/shared";
import { ciIsActive } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { relTimeShort } from "../../lib/format.js";
import { IconButton } from "../ui/IconButton.js";
import { RowButton } from "../ui/RowButton.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { CiSectionError, CiSkeleton, CiStatusIcon } from "./CiBits.js";
import { RunRow } from "./CiRunRow.js";
import { sortWorkflows } from "./CiWorkflowRail.js";
import { useResource, type Resource } from "./useResource.js";

/** Enough to see a trend (three reds in a row) without a group becoming a page. */
const GROUP_RUNS = 5;
const POLL_LIVE_MS = 10_000;
const POLL_IDLE_MS = 60_000;

export interface RunFilter {
  status?: string;
  branch?: string;
}

/**
 * Collapsed by default: provider-managed workflows (Dependabot, CodeQL) and
 * disabled ones — rarely what someone opened the page for, and N fewer
 * requests per poll.
 */
function openByDefault(w: CiWorkflow): boolean {
  return !w.managed && w.state === "active";
}

export function CiRunGroups({
  projectId,
  workflows,
  filter,
  filterKey,
  selectedRunId,
  onSelect,
  onShowAll,
  onRun,
  refreshTick,
}: {
  projectId: string;
  workflows: Resource<CiWorkflow[]>;
  filter: RunFilter;
  /** Changes whenever `filter` does — resets every group's read. */
  filterKey: string;
  selectedRunId: number | null;
  onSelect: (run: CiRun) => void;
  /** Narrow the page to one workflow's full, paginated history. */
  onShowAll: (workflowId: number) => void;
  onRun: (workflowId: number) => void;
  refreshTick: number;
}) {
  // Only the user's overrides; everything else follows openByDefault, so a
  // workflow added since the page opened gets the right default.
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const { own, managed } = sortWorkflows(workflows.data ?? []);

  if (!workflows.data) {
    return (
      <div className="p-3">
        {workflows.error ? (
          <CiSectionError message={workflows.error} onRetry={() => void workflows.reload()} />
        ) : (
          <CiSkeleton rows={8} />
        )}
      </div>
    );
  }
  if (own.length + managed.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-secondary">No workflows yet</p>
        <p className="mt-1 text-xs text-faint">Add one under .github/workflows to see its runs here.</p>
      </div>
    );
  }

  const group = (w: CiWorkflow) => (
    <WorkflowGroup
      key={w.id}
      projectId={projectId}
      workflow={w}
      open={toggled[w.id] ?? openByDefault(w)}
      onToggle={() => setToggled((t) => ({ ...t, [w.id]: !(t[w.id] ?? openByDefault(w)) }))}
      filter={filter}
      filterKey={filterKey}
      selectedRunId={selectedRunId}
      onSelect={onSelect}
      onShowAll={() => onShowAll(w.id)}
      onRun={() => onRun(w.id)}
      refreshTick={refreshTick}
    />
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      {workflows.error && (
        <div className="px-3 pt-2">
          <CiSectionError message={workflows.error} onRetry={() => void workflows.reload()} slim />
        </div>
      )}
      {own.map(group)}
      {managed.length > 0 && (
        <>
          <p className="px-3 pb-1 pt-4 text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
            Managed by GitHub
          </p>
          {managed.map(group)}
        </>
      )}
      <div className="h-4" />
    </ScrollArea>
  );
}

function WorkflowGroup({
  projectId,
  workflow: w,
  open,
  onToggle,
  filter,
  filterKey,
  selectedRunId,
  onSelect,
  onShowAll,
  onRun,
  refreshTick,
}: {
  projectId: string;
  workflow: CiWorkflow;
  open: boolean;
  onToggle: () => void;
  filter: RunFilter;
  filterKey: string;
  selectedRunId: number | null;
  onSelect: (run: CiRun) => void;
  onShowAll: () => void;
  onRun: () => void;
  refreshTick: number;
}) {
  const [live, setLive] = useState(false);
  const runs = useResource(
    open ? `${filterKey}:${w.id}` : null,
    () => api.ci.runs(projectId, { ...filter, workflowId: w.id, perPage: GROUP_RUNS, page: 1 }),
    { pollMs: live ? POLL_LIVE_MS : POLL_IDLE_MS },
  );

  useEffect(() => {
    if (refreshTick > 0 && open) void runs.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const list = useMemo(() => runs.data?.runs ?? [], [runs.data]);
  useEffect(() => setLive(list.some(ciIsActive)), [list]);

  // One clock per group, and only while something in it is moving.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  // The freshest thing we know: this group's own read when it is unfiltered,
  // else the workflow list's. A filtered list's top row is not "latest".
  const unfiltered = !filter.status && !filter.branch;
  const latest = (unfiltered && list[0]) || w.lastRun || undefined;
  const total = runs.data?.totalCount;
  const canRun = !w.managed && w.state === "active";

  return (
    <section aria-label={w.name} className="cm-hairline-b">
      <div
        className={cn(
          // Sticky so a long group never leaves its runs unlabelled mid-scroll.
          "group sticky top-0 z-10 flex items-center gap-1 bg-surface py-1 pl-1.5 pr-2",
          w.state !== "active" && "opacity-60",
        )}
      >
        <RowButton
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-2"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
          {latest ? <CiStatusIcon x={latest} /> : <Workflow className="size-3.5 shrink-0 text-faint" />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">{w.name}</span>
          {latest && (
            <span className="shrink-0 text-2xs text-faint">
              {relTimeShort(Date.parse(latest.createdAt), now)}
            </span>
          )}
        </RowButton>
        {canRun && (
          <IconButton
            tip={`Run ${w.name}`}
            onClick={onRun}
            className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Play />
          </IconButton>
        )}
      </div>

      {open && (
        <div className="pb-1">
          {runs.error && (
            <div className="px-3 py-1">
              <CiSectionError message={runs.error} onRetry={() => void runs.reload()} slim />
            </div>
          )}
          {!runs.data ? (
            !runs.error && <CiSkeleton rows={2} className="px-3 py-1.5" />
          ) : list.length === 0 ? (
            <p className="px-9 pb-2 pt-0.5 text-xs text-faint">
              {unfiltered ? "No runs yet." : "No matching runs."}
            </p>
          ) : (
            <>
              <ul>
                {list.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    now={now}
                    selected={run.id === selectedRunId}
                    showWorkflow={false}
                    onSelect={() => onSelect(run)}
                  />
                ))}
              </ul>
              {total !== undefined && total > list.length && (
                <RowButton
                  type="button"
                  onClick={onShowAll}
                  className="ml-9 mt-0.5 rounded px-1 py-0.5 text-2xs text-muted hover:text-accent"
                >
                  All {total.toLocaleString()} runs →
                </RowButton>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
