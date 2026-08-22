/**
 * One task — the brief, the graph around it, what it satisfies, and who worked
 * it.
 *
 * The agents section is the drill-in that makes hiring legible: a lead's choice
 * to put a researcher on a task instead of a developer is a decision worth
 * being able to find later, so `hiredBecause` is shown here rather than buried
 * in a transcript.
 */
import { ArrowUpRight, FileText, GitPullRequest, Users } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import {
  ActorStatusPill,
  Card,
  Crumbs,
  Empty,
  SectionTitle,
  TaskStatusPill,
  Tunable,
} from "./chrome.js";
import { actorsForTask, teamColor, type Plan } from "./derive.js";
import type { Nav } from "./nav.js";
import { CAPS } from "./types.js";

export function TaskScreen({ plan, taskId, nav }: { plan: Plan; taskId: string; nav: Nav }) {
  const { spec, run } = plan;
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return <div className="p-4 text-xs text-faint">no such task</div>;

  const phase = spec.phases.find((p) => p.id === task.phaseId);
  const team = spec.teams.find((t) => t.id === task.teamId);
  const state = run?.tasks[task.id];
  const actors = actorsForTask(plan, task.id);
  const dependents = plan.tasks.filter((t) => t.dependsOn.includes(task.id));
  const color = teamColor(spec, task.teamId);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="px-4 pb-3 pt-3">
        <Crumbs
          crumbs={[
            { label: spec.title, onClick: () => nav.go({ at: "program" }) },
            {
              label: `${phase?.order}. ${phase?.title}`,
              onClick: () => nav.go({ at: "phase", phaseId: task.phaseId }),
            },
            { label: task.title },
          ]}
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {state && <TaskStatusPill status={state.status} />}
          <Chip tone="neutral">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: color }} />
              {team?.name}
            </span>
          </Chip>
          <Chip tone="neutral">{task.deliverable}</Chip>
          {task.size && <Chip tone="neutral">size {task.size.toUpperCase()}</Chip>}
          {task.remediationRound !== undefined && (
            <Chip tone="warn">added by QA · round {task.remediationRound}</Chip>
          )}
          <span className="cm-mono text-2xs text-faint">{task.id}</span>
        </div>
      </div>

      <div className="grid gap-4 px-4 pb-6 [grid-template-columns:minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------- left */}
        <div className="flex flex-col gap-4">
          <div>
            <SectionTitle
              icon={<FileText className="size-3.5" />}
              label="Brief"
              right={
                <span className="cm-mono text-[10px] leading-4 text-faint">
                  {task.brief.length}/{CAPS.taskBrief}
                </span>
              }
            >
              the hire's entire context — it inherits nothing
            </SectionTitle>
            <div className="rounded-lg border border-line bg-panel p-2.5">
              <p className="whitespace-pre-wrap text-2xs leading-relaxed text-secondary">
                {task.brief}
              </p>
            </div>
          </div>

          {task.acceptance.length > 0 && (
            <div>
              <SectionTitle label="Task acceptance">judged by the lead on intake</SectionTitle>
              <div className="flex flex-col gap-1.5">
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
            </div>
          )}

          <div>
            <SectionTitle icon={<Users className="size-3.5" />} label="Agents on this task">
              hired by the lead, from its team's menu, within budget
            </SectionTitle>
            {actors.length === 0 ? (
              <Empty>nobody hired yet</Empty>
            ) : (
              <div className="flex flex-col gap-1.5">
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
          </div>
        </div>

        {/* ------------------------------------------------------ right */}
        <div className="flex flex-col gap-4">
          <div>
            <SectionTitle label="Dependencies" />
            {task.dependsOn.length === 0 ? (
              <Empty>none — starts in wave 1</Empty>
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
                        style={{
                          background: dep ? teamColor(spec, dep.teamId) : "var(--p-line)",
                        }}
                      />
                      <span className="flex-1 truncate text-2xs text-secondary">
                        {dep?.title ?? d}
                      </span>
                      {ds && <TaskStatusPill status={ds.status} />}
                    </button>
                  );
                })}
                <p className="mt-1 text-[10px] leading-relaxed text-faint">
                  Under {spec.policy.branching}, this waits until <b>every</b> PR on each
                  dependency is merged and its report is filed — a task may open more than one.
                </p>
              </div>
            )}
          </div>

          {dependents.length > 0 && (
            <div>
              <SectionTitle label="Blocks" />
              <div className="flex flex-col gap-1">
                {dependents.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => nav.go({ at: "task", taskId: d.id })}
                    className="truncate rounded px-1 py-0.5 text-left text-2xs text-secondary hover:bg-hover hover:text-primary"
                  >
                    {d.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <SectionTitle icon={<GitPullRequest className="size-3.5" />} label="Pull requests" />
            {(state?.prs.length ?? 0) === 0 ? (
              <Empty>none opened</Empty>
            ) : (
              <div className="flex flex-col gap-1">
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
          </div>

          <div>
            <SectionTitle label="Satisfies">
              which criteria this contributes to — and therefore who signs
            </SectionTitle>
            {task.satisfies.length === 0 ? (
              <Empty>no criterion — this team gets no vote from this task</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {task.satisfies.map((s) => {
                  const c =
                    spec.acceptance.find((x) => x.id === s) ??
                    spec.phases.flatMap((p) => p.acceptance).find((x) => x.id === s);
                  const scope = spec.acceptance.some((x) => x.id === s) ? "program" : "phase";
                  return (
                    <div key={s} className="rounded border border-line bg-panel px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        <Chip tone={scope === "program" ? "accent" : "neutral"}>{scope}</Chip>
                        <span className="truncate text-2xs text-primary">{c?.title ?? s}</span>
                      </div>
                      <span className="cm-mono text-[10px] leading-4 text-faint">{s}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <SectionTitle label="Overrides">changeable per task once the engine lands</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              <Tunable label="team" value={team?.name ?? task.teamId} />
              <Tunable label="deliverable" value={task.deliverable} />
              <Tunable label="attempts" value={state?.attempts ?? 0} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
