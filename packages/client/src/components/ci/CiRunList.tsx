/**
 * Run history: filterable, paginated, live.
 *
 * With no workflow picked this is grouped by workflow (`CiRunGroups`); the
 * flat, paginated list below is one workflow's full history. The status and
 * branch filters apply to both.
 *
 * Page 1 is a polled resource; "Load more" pages are held separately and
 * folded under it (`mergeRuns`), so a poll refreshes the top of the list
 * without discarding what you scrolled down to.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitBranch, Search, X } from "lucide-react";
import type { CiRun, CiWorkflow } from "@dispatch/shared";
import { ciIsActive } from "@dispatch/shared";
import { api } from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Spinner } from "../ui/Spinner.js";
import { CiSectionError, CiSkeleton } from "./CiBits.js";
import { CiRunGroups } from "./CiRunGroups.js";
import { RunRow } from "./CiRunRow.js";
import {
  appendRuns,
  mergeRuns,
  statusParam,
  type RunStatusFilter,
} from "./ciModel.js";
import { useResource, type Resource } from "./useResource.js";

const PER_PAGE = 30;
/** Poll faster while something on screen is moving. */
const POLL_LIVE_MS = 10_000;
const POLL_IDLE_MS = 45_000;

const STATUS_SEGMENTS: { value: RunStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Running" },
  { value: "failure", label: "Failed" },
  { value: "success", label: "Passed" },
];

export function CiRunList({
  projectId,
  workflowId,
  workflows,
  onShowAll,
  onRun,
  selectedRunId,
  onSelect,
  refreshTick,
  compact,
  header,
}: {
  projectId: string;
  workflowId: number | null;
  workflows: Resource<CiWorkflow[]>;
  onShowAll: (workflowId: number) => void;
  onRun: (workflowId: number) => void;
  selectedRunId: number | null;
  onSelect: (run: CiRun) => void;
  /** Bumped by the page's Refresh / after an action — reload page 1. */
  refreshTick: number;
  compact: boolean;
  /** Rendered above the filters (the workflow picker when the rail is hidden). */
  header?: ReactNode;
}) {
  const [status, setStatus] = useState<RunStatusFilter>("all");
  const [branchInput, setBranchInput] = useState("");
  const [branch, setBranch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // Debounced: every keystroke would be a GitHub API call.
  useEffect(() => {
    const t = setTimeout(() => setBranch(branchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [branchInput]);

  const filterKey = `${projectId}:${workflowId ?? "all"}:${status}:${branch}`;
  // Read by an in-flight "Load more" to notice the filter moved under it.
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;
  const filter = {
    workflowId: workflowId ?? undefined,
    status: statusParam(status),
    branch: branch || undefined,
    perPage: PER_PAGE,
  };

  const [more, setMore] = useState<CiRun[]>([]);
  const [pages, setPages] = useState(1);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [anyLive, setAnyLive] = useState(false);

  const grouped = workflowId === null;
  // Grouped mode reads per workflow instead; a null key keeps this one idle.
  const first = useResource(grouped ? null : filterKey, () => api.ci.runs(projectId, { ...filter, page: 1 }), {
    pollMs: anyLive ? POLL_LIVE_MS : POLL_IDLE_MS,
  });

  useEffect(() => {
    setMore([]);
    setPages(1);
    setMoreError(null);
  }, [filterKey]);

  useEffect(() => {
    if (refreshTick > 0) void first.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const runs = useMemo(
    () => (first.data ? mergeRuns(more, first.data.runs) : []),
    [first.data, more],
  );
  useEffect(() => setAnyLive(runs.some(ciIsActive)), [runs]);

  const total = first.data?.totalCount ?? 0;
  const canLoadMore = !!first.data && runs.length < total;

  const loadMore = async () => {
    setMoreLoading(true);
    setMoreError(null);
    const key = filterKey;
    try {
      const page = await api.ci.runs(projectId, { ...filter, page: pages + 1 });
      if (key !== filterKeyRef.current) return;
      setMore((m) => appendRuns(m, page.runs));
      setPages((p) => p + 1);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoreLoading(false);
    }
  };

  // One clock for every row's "running 2m" — not a timer per row.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const filtered = status !== "all" || !!branch;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-2.5 cm-hairline-b">
        {header}
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            segments={STATUS_SEGMENTS}
            value={status}
            onChange={setStatus}
            className={cn(compact && "flex flex-1 [&>button]:flex-1 [&>button]:justify-center")}
          />
          {!compact && <div className="flex-1" />}
          {searchOpen || branchInput ? (
            <div
              className={cn(
                "flex h-6 items-center gap-1 rounded-md border border-line bg-inset px-1.5 focus-within:border-line-strong",
                compact ? "w-32" : "w-44",
              )}
            >
              <GitBranch className="size-3 shrink-0 text-faint" />
              <input
                autoFocus={searchOpen && !branchInput}
                value={branchInput}
                onChange={(e) => setBranchInput(e.target.value)}
                onBlur={() => !branchInput && setSearchOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setBranchInput("");
                    setSearchOpen(false);
                  }
                }}
                placeholder="Branch"
                spellCheck={false}
                aria-label="Filter by branch"
                className="cm-mono min-w-0 flex-1 bg-transparent text-xs text-primary outline-none placeholder:text-faint"
              />
              {branchInput && (
                <IconButton
                  tip="Clear branch filter"
                  onClick={() => {
                    setBranchInput("");
                    setSearchOpen(false);
                  }}
                  className="-mr-1 size-5"
                >
                  <X />
                </IconButton>
              )}
            </div>
          ) : (
            <IconButton tip="Filter by branch" onClick={() => setSearchOpen(true)} className="shrink-0">
              <Search />
            </IconButton>
          )}
        </div>
      </div>

      {grouped ? (
        <CiRunGroups
          projectId={projectId}
          workflows={workflows}
          filter={{ status: filter.status, branch: filter.branch }}
          filterKey={filterKey}
          selectedRunId={selectedRunId}
          onSelect={onSelect}
          onShowAll={onShowAll}
          onRun={onRun}
          refreshTick={refreshTick}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {first.error && first.data && (
            <div className="px-3 pt-2">
              <CiSectionError message={first.error} onRetry={() => void first.reload()} slim />
            </div>
          )}
          {!first.data ? (
            first.error ? (
              <div className="p-3">
                <CiSectionError message={first.error} onRetry={() => void first.reload()} />
              </div>
            ) : (
              <CiSkeleton rows={8} className="p-3" />
            )
          ) : runs.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-secondary">{filtered ? "No matching runs" : "No runs yet"}</p>
              <p className="mt-1 text-xs text-faint">
                {filtered
                  ? "Try a different status or branch."
                  : "Runs appear here as soon as a workflow is triggered."}
              </p>
            </div>
          ) : (
            <>
              <ul className="py-1">
                {runs.map((run) => (
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
              <div className="px-3 pb-4 pt-1 text-center">
                {moreError && (
                  <div className="mb-2 text-left">
                    <CiSectionError message={moreError} onRetry={() => void loadMore()} slim />
                  </div>
                )}
                {canLoadMore ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={moreLoading}
                    leftIcon={moreLoading ? <Spinner size={12} /> : undefined}
                    onClick={() => void loadMore()}
                  >
                    Load more · {runs.length.toLocaleString()} of {total.toLocaleString()}
                  </Button>
                ) : (
                  <span className="text-2xs text-faint">
                    {total.toLocaleString()} run{total === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
