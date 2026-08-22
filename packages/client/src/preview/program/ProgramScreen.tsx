/**
 * The base screen — the program, and the phases within it.
 *
 * Counts on the phase cards are the whole job here: tasks, waves, and PHASE
 * acceptance criteria (not the tasks' own, which are a different and much
 * larger number and would make every card look the same). Everything deeper is
 * a drill-in, not a tab.
 */
import { Boxes, CheckCircle2, Layers, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import {
  ActorStatusPill,
  Card,
  ContextBar,
  Crumbs,
  Empty,
  Metric,
  SectionTitle,
  Tunable,
} from "./chrome.js";
import { gatePreviews, leadForTeam, liveHires, phaseCounts, teamColor, type Plan } from "./derive.js";
import type { Nav } from "./nav.js";

const PHASE_TONE = {
  pending: "text-faint",
  running: "text-accent",
  qa: "text-warn",
  gating: "text-warn",
  done: "text-success",
  blocked: "text-danger",
} as const;

export function ProgramScreen({ plan, nav }: { plan: Plan; nav: Nav }) {
  const { spec, run } = plan;
  const threshold = spec.policy.leadRecycle.contextThreshold;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-4 pb-3 pt-3">
        <Crumbs crumbs={[{ label: spec.title }]} />
        <p className="mt-2 max-w-5xl text-xs leading-relaxed text-secondary">{spec.objective}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Tunable label="concurrent" value={`≤${spec.policy.maxParallelTasks}`} />
          <Tunable label="branching" value={spec.policy.branching} />
          <Tunable label="recycle at" value={`${Math.round(threshold * 100)}%`} />
          <Tunable label="QA rounds" value={`≤${spec.policy.maxRemediationRounds}`} />
          <Tunable label="consent" value={spec.policy.spawnConsent} />
          <Chip tone="warn" icon={<ShieldCheck />}>
            PR override: {spec.policy.prOverride}
          </Chip>
        </div>
      </div>

      {/* ------------------------------------------------------------ phases */}
      <div className="px-4 pb-5">
        <SectionTitle icon={<Layers className="size-3.5" />} label="Phases">
          sequential gates — drill in for waves, tasks and acceptance
        </SectionTitle>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
          {[...spec.phases]
            .sort((a, b) => a.order - b.order)
            .map((p) => {
              const c = phaseCounts(plan, p.id);
              const live = run?.phases[p.id];
              const status = live?.status ?? "pending";
              const isCurrent = run?.currentPhaseId === p.id;
              return (
                <Card
                  key={p.id}
                  onClick={() => nav.go({ at: "phase", phaseId: p.id })}
                  className={cn("p-2.5", isCurrent && "ring-1 ring-accent-line")}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "cm-mono flex size-4.5 items-center justify-center rounded text-2xs",
                        isCurrent ? "bg-accent text-accent-fg" : "bg-inset text-muted",
                      )}
                    >
                      {p.order}
                    </span>
                    <span className="truncate text-xs font-semibold text-primary">{p.title}</span>
                    <span className={cn("ml-auto text-2xs font-medium", PHASE_TONE[status])}>
                      {status}
                    </span>
                  </div>

                  <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-muted">
                    {p.description}
                  </p>

                  <div className="mt-2.5 flex items-end gap-4">
                    <Metric value={c.tasks} label="tasks" />
                    <Metric value={c.waves} label="waves" />
                    <Metric value={c.criteria} label="phase AC" />
                    <Metric
                      value={c.done}
                      label="done"
                      tone={c.done === c.tasks && c.tasks > 0 ? "success" : "muted"}
                    />
                    {c.qaRounds > 0 && (
                      <Metric
                        value={c.qaRounds}
                        label={c.qaRounds === 1 ? "QA round" : "QA rounds"}
                        tone={c.qaRounds > 1 ? "warn" : "default"}
                      />
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="flex gap-0.5">
                      {c.teams.map((tid) => (
                        <span
                          key={tid}
                          title={spec.teams.find((t) => t.id === tid)?.name}
                          className="size-1.5 rounded-full"
                          style={{ background: teamColor(spec, tid) }}
                        />
                      ))}
                    </span>
                    {c.remediation > 0 && (
                      <Chip tone="warn">+{c.remediation} from QA</Chip>
                    )}
                    {!p.qa && (
                      <Chip tone="muted" icon={<TriangleAlert />}>
                        no QA
                      </Chip>
                    )}
                    <span className="ml-auto text-2xs text-faint">exit: {p.exit}</span>
                  </div>
                </Card>
              );
            })}
        </div>
      </div>

      {/* -------------------------------------------- program acceptance */}
      <div className="px-4 pb-5">
        <SectionTitle icon={<CheckCircle2 className="size-3.5" />} label="Program acceptance">
          the done-agreement for the whole run — signatories derived from which teams build it
        </SectionTitle>
        <div className="flex flex-col gap-1">
          {gatePreviews(plan)
            .filter((g) => g.scope === "program")
            .map((g) => (
              <div
                key={g.criterion.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5"
              >
                <span className="text-2xs font-medium text-primary">{g.criterion.title}</span>
                <span className="cm-mono text-[10px] leading-4 text-faint">{g.criterion.id}</span>
                <Chip tone={g.criterion.verify === "command" ? "success" : "info"}>
                  {g.criterion.verify}
                </Chip>
                <span className="min-w-[14rem] flex-1 truncate text-2xs text-muted">
                  {g.criterion.then}
                </span>
                <span className="flex items-center gap-1">
                  {g.signatories.map((tid) => (
                    <span
                      key={tid}
                      title={spec.teams.find((t) => t.id === tid)?.name}
                      className="size-2 rounded-full"
                      style={{ background: teamColor(spec, tid) }}
                    />
                  ))}
                  <span className="ml-1 cm-mono text-[10px] leading-4 text-faint">
                    {g.signatories.length} sign
                  </span>
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* ------------------------------------------------------------- teams */}
      <div className="px-4 pb-6">
        <SectionTitle icon={<Users className="size-3.5" />} label="Teams">
          leads are permanent for the run; workers are hired per task, from the menu
        </SectionTitle>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(18rem,1fr))]">
          {spec.teams.map((team) => {
            const color = teamColor(spec, team.id);
            const lead = leadForTeam(plan, team.id);
            const hires = liveHires(plan, team.id);
            return (
              <div
                key={team.id}
                className="rounded-lg border border-line bg-panel p-2.5"
                style={{ borderTopColor: color, borderTopWidth: 2 }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-primary">{team.name}</span>
                  <span className="ml-auto cm-mono text-2xs text-faint">{team.id}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-muted">
                  {team.charter}
                </p>

                {lead && (
                  <button
                    type="button"
                    onClick={() => nav.go({ at: "agent", actorId: lead.id })}
                    className="mt-2 flex w-full items-center gap-2 rounded-md border border-line-soft bg-panel-2 px-2 py-1.5 text-left hover:border-line-strong"
                  >
                    <Boxes className="size-3 shrink-0" style={{ color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-2xs font-medium text-primary">
                        {lead.name}
                      </span>
                      <span className="block truncate text-[10px] leading-4 text-faint">
                        {lead.activity}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <ActorStatusPill status={lead.status} />
                      <ContextBar fill={lead.contextFill} threshold={threshold} />
                    </span>
                  </button>
                )}

                <div className="mt-2 flex items-center gap-1.5">
                  <Tunable label="hire budget" value={`${hires.length}/${team.hireBudget}`} />
                  <span className="flex flex-1 gap-0.5">
                    {Array.from({ length: team.hireBudget }).map((_, i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 flex-1 rounded-full",
                          i < hires.length ? "" : "bg-inset",
                        )}
                        style={i < hires.length ? { background: color } : undefined}
                      />
                    ))}
                  </span>
                </div>

                <div className="mt-2">
                  <span className="text-[10px] leading-4 text-faint">can hire</span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {team.hireableRoles.map((r) => (
                      <span
                        key={r}
                        className="cm-mono rounded bg-inset px-1 text-[10px] leading-4 text-muted"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                </div>

                {hires.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {hires.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => nav.go({ at: "agent", actorId: h.id })}
                        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
                      >
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-2xs text-secondary">
                          {h.name}
                        </span>
                        <ActorStatusPill status={h.status} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2">
                    <Empty>no one hired right now</Empty>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
