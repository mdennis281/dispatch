/**
 * The plan view — phases, the dependency DAG, and what actually runs at once.
 *
 * The layout answers the question the spec text cannot: a phase is drawn as
 * WAVES left-to-right (everything in a column could start together) with the
 * dependency edges that force that shape, and a schedule strip underneath
 * showing what the concurrency caps reduce it to. The gap between the two is
 * the plan's real cost, and it is invisible in any list-shaped rendering.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, GitBranch, Layers, ShieldCheck, Users } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { scheduleFor, teamColor, waveGroups, wavesFor } from "./derive.js";
import type { ProgramSpec, Task } from "./types.js";

interface Props {
  spec: ProgramSpec;
  phaseId: string;
  onPhase: (id: string) => void;
  onTask: (t: Task) => void;
  selectedTaskId?: string;
}

export function PlanBoard({ spec, phaseId, onPhase, onTask, selectedTaskId }: Props) {
  const phase = spec.phases.find((p) => p.id === phaseId) ?? spec.phases[0];
  // A spec with zero phases fails validation; the picture still has to render
  // rather than throw, because the issue banner is what explains why.
  if (!phase) return <Hollow>this program has no phases</Hollow>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PhaseRail spec={spec} active={phase.id} onPhase={onPhase} />
      <div className="min-h-0 flex-1 overflow-auto">
        <PhaseHeader spec={spec} phaseId={phase.id} />
        <Dag spec={spec} phaseId={phase.id} onTask={onTask} selectedTaskId={selectedTaskId} />
        <ScheduleStrip spec={spec} phaseId={phase.id} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the rail */

/** The five phases in sequence — the "on top of that" layer, always visible. */
function PhaseRail({
  spec,
  active,
  onPhase,
}: {
  spec: ProgramSpec;
  active: string;
  onPhase: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto px-3 py-2.5 cm-hairline-b">
      {[...spec.phases]
        .sort((a, b) => a.order - b.order)
        .map((p, i) => {
          const tasks = spec.tasks.filter((t) => t.phaseId === p.id);
          const teams = [...new Set(tasks.map((t) => t.teamId))];
          const waves = waveGroups(spec, p.id).length;
          const on = p.id === active;
          return (
            <div key={p.id} className="flex items-center gap-1">
              {i > 0 && <ArrowRight className="size-3.5 shrink-0 text-faint" />}
              <button
                type="button"
                onClick={() => onPhase(p.id)}
                className={cn(
                  "min-w-[10.5rem] rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                  on
                    ? "border-accent-line bg-accent-ghost"
                    : "border-line bg-panel-2 hover:border-line-strong",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "cm-mono flex size-4 items-center justify-center rounded text-2xs",
                      on ? "bg-accent text-accent-fg" : "bg-inset text-muted",
                    )}
                  >
                    {p.order}
                  </span>
                  <span
                    className={cn(
                      "truncate text-xs font-semibold",
                      on ? "text-primary" : "text-secondary",
                    )}
                  >
                    {p.title}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-2xs text-muted">
                  <span>{tasks.length} tasks</span>
                  <span className="text-faint">·</span>
                  <span>{waves} waves</span>
                  <span className="ml-auto flex gap-0.5">
                    {teams.map((tid) => (
                      <span
                        key={tid}
                        className="size-1.5 rounded-full"
                        style={{ background: teamColor(spec, tid) }}
                      />
                    ))}
                  </span>
                </div>
              </button>
            </div>
          );
        })}
    </div>
  );
}

/* -------------------------------------------------------------- phase head */

