/**
 * Everything the board SHOWS but the spec does not STORE.
 *
 * Waves, the concurrency schedule and a gate's signatory list are all pure
 * functions of the plan. Persisting any of them would be storing a second copy
 * of the truth that can disagree with the first — a stored `wave` on a task
 * survives an edit to `dependsOn` and then quietly lies. They recompute in
 * microseconds; derive them.
 *
 * Every function takes a {@link Plan}, not a spec, because the spec is not what
 * runs. A phase QA reopened is executing `spec.tasks` PLUS the tasks of every
 * accepted remediation, and a view that reads `spec.tasks` renders a reopened
 * phase as though nothing had changed.
 */
import type {
  Criterion,
  LiveActor,
  MissionRun,
  MissionSpec,
  MissionTask,
  MissionTaskId,
  TaskStatus,
  TeamId,
} from "./types.js";
import { CAPS } from "./types.js";

/** The spec, the tasks actually being executed, and (optionally) live state. */
export interface Plan {
  spec: MissionSpec;
  /** `spec.tasks` plus accepted remediation tasks. */
  tasks: MissionTask[];
  run?: MissionRun;
}

/* -------------------------------------------------------------------- waves */

/**
 * Topological level per task, 1-indexed, within one phase.
 *
 * A task's wave is one past the deepest wave it depends on, so every task in
 * wave N could in principle start at the same moment. This is the THEORETICAL
 * parallelism — what the dependency graph permits. What actually runs
 * concurrently is {@link scheduleFor}, which then applies the concurrency caps.
 * Showing both is the point: the gap between them is the plan's real cost.
 */
export function wavesFor(plan: Plan, phaseId: string): Map<MissionTaskId, number> {
  const tasks = plan.tasks.filter((t) => t.phaseId === phaseId);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const wave = new Map<MissionTaskId, number>();

  const visit = (id: MissionTaskId, seen: Set<MissionTaskId>): number => {
    const cached = wave.get(id);
    if (cached !== undefined) return cached;
    // A cycle is a validation error, not a render error. Break it at depth 1 so
    // the picture still draws and the issues list is what explains the problem.
    if (seen.has(id)) return 1;
    const task = byId.get(id);
    if (!task) return 1;
    seen.add(id);
    const deps = task.dependsOn.filter((d) => byId.has(d));
    const level = deps.length === 0 ? 1 : Math.max(...deps.map((d) => visit(d, seen))) + 1;
    seen.delete(id);
    wave.set(id, level);
    return level;
  };

  for (const t of tasks) visit(t.id, new Set());
  return wave;
}

/** Tasks of one phase, grouped by wave and ordered. */
export function waveGroups(plan: Plan, phaseId: string): MissionTask[][] {
  const wave = wavesFor(plan, phaseId);
  const groups: MissionTask[][] = [];
  for (const t of plan.tasks.filter((x) => x.phaseId === phaseId)) {
    const w = (wave.get(t.id) ?? 1) - 1;
    (groups[w] ??= []).push(t);
  }
  return groups.map((g) => g ?? []);
}

/* ------------------------------------------------------------------- counts */

/** The numbers the base screen shows per phase. */
export interface PhaseCounts {
  tasks: number;
  waves: number;
  /** PHASE acceptance criteria — not the tasks' own. */
  criteria: number;
  teams: TeamId[];
  done: number;
  running: number;
  /** Tasks QA added after the fact. */
  remediation: number;
  qaRounds: number;
}

export function phaseCounts(plan: Plan, phaseId: string): PhaseCounts {
  const phase = plan.spec.phases.find((p) => p.id === phaseId);
  const tasks = plan.tasks.filter((t) => t.phaseId === phaseId);
  const state = (id: MissionTaskId): TaskStatus | undefined => plan.run?.tasks[id]?.status;
  return {
    tasks: tasks.length,
    waves: waveGroups(plan, phaseId).length,
    criteria: phase?.acceptance.length ?? 0,
    teams: [...new Set(tasks.map((t) => t.teamId))],
    done: tasks.filter((t) => state(t.id) === "done").length,
    running: tasks.filter((t) => state(t.id) === "running" || state(t.id) === "in-review").length,
    remediation: tasks.filter((t) => t.remediationRound !== undefined).length,
    qaRounds: plan.run?.phases[phaseId]?.qaRounds ?? 0,
  };
}

