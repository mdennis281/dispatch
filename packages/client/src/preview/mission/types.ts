/**
 * PROPOSAL ONLY — the Mission ("workflows") schema, as TypeScript types.
 *
 * This is the shape being pitched, rendered by the preview at `/mission-preview`
 * so the plan can be argued about visually before any of it is built. It lives
 * under `preview/` and is imported by nothing in the real app on purpose: the
 * engine, the comms primitive and the store tables it describes do not exist
 * yet, and a half-wired schema in `@dispatch/shared` would read as if they did.
 *
 * WHY "Mission", AND WHY NOT THE OBVIOUS NAMES.
 *
 *   - `Workflow` is taken TWICE. `shared/workflow.ts` is the per-project ship
 *     profile (none/commit/review) that drives the permission guard, and
 *     `domain.ts` already exports `WorkflowDefSchema`/`WorkflowRunSchema` for
 *     GitHub Actions. A third meaning would collide with both.
 *   - `Project` is a git repo here, in hundreds of places.
 *   - `Program` collides with nothing, and was the first pick for its SAFe fit
 *     with "RTE" — but a *program* is a piece of software, so `ProgramSpec` in a
 *     TypeScript file reads ambiguously. That optimised for the wrong reader.
 *   - `Effort` is reasoning effort (857 references). `Brief` is a MessagePart
 *     kind. `Track` and `Arc` are unsearchable.
 *
 * `Mission` wins on the thing none of the others have: the product is called
 * DISPATCH. Dispatch dispatches missions. The vocabulary then cascades for free
 * — a mission has an objective and a definition of accomplished, which is what
 * acceptance criteria are, and the board has an obvious name in Mission Control.
 *
 * `MissionTask` carries a prefix for the same reason: `AgentTask` already owns
 * "task" for quick actions, and `taskId` means a harness subagent in 135 other
 * places. The UI still says "task", because that is the right word on screen —
 * only the type needs disambiguating.
 *
 * When this graduates, every type below becomes a zod schema in
 * `shared/src/mission.ts` and every cap becomes a named constant in
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
  roleSummary: 200,
  /** The context-flood control: what a single actor wake may carry. */
  eventSummary: 280,
  eventDetail: 4000,
  wakeEvents: 8,
  reportSummary: 500,
  handoffCarry: 1500,
  /** How many times QA may send a phase back before it becomes the human's problem. */
  remediationRounds: 3,
  remediationFindings: 2000,
} as const;

/* ----------------------------------------------------------------- identity */

/** `^[a-z0-9][a-z0-9-]{0,39}$` — stable, readable, URL-safe. */
export type Slug = string;

export type CriterionId = Slug;
export type PhaseId = Slug;
export type MissionTaskId = Slug;
export type TeamId = Slug;
export type RoleId = Slug;
export type ActorId = Slug;

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

/* ---------------------------------------------------------- tools & profiles */

/**
 * Named default tool postures, so "read-only" is one decision made once rather
 * than a deny-list pasted into every persona and drifting between them.
 *
 * A profile is the DEFAULT. The mission manager can widen or narrow any actor
 * with {@link Persona.toolOverrides} — which is the point: the profile carries
 * the intent ("this actor observes"), the override carries the exception
 * ("…but this one also needs the browser"), and the two stay legible apart.
 */
export type ToolProfileId = "observer" | "reader" | "author" | "integrator";

export interface ToolProfile {
  id: ToolProfileId;
  name: string;
  summary: string;
  /** Tools excluded by this posture. The allow-list is "everything else". */
  deny: string[];
}

export const TOOL_PROFILES: Record<ToolProfileId, ToolProfile> = {
  observer: {
    id: "observer",
    name: "Observer",
    summary: "Reads and reasons. No filesystem writes, no shell, no PRs.",
    deny: [
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
      "PowerShell",
      "mcp__manager__terminal",
      "mcp__manager__create_pr",
      "mcp__manager__approve_pr",
    ],
  },
  reader: {
    id: "reader",
    name: "Reader",
    summary: "Observer plus a shell — can run tests and inspect, cannot author.",
    deny: [
      "Edit",
      "Write",
      "NotebookEdit",
      "mcp__manager__create_pr",
      "mcp__manager__approve_pr",
    ],
  },
  author: {
    id: "author",
    name: "Author",
    summary: "Writes code and opens PRs. Cannot approve or merge one.",
    deny: ["mcp__manager__approve_pr"],
  },
  integrator: {
    id: "integrator",
    name: "Integrator",
    summary: "Author plus merge rights. Reserved — no mission actor gets this by default.",
    deny: [],
  },
};

/* ------------------------------------------------------------------ personas */

/**
 * A hireable ROLE — the thing a team lead picks from when it decides who it
 * needs, rather than a body the mission author staffed up front.
 *
 * This replaced a fixed `Team.developer` template. A lead does not know at
 * authoring time whether closing a task needs a developer, a QA specialist or
 * somebody to go read an API's docs for an hour, and forcing the mission author
 * to guess produced exactly one shape of worker for every kind of work.
 */
