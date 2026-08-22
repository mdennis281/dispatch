/**
 * PROPOSAL PREVIEW — the Program module's plan, rendered so it can be argued
 * with. Reachable at `/program-preview` in a DEV build only (see main.tsx).
 *
 * Nothing here talks to a server. The spec is the static mock in `mock.ts`, and
 * every number on screen — waves, concurrency steps, gate signatories, cap
 * usage, validation errors — is derived live from it by `derive.ts`. That is
 * deliberate: it means the picture is a real test of the schema rather than an
 * illustration of it, and editing the mock immediately shows whether the shape
 * can express what you wanted.
 */
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Info,
  Network,
  Target,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip, Tabs } from "../../components/ui/index.js";
import { MOCK_PROGRAM } from "./mock.js";
import { teamColor, validate } from "./derive.js";
import { CAPS, type Criterion, type Persona, type ProgramSpec, type Task } from "./types.js";
import { PlanBoard } from "./PlanBoard.js";
import { OrgBoard, type PersonaPick } from "./OrgBoard.js";
import { GateBoard } from "./GateBoard.js";

type Section = "plan" | "org" | "gates";
type Detail =
  | { kind: "task"; task: Task }
  | { kind: "persona"; pick: PersonaPick }
  | { kind: "criterion"; criterion: Criterion }
  | null;