/* ----------------------------------------------------------------- schedule */

/** One concurrent batch: what actually runs at the same time. */
export interface Slot {
  step: number;
  tasks: MissionTask[];
  /** Tasks that were dependency-free this step but had to wait on a cap. */
  deferred: MissionTask[];
}

/**
 * Simulate the phase under both concurrency caps.
 *
 * Greedy by step: take everything whose dependencies already completed, then
 * admit tasks until either the mission-wide `maxParallelTasks` or the owning
 * team's `hireBudget` is full. Whatever is left over is `deferred` — and that
 * list is the honest version of "this phase is parallel", because a wave of
 * five tasks under a cap of four is two steps, not one.
 */
export function scheduleFor(plan: Plan, phaseId: string): Slot[] {
  const tasks = plan.tasks.filter((t) => t.phaseId === phaseId);
  const teamCap = new Map(plan.spec.teams.map((t) => [t.id, t.hireBudget]));
  const done = new Set<MissionTaskId>();
  const slots: Slot[] = [];
  let remaining = [...tasks];
  let step = 1;

  // Bounded by task count: every step completes at least one task, or the graph
  // is cyclic and the validator has already said so.
  while (remaining.length > 0 && step <= tasks.length + 1) {
    const eligible = remaining.filter((t) =>
      t.dependsOn.filter((d) => tasks.some((x) => x.id === d)).every((d) => done.has(d)),
    );
    if (eligible.length === 0) break; // cycle — validator reports it

    const admitted: MissionTask[] = [];
    const deferred: MissionTask[] = [];
    const perTeam = new Map<TeamId, number>();
    for (const t of eligible) {
      const used = perTeam.get(t.teamId) ?? 0;
      const cap = teamCap.get(t.teamId) ?? 1;
      if (admitted.length >= plan.spec.policy.maxParallelTasks || used >= cap) {
        deferred.push(t);
        continue;
      }
      admitted.push(t);
      perTeam.set(t.teamId, used + 1);
    }

    slots.push({ step, tasks: admitted, deferred });
    for (const t of admitted) done.add(t.id);
    remaining = remaining.filter((t) => !done.has(t.id));
    step += 1;
  }
  return slots;
}

/* -------------------------------------------------------------------- gates */

export interface GatePreview {
  criterion: Criterion;
  scope: "mission" | "phase";
  phaseId?: string;
  /** Teams owning at least one satisfying task — the derived signatory list. */
  signatories: TeamId[];
  satisfiedBy: MissionTask[];
  /**
   * True when no task named this criterion and the signatories fell back to
   * "every team working in the phase". See {@link gatePreviews}.
   */
  implied: boolean;
}

/**
 * Every criterion with the leads who would have to agree it is done.
 *
 * Signatories are derived from `task.satisfies` rather than authored, which is
 * what keeps "the lead is omitted if uninvolved" true after a plan edit.
 */
export function gatePreviews(plan: Plan, opts?: { phaseId?: string }): GatePreview[] {
  const { spec } = plan;
  const out: GatePreview[] = [];
  const forCriterion = (criterion: Criterion, scope: "mission" | "phase", phaseId?: string) => {
    const satisfiedBy = plan.tasks.filter((t) => t.satisfies.includes(criterion.id));
    let signatories = [...new Set(satisfiedBy.map((t) => t.teamId))];
    // A PHASE criterion is frequently a property of the phase as a whole —
    // "specs round-trip", "every view was screenshotted" — that no single task
    // owns. Demanding a task name it was the first rule this preview broke:
    // seven of eight phase criteria failed it, and linking each to an arbitrary
    // task would have been bookkeeping, not traceability. So an unnamed phase
    // criterion falls back to "every team working in this phase signs", which
    // is what a phase gate means anyway. Mission criteria get no such fallback:
    // there, nothing building it really is a plan hole.
    let implied = false;
    if (signatories.length === 0 && scope === "phase" && phaseId) {
      signatories = [
        ...new Set(plan.tasks.filter((t) => t.phaseId === phaseId).map((t) => t.teamId)),
      ];
      implied = true;
    }
    out.push({ criterion, scope, phaseId, signatories, satisfiedBy, implied });
  };
  if (!opts?.phaseId) for (const c of spec.acceptance) forCriterion(c, "mission");
  for (const p of spec.phases) {
    if (opts?.phaseId && p.id !== opts.phaseId) continue;
    for (const c of p.acceptance) forCriterion(c, "phase", p.id);
  }
  return out;
}

