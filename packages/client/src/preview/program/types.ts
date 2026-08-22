/**
 * PROPOSAL ONLY — the Program ("workflows") schema, as TypeScript types.
 *
 * This is the shape being pitched, rendered by the preview at `/program-preview`
 * so the plan can be argued about visually before any of it is built. It lives
 * under `preview/` and is imported by nothing in the real app on purpose: the
 * engine, the messaging primitive and the store tables it describes do not
 * exist yet, and a half-wired schema in `@dispatch/shared` would read as if they
 * did.
 *
 * WHY "Program" AND NOT "Workflow". Both good names are already taken in this
 * repo: `shared/workflow.ts` is the per-project ship profile (none/commit/
 * review) that drives the permission guard, and `domain.ts` already exports
 * `WorkflowDefSchema`/`WorkflowRunSchema` for GitHub Actions. A third meaning
 * would collide with both.
 *
 * When this graduates, every type below becomes a zod schema in
 * `shared/src/program.ts` and every cap becomes a named constant in
 * `shared/src/limits.ts` — so the validator, the MCP tool description and this
 * UI all quote one number instead of three that drift.
 */

/* --------------------------------------------------------------------- caps */

/**
 * Every authoring limit, in one place.
 *
 * These are HARD validation errors, not warnings. The spec's author is usually
 * a model, and a cap it can negotiate with is not a cap — the whole point of
 * bounding the plan is that the thing writing it cannot decide the bound
 * doesn't apply this time.
 */
export const CAPS = {
  title: 80,
  objective: 500,
  criteria: 10,
  criterionTitle: 80,
  criterionClause: 250,
  phases: 5,
  phaseDescription: 500,
  phaseCriteria: 10,
  teams: 5,
  teamName: 40,
  teamCharter: 300,
  tasks: 50,
  taskBrief: 1500,
  taskDeps: 10,
  taskCriteria: 5,
  taskSatisfies: 5,
  personaName: 40,
  personaInstructions: 2000,
  /** The context-flood control: what a single actor wake may carry. */
  eventSummary: 280,
  eventDetail: 4000,
  wakeEvents: 8,
  reportSummary: 500,
  handoffCarry: 1500,
} as const;

/* ----------------------------------------------------------------- identity */

/** `^[a-z0-9][a-z0-9-]{0,39}$` — stable, readable, URL-safe. */
export type Slug = string;

export type CriterionId = Slug;
export type PhaseId = Slug;
export type TaskId = Slug;
export type TeamId = Slug;

/* --------------------------------------------------------------- acceptance */

/**
 * Given/when/then as three capped fields rather than one 250-char blob.
 *
 * Only `then` is required, so a one-line criterion stays a one-liner and pays
 * no ceremony tax. The split earns its keep on the ones that aren't: a
 * structured assertion is something a verifier can be pointed at, and prose
 * isn't.
 */
export interface Criterion {
  id: CriterionId;
  title: string;
  given?: string;
  when?: string;
  /** The assertion. Always present — it is what "met" is judged against. */
  then: string;
  /** How the verdict is reached. */
  verify: "command" | "review" | "human";
  /** Required iff `verify === "command"`. Exit code is the verdict. */
  check?: string;
}

/* ------------------------------------------------------------------ personas */

/**
 * An actor's character. Compiles to an ephemeral {@link AgentConfig} at spawn
 * time rather than being a second, parallel system for "an agent's
 * instructions" — which is also how "a lead makes no code changes" becomes
 * ENFORCED (`disallowedTools`) instead of merely requested in prose.
 */
export interface Persona {
  /** Reuse a configured agent instead of inlining. Exclusive with `instructions`. */
  agentId?: string;
  name: string;
  instructions?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: string;
  disallowedTools?: string[];
}

/* -------------------------------------------------------------------- teams */

export interface Team {
  id: TeamId;
  name: string;
  /** What this team is FOR — the one line that decides if a task belongs here. */
  charter: string;
  lead: Persona;
  /** Template every developer on this team is spawned from. */
  developer: Persona;
  /** Concurrent developer chats this team may hold. */
  maxParallel: number;
}

/* ------------------------------------------------------------ phases & tasks */

