/** One run in a list — shared by the flat history and the per-workflow groups. */
import type { CiRun } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";
import { dur, relTimeShort } from "../../lib/format.js";
import { RowButton } from "../ui/RowButton.js";
import { CiStatusIcon } from "./CiBits.js";
import { runElapsed } from "./ciModel.js";

export function RunRow({
  run,
  now,
  selected,
  showWorkflow,
  onSelect,
}: {
  run: CiRun;
  now: number;
  selected: boolean;
  showWorkflow: boolean;
  onSelect: () => void;
}) {
  const elapsed = runElapsed(run, now);
  return (
    <li>
      <RowButton
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
          selected ? "bg-accent-ghost" : "hover:bg-hover/60",
        )}
      >
        {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-accent" />}
        <CiStatusIcon x={run} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", selected ? "text-primary" : "text-secondary")}>
              {run.title || run.workflowName}
            </span>
            <span className="shrink-0 text-2xs text-faint">
              {relTimeShort(Date.parse(run.createdAt), now)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-faint">
            {showWorkflow && <span className="shrink-0 text-muted">{run.workflowName}</span>}
            <span className="cm-mono shrink-0">#{run.number}</span>
            {run.branch && (
              <span className="cm-mono min-w-0 truncate rounded bg-panel-2 px-1 text-info-hi">
                {run.branch}
              </span>
            )}
            <span className="hidden shrink-0 sm:inline">{run.event.replace(/_/g, " ")}</span>
            <span className="flex-1" />
            {elapsed !== undefined && <span className="cm-mono shrink-0">{dur(elapsed)}</span>}
          </span>
        </span>
      </RowButton>
    </li>
  );
}
