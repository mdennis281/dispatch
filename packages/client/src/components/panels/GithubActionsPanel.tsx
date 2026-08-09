import { useCallback, useEffect, useState } from "react";
import {
  Workflow,
  Play,
  RefreshCw,
  Check,
  X,
  Clock,
  CircleDot,
  AlertTriangle,
  Minus,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { Chat, WorkflowRun, WorkflowWithLastRun, WorkflowInput } from "@dispatch/shared";
import { usePanels } from "../../stores/panels.js";
import { useProjects } from "../../stores/projects.js";
import { api } from "../../lib/api.js";
import { actions } from "../../lib/actions.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { Chip } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { Popover } from "../ui/Popover.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { SectionLabel } from "../ui/Panel.js";
import { cn } from "../../lib/cn.js";
import { relTime } from "../../lib/format.js";

/** The file basename `gh workflow view/run` accepts (path is repo-relative). */
function workflowFile(path: string, fallback: string): string {
  return path.split("/").pop() || fallback;
}

/** Icon + colour + label for a workflow's latest run (null = never run). */
function runVisual(run: WorkflowRun | null): {
  Icon: LucideIcon;
  spin: boolean;
  color: string;
  label: string;
} {
  if (!run) return { Icon: Minus, spin: false, color: "text-faint", label: "never run" };
  if (run.status !== "completed") {
    return { Icon: Clock, spin: true, color: "text-accent-hi", label: run.status.replace(/_/g, " ") };
  }
  switch (run.conclusion) {
    case "success":
      return { Icon: Check, spin: false, color: "text-success", label: "success" };
    case "failure":
    case "timed_out":
      return { Icon: X, spin: false, color: "text-danger", label: run.conclusion };
    case "action_required":
      return { Icon: AlertTriangle, spin: false, color: "text-warn", label: "action required" };
    case "cancelled":
      return { Icon: X, spin: false, color: "text-muted", label: "cancelled" };
    default:
      return { Icon: CircleDot, spin: false, color: "text-muted", label: run.conclusion ?? "done" };
  }
}

/* ------------------------------------------------------------- dispatch form */

const FIELD =
  "h-7 w-full rounded-md border border-line bg-inset px-2 text-[11.5px] text-primary outline-none " +
  "placeholder:text-faint focus:border-line-strong";

/**
 * The Run dialog for ONE workflow: a branch/ref field + a form rendered from the
 * workflow's `workflow_dispatch` inputs (text / choice / boolean, honouring
 * required + defaults). The Run button stays DISABLED until every required input
 * is satisfied (gate-by-disable, with a status hint) — then dispatches via the
 * shared `gh-action` op.
 */
function DispatchDialog({
  chatId,
  projectId,
  workflowName,
  file,
  defaultRef,
  onDone,
}: {
  chatId: string;
  projectId: string;
  workflowName: string;
  file: string;
  defaultRef: string;
  onDone: () => void;
}) {
  const [ref, setRef] = useState(defaultRef);
  const [inputs, setInputs] = useState<WorkflowInput[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  // Load the dispatch inputs + seed the form from their declared defaults.
  useEffect(() => {
    let cancelled = false;
    api.github
      .workflowInputs(projectId, file)
      .then((list) => {
        if (cancelled) return;
        const seed: Record<string, string> = {};
        for (const inp of list) {
          if (inp.type === "boolean") seed[inp.name] = inp.default ?? "false";
          else if (inp.type === "choice") seed[inp.name] = inp.default ?? inp.options?.[0] ?? "";
          else seed[inp.name] = inp.default ?? "";
        }
        setInputs(list);
        setValues(seed);
      })
      .catch(() => {
        if (!cancelled) setInputs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file]);

  const setVal = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }));

  const list = inputs ?? [];
  const missing = list.filter(
    (i) => i.required && i.type !== "boolean" && !(values[i.name] ?? "").trim(),
  );
  // Gate on inputs being LOADED too: `ref` is pre-seeded (always non-empty) and a
  // still-loading form has an empty `list`, so without the `inputs !== null` guard
  // the Run button (and the Enter handler) would fire while required inputs are
  // omitted. The button IS the gate — stay disabled until the form is real.
  const ready = inputs !== null && ref.trim().length > 0 && missing.length === 0;
  const hint =
    inputs === null
      ? "Loading inputs…"
      : !ref.trim()
        ? "Enter a branch to run on"
        : missing.length
          ? `${missing.length} required input${missing.length > 1 ? "s" : ""} left`
          : null;

  const submit = () => {
    if (!ready) return;
    const collected: Record<string, string> = {};
    for (const inp of list) {
      const v = values[inp.name] ?? "";
      if (inp.type === "boolean") collected[inp.name] = v === "true" ? "true" : "false";
      else if (v.trim() !== "") collected[inp.name] = v;
    }
    actions.ghAction({
      op: "dispatch",
      chatId,
      projectId,
      workflow: file,
      ref: ref.trim() || defaultRef,
      inputs: Object.keys(collected).length ? collected : undefined,
    });
    onDone();
  };

  return (
    <div className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-1.5">
        <Workflow className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary">
          Run {workflowName}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">Branch</label>
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={defaultRef}
          spellCheck={false}
          className={cn(FIELD, "cm-mono !text-[11px]")}
        />
      </div>

      {inputs === null ? (
        <div className="flex items-center gap-2 py-1 text-[11px] text-faint">
          <Spinner size={12} /> Loading inputs…
        </div>
      ) : (
        list.map((inp) => (
          <div key={inp.name} className="flex flex-col gap-1">
            <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
              <span className="normal-case tracking-normal text-secondary">{inp.name}</span>
              {inp.required && <span className="text-danger">*</span>}
            </label>
            {inp.description && (
              <span className="-mt-0.5 text-[10px] leading-snug text-faint">{inp.description}</span>
            )}
            {inp.type === "boolean" ? (
              <button
                type="button"
                onClick={() => setVal(inp.name, values[inp.name] === "true" ? "false" : "true")}
                className={cn(
                  "inline-flex h-7 w-fit items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors",
                  values[inp.name] === "true"
                    ? "border-accent-line bg-accent-ghost text-accent-hi"
                    : "border-line bg-inset text-secondary hover:border-line-strong",
                )}
              >
                {values[inp.name] === "true" ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                {values[inp.name] === "true" ? "true" : "false"}
              </button>
            ) : inp.type === "choice" && inp.options?.length ? (
              <select
                value={values[inp.name] ?? ""}
                onChange={(e) => setVal(inp.name, e.target.value)}
                className={cn(FIELD, "cursor-pointer")}
              >
                {inp.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[inp.name] ?? ""}
                onChange={(e) => setVal(inp.name, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={inp.default || inp.name}
                spellCheck={false}
                inputMode={inp.type === "number" ? "numeric" : undefined}
                className={FIELD}
              />
            )}
          </div>
        ))
      )}

      <div className="flex items-center gap-2 pt-0.5">
        {hint && <span className="text-[10px] text-faint">{hint}</span>}
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onDone}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" leftIcon={<Send />} disabled={!ready} onClick={submit}>
          Run
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- rows */

/** One workflow with its latest-run status + a per-workflow Run button. */
function WorkflowRow({
  item,
  chatId,
  projectId,
  defaultRef,
  onDispatched,
}: {
  item: WorkflowWithLastRun;
  chatId: string;
  projectId: string;
  defaultRef: string;
  onDispatched: () => void;
}) {
  const { workflow, lastRun } = item;
  const v = runVisual(lastRun);
  const file = workflowFile(workflow.path, workflow.name);
  const href = lastRun?.url && lastRun.url !== "#" ? lastRun.url : undefined;

  return (
    <div className="flex items-center gap-2 py-1.5">
      {v.spin ? <Spinner size={12} /> : <v.Icon className={cn("size-3.5 shrink-0", v.color)} />}
      <div className="min-w-0 flex-1">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[11.5px] text-secondary hover:text-primary"
          >
            {workflow.name}
          </a>
        ) : (
          <span className="block truncate text-[11.5px] text-secondary">{workflow.name}</span>
        )}
        <span className="flex items-center gap-1 text-[10px] text-faint">
          <span className={v.color}>{v.label}</span>
          {lastRun?.headBranch && (
            <>
              <span>·</span>
              <span className="cm-mono truncate">{lastRun.headBranch}</span>
            </>
          )}
          {lastRun?.updatedAt && (
            <>
              <span>·</span>
              <span className="shrink-0">{relTime(Date.parse(lastRun.updatedAt))}</span>
            </>
          )}
        </span>
      </div>
      <Popover
        align="end"
        width={288}
        className="p-0"
        trigger={({ toggle, open }) => (
          <button
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-line px-1.5 py-1 text-[10.5px] text-secondary transition-colors hover:border-line-strong hover:text-primary [&_svg]:size-3"
          >
            <Play />
            Run
          </button>
        )}
      >
        {(close) => (
          <DispatchDialog
            chatId={chatId}
            projectId={projectId}
            workflowName={workflow.name}
            file={file}
            defaultRef={defaultRef}
            onDone={() => {
              close();
              onDispatched();
            }}
          />
        )}
      </Popover>
    </div>
  );
}

/** A single run line in the History view. */
function RunRow({ run }: { run: WorkflowRun }) {
  const v = runVisual(run);
  const inner = (
    <div className="flex items-center gap-2 py-1.5 text-[11.5px]">
      {v.spin ? <Spinner size={12} /> : <v.Icon className={cn("size-3.5", v.color)} />}
      <span className="min-w-0 flex-1 truncate text-secondary">{run.workflowName ?? run.name}</span>
      {run.event && (
        <Chip tone="muted" mono className="shrink-0">
          {run.event}
        </Chip>
      )}
      <span className={cn("shrink-0 text-[10.5px]", v.color)}>{v.label}</span>
    </div>
  );
  return run.url && run.url !== "#" ? (
    <a href={run.url} target="_blank" rel="noopener noreferrer" className="block hover:bg-hover">
      {inner}
    </a>
  ) : (
    inner
  );
}

/* --------------------------------------------------------------- section */

type View = "workflows" | "history";

/**
 * The GitHub Actions section: DEFAULTS to last-run-per-workflow (each workflow +
 * its latest status, with a per-workflow Run/dispatch dialog). A "History" toggle
 * reveals the full chronological run list. Last-run data is fetched from the new
 * `/workflows/status` endpoint; history reuses the live run store.
 */
export function GithubActionsSection({ chat }: { chat: Chat }) {
  const project = useProjects((s) => s.projects.find((p) => p.id === chat.projectId));
  const defaultRef = project?.defaultBranch ?? "main";
  const projectId = chat.projectId;

  const runs = usePanels((s) => s.workflowRuns);
  const [view, setView] = useState<View>("workflows");
  const [wfs, setWfs] = useState<WorkflowWithLastRun[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const jobs: Promise<unknown>[] = [
      api.github
        .workflowsStatus(projectId)
        .then(setWfs)
        .catch(() => {
          /* leave the last-known list; a git/gh hiccup shouldn't blank the panel */
        }),
    ];
    // The History view renders the shared `workflowRuns` store, which `load` never
    // touched — so Refresh spun without refetching runs. Pull the run list too when
    // History is showing and fold it into the store.
    if (view === "history") {
      jobs.push(
        api.github
          .runs(projectId, { limit: 20 })
          .then((rs) => {
            const upsert = usePanels.getState().upsertRun;
            for (const r of rs) upsert(r);
          })
          .catch(() => {
            /* stale history is better than a blanked list on a gh hiccup */
          }),
      );
    }
    void Promise.allSettled(jobs).finally(() => setLoading(false));
  }, [projectId, view]);

  useEffect(() => {
    load();
  }, [load]);

  // A dispatch creates a run GitHub takes a beat to register — refetch now and
  // again shortly so the workflow's status reflects the new run.
  const onDispatched = useCallback(() => {
    load();
    setTimeout(load, 2500);
  }, [load]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 px-0.5">
        <Workflow className="size-3.5 text-muted" />
        <SectionLabel className="px-0">GitHub Actions</SectionLabel>
        <div className="ml-auto flex items-center gap-1">
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            segments={[
              { value: "workflows", label: "Workflows" },
              { value: "history", label: "History" },
            ]}
          />
          <IconButton size="sm" tip="Refresh" onClick={load}>
            {loading ? <Spinner size={12} /> : <RefreshCw />}
          </IconButton>
        </div>
      </div>

      <div className="rounded-md border border-line bg-panel-2/40 px-3 py-1.5">
        {view === "workflows" ? (
          wfs.length > 0 ? (
            wfs.map((it) => (
              <WorkflowRow
                key={it.workflow.id}
                item={it}
                chatId={chat.id}
                projectId={projectId}
                defaultRef={defaultRef}
                onDispatched={onDispatched}
              />
            ))
          ) : loading ? (
            <div className="flex items-center gap-2 py-1.5 text-[11px] text-faint">
              <Spinner size={12} /> Loading workflows…
            </div>
          ) : (
            <p className="py-1.5 text-[11px] text-faint">No workflows in this repo.</p>
          )
        ) : runs.length > 0 ? (
          runs.map((r) => <RunRow key={r.id} run={r} />)
        ) : (
          <p className="py-1.5 text-[11px] text-faint">No recent runs.</p>
        )}
      </div>
    </div>
  );
}
