/**
 * The workflow picker — a rail at `lg`, a Select above the run list below it.
 *
 * Each workflow carries its latest run's status when the server could see it.
 * `lastRun === undefined` means the server couldn't read recent runs at all,
 * and draws as NOTHING rather than as "never run" — a wrong "never" on a
 * workflow that ran an hour ago is worse than no dot.
 */
import type { ReactNode } from "react";
import { Layers, Play, Workflow } from "lucide-react";
import type { CiWorkflow } from "@dispatch/shared";
import { cn } from "../../lib/cn.js";
import { relTimeShort } from "../../lib/format.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { RowButton } from "../ui/RowButton.js";
import { Select } from "../ui/Select.js";
import { CiSectionError, CiSkeleton, CiStatusIcon } from "./CiBits.js";
import type { Resource } from "./useResource.js";

/** File workflows first (by name), then the provider-managed ones. */
export function sortWorkflows(list: CiWorkflow[]): { own: CiWorkflow[]; managed: CiWorkflow[] } {
  const byName = (a: CiWorkflow, b: CiWorkflow) => a.name.localeCompare(b.name);
  return {
    own: list.filter((w) => !w.managed).sort(byName),
    managed: list.filter((w) => w.managed).sort(byName),
  };
}

function RailRow({
  active,
  onClick,
  icon,
  label,
  meta,
  dim,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  meta?: string;
  dim?: boolean;
}) {
  return (
    <RowButton
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        active ? "bg-accent-ghost text-accent" : "text-secondary hover:bg-panel-2 hover:text-primary",
        dim && !active && "opacity-60",
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {meta && <span className="shrink-0 text-2xs text-faint">{meta}</span>}
    </RowButton>
  );
}

function workflowIcon(w: CiWorkflow) {
  return w.lastRun ? <CiStatusIcon x={w.lastRun} /> : <Workflow className="text-faint" />;
}

export function CiWorkflowRail({
  res,
  selected,
  onSelect,
  onRun,
}: {
  res: Resource<CiWorkflow[]>;
  selected: number | null;
  onSelect: (id: number | null) => void;
  onRun: (id: number) => void;
}) {
  const { own, managed } = sortWorkflows(res.data ?? []);
  const now = Date.now();
  const row = (w: CiWorkflow) => (
    <div key={w.id} className="flex items-center gap-0.5">
      <div className="min-w-0 flex-1">
        <RailRow
          active={selected === w.id}
          onClick={() => onSelect(w.id)}
          icon={workflowIcon(w)}
          label={w.name}
          meta={w.lastRun ? relTimeShort(Date.parse(w.lastRun.createdAt), now) : undefined}
          dim={w.state !== "active"}
        />
      </div>
      {/* Always shown, beside the row rather than over it: running a
          workflow is done from the workflow, and a hover-only button was
          unfindable on touch. The spacer keeps rows without one aligned. */}
      {!w.managed && w.state === "active" ? (
        <IconButton tip={`Run ${w.name}`} onClick={() => onRun(w.id)} className="shrink-0 text-muted hover:text-accent">
          <Play />
        </IconButton>
      ) : (
        <span className="size-6 shrink-0" aria-hidden />
      )}
    </div>
  );

  return (
    <nav
      aria-label="Workflows"
      className="flex w-[248px] shrink-0 flex-col border-r border-line bg-surface"
    >
      <ScrollArea className="min-h-0 flex-1 p-2">
        <RailRow
          active={selected === null}
          onClick={() => onSelect(null)}
          icon={<Layers className="text-muted" />}
          label="All workflows"
        />
        <div className="my-2 h-px bg-line-soft" />
        {res.error && (
          <div className="mb-2">
            <CiSectionError message={res.error} onRetry={() => void res.reload()} slim />
          </div>
        )}
        {!res.data ? (
          !res.error && <CiSkeleton rows={5} className="px-2.5 py-1" />
        ) : (
          <>
            <div className="space-y-0.5">{own.map(row)}</div>
            {managed.length > 0 && (
              <>
                <p className="mb-1 mt-4 px-2.5 text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
                  Managed by GitHub
                </p>
                <div className="space-y-0.5">{managed.map(row)}</div>
              </>
            )}
            {own.length + managed.length === 0 && (
              <p className="px-2.5 py-2 text-xs text-faint">No workflows in this repository.</p>
            )}
          </>
        )}
      </ScrollArea>
    </nav>
  );
}

/** The same choice as a dropdown, for layouts with no room for the rail. */
export function CiWorkflowSelect({
  res,
  selected,
  onSelect,
}: {
  res: Resource<CiWorkflow[]>;
  selected: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { own, managed } = sortWorkflows(res.data ?? []);
  const options = [
    { value: "all", label: "All workflows", icon: <Layers /> },
    ...[...own, ...managed].map((w) => ({
      value: String(w.id),
      label: w.name,
      icon: workflowIcon(w),
      hint: w.managed ? "GitHub" : w.state !== "active" ? "disabled" : undefined,
    })),
  ];
  return (
    <Select
      options={options}
      value={selected === null ? "all" : String(selected)}
      onChange={(v) => onSelect(v === "all" ? null : Number(v))}
      // No leftIcon: every option carries its own (status or layers), and the
      // trigger shows the selected one's — a second icon beside it was noise.
      label={res.error && !res.data ? "Workflows unavailable" : undefined}
      width={280}
      className="w-full justify-start"
    />
  );
}
