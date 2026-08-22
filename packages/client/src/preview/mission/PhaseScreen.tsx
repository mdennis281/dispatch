/**
 * One phase — its waves, its tasks, its acceptance, and its QA history.
 *
 * Acceptance is NESTED here rather than living in a tab of its own: a criterion
 * read apart from the tasks that satisfy it is just a sentence, and the
 * question you actually have in front of a phase is "which of these is anybody
 * building".
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Terminal, UserCheck } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { Card, Empty, Section, TaskStatusPill } from "./chrome.js";
import { gatePreviews, scheduleFor, teamColor, waveGroups, type Plan } from "./derive.js";
import type { Nav } from "./nav.js";
import type { SectionState } from "./sections.js";
import type { MissionTask } from "./types.js";

export function PhaseScreen({
  plan,
  phaseId,
  nav,
  sections,
}: {
  plan: Plan;
  phaseId: string;
  nav: Nav;
  sections: SectionState;
}) {
  const { spec, run } = plan;
  const phase = spec.phases.find((p) => p.id === phaseId);
  if (!phase) return <div className="p-4 text-xs text-faint">no such phase</div>;
  const live = run?.phases[phaseId];
  const remediations = (run?.remediations ?? []).filter((r) => r.phaseId === phaseId);
  const counts = { waves: waveGroups(plan, phaseId).length };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section id="phase-detail" title="Detail" state={sections} hint={`exit: ${phase.exit}`}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Chip tone={live?.status === "done" ? "success" : "accent"}>
            {live?.status ?? "pending"}
          </Chip>
          {phase.qa ? (
            <Chip tone="info">QA on · fresh context each round</Chip>
          ) : (
            <Chip tone="warn">no QA pass</Chip>
          )}
          {(live?.qaRounds ?? 0) > 0 && (
            <Chip tone={(live?.qaRounds ?? 0) > 1 ? "warn" : "neutral"}>
              {live?.qaRounds} QA {live?.qaRounds === 1 ? "round" : "rounds"}
            </Chip>
          )}
          <Chip tone="neutral">round cap {spec.policy.maxRemediationRounds}</Chip>
          <Chip tone="neutral">{counts.waves} waves</Chip>
        </div>
        <p className="max-w-4xl text-xs leading-relaxed text-secondary">{phase.description}</p>
      </Section>

      <Section
        id="phase-acceptance"
        title="Phase acceptance"
        state={sections}
        hint="what QA checks before the gate — every involved lead must agree"
      >
        <PhaseAcceptance plan={plan} phaseId={phaseId} />
      </Section>

      <Section
        id="phase-dag"
        title="Waves and tasks"
        state={sections}
        hint="columns are waves — every task in a column can start at the same moment"
      >
        <Dag plan={plan} phaseId={phaseId} nav={nav} />
      </Section>

      <Section
        id="phase-schedule"
        title="Concurrency"
        state={sections}
        hint="what the caps actually permit"
      >
        <ScheduleStrip plan={plan} phaseId={phaseId} />
      </Section>

      <Section
        id="phase-qa"
        title="QA history"
        state={sections}
        hint="the spec is never edited — accepted tasks join the run's effective list"
      >
        <QaHistory plan={plan} phaseId={phaseId} nav={nav} />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------- acceptance */