export interface Phase {
  id: PhaseId;
  /** Unique, contiguous from 1. */
  order: number;
  title: string;
  description: string;
  acceptance: Criterion[];
  exit: "tasks-done" | "criteria-met" | "human-approval";
}

export interface Task {
  id: TaskId;
  phaseId: PhaseId;
  teamId: TeamId;
  title: string;
  /**
   * The developer's ENTIRE world. Deliberately larger than a phase description:
   * a phase is read by an actor that already has context, a task brief is the
   * whole prompt of a chat that has none.
   */
  brief: string;
  /** Same-phase task ids. Cross-phase ordering comes free from the phase gate. */
  dependsOn: TaskId[];
  /** Task-local checks, judged by the lead on intake. */
  acceptance: Criterion[];
  /**
   * Phase/program criteria this task contributes to.
   *
   * This is what makes the done-agreement DERIVABLE: a lead is a signatory on
   * criterion C iff their team owns at least one task with C in `satisfies`.
   * Authoring the signatory list by hand would let it drift out of step with
   * the plan it is supposed to describe. Empty is legal — scaffolding work
   * earns its team no vote.
   */
  satisfies: CriterionId[];
  deliverable: "pr" | "artifact" | "investigation";
  size?: "s" | "m" | "l";
}

/* ------------------------------------------------------------------- policy */

export interface ProgramPolicy {
  /** Program-wide ceiling on concurrent developer chats. */
  maxParallelTasks: number;
  /**
   * `serialize-on-merge`: a dependent task waits until EVERY PR on each of its
   * dependencies is merged and the report is filed, then branches off fresh
   * main. A task may open more than one PR, so "the PR merged" is not the test.
   */
  branching: "serialize-on-merge" | "stacked";
  onTaskFailure: "escalate" | "retry-once" | "halt-phase";
  leadRecycle: {
    /** Retire a lead when its team has no tasks in the upcoming phase. */
    onPhaseGap: true;
    /** Retire when the lead chat's context passes this fill fraction. */
    contextThreshold: number;
  };
  /**
   * Pinned. A lead may REQUEST a PR override; it can never self-grant one.
   * Relaxing this would reopen the hole PR #15 closed — `allowNoReview` and
   * `allowNoChecks` are requests that raise a permission card, and a lead that
   * could approve its own would make that card unreachable.
   */
  prOverride: "escalate";
  spawnConsent: "per-spawn" | "program-grant";
}

/* ------------------------------------------------------------------ the spec */

export interface ProgramSpec {
  id: string;
  projectId: string;
  /** Bumped by an accepted change proposal. A run pins the version it executes. */
  version: number;
  title: string;
  objective: string;
  acceptance: Criterion[];
  phases: Phase[];
  teams: Team[];
  /** FLAT, not nested under phases — dependency edges need one array to validate. */
  tasks: Task[];
  orchestrator: Persona;
  policy: ProgramPolicy;
  createdAt: number;
  createdByChatId: string;
}

/* ------------------------------------------------------- runtime (sketch) */

/** Who an event is from or to. */
export interface ActorRef {
  role: "creator" | "orchestrator" | "lead" | "developer" | "engine" | "human";
  teamId?: TeamId;
  taskId?: TaskId;
  chatId?: string;
}

/** The only thing a developer hands upward. Structured, so it can't be a wall of text. */
export interface TaskReport {
  outcome: "done" | "blocked" | "failed";
  summary: string;
  criteria: Array<{ id: CriterionId; met: boolean; note?: string }>;
  followups: string[];
}

/**
 * A done-agreement. Opened by the engine once every satisfying task is done;
 * `agreed` requires at least one `met` and zero `not-met` (an involved lead may
 * abstain when it genuinely cannot judge, but abstentions alone can't carry a
 * gate). Any `not-met` makes it `disputed`, which is the RTE's to mediate and
 * yours if the RTE can't.
 */
export interface Gate {
  scope: "criterion" | "phase" | "program";
  criterionId?: CriterionId;
  phaseId?: PhaseId;
  /** Derived from `satisfies`, frozen when the gate opens. */
  signatories: TeamId[];
  votes: Record<TeamId, { verdict: "met" | "not-met" | "abstain"; note: string }>;
  status: "open" | "agreed" | "disputed" | "withdrawn";
}