/* --------------------------------------------------------------- validation */

export interface Issue {
  severity: "error" | "warn";
  where: string;
  message: string;
}

/**
 * The authoring gate, run live so the board can show a bad plan as bad.
 *
 * Mirrors what `validateMissionSpec` would enforce server-side. The rules that
 * matter most are the ones a human eye slides past: a mission criterion no task
 * contributes to (it can never be declared met), and a dependency edge crossing
 * a phase boundary (two contradictory orderings, since the phase gate already
 * sequences them).
 */
export function validate(plan: Plan): Issue[] {
  const { spec } = plan;
  const issues: Issue[] = [];
  const err = (where: string, message: string) =>
    issues.push({ severity: "error", where, message });
  const warn = (where: string, message: string) =>
    issues.push({ severity: "warn", where, message });

  /* caps */
  if (spec.title.length > CAPS.title) err("title", `over ${CAPS.title} chars`);
  if (spec.objective.length > CAPS.objective)
    err("objective", `${spec.objective.length} chars, cap ${CAPS.objective}`);
  if (spec.acceptance.length > CAPS.criteria)
    err("acceptance", `${spec.acceptance.length} criteria, cap ${CAPS.criteria}`);
  if (spec.acceptance.length === 0)
    err("acceptance", "a mission with no definition of done cannot be gated");
  if (spec.phases.length > CAPS.phases)
    err("phases", `${spec.phases.length} phases, cap ${CAPS.phases}`);
  if (spec.teams.length > CAPS.teams) err("teams", `${spec.teams.length} teams, cap ${CAPS.teams}`);
  if (plan.tasks.length > CAPS.tasks)
    err("tasks", `${plan.tasks.length} tasks, cap ${CAPS.tasks}`);

  /* phase order */
  const orders = spec.phases.map((p) => p.order).sort((a, b) => a - b);
  orders.forEach((o, i) => {
    if (o !== i + 1) err("phases", `order must be contiguous from 1 — saw ${orders.join(",")}`);
  });

  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const phaseIds = new Set(spec.phases.map((p) => p.id));
  const teamIds = new Set(spec.teams.map((t) => t.id));
  const roleIds = new Set(spec.roles.map((r) => r.id));

  for (const t of plan.tasks) {
    if (t.brief.length > CAPS.taskBrief)
      err(t.id, `brief is ${t.brief.length} chars, cap ${CAPS.taskBrief}`);
    if (!phaseIds.has(t.phaseId)) err(t.id, `unknown phaseId "${t.phaseId}"`);
    if (!teamIds.has(t.teamId)) err(t.id, `unknown teamId "${t.teamId}"`);
    if (t.dependsOn.includes(t.id)) err(t.id, "depends on itself");
    for (const d of t.dependsOn) {
      const dep = taskById.get(d);
      if (!dep) {
        err(t.id, `depends on unknown task "${d}"`);
        continue;
      }
      if (dep.phaseId !== t.phaseId)
        err(t.id, `depends on "${d}" in another phase — the phase gate already orders those`);
    }
  }

  /* cycles, named */
  for (const p of spec.phases) {
    const cycle = findCycle(plan.tasks.filter((t) => t.phaseId === p.id));
    if (cycle) err(p.id, `dependency cycle: ${cycle.join(" → ")}`);
  }

  /* coverage — the rules that catch a plan hole */
  for (const c of spec.acceptance) {
    if (!plan.tasks.some((t) => t.satisfies.includes(c.id)))
      err(
        "acceptance",
        `criterion "${c.id}" is satisfied by no task — it can never be declared met`,
      );
  }
  const allCriteria = [
    ...spec.acceptance.map((c) => ({ c, where: "acceptance" })),
    ...spec.phases.flatMap((p) => p.acceptance.map((c) => ({ c, where: p.id }))),
  ];
  for (const { c, where } of allCriteria) {
    if (c.verify === "command" && !c.check)
      err(where, `criterion "${c.id}" is verify:'command' with no check`);
  }
  for (const team of spec.teams) {
    if (!plan.tasks.some((t) => t.teamId === team.id)) err("teams", `team "${team.id}" owns no tasks`);
    for (const r of team.hireableRoles) {
      if (!roleIds.has(r)) err(team.id, `hireableRole "${r}" resolves to no role template`);
    }
    if (team.hireBudget < 1) err(team.id, "hireBudget must be at least 1");
  }
  for (const p of spec.phases) {
    if (!plan.tasks.some((t) => t.phaseId === p.id)) err(p.id, "phase has no tasks");
  }

  /* personas */
  const personas: Array<[string, { agentId?: string; instructions?: string }]> = [
    ["orchestrator", spec.orchestrator],
    ["qa", spec.qa],
    ...spec.teams.map((t) => [`${t.id}.lead`, t.lead] as [string, { instructions?: string }]),
  ];
  for (const [where, p] of personas) {
    if (!!p.agentId === !!p.instructions)
      err(where, "a persona needs exactly one of agentId or instructions");
    if ((p.instructions?.length ?? 0) > CAPS.personaInstructions)
      err(where, `instructions over ${CAPS.personaInstructions} chars`);
  }

  /* soft signals */
  const unlinked = plan.tasks.filter((t) => t.satisfies.length === 0);
  if (unlinked.length)
    warn(
      "tasks",
      `${unlinked.length} task(s) satisfy no criterion — legal for scaffolding, but their ` +
        `team gets no vote at any gate`,
    );
  for (const p of spec.phases) {
    if (!p.qa) warn(p.id, "no QA pass — nothing independently checks this phase's criteria");
  }

  return issues;
}

