/**
 * One task — the brief, the graph around it, what it satisfies, and who worked
 * it.
 *
 * The agents section is the drill-in that makes hiring legible: a lead's choice
 * to put a researcher on a task instead of a developer is a decision worth
 * being able to find later, so `hiredBecause` is shown here rather than buried
 * in a transcript.
 */
import { ArrowUpRight } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { ActorStatusPill, Card, Empty, Section, TaskStatusPill, Tunable } from "./chrome.js";
import { actorsForTask, teamColor, type Plan } from "./derive.js";
import type { Nav } from "./nav.js";
import type { SectionState } from "./sections.js";
import { CAPS } from "./types.js";

export function TaskScreen({
  plan,
  taskId,
  nav,
  sections,
}: {
  plan: Plan;
  taskId: string;
  nav: Nav;
  sections: SectionState;
}) {
  const { spec, run } = plan;
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return <div className="p-4 text-xs text-faint">no such task</div>;

  const team = spec.teams.find((t) => t.id === task.teamId);
  const state = run?.tasks[task.id];
  const actors = actorsForTask(plan, task.id);
  const dependents = plan.tasks.filter((t) => t.dependsOn.includes(task.id));
  const color = teamColor(spec, task.teamId);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section
        id="task-brief"
        title="Brief"
        state={sections}
        hint="the hire's entire context — it inherits nothing"
        right={
          <span className="cm-mono text-[10px] leading-4 text-faint">
            {task.brief.length}/{CAPS.taskBrief}
          </span>
        }
      >
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          {state && <TaskStatusPill status={state.status} />}
          <Chip tone="neutral">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: color }} />
              {team?.name}
            </span>
          </Chip>
          <Tunable label="deliverable" value={task.deliverable} />
          {task.size && <Chip tone="neutral">size {task.size.toUpperCase()}</Chip>}
          {task.remediationRound !== undefined && (
            <Chip tone="warn">added by QA · round {task.remediationRound}</Chip>
          )}
          <span className="cm-mono text-2xs text-faint">{task.id}</span>
        </div>
        <div className="max-w-4xl rounded-lg border border-line bg-panel p-2.5">
          <p className="whitespace-pre-wrap text-2xs leading-relaxed text-secondary">
            {task.brief}
          </p>
        </div>
      </Section>

      <Section
        id="task-acceptance"
        title="MissionTask acceptance"
        state={sections}
        hint="judged by the lead on intake"
      >
        {task.acceptance.length === 0 ? (
          <Empty>none — this task is judged only by its phase's criteria</Empty>
        ) : (
          <div className="flex max-w-4xl flex-col gap-1.5">
            {task.acceptance.map((c) => (
              <div key={c.id} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-primary">{c.title}</span>
                  <Chip tone={c.verify === "command" ? "success" : "info"}>{c.verify}</Chip>
                </div>
                <div className="mt-1 grid gap-x-3 gap-y-0.5 text-2xs leading-relaxed [grid-template-columns:2.6rem_1fr]">
                  {c.given && (
                    <>
                      <span className="cm-mono text-faint">given</span>
                      <span className="text-muted">{c.given}</span>
                    </>
                  )}
                  {c.when && (
                    <>
                      <span className="cm-mono text-faint">when</span>
                      <span className="text-muted">{c.when}</span>
                    </>
                  )}
                  <span className="cm-mono text-faint">then</span>
                  <span className="text-secondary">{c.then}</span>
                </div>
                {c.check && (
                  <code className="cm-mono mt-1.5 block rounded bg-inset px-1.5 py-1 text-[10px] leading-relaxed text-secondary">
                    {c.check}
                  </code>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        id="task-graph"
        title="Dependencies"
        state={sections}
        hint={`${spec.policy.branching} — waits for every PR on each dependency`}
      >
        <div className="grid max-w-4xl gap-4 [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
          <div>
            <div className="mb-1 text-[10px] uppercase leading-4 tracking-wide text-faint">
              depends on
            </div>
            {task.dependsOn.length === 0 ? (
              <Empty>nothing — starts in wave 1</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {task.dependsOn.map((d) => {
                  const dep = plan.tasks.find((t) => t.id === d);
                  const ds = run?.tasks[d];
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => nav.go({ at: "task", taskId: d })}
                      className="flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 text-left hover:border-line-strong"
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: dep ? teamColor(spec, dep.teamId) : "var(--p-line)" }}
                      />
                      <span className="flex-1 truncate text-2xs text-secondary">
                        {dep?.title ?? d}
                      </span>
                      {ds && <TaskStatusPill status={ds.status} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase leading-4 tracking-wide text-faint">
              blocks
            </div>
            {dependents.length === 0 ? (
              <Empty>nothing waits on this</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {dependents.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => nav.go({ at: "task", taskId: d.id })}
                    className="flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 text-left hover:border-line-strong"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: teamColor(spec, d.teamId) }}
                    />
                    <span className="flex-1 truncate text-2xs text-secondary">{d.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section id="task-prs" title="Pull requests" state={sections}>
        {(state?.prs.length ?? 0) === 0 ? (
          <Empty>none opened</Empty>
        ) : (
          <div className="flex max-w-2xl flex-col gap-1">
            {state!.prs.map((pr) => (
              <div
                key={pr.number}
                className="flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1"
              >
                <span
                  className={cn(
                    "cm-mono text-2xs",
                    pr.state === "merged" ? "text-success" : "text-muted",
                  )}
                >
                  #{pr.number}
                </span>
                <span className="flex-1 truncate text-2xs text-secondary">{pr.title}</span>
                <Chip tone={pr.state === "merged" ? "success" : "info"}>{pr.state}</Chip>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        id="task-satisfies"
        title="Satisfies"
        state={sections}
        hint="which criteria this contributes to — and therefore who signs"
      >
        {task.satisfies.length === 0 ? (
          <Empty>no criterion — this team gets no vote from this task</Empty>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {task.satisfies.map((s) => {
              const c =
                spec.acceptance.find((x) => x.id === s) ??
                spec.phases.flatMap((p) => p.acceptance).find((x) => x.id === s);
              const scope = spec.acceptance.some((x) => x.id === s) ? "mission" : "phase";
              return (
                <div key={s} className="rounded border border-line bg-panel px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <Chip tone={scope === "mission" ? "accent" : "neutral"}>{scope}</Chip>
                    <span className="text-2xs text-primary">{c?.title ?? s}</span>
                  </div>
                  <span className="cm-mono text-[10px] leading-4 text-faint">{s}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        id="task-agents"
        title="Agents"
        state={sections}
        hint="hired by the lead, from its team's menu, within budget"
      >
        {actors.length === 0 ? (
          <Empty>nobody hired yet</Empty>
        ) : (
          <div className="flex max-w-3xl flex-col gap-1.5">
            {actors.map((a) => (
              <Card
                key={a.id}
                onClick={() => nav.go({ at: "agent", actorId: a.id })}
                accent={color}
                className="px-2.5 py-2"
              >
                <div className="pl-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-primary">{a.name}</span>
                    {a.roleTemplateId && (
                      <Chip tone="neutral" mono>
                        {a.roleTemplateId}
                      </Chip>
                    )}
                    <ActorStatusPill status={a.status} />
                    <ArrowUpRight className="ml-auto size-3 text-faint" />
                  </div>
                  <p className="mt-0.5 text-2xs text-muted">{a.activity}</p>
                  {a.hiredBecause && (
                    <p className="mt-1 border-l-2 border-line pl-2 text-2xs italic leading-relaxed text-faint">
                      {a.hiredBecause}
                    </p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