function PhaseHeader({ spec, phaseId }: { spec: ProgramSpec; phaseId: string }) {
  const phase = spec.phases.find((p) => p.id === phaseId);
  if (!phase) return null;
  return (
    <div className="px-4 pb-3 pt-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold text-primary">{phase.title}</h2>
        <span className="cm-mono text-2xs text-faint">{phase.id}</span>
        <span className="ml-auto flex items-center gap-1 text-2xs text-muted">
          <ShieldCheck className="size-3" />
          exit: {phase.exit}
        </span>
      </div>
      <p className="mt-1.5 max-w-4xl text-xs leading-relaxed text-secondary">{phase.description}</p>
      {phase.acceptance.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {phase.acceptance.map((c) => (
            <span
              key={c.id}
              className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-2xs text-secondary"
              title={c.then}
            >
              {c.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the DAG */

function Dag({
  spec,
  phaseId,
  onTask,
  selectedTaskId,
}: {
  spec: ProgramSpec;
  phaseId: string;
  onTask: (t: Task) => void;
  selectedTaskId?: string;
}) {
  const groups = useMemo(() => waveGroups(spec, phaseId), [spec, phaseId]);
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
      for (const t of spec.tasks.filter((x) => x.phaseId === phaseId)) {
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
            color: teamColor(spec, t.teamId),
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
  }, [spec, phaseId, groups]);

  return (
    <div className="px-4 pb-2">
      <SectionTitle icon={<GitBranch className="size-3.5" />} label="Dependency graph">
        columns are waves — every task in a column can start at the same moment
      </SectionTitle>
      <div ref={wrap} className="relative flex items-start gap-8 overflow-x-auto pb-3 pt-1">
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
          <div key={i} className="relative flex min-w-[15rem] flex-col gap-2">
            <div className="flex items-center gap-1.5 pb-0.5">
              <span className="cm-mono rounded bg-inset px-1 py-px text-2xs text-muted">
                wave {i + 1}
              </span>
              <span className="text-2xs text-faint">{tasks.length}</span>
            </div>
            {tasks.map((t) => (
              <TaskCard
                key={t.id}
                spec={spec}
                task={t}
                selected={t.id === selectedTaskId}
                onClick={() => onTask(t)}
                register={(el) => {
                  if (el) cards.current.set(t.id, el);
                  else cards.current.delete(t.id);
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  spec,
  task,
  selected,
  onClick,
  register,
}: {
  spec: ProgramSpec;
  task: Task;
  selected: boolean;
  onClick: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const team = spec.teams.find((t) => t.id === task.teamId);
  const color = teamColor(spec, task.teamId);
  return (
    <div
      ref={register}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className={cn(
        "relative z-10 cursor-pointer rounded-lg border bg-panel px-2.5 py-2 transition-colors",
        selected ? "border-accent-line bg-accent-ghost" : "border-line hover:border-line-strong",
      )}
    >
      <span
        className="absolute inset-y-1.5 left-0 w-[3px] rounded-full"
        style={{ background: color }}
      />
      <div className="pl-2">
        <div className="text-xs font-medium leading-snug text-primary">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
          <span style={{ color }}>{team?.name ?? task.teamId}</span>
          {task.size && <span className="cm-mono text-faint">{task.size.toUpperCase()}</span>}
          <span className="cm-mono text-faint">{task.deliverable}</span>
        </div>
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
    </div>
  );
}

/* -------------------------------------------------------------- schedule */

/**
 * What the caps actually permit. Waves say "these five could run together";
 * this says "four do, and the fifth waits" — which is the number that decides
 * how long the phase takes.
 */
function ScheduleStrip({ spec, phaseId }: { spec: ProgramSpec; phaseId: string }) {
  const slots = useMemo(() => scheduleFor(spec, phaseId), [spec, phaseId]);
  const waves = waveGroups(spec, phaseId).length;
  const clamped = slots.length > waves;

  return (
    <div className="px-4 pb-6 pt-1">
      <SectionTitle icon={<Layers className="size-3.5" />} label="Concurrency preview">
        {waves} waves → <span className={cn(clamped && "text-warn")}>{slots.length} steps</span>{" "}
        under maxParallelTasks {spec.policy.maxParallelTasks}
        {clamped && " — the caps serialize this phase further than its graph does"}
      </SectionTitle>
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
                    style={{ background: teamColor(spec, t.teamId) }}
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
      <TeamLegend spec={spec} phaseId={phaseId} />
    </div>
  );
}

function TeamLegend({ spec, phaseId }: { spec: ProgramSpec; phaseId: string }) {
  const used = [...new Set(spec.tasks.filter((t) => t.phaseId === phaseId).map((t) => t.teamId))];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="flex items-center gap-1 text-2xs text-faint">
        <Users className="size-3" /> teams in this phase
      </span>
      {used.map((tid) => {
        const team = spec.teams.find((t) => t.id === tid);
        return (
          <span key={tid} className="flex items-center gap-1.5 text-2xs text-muted">
            <span
              className="size-2 rounded-full"
              style={{ background: teamColor(spec, tid) }}
            />
            {team?.name ?? tid}
            <Chip tone="neutral">max {team?.maxParallel}</Chip>
          </span>
        );
      })}
    </div>
  );
}

export function SectionTitle({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-secondary">
        {icon}
        {label}
      </span>
      <span className="text-2xs text-faint">{children}</span>
    </div>
  );
}

function Hollow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-faint">{children}</div>
  );
}