/** Depth-first cycle hunt that returns the PATH, because "a cycle exists" is not actionable. */
function findCycle(tasks: MissionTask[]): MissionTaskId[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<MissionTaskId, "open" | "done">();
  const stack: MissionTaskId[] = [];

  const walk = (id: MissionTaskId): MissionTaskId[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const found = walk(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const t of tasks) {
    const found = walk(t.id);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ colours */

/** Stable team → palette slot, so a team is the same colour in every view. */
export function teamColor(spec: MissionSpec, teamId: TeamId): string {
  const i = spec.teams.findIndex((t) => t.id === teamId);
  return `var(--p-cat-${(i < 0 ? 0 : i) + 1})`;
}

/* ------------------------------------------------------------------ actors */

/** Live actors attached to one task, oldest first. */
export function actorsForTask(plan: Plan, taskId: MissionTaskId): LiveActor[] {
  const ids = plan.run?.tasks[taskId]?.actorIds ?? [];
  return ids
    .map((id) => plan.run?.actors.find((a) => a.id === id))
    .filter((a): a is LiveActor => Boolean(a));
}

/** The lead actor for a team, live or retired. */
export function leadForTeam(plan: Plan, teamId: TeamId): LiveActor | undefined {
  return plan.run?.actors.find((a) => a.kind === "lead" && a.teamId === teamId);
}

/** Hires currently occupying a team's budget. */
export function liveHires(plan: Plan, teamId: TeamId): LiveActor[] {
  return (plan.run?.actors ?? []).filter(
    (a) => a.kind === "hire" && a.teamId === teamId && a.status !== "retired" && a.status !== "idle",
  );
}