export function ProgramPreview() {
  const spec = MOCK_PROGRAM;
  const [section, setSection] = useState<Section>("plan");
  const [phaseId, setPhaseId] = useState(spec.phases[0]?.id ?? "");
  const [detail, setDetail] = useState<Detail>(null);
  const issues = validate(spec);
  const errors = issues.filter((i) => i.severity === "error");

  return (
    <div className="flex h-dvh w-full bg-app text-primary">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header spec={spec} errors={errors.length} warns={issues.length - errors.length} />

        <div className="flex shrink-0 items-center gap-2 px-3 py-2 cm-hairline-b">
          <Tabs
            value={section}
            onChange={(id) => setSection(id as Section)}
            tabs={[
              { id: "plan", label: "Plan", icon: <GitBranch size={13} /> },
              { id: "org", label: "Teams & personas", icon: <Network size={13} /> },
              { id: "gates", label: "Acceptance", icon: <CheckCircle2 size={13} /> },
            ]}
          />
          <div className="flex-1" />
          <PolicyChips spec={spec} />
        </div>

        {issues.length > 0 && <IssueBanner issues={issues} />}

        {section === "plan" && (
          <PlanBoard
            spec={spec}
            phaseId={phaseId}
            onPhase={setPhaseId}
            onTask={(task) => setDetail({ kind: "task", task })}
            selectedTaskId={detail?.kind === "task" ? detail.task.id : undefined}
          />
        )}
        {section === "org" && (
          <OrgBoard
            spec={spec}
            onPersona={(pick) => setDetail({ kind: "persona", pick })}
            selected={detail?.kind === "persona" ? detail.pick.role : undefined}
          />
        )}
        {section === "gates" && (
          <GateBoard
            spec={spec}
            onCriterion={(criterion) => setDetail({ kind: "criterion", criterion })}
            selected={detail?.kind === "criterion" ? detail.criterion.id : undefined}
          />
        )}
      </div>

      {detail && (
        <DetailPanel spec={spec} detail={detail} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ spec, errors, warns }: { spec: ProgramSpec; errors: number; warns: number }) {
  return (
    <div className="shrink-0 px-4 pb-3 pt-3.5 cm-hairline-b">
      <div className="flex flex-wrap items-center gap-2">
        <Target className="size-4 text-accent" />
        <h1 className="text-base font-semibold text-primary">{spec.title}</h1>
        <Chip tone="neutral" mono>
          v{spec.version}
        </Chip>
        <Chip tone="accent">proposal</Chip>
        {errors > 0 ? (
          <Chip tone="danger">
            {errors} validation {errors === 1 ? "error" : "errors"}
          </Chip>
        ) : (
          <Chip tone="success">validates</Chip>
        )}
        {warns > 0 && <Chip tone="warn">{warns} advisory</Chip>}
        <div className="flex-1" />
        <CapMeter label="objective" used={spec.objective.length} cap={CAPS.objective} />
        <CapMeter label="criteria" used={spec.acceptance.length} cap={CAPS.criteria} />
        <CapMeter label="phases" used={spec.phases.length} cap={CAPS.phases} />
        <CapMeter label="teams" used={spec.teams.length} cap={CAPS.teams} />
        <CapMeter label="tasks" used={spec.tasks.length} cap={CAPS.tasks} />
      </div>
      <p className="mt-1.5 max-w-5xl text-xs leading-relaxed text-secondary">{spec.objective}</p>
    </div>
  );
}

/** A cap and how much of it the plan spends — the authoring budget, made visible. */
function CapMeter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = Math.min(100, (used / cap) * 100);
  const hot = pct > 90;
  return (
    <div className="w-[5.2rem] shrink-0" title={`${label}: ${used} of ${cap}`}>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-[10px] leading-4 text-faint">{label}</span>
        <span className={cn("cm-mono text-[10px] leading-4", hot ? "text-warn" : "text-muted")}>
          {used}/{cap}
        </span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-inset">
        <div
          className={cn("h-full rounded-full", hot ? "bg-warn" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PolicyChips({ spec }: { spec: ProgramSpec }) {
  const p = spec.policy;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip tone="neutral">≤{p.maxParallelTasks} concurrent</Chip>
      <Chip tone="neutral">{p.branching}</Chip>
      <Chip tone="neutral">recycle @ {Math.round(p.leadRecycle.contextThreshold * 100)}%</Chip>
      <Chip tone="warn">PR override: {p.prOverride}</Chip>
      <Chip tone="neutral">{p.spawnConsent}</Chip>
    </div>
  );
}

function IssueBanner({ issues }: { issues: ReturnType<typeof validate> }) {
  return (
    <div className="shrink-0 border-b border-line bg-panel-2 px-4 py-2">
      <div className="flex flex-col gap-1">
        {issues.map((i, n) => (
          <div key={n} className="flex items-start gap-1.5 text-2xs leading-relaxed">
            {i.severity === "error" ? (
              <AlertTriangle className="mt-px size-3 shrink-0 text-danger" />
            ) : (
              <Info className="mt-px size-3 shrink-0 text-warn" />
            )}
            <span className="cm-mono text-faint">{i.where}</span>
            <span className={i.severity === "error" ? "text-danger-hi" : "text-secondary"}>
              {i.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function DetailPanel({
  spec,
  detail,
  onClose,
}: {
  spec: ProgramSpec;
  detail: NonNullable<Detail>;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-[24rem] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 cm-hairline-b">
        <span className="text-xs font-semibold text-secondary">
          {detail.kind === "task"
            ? "Task"
            : detail.kind === "persona"
              ? "Persona"
              : "Acceptance criterion"}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {detail.kind === "task" && <TaskDetail spec={spec} task={detail.task} />}
        {detail.kind === "persona" && <PersonaDetail pick={detail.pick} />}
        {detail.kind === "criterion" && <CriterionDetail criterion={detail.criterion} />}
      </div>
    </aside>
  );
}

function TaskDetail({ spec, task }: { spec: ProgramSpec; task: Task }) {
  const team = spec.teams.find((t) => t.id === task.teamId);
  const phase = spec.phases.find((p) => p.id === task.phaseId);
  const dependents = spec.tasks.filter((t) => t.dependsOn.includes(task.id));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold leading-snug text-primary">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="cm-mono text-2xs text-faint">{task.id}</span>
          <Chip tone="neutral">
            <span className="flex items-center gap-1">
              <span
                className="size-1.5 rounded-full"
                style={{ background: teamColor(spec, task.teamId) }}
              />
              {team?.name}
            </span>
          </Chip>
          <Chip tone="neutral">{phase?.title}</Chip>
          <Chip tone="neutral">{task.deliverable}</Chip>
          {task.size && <Chip tone="neutral">{task.size.toUpperCase()}</Chip>}
        </div>
      </div>

      <Field label={`Brief — the developer's entire context`} meter={{ used: task.brief.length, cap: CAPS.taskBrief }}>
        <p className="whitespace-pre-wrap text-2xs leading-relaxed text-secondary">{task.brief}</p>
      </Field>

      <Field label="Depends on">
        {task.dependsOn.length === 0 ? (
          <Empty>nothing — starts in wave 1</Empty>
        ) : (
          <div className="flex flex-col gap-1">
            {task.dependsOn.map((d) => {
              const dep = spec.tasks.find((t) => t.id === d);
              return (
                <div key={d} className="flex items-center gap-1.5 text-2xs text-secondary">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: dep ? teamColor(spec, dep.teamId) : "var(--p-line)" }}
                  />
                  <span className="truncate">{dep?.title ?? d}</span>
                </div>
              );
            })}
            <p className="mt-0.5 text-[10px] leading-4 text-faint">
              Under {spec.policy.branching}, this task waits until every PR on each dependency is
              merged and its report is filed — a task may open more than one PR.
            </p>
          </div>
        )}
      </Field>

      {dependents.length > 0 && (
        <Field label="Blocks">
          <div className="flex flex-col gap-1">
            {dependents.map((d) => (
              <div key={d.id} className="truncate text-2xs text-secondary">
                {d.title}
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label="Satisfies">
        {task.satisfies.length === 0 ? (
          <Empty>no criterion — this team gets no vote at any gate</Empty>
        ) : (
          <div className="flex flex-col gap-1">
            {task.satisfies.map((s) => {
              const c =
                spec.acceptance.find((x) => x.id === s) ??
                spec.phases.flatMap((p) => p.acceptance).find((x) => x.id === s);
              return (
                <div key={s} className="text-2xs text-secondary">
                  <span className="cm-mono text-faint">{s}</span> — {c?.title ?? "unknown"}
                </div>
              );
            })}
          </div>
        )}
      </Field>

      {task.acceptance.length > 0 && (
        <Field label="Task-local acceptance">
          <div className="flex flex-col gap-2">
            {task.acceptance.map((c) => (
              <CriterionBlock key={c.id} criterion={c} />
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

function PersonaDetail({ pick }: { pick: PersonaPick }) {
  const { persona, role } = pick;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold text-primary">{persona.name}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Chip tone="accent">{role}</Chip>
          {persona.effort && <Chip tone="neutral">effort {persona.effort}</Chip>}
          {persona.model && <Chip tone="neutral">{persona.model}</Chip>}
        </div>
      </div>

      <Field
        label="Instructions"
        meter={{ used: persona.instructions?.length ?? 0, cap: CAPS.personaInstructions }}
      >
        <p className="whitespace-pre-wrap text-2xs leading-relaxed text-secondary">
          {persona.instructions ?? `reuses configured agent "${persona.agentId}"`}
        </p>
      </Field>

      {persona.disallowedTools?.length ? (
        <Field label="Blocked tools — enforced at spawn">
          <div className="flex flex-wrap gap-1">
            {persona.disallowedTools.map((t) => (
              <span
                key={t}
                className="cm-mono rounded border border-danger-line bg-danger-ghost px-1 text-[10px] leading-4 text-danger-hi"
              >
                {t}
              </span>
            ))}
          </div>
        </Field>
      ) : (
        <Field label="Blocked tools">
          <Empty>none — this actor writes code</Empty>
        </Field>
      )}

      <div className="rounded-md border border-line bg-panel-2 p-2 text-[10px] leading-relaxed text-muted">
        A persona compiles to an ephemeral <b className="text-secondary">AgentConfig</b> at spawn
        time rather than being a parallel system for agent instructions — which is what makes the
        blocked-tool list real rather than a request in prose.
      </div>
    </div>
  );
}

function CriterionDetail({ criterion }: { criterion: Criterion }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold text-primary">{criterion.title}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Chip tone="neutral" mono>
            {criterion.id}
          </Chip>
          <Chip tone={criterion.verify === "command" ? "success" : "info"}>
            verify: {criterion.verify}
          </Chip>
        </div>
      </div>
      <CriterionBlock criterion={criterion} />
      {criterion.check && (
        <Field label="Check">
          <code className="cm-mono block rounded bg-inset px-1.5 py-1 text-[10px] leading-relaxed text-secondary">
            {criterion.check}
          </code>
        </Field>
      )}
    </div>
  );
}

function CriterionBlock({ criterion }: { criterion: Criterion }) {
  return (
    <div className="grid gap-x-2 gap-y-0.5 text-2xs leading-relaxed [grid-template-columns:2.6rem_1fr]">
      {criterion.given && (
        <>
          <span className="cm-mono text-faint">given</span>
          <span className="text-muted">{criterion.given}</span>
        </>
      )}
      {criterion.when && (
        <>
          <span className="cm-mono text-faint">when</span>
          <span className="text-muted">{criterion.when}</span>
        </>
      )}
      <span className="cm-mono text-faint">then</span>
      <span className="text-secondary">{criterion.then}</span>
    </div>
  );
}

function Field({
  label,
  meter,
  children,
}: {
  label: string;
  meter?: { used: number; cap: number };
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase leading-4 tracking-wide text-faint">
          {label}
        </span>
        {meter && (
          <span className="cm-mono ml-auto text-[10px] leading-4 text-faint">
            {meter.used}/{meter.cap}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span className="text-2xs italic text-faint">{children}</span>;
}
