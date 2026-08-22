/**
 * The mock Program: the program for building the Program module.
 *
 * Self-referential on purpose. A demo spec about some imaginary feature proves
 * the renderer works; a spec about the thing we are actually proposing proves
 * the SCHEMA works — it has to carry a real dependency graph, a real team split,
 * and acceptance criteria that more than one team has to sign off on. Every
 * awkwardness visible here is an awkwardness the schema would have in anger.
 */
import type { ProgramSpec } from "./types.js";

/** Lead persona shared shape — leads never touch code, and it's enforced, not asked. */
const LEAD_GATING = [
  "Edit",
  "Write",
  "NotebookEdit",
  "mcp__manager__create_pr",
  "mcp__manager__approve_pr",
];

export const MOCK_PROGRAM: ProgramSpec = {
  id: "prg-program-module",
  projectId: "dispatch",
  version: 1,
  title: "Ship the Program module",
  objective:
    "Give Dispatch a project-manager layer: a human-approved Program spec (objective, " +
    "phases, tasks, teams) that a deterministic engine executes by spawning lead and " +
    "developer chats, with an RTE agent orchestrating cross-team communication and a " +
    "multi-lead done-agreement gating every acceptance criterion.",
  createdAt: Date.parse("2026-08-22T15:00:00Z"),
  createdByChatId: "chat-workflow-creator",

  orchestrator: {
    name: "RTE",
    effort: "high",
    disallowedTools: [...LEAD_GATING, "Bash", "mcp__manager__terminal"],
    instructions:
      "You are the Release Train Engineer for this program. You do not schedule work and " +
      "you do not write code — the engine owns readiness, spawning and phase arithmetic, " +
      "and it is always right about them.\n\n" +
      "Your job is the communication gap:\n" +
      "  1. ROUTE cross-team traffic. Intra-team messages (a developer to its own lead) " +
      "are delivered by the engine and never reach you. Lead-to-lead goes through you, " +
      "so two leads who share no context do not have to build one.\n" +
      "  2. CONVENE done-agreements. When the engine opens a gate, make sure every " +
      "signatory lead votes, chase the ones who haven't, and mediate a dispute before it " +
      "reaches the human.\n" +
      "  3. FILTER escalations. The workflow creator's attention is the scarcest resource " +
      "in the program. Forward what genuinely needs a decision; answer the rest.\n" +
      "  4. NOTICE silence. A task with no events past its threshold is a stall, not " +
      "progress.\n\n" +
      "Never restate a lead's report to another lead in full — send the 280-character " +
      "summary and the chat id. Anyone who needs the detail can read it.",
  },

  policy: {
    maxParallelTasks: 4,
    branching: "serialize-on-merge",
    onTaskFailure: "escalate",
    leadRecycle: { onPhaseGap: true, contextThreshold: 0.6 },
    prOverride: "escalate",
    spawnConsent: "program-grant",
  },

  /* ----------------------------------------------------- program acceptance */

  acceptance: [
    {
      id: "spec-validated",
      title: "A bad plan cannot be saved",
      given: "A Program spec that breaks a cap, a DAG rule, or leaves a criterion unsatisfied",
      when: "It is submitted for approval",
      then: "Validation fails naming the exact field, and for a cycle, the cycle path",
      verify: "command",
      check: "pnpm --filter @dispatch/shared exec vitest run program",
    },
    {
      id: "actors-addressable",
      title: "Actors can talk to each other",
      given: "Two live actor chats in the same run",
      when: "One sends the other a program event",
      then: "It lands as a Dispatch-attributed turn, not as words in the human's mouth",
      verify: "review",
    },
    {
      id: "engine-schedules",
      title: "Scheduling is deterministic",
      when: "A task's dependencies are all merged and reported",
      then: "The engine marks it ready without consulting any agent",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run program-engine",
    },
    {
      id: "gate-requires-consensus",
      title: "Done is agreed, not declared",
      given: "A criterion satisfied by tasks from more than one team",
      when: "The last of those tasks finishes",
      then: "The gate stays open until every involved lead votes, and any not-met disputes it",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run program-gates",
    },
    {
      id: "context-bounded",
      title: "No actor drowns",
      when: "An actor is woken with new activity",
      then: "The wake carries at most 8 events of at most 280 chars, plus pointers",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run program-wake",
    },
    {
      id: "escalation-reaches-human",
      title: "A dispute reaches a person",
      given: "A gate the RTE could not resolve",
      when: "It stays disputed past the escalation threshold",
      then: "An Attention Queue item appears against the creator's chat",
      verify: "review",
    },
    {
      id: "kill-switch",
      title: "One action stops everything",
      when: "The human hits Stop all on a running program",
      then: "Every actor chat is interrupted and the run moves to paused, with no orphans",
      verify: "human",
    },
    {
      id: "no-self-granted-overrides",
      title: "A lead cannot wave a PR through",
      given: "A lead holding a task whose PR is blocked on review or checks",
      when: "It attempts an override",
      then: "The guard refuses and converts the attempt into an escalation",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run program-guard",
    },
  ],

  /* ----------------------------------------------------------------- phases */

  phases: [
    {
      id: "foundations",
      order: 1,
      title: "Foundations",
      description:
        "The spec shape, its caps, its validator, and the two state tables. Nothing " +
        "executes yet — this phase exists so that everything after it can assume a " +
        "Program is well-formed and has somewhere to record what happened.",
      exit: "criteria-met",
      acceptance: [
        {
          id: "f-roundtrip",
          title: "Specs round-trip",
          then: "A spec written, stored and re-read is byte-identical",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run program",
        },
        {
          id: "f-caps-single-source",
          title: "One number, not three",
          then: "Every cap is read from shared/limits.ts by schema, validator and UI alike",
          verify: "review",
        },
      ],
    },
    {
      id: "comms",
      order: 2,
      title: "Communication",
      description:
        "The primitive the whole design rests on and the one thing Dispatch does not " +
        "have: an actor addressing another actor. Server-side delivery on top of the " +
        "existing resume path, an MCP surface over it, the append-only ledger, and the " +
        "wake composer that keeps a delta from becoming a replay.",
      exit: "criteria-met",
      acceptance: [
        {
          id: "c-attribution",
          title: "Dispatch speaks as Dispatch",
          then: "Every delivered event renders with a brief part, never as a human turn",
          verify: "review",
        },
        {
          id: "c-delta-not-replay",
          title: "Wakes are deltas",
          then: "An actor woken twice never sees the same event twice",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run program-wake",
        },
      ],
    },
    {
      id: "engine",
      order: 3,
      title: "Engine",
      description:
        "The deterministic half: readiness from the DAG, actor spawn and retire, gate " +
        "arithmetic, lead recycling, the kill switch, and the guard that stops a lead " +
        "granting itself a PR override. No agent judgement anywhere in this phase.",
      exit: "criteria-met",
      acceptance: [
        {
          id: "e-no-agent-in-loop",
          title: "No agent in the scheduling loop",
          then: "Readiness, gating and recycling are decided without a model call",
          verify: "review",
        },
      ],
    },
    {
      id: "actors",
      order: 4,
      title: "Actors",
      description:
        "Personas become real chats: the materializer that compiles a Persona into an " +
        "ephemeral AgentConfig, the RTE hub, the lead's brief/intake/vote loop, and the " +
        "capped handoff a retiring lead writes for its successor.",
      exit: "criteria-met",
      acceptance: [
        {
          id: "a-gating-enforced",
          title: "Leads cannot edit",
          then: "A lead chat's tool set genuinely excludes Edit, Write and create_pr",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run program-personas",
        },
      ],
    },
    {
      id: "surface",
      order: 5,
      title: "Surface",
      description:
        "What the human actually touches: the plan view this preview prototypes, the " +
        "persona and org view, the gate board wired into the Attention Queue, the Stop " +
        "all control, and an end-to-end run of a real program.",
      exit: "human-approval",
      acceptance: [
        {
          id: "s-visual-verified",
          title: "Verified by looking at it",
          then: "Every view is screenshotted against a running dev instance, not asserted",
          verify: "human",
        },
      ],
    },
  ],

  /* ------------------------------------------------------------------ teams */

  teams: [
    {
      id: "platform",
      name: "Platform",
      charter: "Schemas, the store, migrations, and anything that persists.",
      maxParallel: 2,
      lead: {
        name: "Platform Lead",
        effort: "high",
        disallowedTools: LEAD_GATING,
        instructions:
          "You own the durable shapes. Hold two lines your developers will push on:\n" +
          "  - Zod is the source of truth, and a type that isn't validated on the way OUT " +
          "of the store is not validated.\n" +
          "  - Migrations are APPEND ONLY. user_version is a count; inserting a step " +
          "re-runs the wrong SQL against a live store.\n" +
          "Reject a task report whose schema change has no test that a legacy record still " +
          "parses. Escalate to the RTE when a shape another team already builds on has to " +
          "change — that is a cross-team decision, not yours.",
      },
      developer: {
        name: "Platform Dev",
        effort: "high",
        instructions:
          "Write the schema first and the code that uses it second. Every field gets a " +
          "docblock naming WHY it exists — a comment restating the type is noise, a " +
          "comment naming the bug it prevents is why this codebase is maintainable.",
      },
    },
    {
      id: "comms",
      name: "Comms & MCP",
      charter: "Actor-to-actor delivery, the MCP tool surface, and the event ledger.",
      maxParallel: 2,
      lead: {
        name: "Comms Lead",
        effort: "high",
        disallowedTools: LEAD_GATING,
        instructions:
          "You own the primitive the rest of the program cannot work without, so you are " +
          "the team most likely to block others — say so early and loudly to the RTE " +
          "rather than late and quietly.\n" +
          "Two non-negotiables:\n" +
          "  - A delivered event is DISPATCH talking. It rides as a brief part; it never " +
          "renders as something the human said.\n" +
          "  - Summaries are capped and details are pulled, never pushed. A tool that lets " +
          "an actor paste 4KB into another actor's context has defeated the design.",
      },
      developer: {
        name: "Comms Dev",
        effort: "high",
        instructions:
          "Build on the existing resume path rather than a parallel one — it already " +
          "ensures a live session and carries authorship parts. Every new MCP tool needs " +
          "its description written for a model that has never seen this codebase.",
      },
    },
    {
      id: "engine",
      name: "Orchestration Engine",
      charter: "Readiness, spawning, gates, recycling, and the kill switch.",
      maxParallel: 3,
      lead: {
        name: "Engine Lead",
        effort: "xhigh",
        disallowedTools: LEAD_GATING,
        instructions:
          "Everything your team ships must be decidable without a model call. If a " +
          "developer proposes 'ask the RTE which task is next', that is the bug — the " +
          "engine is the thing that knows.\n" +
          "Watch for the silent failure mode specifically: a task that never becomes " +
          "ready looks exactly like a task that is still waiting. Every readiness rule " +
          "needs a test that proves the negative case eventually resolves.",
      },
      developer: {
        name: "Engine Dev",
        effort: "high",
        instructions:
          "Pure functions over run state wherever possible — readiness, wave assignment " +
          "and gate status should be testable without a database or a session.",
      },
    },
    {
      id: "experience",
      name: "Experience",
      charter: "Everything the human sees: plan, org, gates, and the stop control.",
      maxParallel: 2,
      lead: {
        name: "Experience Lead",
        effort: "high",
        disallowedTools: LEAD_GATING,
        instructions:
          "A UI change that builds and type-checks has been verified by nobody. Refuse " +
          "any task report that claims a view works without a screenshot of it working " +
          "against a running dev instance.\n" +
          "The program view has one job: make a bad plan look bad. An unsatisfied " +
          "criterion, a serialized chain that should have been parallel, a team with no " +
          "tasks — if the picture doesn't show it, the picture isn't finished.",
      },
      developer: {
        name: "Experience Dev",
        effort: "high",
        instructions:
          "Use the app's own tokens (--p-*) and components; never hardcode a colour. " +
          "Screenshot what you built and attach it to your report.",
      },
    },
    {
      id: "assurance",
      name: "Assurance",
      charter: "Validators, guard rules, and proving the negative cases.",
      maxParallel: 2,
      lead: {
        name: "Assurance Lead",
        effort: "high",
        disallowedTools: LEAD_GATING,
        instructions:
          "Your team writes the tests that fail before the fix, not the tests that " +
          "confirm the code that was just written.\n" +
          "Own the two rules with teeth: the DAG validator must name a cycle's path, and " +
          "the PR-override guard must convert an attempt into an escalation rather than " +
          "simply refusing it. A refusal a lead can retry forever is not a guard.",
      },
      developer: {
        name: "Assurance Dev",
        effort: "high",
        instructions:
          "Absolute-path fixtures must root from process.platform — a literal C:/ path is " +
          "a relative path on the Linux CI runner and will break the gate.",
      },
    },
  ],

  /* ------------------------------------------------------------------ tasks */

  tasks: [
    /* ---- phase 1: foundations ---- */
    {
      id: "t-schema",
      phaseId: "foundations",
      teamId: "platform",
      title: "Author the ProgramSpec schemas",
      brief:
        "Create packages/shared/src/program.ts with zod schemas for ProgramSpec, " +
        "Criterion, Phase, Task, Team, Persona and ProgramPolicy, mirroring the approved " +
        "proposal. Export types via shared/src/index.ts. Every cap must be imported from " +
        "limits.ts (task t-limits) rather than written inline — coordinate, do not " +
        "duplicate. Docblock each field with why it exists, matching the house style in " +
        "domain.ts. No engine, no store, no UI in this task.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [
        {
          id: "ts-1",
          title: "Round-trips",
          then: "A spec parsed and re-serialized is byte-identical",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run program",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-limits",
      phaseId: "foundations",
      teamId: "platform",
      title: "Name every cap in limits.ts",
      brief:
        "Add the PROGRAM_CAPS constant block to packages/shared/src/limits.ts, covering " +
        "every authoring limit in the proposal (title 80, objective 500, criteria 10, " +
        "phases 5, teams 5, tasks 50, task brief 1500, event summary 280, wake events 8, " +
        "and the rest). One exported frozen object. These are the numbers the schema, the " +
        "validator, the MCP tool descriptions and the UI must all quote.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [],
      deliverable: "pr",
      size: "s",
    },
    {
      id: "t-validate",
      phaseId: "foundations",
      teamId: "assurance",
      title: "DAG and traceability validator",
      brief:
        "Write validateProgramSpec(). Structural rules: phase orders unique and " +
        "contiguous from 1; every task's phaseId and teamId resolve; every dependsOn id " +
        "exists AND is in the same phase; the dependency graph is acyclic; no " +
        "self-dependency; criterion ids unique within their owner; every team referenced " +
        "by at least one task; every phase has at least one task. Traceability rules: " +
        "every program and phase criterion is satisfied by at least one task. Semantic " +
        "rules: verify:'command' requires check; a Persona has exactly one of agentId or " +
        "instructions. A cycle error must NAME THE CYCLE PATH — 'a cycle exists' is not " +
        "an actionable error.",
      dependsOn: ["t-schema", "t-limits"],
      satisfies: ["spec-validated"],
      acceptance: [
        {
          id: "tv-1",
          title: "Cycles are named",
          given: "A spec with a → b → c → a",
          when: "It is validated",
          then: "The error text contains the full cycle path",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run program",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-store",
      phaseId: "foundations",
      teamId: "platform",
      title: "Run and event tables",
      brief:
        "Add one APPEND-ONLY migration step to store/db.ts creating program_run (seq, id " +
        "unique, project_id, body) and program_event (seq, run_id, ts, body) with an " +
        "index on (run_id, seq). Add Store methods to read/write runs and append/range " +
        "events. Specs are NOT stored here — they belong in the config root as JSON " +
        "beside projects, because they are low-write, diffable and reusable as templates. " +
        "Only run state and the ledger are high-write.",
      dependsOn: ["t-schema"],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 2: comms ---- */
    {
      id: "t-deliver",
      phaseId: "comms",
      teamId: "comms",
      title: "Server-side actor delivery",
      brief:
        "Build ProgramCourier.deliver(chatId, event) on top of the same resume path " +
        "PrReviewWatcher uses: ensure a live session, then send the composed text with " +
        "parts [{kind:'brief', label, text}] so the transcript renders it as Dispatch " +
        "speaking. Never as a user turn. Handle the busy case (target mid-run) by queuing " +
        "rather than dropping.",
      dependsOn: [],
      satisfies: ["actors-addressable"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-ledger",
      phaseId: "comms",
      teamId: "platform",
      title: "Event ledger and unseen cursor",
      brief:
        "Append-only ProgramEvent writes plus a per-actor cursor so 'what has this actor " +
        "not seen' is a range query, not a scan. Enforce the caps at the write boundary: " +
        "a summary over 280 chars is a validation error, not a silent truncation.",
      dependsOn: [],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-mcp-tools",
      phaseId: "comms",
      teamId: "comms",
      title: "program_send / program_report MCP tools",
      brief:
        "Expose the courier to agents. program_send(to, kind, summary, detail?) for " +
        "actor-to-actor messages, with routing enforced server-side: intra-team goes " +
        "direct, lead-to-lead is rejected unless routed via the RTE. program_report " +
        "(outcome, summary, criteria[], followups[]) is how a developer finishes — a " +
        "structured shape, so a dev CANNOT hand its lead a wall of text. Tool " +
        "descriptions must be written for a model that has never seen this repo.",
      dependsOn: ["t-deliver"],
      satisfies: ["actors-addressable", "context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-wake",
      phaseId: "comms",
      teamId: "experience",
      title: "Wake composer",
      brief:
        "Given an actor and its unseen events, compose the wake: at most 8 events, each " +
        "at most 280 chars, plus a rendered state table of the actor's own tasks, plus " +
        "pointers (chatId, PR ref, row id) for anything deeper. Detail is NEVER inlined. " +
        "If more than 8 events are unseen, say how many were elided and let the actor " +
        "pull the rest. This function is the context-flood control — treat its budget as " +
        "a contract, and test it at the boundary.",
      dependsOn: ["t-mcp-tools", "t-ledger"],
      satisfies: ["context-bounded"],
      acceptance: [
        {
          id: "tw-1",
          title: "Budget holds",
          given: "40 unseen events",
          when: "A wake is composed",
          then: "It carries 8 summaries and an elision count, under the byte budget",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run program-wake",
        },
      ],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 3: engine ---- */
    {
      id: "t-readiness",
      phaseId: "engine",
      teamId: "engine",
      title: "Readiness resolver",
      brief:
        "A pure function from (spec, run) to the set of ready tasks. Under " +
        "serialize-on-merge a task is ready when every dependency has ALL of its PRs " +
        "merged and a filed report — a task may open more than one PR, so 'the PR merged' " +
        "is the wrong test. Respect team maxParallel and program maxParallelTasks. No " +
        "database, no session, no model call.",
      dependsOn: [],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-spawn",
      phaseId: "engine",
      teamId: "engine",
      title: "Actor spawn and retire",
      brief:
        "Spawn leads and developers from personas under a program-grant consent (one " +
        "approval at run start, not one per chat — a five-phase program would otherwise " +
        "prompt the human dozens of times). Record every actor chatId on the run: it is " +
        "what the kill switch and the recycler both read. Set Chat.purpose so the sidebar " +
        "can recognise them.",
      dependsOn: [],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-gates",
      phaseId: "engine",
      teamId: "engine",
      title: "Gate open, vote, adjudicate",
      brief:
        "Open a gate when every task satisfying a criterion is done. Signatories are " +
        "DERIVED from task.satisfies — the set of teams owning a satisfying task — and " +
        "frozen at open time. agreed = at least one 'met' and zero 'not-met'; any " +
        "'not-met' is disputed. A disputed gate notifies the RTE; past the threshold it " +
        "raises an Attention Queue item against the creator.",
      dependsOn: ["t-readiness"],
      satisfies: ["gate-requires-consensus"],
      acceptance: [
        {
          id: "tg-1",
          title: "Uninvolved leads are omitted",
          given: "A criterion satisfied only by Platform tasks",
          when: "Its gate opens",
          then: "Platform is the sole signatory and no other lead is asked",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run program-gates",
        },
      ],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-recycle",
      phaseId: "engine",
      teamId: "engine",
      title: "Lead recycling",
      brief:
        "A lead chat is reused across contiguous phases and retired on either trigger: " +
        "its team has no tasks in the upcoming phase, or broker.getContextUsage(chatId) " +
        "reports past policy.leadRecycle.contextThreshold. On retirement the lead writes " +
        "a LeadHandoff (carry <= 1500 chars, <= 5 watch-outs) that seeds its successor. " +
        "Both triggers are engine-observable — never ask the lead whether it feels full.",
      dependsOn: ["t-spawn"],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-killswitch",
      phaseId: "engine",
      teamId: "engine",
      title: "Stop all",
      brief:
        "One action that interrupts every actor chat on the run and moves it to paused. " +
        "It reads the actor chatIds off ProgramRun, so it works whether or not any agent " +
        "cooperates. Must leave no orphaned worktree or subApp process behind, and must " +
        "be idempotent — a second press on a paused run is a no-op, not an error.",
      dependsOn: ["t-spawn"],
      satisfies: ["kill-switch"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-guard",
      phaseId: "engine",
      teamId: "assurance",
      title: "Refuse self-granted PR overrides",
      brief:
        "A lead calling approve_pr with allowNoReview or allowNoChecks must be refused " +
        "AND have the attempt converted into an escalation to the RTE — a bare refusal is " +
        "something a model retries in a loop. This upholds the rule PR #15 established: " +
        "those flags are requests that raise a permission card in front of a human, and " +
        "an actor that could self-approve would make that card unreachable.",
      dependsOn: ["t-spawn"],
      satisfies: ["no-self-granted-overrides"],
      acceptance: [
        {
          id: "tgu-1",
          title: "Refusal escalates",
          given: "A lead attempting allowNoReview",
          when: "The guard fires",
          then: "The call is refused and an escalation event is appended",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run program-guard",
        },
      ],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 4: actors ---- */
    {
      id: "t-personas",
      phaseId: "actors",
      teamId: "platform",
      title: "Persona materializer",
      brief:
        "Compile a Persona into an ephemeral AgentConfig at spawn time — reusing the " +
        "existing agent machinery rather than inventing a second system for 'an agent's " +
        "instructions'. Honour agentId (reuse a configured agent) exclusive-or " +
        "instructions (inline). disallowedTools is what makes 'a lead makes no code " +
        "changes' enforced rather than merely requested, so it must actually reach the " +
        "session's tool gating.",
      dependsOn: [],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-rte",
      phaseId: "actors",
      teamId: "engine",
      title: "RTE hub",
      brief:
        "The orchestrator's loop: receive cross-team traffic, route it, convene gates, " +
        "chase non-voting signatories, mediate disputes, and filter what reaches the " +
        "creator. It must NOT be given scheduling tools — readiness is the engine's, and " +
        "an RTE that can schedule will start doing topological sort in prose.",
      dependsOn: ["t-personas"],
      satisfies: ["escalation-reaches-human"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-lead",
      phaseId: "actors",
      teamId: "engine",
      title: "Team lead loop",
      brief:
        "Phase brief on wake, developer spawn within maxParallel, report intake with " +
        "acceptance judgement, question answering, and gate voting. A lead may stop its " +
        "own developers and escalate to the RTE; it may not touch another team's actors.",
      dependsOn: ["t-personas"],
      satisfies: ["gate-requires-consensus"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-handoff",
      phaseId: "actors",
      teamId: "engine",
      title: "Lead handoff",
      brief:
        "On retirement a lead writes LeadHandoff { carry <= 1500, watchOut: <= 5 x 200 } " +
        "and the engine seeds the successor chat with it plus the run state. Model it on " +
        "Chat.harnessHandoff, which solves the same problem for a runtime migration.",
      dependsOn: ["t-lead"],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "s",
    },

    /* ---- phase 5: surface ---- */
    {
      id: "t-plan-view",
      phaseId: "surface",
      teamId: "experience",
      title: "Plan view",
      brief:
        "Promote this preview into a real view: phases as columns, tasks by wave, " +
        "dependency edges, team colouring, and the concurrency clamp made visible. Drill " +
        "into a task for its brief, dependencies and the criteria it satisfies. Screenshot " +
        "it against a running dev instance before reporting done.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-org-view",
      phaseId: "surface",
      teamId: "experience",
      title: "Org and persona view",
      brief:
        "The actor tree — creator, RTE, leads, developers — with each persona's " +
        "instructions, model, effort and tool gating inspectable. Show which leads are " +
        "live, which are retired, and each live lead's context fill against the recycle " +
        "threshold.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-gate-view",
      phaseId: "surface",
      teamId: "experience",
      title: "Gate board and Stop all",
      brief:
        "Every criterion with its derived signatories and their votes, disputes surfaced " +
        "first, wired into the Attention Queue. Plus the Stop all control, which needs a " +
        "confirmation: it interrupts every actor in the program.",
      dependsOn: ["t-plan-view"],
      satisfies: ["escalation-reaches-human", "kill-switch"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-e2e",
      phaseId: "surface",
      teamId: "assurance",
      title: "End-to-end run",
      brief:
        "Drive a small real program from approval to completion against a scratch " +
        "project: actors spawn, tasks serialize on merge, a gate is disputed and resolved, " +
        "a lead is recycled at a phase gap, and Stop all leaves nothing orphaned.",
      dependsOn: ["t-plan-view", "t-org-view"],
      satisfies: ["engine-schedules", "gate-requires-consensus"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
  ],
};