export interface RoleTemplate {
  id: RoleId;
  name: string;
  /** One line the lead reads when choosing who to hire. */
  summary: string;
  toolProfile: ToolProfileId;
  /** Default brief prepended to every hire of this role. */
  instructions: string;
  /** Dispatch skills materialized into the hire's session. */
  skills: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Never reuse a chat for this role — every engagement starts clean.
   * True for QA: a verifier that has watched the work happen is no longer
   * checking the work, it is confirming its own memory of it.
   */
  freshContext?: boolean;
}

/**
 * A named actor's character. Compiles to an ephemeral `AgentConfig` at spawn
 * time rather than being a second, parallel system for "an agent's
 * instructions" — which is also how "a lead makes no code changes" becomes
 * ENFORCED rather than merely requested in prose.
 */
export interface Persona {
  /** Reuse a configured agent. Exclusive with `instructions`. */
  agentId?: string;
  name: string;
  /** Inherit defaults from a role; anything set below overrides the template. */
  roleTemplateId?: RoleId;
  instructions?: string;
  skills?: string[];
  toolProfile?: ToolProfileId;
  /**
   * The mission manager's exception to the profile. Kept separate from the
   * profile itself so the intent and the exception stay readable apart.
   */
  toolOverrides?: { allow?: string[]; deny?: string[] };
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** The effective tool deny-list for a persona: profile, plus/minus overrides. */
export function effectiveDeny(persona: Persona, roles: RoleTemplate[]): string[] {
  const role = roles.find((r) => r.id === persona.roleTemplateId);
  const profileId = persona.toolProfile ?? role?.toolProfile ?? "observer";
  const base = new Set(TOOL_PROFILES[profileId].deny);
  for (const t of persona.toolOverrides?.allow ?? []) base.delete(t);
  for (const t of persona.toolOverrides?.deny ?? []) base.add(t);
  return [...base];
}

/** The profile a persona resolves to, following its role template. */
export function effectiveProfile(persona: Persona, roles: RoleTemplate[]): ToolProfileId {
  const role = roles.find((r) => r.id === persona.roleTemplateId);
  return persona.toolProfile ?? role?.toolProfile ?? "observer";
}

/* -------------------------------------------------------------------- teams */

export interface Team {
  id: TeamId;
  name: string;
  /** What this team is FOR — the one line that decides if a task belongs here. */
  charter: string;
  lead: Persona;
  /**
   * Roles this lead may hire. The lead decides WHO it needs once the task is
   * underway; the mission author decides only what is on the menu.
   */
  hireableRoles: RoleId[];
  /**
   * Concurrent hired chats this lead may hold. The lead spends this budget
   * however it likes — three developers, or one developer and a QA, or one
   * researcher while it thinks.
   */
  hireBudget: number;
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
  /**
   * Run a QA pass against this phase's acceptance criteria before its gate.
   * A failing pass may ADD tasks to the phase — see {@link Remediation}.
   */
  qa: boolean;
}

export interface MissionTask {
  id: MissionTaskId;
  phaseId: PhaseId;
  teamId: TeamId;
  title: string;
  /**
   * The hire's ENTIRE world. Deliberately larger than a phase description: a
   * phase is read by an actor that already has context, a task brief is the
   * whole prompt of a chat that has none.
   */
  brief: string;
  /** Same-phase task ids. Cross-phase ordering comes free from the phase gate. */
  dependsOn: MissionTaskId[];
  /** MissionTask-local checks, judged by the lead on intake. */
  acceptance: Criterion[];
  /**
   * Phase/mission criteria this task contributes to.
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
  /**
   * Set when QA added this task to close an unmet criterion, naming the round
   * it came from. The plan's own audit trail: a phase that took three rounds
   * says so forever.
   */
  remediationRound?: number;
}

/* ------------------------------------------------------------------- policy */

export interface MissionPolicy {
  /** Mission-wide ceiling on concurrent hired chats, across every team. */
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
  /** How many QA rounds a phase may take before the human is asked. */
  maxRemediationRounds: number;
  /**
   * Pinned. A lead may REQUEST a PR override; it can never self-grant one.
   * Relaxing this would reopen the hole PR #15 closed — `allowNoReview` and
   * `allowNoChecks` are requests that raise a permission card, and a lead that
   * could approve its own would make that card unreachable.
   */
  prOverride: "escalate";
  spawnConsent: "per-spawn" | "mission-grant";
}

/* ------------------------------------------------------------------ the spec */

export interface MissionSpec {
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
  tasks: MissionTask[];
  /** The menu every lead hires from. */
  roles: RoleTemplate[];
  orchestrator: Persona;
  /** The QA persona. One per mission, respawned fresh for every phase it checks. */
  qa: Persona;
  policy: MissionPolicy;
  createdAt: number;
  createdByChatId: string;
}

/* ------------------------------------------------------------- runtime state */

export type RunStatus =
  | "draft"
  | "awaiting-approval"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "abandoned";

export type TaskStatus =
  | "blocked"
  | "ready"
  | "assigned"
  | "running"
  | "in-review"
  | "remediation"
  | "done"
  | "failed"
  | "cancelled";

export type ActorStatus = "idle" | "running" | "waiting-human" | "blocked" | "retired";

/** Who an event is from or to. */
export interface ActorRef {
  role: "creator" | "orchestrator" | "lead" | "hire" | "qa" | "engine" | "human";
  teamId?: TeamId;
  taskId?: MissionTaskId;
  chatId?: string;
}

/** A live actor chat. The bridge from the plan to something you can click into. */
export interface LiveActor {
  id: ActorId;
  chatId: string;
  kind: "orchestrator" | "lead" | "hire" | "qa";
  name: string;
  /** Set for hires: which role the lead chose off the menu. */
  roleTemplateId?: RoleId;
  teamId?: TeamId;
  taskId?: MissionTaskId;
  status: ActorStatus;
  /** 0..1 — drives lead recycling, read from `broker.getContextUsage`. */
  contextFill: number;
  /** One line: what it is doing right now. */
  activity: string;
  startedAt: number;
  /** Set once retired; a retired lead keeps its row so the history survives. */
  retiredAt?: number;
  /** Why this actor was hired, in the lead's own words. */
  hiredBecause?: string;
}

/** The only thing a hire hands upward. Structured, so it can't be a wall of text. */
export interface TaskReport {
  outcome: "done" | "blocked" | "failed";
  summary: string;
  criteria: Array<{ id: CriterionId; met: boolean; note?: string }>;
  followups: string[];
}

export interface LiveTask {
  status: TaskStatus;
  /** Actor ids that have worked this task, newest last. */
  actorIds: ActorId[];
  prs: Array<{ number: number; state: "open" | "merged" | "closed"; title: string }>;
  attempts: number;
  report?: TaskReport;
  startedAt?: number;
  endedAt?: number;
}

/**
 * A done-agreement. Opened by the engine once every satisfying task is done;
 * `agreed` requires at least one `met` and zero `not-met` (an involved lead may
 * abstain when it genuinely cannot judge, but abstentions alone can't carry a
 * gate). Any `not-met` makes it `disputed`, which is the RTE's to mediate and
 * the human's if the RTE can't.
 */
export interface Gate {
  criterionId: CriterionId;
  scope: "criterion" | "phase" | "mission";
  phaseId?: PhaseId;
  /** Derived from `satisfies`, frozen when the gate opens. */
  signatories: TeamId[];
  votes: Record<TeamId, { verdict: "met" | "not-met" | "abstain"; note: string }>;
  status: "pending" | "open" | "agreed" | "disputed" | "withdrawn";
}

/**
 * A QA round that sent a phase back — and the tasks it added to close the gap.
 *
 * This is how a phase adapts without editing the spec. The spec stays versioned
 * and immutable; the run's EFFECTIVE task list is `spec.tasks` plus the tasks of
 * every accepted remediation. That keeps the plan reviewable and makes the loop
 * auditable: a phase that needed three rounds says so forever, rather than
 * quietly having always contained nine tasks.
 */
export interface Remediation {
  id: string;
  phaseId: PhaseId;
  round: number;
  raisedBy: ActorRef;
  /** Which phase criteria QA judged unmet. */
  unmet: CriterionId[];
  findings: string;
  /** The tasks proposed to close them. Carry `remediationRound`. */
  tasks: MissionTask[];
  status: "proposed" | "accepted" | "rejected";
  decidedBy?: ActorRef;
}

export interface LivePhase {
  status: "pending" | "running" | "qa" | "gating" | "done" | "blocked";
  qaRounds: number;
  gates: Gate[];
}

/** One entry in the capped ledger. `summary` is what a wake carries. */
export interface MissionEvent {
  seq: number;
  ts: number;
  from: ActorRef;
  to: ActorRef;
  kind:
    | "status"
    | "report"
    | "question"
    | "answer"
    | "directive"
    | "escalation"
    | "decision"
    | "proposal"
    | "hire"
    | "gate";
  phaseId?: PhaseId;
  taskId?: MissionTaskId;
  /** ≤ CAPS.eventSummary. The ONLY thing injected into another actor's context. */
  summary: string;
  /** ≤ CAPS.eventDetail. Never injected — pulled on demand. */
  detail?: string;
}

export interface MissionRun {
  id: string;
  specId: string;
  specVersion: number;
  status: RunStatus;
  currentPhaseId?: PhaseId;
  actors: LiveActor[];
  tasks: Record<MissionTaskId, LiveTask>;
  phases: Record<PhaseId, LivePhase>;
  remediations: Remediation[];
  events: MissionEvent[];
  startedAt: number;
}

/* ------------------------------------------------------------ the PM's chat */

/**
 * A turn in the manager conversation — the human's only comms path into a run.
 *
 * Rendered by the mini chat beside the board. Deliberately the ordinary chat
 * transcript shape (`parts` carries authorship so Dispatch's own words are not
 * put in the human's mouth), because the mini chat is meant to BE a Dispatch
 * chat with the terminals and ship rails omitted, not a lookalike.
 */
export interface ManagerTurn {
  id: string;
  author: "human" | "manager";
  ts: number;
  text: string;
  /** Rendered as a labelled brief block rather than prose. */
  brief?: { label: string; text: string };
}