function PhaseAcceptance({ plan, phaseId }: { plan: Plan; phaseId: string }) {
  const gates = gatePreviews(plan, { phaseId });
  if (gates.length === 0) return <Empty>this phase declares no acceptance criteria</Empty>;
  return (
    <div className="flex flex-col gap-1.5">
      {gates.map((g) => (
        <div key={g.criterion.id} className="rounded-lg border border-line bg-panel px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-primary">{g.criterion.title}</span>
            <span className="cm-mono text-2xs text-faint">{g.criterion.id}</span>
            <Chip
              tone={
                g.criterion.verify === "command"
                  ? "success"
                  : g.criterion.verify === "human"
                    ? "warn"
                    : "info"
              }
              icon={g.criterion.verify === "command" ? <Terminal /> : <UserCheck />}
            >
              {g.criterion.verify}
            </Chip>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-2xs text-faint">
                {g.implied ? "whole phase signs" : `${g.signatories.length} sign`}
              </span>
              {g.signatories.map((tid) => (
                <span
                  key={tid}
                  title={plan.spec.teams.find((t) => t.id === tid)?.name}
                  className="flex items-center gap-1 rounded border border-line bg-panel-2 px-1.5 py-px text-2xs text-secondary"
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: teamColor(plan.spec, tid) }}
                  />
                  {plan.spec.teams.find((t) => t.id === tid)?.name ?? tid}
                </span>
              ))}
            </span>
          </div>
          <div className="mt-1.5 grid gap-x-3 gap-y-0.5 text-2xs leading-relaxed [grid-template-columns:2.6rem_1fr]">
            {g.criterion.given && (
              <>
                <span className="cm-mono text-faint">given</span>
                <span className="text-muted">{g.criterion.given}</span>
              </>
            )}
            {g.criterion.when && (
              <>
                <span className="cm-mono text-faint">when</span>
                <span className="text-muted">{g.criterion.when}</span>
              </>
            )}
            <span className="cm-mono text-faint">then</span>
            <span className="text-secondary">{g.criterion.then}</span>
          </div>
          {g.satisfiedBy.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] leading-4 text-faint">built by</span>
              {g.satisfiedBy.map((t) => (
                <span
                  key={t.id}
                  className="cm-mono rounded bg-inset px-1 text-[10px] leading-4 text-muted"
                >
                  {t.id}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- the DAG */

function Dag({ plan, phaseId, nav }: { plan: Plan; phaseId: string; nav: Nav }) {
  const groups = useMemo(() => waveGroups(plan, phaseId), [plan, phaseId]);
  const wrap = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<Array<{ key: string; d: string; color: string }>>([]);

  // Edges are measured from the laid-out cards rather than computed from a
  // fixed grid: the cards are content-sized, so any guess at their geometry
  // would drift the moment a title wrapped to two lines.
  useLayoutEffect(() => {
    const compute = () => {
      const box = wrap.current?.getBoundingClientRect();
      if (!box) return;
      const next: Array<{ key: string; d: string; color: string }> = [];
      for (const t of plan.tasks.filter((x) => x.phaseId === phaseId)) {
        for (const dep of t.dependsOn) {
          const a = cards.current.get(dep);
          const b = cards.current.get(t.id);
          if (!a || !b) continue;
          const ab = a.getBoundingClientRect();
          const bb = b.getBoundingClientRect();
          const x1 = ab.right - box.left;
          const y1 = ab.top + ab.height / 2 - box.top;
          const x2 = bb.left - box.left;
          const y2 = bb.top + bb.height / 2 - box.top;
          const mx = x1 + Math.max(18, (x2 - x1) / 2);
          next.push({
            key: `${dep}->${t.id}`,
            d: `M ${x1} ${y1} C ${mx} ${y1}, ${x2 - (x2 - x1) / 2} ${y2}, ${x2} ${y2}`,
            color: teamColor(plan.spec, t.teamId),
          });
        }
      }
      setEdges(next);
    };
    compute();
    // Safe against a feedback loop: the SVG is absolutely positioned with
    // pointer-events none, so drawing an edge can never resize what it measured.
    const ro = new ResizeObserver(compute);
    if (wrap.current) ro.observe(wrap.current);
    for (const el of cards.current.values()) ro.observe(el);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [plan, phaseId, groups]);

  return (
    <div ref={wrap} className="relative flex items-start gap-8 overflow-x-auto pb-2">
      <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {edges.map((e) => (
          <path
            key={e.key}
            d={e.d}
            fill="none"
            stroke={e.color}
            strokeWidth={1.5}
            strokeOpacity={0.55}
          />
        ))}
      </svg>
      {groups.map((tasks, i) => (
        <div key={i} className="relative flex min-w-[15.5rem] flex-col gap-2">
          <div className="flex items-center gap-1.5 pb-0.5">
            <span className="cm-mono rounded bg-inset px-1 py-px text-2xs text-muted">
              wave {i + 1}
            </span>
            <span className="text-2xs text-faint">{tasks.length}</span>
          </div>
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              plan={plan}
              task={t}
              onClick={() => nav.go({ at: "task", taskId: t.id })}
              register={(el) => {
                if (el) cards.current.set(t.id, el);
                else cards.current.delete(t.id);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TaskCard({
  plan,
  task,
  onClick,
  register,
}: {
  plan: Plan;
  task: MissionTask;
  onClick: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const team = plan.spec.teams.find((t) => t.id === task.teamId);
  const color = teamColor(plan.spec, task.teamId);
  const state = plan.run?.tasks[task.id];
  return (
    <div ref={register} className="relative z-10">
      <Card onClick={onClick} accent={color} className="px-2.5 py-2">
        <div className="pl-2">
          <div className="flex items-start gap-1.5">
            <span className="flex-1 text-xs font-medium leading-snug text-primary">
              {task.title}
            </span>
            {state && <TaskStatusPill status={state.status} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
            <span style={{ color }}>{team?.name ?? task.teamId}</span>
            {task.size && <span className="cm-mono text-faint">{task.size.toUpperCase()}</span>}
            <span className="cm-mono text-faint">{task.deliverable}</span>
            {task.remediationRound !== undefined && (
              <Chip tone="warn">QA r{task.remediationRound}</Chip>
            )}
          </div>
          {(state?.prs.length ?? 0) > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {state!.prs.map((pr) => (
                <span
                  key={pr.number}
                  title={pr.title}
                  className={cn(
                    "cm-mono rounded px-1 text-[10px] leading-4",
                    pr.state === "merged"
                      ? "bg-success-ghost text-success-hi"
                      : "bg-inset text-muted",
                  )}
                >
                  #{pr.number} {pr.state}
                </span>
              ))}
            </div>
          )}
          {task.satisfies.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {task.satisfies.map((s) => (
                <span
                  key={s}
                  className="cm-mono rounded bg-inset px-1 text-[10px] leading-4 text-muted"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- schedule */

function ScheduleStrip({ plan, phaseId }: { plan: Plan; phaseId: string }) {
  const slots = useMemo(() => scheduleFor(plan, phaseId), [plan, phaseId]);
  const waves = waveGroups(plan, phaseId).length;
  const clamped = slots.length > waves;

  return (
    <div>
      <p className="mb-2 text-2xs text-faint">
        {waves} waves → <span className={cn(clamped && "text-warn")}>{slots.length} steps</span>{" "}
        under maxParallelTasks {plan.spec.policy.maxParallelTasks} and each team's hire budget
        {clamped && " — the caps serialize this phase further than its graph does"}
      </p>
      <div className="flex flex-wrap gap-2">
        {slots.map((s) => (
          <div key={s.step} className="rounded-lg border border-line bg-panel-2 p-2">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="cm-mono text-2xs text-muted">step {s.step}</span>
              <span className="text-2xs text-faint">{s.tasks.length} concurrent</span>
            </div>
            <div className="flex flex-col gap-1">
              {s.tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-1.5">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: teamColor(plan.spec, t.teamId) }}
                  />
                  <span className="max-w-[13rem] truncate text-2xs text-secondary">{t.title}</span>
                </div>
              ))}
              {s.deferred.map((t) => (
                <div key={t.id} className="flex items-center gap-1.5 opacity-45">
                  <span className="size-1.5 shrink-0 rounded-full border border-line-strong" />
                  <span className="max-w-[13rem] truncate text-2xs text-muted line-through">
                    {t.title}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ QA history */

function QaHistory({ plan, phaseId, nav }: { plan: Plan; phaseId: string; nav: Nav }) {
  const rounds = (plan.run?.remediations ?? []).filter((r) => r.phaseId === phaseId);
  if (rounds.length === 0) return <Empty>no QA round has sent this phase back</Empty>;
  return (
    <div className="flex flex-col gap-2">
      {rounds.map((r) => {
        const qa = plan.run?.actors.find((a) => a.chatId === r.raisedBy.chatId);
        return (
          <div key={r.id} className="rounded-lg border border-warn-line bg-warn-ghost p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="warn">round {r.round}</Chip>
              <span className="text-xs font-medium text-primary">
                {r.unmet.length} criterion not met
              </span>
              {r.unmet.map((u) => (
                <span key={u} className="cm-mono text-2xs text-warn">
                  {u}
                </span>
              ))}
              <Chip tone={r.status === "accepted" ? "success" : "neutral"}>{r.status}</Chip>
              {qa && (
                <button
                  type="button"
                  onClick={() => nav.go({ at: "agent", actorId: qa.id })}
                  className="ml-auto rounded px-1.5 py-0.5 text-2xs text-muted hover:bg-hover hover:text-primary"
                >
                  {qa.name} →
                </button>
              )}
            </div>
            <p className="mt-1.5 text-2xs leading-relaxed text-secondary">{r.findings}</p>
            <div className="mt-2">
              <span className="text-[10px] leading-4 text-faint">tasks added</span>
              <div className="mt-1 flex flex-col gap-1">
                {r.tasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => nav.go({ at: "task", taskId: t.id })}
                    className="flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 text-left hover:border-line-strong"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: teamColor(plan.spec, t.teamId) }}
                    />
                    <span className="flex-1 truncate text-2xs text-primary">{t.title}</span>
                    <span className="cm-mono text-[10px] leading-4 text-faint">{t.id}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
