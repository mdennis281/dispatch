/**
 * The mock Mission: the mission for building the Mission module.
 *
 * Self-referential on purpose. A demo spec about some imaginary feature proves
 * the renderer works; a spec about the thing we are actually proposing proves
 * the SCHEMA works — it has to carry a real dependency graph, a real team split,
 * and acceptance criteria that more than one team has to sign off on. Every
 * awkwardness visible here is an awkwardness the schema would have in anger.
 *
 * THIS MOCK DELIBERATELY FAILS VALIDATION, and the board is meant to open on a
 * red `1 error` chip. It carries SIX phases against `CAPS.phases: 5`, because
 * the tool-surface phase was added after the other five existed and the cap is
 * the first constraint this plan has actually hit.
 *
 * It is left broken rather than papered over, for two reasons. Widening a cap
 * the moment it first binds is how a cap stops being one — and this mock's own
 * flagship criterion is `spec-validated`, "a bad plan cannot be saved", so a
 * demo that quietly raised the limit to stay green would be arguing against
 * itself. The three honest resolutions (raise the cap to 6, merge Engine into
 * Actors, or split the tool-surface work into its own mission) are the owner's
 * call, and the manager chat asks for it — see the last turn of
 * `MOCK_MANAGER_CHAT`.
 *
 * The one advisory alongside it — `t-surface-gaps` satisfies no criterion — is
 * also deliberate: it is an investigation, and investigations earn their team
 * no vote at any gate.
 */
import type { MissionSpec, RoleTemplate } from "./types.js";

/* ---------------------------------------------------------- the hire menu */

/**
 * What a team lead may hire. The mission author sets the MENU; the lead decides
 * who it actually needs once a task is underway and it knows what the work is.
 */
const ROLES: RoleTemplate[] = [
  {
    id: "developer",
    name: "Developer",
    summary: "Implements a task end to end and opens the PR.",
    toolProfile: "author",
    effort: "high",
    skills: ["code-review"],
    instructions:
      "You own one task. Read the brief as your entire context — you inherit nothing from " +
      "the conversation that hired you.\n" +
      "Work in your own worktree, commit in small conventional commits, and open the PR " +
      "through create_pr. Report upward exactly once, through mission_report: outcome, a " +
      "summary under 500 characters, a verdict per acceptance criterion, and any followups. " +
      "Do not paste your reasoning to your lead — it has a context budget and your transcript " +
      "is one call away if it wants the detail.",
  },
  {
    id: "qa-specialist",
    name: "QA specialist",
    summary: "Verifies acceptance criteria against what was actually built. Never reuses context.",
    toolProfile: "reader",
    effort: "high",
    freshContext: true,
    skills: ["code-review", "security-review"],
    instructions:
      "You verify. You did not build any of this and you must not start.\n" +
      "You are given the phase's acceptance criteria, the tasks that claimed to satisfy them, " +
      "every task report, and read access to the whole project. Check the criteria against the " +
      "CODE and the RUNNING SYSTEM, not against the reports — a report saying a thing was done " +
      "is the claim under test, not evidence for it.\n" +
      "For each criterion return met or not-met with the evidence that decided it. Where a " +
      "criterion is not met, propose the specific tasks that would close it. Be concrete: " +
      "'add a test' is not a task, 'assert the cycle error names the path' is.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    summary: "Reads a PR adversarially and files review threads.",
    toolProfile: "observer",
    effort: "high",
    skills: ["code-review"],
    instructions:
      "Review the named PR against the task's acceptance criteria and the house rules. Try to " +
      "REFUTE the claim that it is done. File inline threads through post_review; a finding " +
      "with no line reference is a comment, not a review.",
  },
  {
    id: "researcher",
    name: "Researcher",
    summary: "Answers one question about the codebase or an external API. Writes no code.",
    toolProfile: "observer",
    effort: "medium",
    skills: [],
    instructions:
      "Answer the one question you were hired for and stop. Return findings with file paths " +
      "and line numbers, or URLs, so the answer is checkable. If the question turns out to be " +
      "the wrong question, say so — that is the most valuable thing you can return.",
  },
  {
    id: "ui-verifier",
    name: "UI verifier",
    summary: "Drives the running app and screenshots the change. Read-only on the repo.",
    toolProfile: "reader",
    effort: "medium",
    skills: ["run"],
    instructions:
      "A UI change that builds and type-checks has been verified by nobody. Start the sub-app, " +
      "navigate to the change, and attach a screenshot of it working. Use the accessibility " +
      "snapshot for 'is it present and does it say the right thing' and a picture only when the " +
      "question is genuinely visual. Report what you SAW, not what the code implies.",
  },
];

export const MOCK_MISSION: MissionSpec = {
  id: "msn-mission-module",
  projectId: "dispatch",
  version: 1,
  title: "Ship the Mission module",
  objective:
    "Give Dispatch a management layer: a human-approved Mission spec that a deterministic " +
    "engine executes by spawning leads who hire their own workers, with an RTE orchestrating " +
    "cross-team comms, a multi-lead done-agreement per criterion, and a QA loop that can send a " +
    "phase back. The chat-to-chat primitives it needs land as base Dispatch capabilities.",
  createdAt: Date.parse("2026-08-22T15:00:00Z"),
  createdByChatId: "chat-mission-author",
  roles: ROLES,

  orchestrator: {
    name: "RTE",
    toolProfile: "observer",
    effort: "high",
    skills: [],
    // The RTE coordinates; giving it a shell is giving it a way to start doing
    // the work instead, which is the failure mode this whole split exists to
    // prevent. Observer already denies Bash — spelled out so the intent survives
    // somebody later "helpfully" widening the profile.
    toolOverrides: { deny: ["mcp__dispatch-workspace__terminal", "mcp__dispatch-workspace__run_subapp"] },
    instructions:
      "You are the Release Train Engineer for this mission. You do not schedule work and you do " +
      "not write code — the engine owns readiness, hiring limits and phase arithmetic, and it is " +
      "always right about them.\n\n" +
      "Your job is the communication gap:\n" +
      "  1. ROUTE cross-team traffic. Intra-team messages — a hire to the lead that hired it — " +
      "are delivered by the engine and never reach you. Lead-to-lead goes through you, so two " +
      "leads who share no context do not have to build one.\n" +
      "  2. CONVENE done-agreements. When the engine opens a gate, make sure every signatory " +
      "lead votes, chase the ones who haven't, and mediate a dispute before it reaches the human.\n" +
      "  3. ADJUDICATE remediation. When QA sends a phase back, decide whether the proposed tasks " +
      "actually close the gap, and which team owns each. Rounds are capped — when the cap is hit " +
      "the human decides, not you.\n" +
      "  4. FILTER escalations. The mission manager's attention is the scarcest resource here. " +
      "Forward what genuinely needs a decision; answer the rest.\n" +
      "  5. NOTICE silence. A task with no events past its threshold is a stall, not progress.\n\n" +
      "Never restate a lead's report to another lead in full — send the 280-character summary and " +
      "the chat id. Anyone who needs the detail can read it.",
  },

  qa: {
    name: "Phase QA",
    roleTemplateId: "qa-specialist",
    effort: "xhigh",
    instructions:
      "You verify ONE phase against its acceptance criteria, with fresh context and full read " +
      "access to the project — the objective, every phase, every task and report, and the code " +
      "itself.\n" +
      "Return a verdict per criterion with the evidence. For anything not met, propose the tasks " +
      "that would close it and say which team should own each. You cannot add tasks yourself; the " +
      "RTE adjudicates what you propose, and the round is capped.",
  },

  policy: {
    maxParallelTasks: 4,
    branching: "serialize-on-merge",
    onTaskFailure: "escalate",
    leadRecycle: { onPhaseGap: true, contextThreshold: 0.6 },
    maxRemediationRounds: 3,
    prOverride: "escalate",
    spawnConsent: "mission-grant",
  },

  /* ----------------------------------------------------- mission acceptance */

  acceptance: [
    {
      id: "spec-validated",
      title: "A bad plan cannot be saved",
      given: "A Mission spec that breaks a cap, a DAG rule, or leaves a criterion unsatisfied",
      when: "It is submitted for approval",
      then: "Validation fails naming the exact field, and for a cycle, the cycle path",
      verify: "command",
      check: "pnpm --filter @dispatch/shared exec vitest run mission",
    },
    {
      id: "comms-is-general",
      title: "Chat-to-chat is a base capability",
      given: "Any two Dispatch chats, with no mission running",
      when: "One sends the other a message",
      then: "It lands as a Dispatch-attributed turn — the primitive is not Mission-only",
      verify: "review",
    },
    {
      id: "engine-schedules",
      title: "Scheduling is deterministic",
      when: "A task's dependencies are all merged and reported",
      then: "The engine marks it ready without consulting any agent",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run mission-engine",
    },
    {
      id: "leads-hire",
      title: "Leads choose their own workers",
      given: "A lead holding a ready task and a hire budget",
      when: "It decides the task needs a QA specialist rather than a developer",
      then: "It hires one off the role menu, within budget, without asking the human",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run mission-hiring",
    },
    {
      id: "gate-requires-consensus",
      title: "Done is agreed, not declared",
      given: "A criterion satisfied by tasks from more than one team",
      when: "The last of those tasks finishes",
      then: "The gate stays open until every involved lead votes, and any not-met disputes it",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run mission-gates",
    },
    {
      id: "qa-can-reopen",
      title: "QA can send a phase back",
      given: "A phase whose tasks are all done but whose criteria are not met",
      when: "QA reports the gap with proposed tasks",
      then: "The phase reopens with those tasks added, up to the round cap, then the human decides",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run mission-remediation",
    },
    {
      id: "context-bounded",
      title: "No actor drowns",
      when: "An actor is woken with new activity",
      then: "The wake carries at most 8 events of at most 280 chars, plus pointers",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run mission-wake",
    },
    {
      id: "escalation-reaches-human",
      title: "A dispute reaches a person",
      given: "A gate the RTE could not resolve",
      when: "It stays disputed past the escalation threshold",
      then: "The manager chat is woken and an Attention Queue item appears",
      verify: "review",
    },
    {
      id: "kill-switch",
      title: "One action stops everything",
      when: "The human hits Stop all on a running mission",
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
      check: "pnpm --filter @dispatch/server exec vitest run mission-guard",
    },
  ],

  /* ----------------------------------------------------------------- phases */

  phases: [
    {
      id: "tool-surface",
      order: 1,
      title: "Tool surface",
      description:
        "Break the monolithic `manager` MCP server into named category servers - github, " +
        "confirm, chat, memory, workspace, mcp, session - so a tool's name says what it is for. " +
        "This is a BREAKING rename of 31 tools across 182 references, so the migration and the " +
        "live QA are the work; the split itself is the easy part. `skills` and `instructions` " +
        "have no tools today and are a design question, not a move.",
      exit: "criteria-met",
      qa: true,
      acceptance: [
        {
          id: "ts-categorised",
          title: "No tool is called 'manager' any more",
          given: "A session with every binding available",
          when: "Its tool list is enumerated",
          then: "Every former manager tool appears under a category server and none under manager",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mcp-categories",
        },
        {
          id: "ts-no-stale-refs",
          title: "Nothing still says the retired server name",
          then: "No occurrence survives in code, bundled skills, project instructions or memory",
          verify: "command",
          check: "node tools/verify/no-stale-tool-names.mjs",
        },
        {
          id: "ts-allowlists-migrated",
          title: "An existing allowlist still works",
          given: "A settings.json permitting the retired single-server terminal name",
          when: "The app starts after the upgrade",
          then: "It is rewritten to the new name and the user is not re-prompted",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run settings-migration",
        },
        {
          id: "ts-live-verified",
          title: "A real review round still runs",
          given: "A dev instance on a scratch repo with a real PR",
          when: "watch_pr, resolve_thread, request_review and approve_pr are driven end to end",
          then: "The round completes and the PR lands - verified on a running instance, not mocked",
          verify: "human",
        },
      ],
    },
    {
      id: "foundations",
      order: 2,
      title: "Foundations",
      description:
        "The spec shape, its caps, the role menu and tool profiles, the validator, and the two " +
        "state tables. Nothing executes yet — this phase exists so that everything after it can " +
        "assume a Mission is well-formed and has somewhere to record what happened.",
      exit: "criteria-met",
      qa: true,
      acceptance: [
        {
          id: "f-roundtrip",
          title: "Specs round-trip",
          then: "A spec written, stored and re-read is byte-identical",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run mission",
        },
        {
          id: "f-caps-single-source",
          title: "One number, not three",
          then: "Every cap is read from shared/limits.ts by schema, validator and UI alike",
          verify: "review",
        },
        {
          id: "f-profiles-override",
          title: "Profiles are defaults, not walls",
          then: "A persona's tool overrides visibly widen or narrow its profile, and the UI shows both",
          verify: "review",
        },
      ],
    },
    {
      id: "comms",
      order: 3,
      title: "Chat-to-chat comms",
      description:
        "The primitive the whole design rests on, built as a BASE Dispatch capability rather " +
        "than a Mission internal — any chat can address any chat, mission or not. Server-side " +
        "delivery on the existing resume path, an MCP surface over it, the capped ledger, and " +
        "the wake composer that keeps a delta from becoming a replay.",
      exit: "criteria-met",
      qa: true,
      acceptance: [
        {
          id: "c-attribution",
          title: "Dispatch speaks as Dispatch",
          then: "Every delivered message renders with a brief part, never as a human turn",
          verify: "review",
        },
        {
          id: "c-delta-not-replay",
          title: "Wakes are deltas",
          then: "An actor woken twice never sees the same event twice",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-wake",
        },
        {
          id: "c-usable-without-a-mission",
          title: "Useful on its own",
          then: "Two ordinary chats can message each other with no mission in play",
          verify: "human",
        },
      ],
    },
    {
      id: "engine",
      order: 4,
      title: "Engine",
      description:
        "The deterministic half: readiness from the DAG, hire-budget enforcement, gate " +
        "arithmetic, the remediation loop that lets QA reopen a phase, lead recycling, the kill " +
        "switch, and the guard that stops a lead granting itself a PR override. No agent " +
        "judgement anywhere in this phase.",
      exit: "criteria-met",
      qa: true,
      acceptance: [
        {
          id: "e-no-agent-in-loop",
          title: "No agent in the scheduling loop",
          then: "Readiness, gating, hiring limits and recycling are decided without a model call",
          verify: "review",
        },
        {
          id: "e-remediation-terminates",
          title: "The QA loop cannot spin",
          then: "Remediation stops at the round cap and hands the phase to the human",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-remediation",
        },
      ],
    },
    {
      id: "actors",
      order: 5,
      title: "Actors",
      description:
        "Personas become real chats: the materializer that compiles a role template plus its " +
        "overrides into an ephemeral AgentConfig, the RTE hub, the lead's hire/intake/vote loop, " +
        "the fresh-context QA pass, and the capped handoff a retiring lead writes.",
      exit: "criteria-met",
      qa: true,
      acceptance: [
        {
          id: "a-gating-enforced",
          title: "Profiles are real",
          then: "An observer actor's session genuinely cannot call Edit, Write or create_pr",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-personas",
        },
        {
          id: "a-qa-is-fresh",
          title: "QA never reuses a chat",
          then: "Each QA round runs in a new chat that has not watched the work happen",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-qa",
        },
      ],
    },
    {
      id: "surface",
      order: 6,
      title: "Surface",
      description:
        "What the human touches: a new chat type with its own icon, the drill-in board " +
        "(mission → phase → task → agent), the mini chat that IS the manager conversation, and " +
        "the tunables that let concurrency limits and tool overrides be changed mid-run.",
      exit: "human-approval",
      qa: true,
      acceptance: [
        {
          id: "s-visually-distinct",
          title: "A mission chat is recognisable",
          then: "It is distinguishable at a glance from a normal chat AND from a quick action",
          verify: "human",
        },
        {
          id: "s-drill-in",
          title: "Every level is reachable",
          then: "Mission → phase → task → agent each navigate, with a breadcrumb back",
          verify: "human",
        },
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
      hireBudget: 2,
      hireableRoles: ["developer", "researcher", "reviewer"],
      lead: {
        name: "Platform Lead",
        toolProfile: "observer",
        effort: "high",
        skills: [],
        instructions:
          "You own the durable shapes. Hold two lines your hires will push on:\n" +
          "  - Zod is the source of truth, and a type that isn't validated on the way OUT of the " +
          "store is not validated.\n" +
          "  - Migrations are APPEND ONLY. user_version is a count; inserting a step re-runs the " +
          "wrong SQL against a live store.\n" +
          "Reject a report whose schema change has no test that a legacy record still parses. " +
          "Escalate to the RTE when a shape another team already builds on has to change — that " +
          "is a cross-team decision, not yours.\n" +
          "Hire a researcher before a developer when the question is 'what does this currently " +
          "do'. It is cheaper and it does not open a PR you then have to close.",
      },
    },
    {
      id: "comms",
      name: "Comms & MCP",
      charter: "Actor-to-actor delivery, the MCP tool surface, and the event ledger.",
      hireBudget: 2,
      hireableRoles: ["developer", "reviewer", "researcher"],
      lead: {
        name: "Comms Lead",
        toolProfile: "observer",
        effort: "high",
        skills: [],
        instructions:
          "You own the primitive the rest of the mission cannot work without, so you are the team " +
          "most likely to block others — say so early and loudly to the RTE rather than late and " +
          "quietly.\n" +
          "Three non-negotiables:\n" +
          "  - A delivered message is DISPATCH talking. It rides as a brief part; it never renders " +
          "as something the human said.\n" +
          "  - Summaries are capped and details are pulled, never pushed. A tool that lets an actor " +
          "paste 4KB into another actor's context has defeated the design.\n" +
          "  - This ships as a BASE capability. If a tool only makes sense inside a mission, it is " +
          "in the wrong layer.",
      },
    },
    {
      id: "engine",
      name: "Orchestration Engine",
      charter: "Readiness, hiring limits, gates, remediation, recycling, and the kill switch.",
      hireBudget: 3,
      hireableRoles: ["developer", "reviewer", "researcher"],
      lead: {
        name: "Engine Lead",
        toolProfile: "observer",
        effort: "xhigh",
        skills: [],
        instructions:
          "Everything your team ships must be decidable without a model call. If a hire proposes " +
          "'ask the RTE which task is next', that is the bug — the engine is the thing that knows.\n" +
          "Watch for the silent failure mode specifically: a task that never becomes ready looks " +
          "exactly like a task that is still waiting, and a remediation loop that never terminates " +
          "looks exactly like thorough QA. Every rule needs a test that proves the negative case " +
          "eventually resolves.",
      },
    },
    {
      id: "experience",
      name: "Experience",
      charter: "Everything the human sees: the chat type, the board, the mini chat, the tunables.",
      hireBudget: 2,
      hireableRoles: ["developer", "ui-verifier", "reviewer"],
      lead: {
        name: "Experience Lead",
        toolProfile: "observer",
        effort: "high",
        skills: [],
        instructions:
          "A UI change that builds and type-checks has been verified by nobody. Hire a ui-verifier " +
          "for every visual task and refuse any report that claims a view works without a " +
          "screenshot of it working against a running dev instance.\n" +
          "The board has one job: make a bad plan look bad. An unsatisfied criterion, a chain that " +
          "should have been parallel, a team with no tasks, a phase on its third QA round — if the " +
          "picture doesn't show it, the picture isn't finished.",
      },
    },
    {
      id: "assurance",
      name: "Assurance",
      charter: "Validators, guard rules, the QA pass, and proving the negative cases.",
      hireBudget: 2,
      hireableRoles: ["developer", "qa-specialist", "reviewer"],
      lead: {
        name: "Assurance Lead",
        toolProfile: "observer",
        effort: "high",
        skills: [],
        instructions:
          "Your team writes the tests that fail before the fix, not the tests that confirm the code " +
          "that was just written.\n" +
          "Own the two rules with teeth: the DAG validator must name a cycle's path, and the " +
          "PR-override guard must convert an attempt into an escalation rather than simply refusing " +
          "it. A refusal a lead can retry forever is not a guard.\n" +
          "Absolute-path fixtures must root from process.platform — a literal C:/ path is a relative " +
          "path on the Linux CI runner and will break the gate.",
      },
    },
  ],

  /* ------------------------------------------------------------------ tasks */

  tasks: [
    /* ---- phase 1: tool surface ---- */
    {
      id: "t-taxonomy",
      phaseId: "tool-surface",
      teamId: "comms",
      title: "Category taxonomy and tool registry",
      brief:
        "Name the categories and write the ONE table saying which server a tool belongs to. Seed " +
        "it from MANAGER_TOOL_GATE in manager-mcp.ts, which already maps every tool to a " +
        "capability binding (github, memory, chats, terminals...) - that is the taxonomy in all " +
        "but name. Proposed split of the 31 tools: github (create_pr, approve_pr, watch_pr, " +
        "post_review, request_review, resolve_thread) - confirm (ask_user, request_exemption) - " +
        "chat (spawn_chat, wait_for_chat, chat_find, chat_read) - memory (7) - workspace " +
        "(worktree, terminal, terminal_output, run_subapp) - mcp (list, add, remove, prewarm) - " +
        "session (wait, context_usage, compact_context) - project (project_info). The registry is " +
        "the single source the server factories, the gate table, the metrics classifier and the " +
        "catalog UI all read.",
      dependsOn: [],
      satisfies: ["ts-categorised"],
      acceptance: [
        {
          id: "tt-1",
          title: "Exhaustive by construction",
          then: "A tool missing from the registry fails the build, not the runtime",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mcp-categories",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-split-servers",
      phaseId: "tool-surface",
      teamId: "comms",
      title: "Split createManagerMcpServer",
      brief:
        "session-broker.ts:4890 hands the SDK { manager: createManagerMcpServer(...) } - a map of " +
        "server name to server. Turn that into one entry per category, built from the registry. " +
        "Keep ONE factory holding the tool definitions and partition them; forking the file into " +
        "eight lets the shared helpers (textResult, the binding checks) drift apart.\n" +
        "HARD CUTOVER, no compatibility alias. A legacy manager server would re-declare all 31 " +
        "tools, and a duplicated tool list costs roughly 4-5k tokens of context on every turn, " +
        "indefinitely, to serve a name nobody should type after the sweep.",
      dependsOn: ["t-taxonomy"],
      satisfies: ["ts-categorised"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-gate-rewire",
      phaseId: "tool-surface",
      teamId: "platform",
      title: "Rewire everything keyed on the old names",
      brief:
        "SELF_GATED_TOOLS (session-broker.ts:1099) hardcodes the old ask_user, spawn_chat " +
        "and request_exemption - miss one and that tool double-prompts. MANAGER_TOOL_GATE, the " +
        "metrics classifier and the MCP catalog view all key on the old names too.\n" +
        "Metrics need a decision rather than a rename: existing rows are stored as " +
        "{ server: 'manager', tool: 'create_pr' }. Map them forward at read time so the history " +
        "does not split in two - a Metrics view showing create_pr as two series is worse than one " +
        "showing it once under the new name.",
      dependsOn: ["t-taxonomy"],
      satisfies: ["ts-categorised"],
      acceptance: [
        {
          id: "tgr-1",
          title: "Self-gated tools do not double-prompt",
          then: "ask_user, spawn_chat and request_exemption each raise exactly one card",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run session-broker",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-allowlist-migration",
      phaseId: "tool-surface",
      teamId: "platform",
      title: "Migrate permission allowlists",
      brief:
        "The one breakage a user FEELS. A settings.json allowing the old terminal name stops " +
        "matching after the rename, and the symptom is not an error - it is a permission prompt " +
        "on a tool that was silently approved for months. Rewrite allow/deny entries on startup, " +
        "log what changed, and make it idempotent. Then add a boot check that warns when any " +
        "config still mentions a retired name, so a hand-edited file or an old export says so " +
        "instead of quietly prompting.",
      dependsOn: ["t-split-servers"],
      satisfies: ["ts-allowlists-migrated"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-name-sweep",
      phaseId: "tool-surface",
      teamId: "assurance",
      title: "Sweep every stale reference",
      brief:
        "~200 occurrences across ~50 tracked files, mostly packages/server. Do not chase the " +
        "exact number: it was 185/49 when this task was written and 198/51 three commits later, " +
        "because main keeps adding references while you work. Build the VERIFIER first and let " +
        "it be the count - a sweep measured against a stale number is finished the moment " +
        "somebody merges.\n" +
        "The hits include the bundled mcp-setup skill and the workflow rules in " +
        "shared/workflow.ts, which are INJECTED into every chat - leave those and the app " +
        "keeps teaching the dead names to every new session.\n" +
        "Project memory is a separate surface and the easiest to forget: 49 more occurrences " +
        "across 30 files in .dispatch/memory/, led by the old terminal name (22) and " +
        "ask_user (8). Those are markdown in the PRIMARY checkout, not this worktree, and they " +
        "are surfaced to agents as trusted context - a stale memory outlives the rename " +
        "indefinitely. Rewrite them through the memory tools, never by hand.\n" +
        "Wire the verifier into CI as `git grep`, not a filesystem walk: .worktrees/ holds a " +
        "dozen sibling checkouts of this repo and is gitignored, so a naive walk finds ~15k " +
        "hits and can never go green.",
      dependsOn: ["t-split-servers"],
      satisfies: ["ts-no-stale-refs"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-surface-gaps",
      phaseId: "tool-surface",
      teamId: "comms",
      title: "Decide what skills and instructions expose",
      brief:
        "Both were named as categories and NEITHER has a tool today - they are managed through " +
        "the config agent-tasks and file editing, not MCP. So this is new capability, not a move, " +
        "and it must not ride along inside a rename PR. Answer: what would an agent do with a " +
        "skills or instructions tool that it cannot already do by reading and writing the files, " +
        "and is that worth a tool? Return a recommendation and a proposed surface, or a reasoned " +
        "no. Write no production code.",
      dependsOn: ["t-taxonomy"],
      satisfies: [],
      acceptance: [],
      deliverable: "investigation",
      size: "s",
    },
    {
      id: "t-tool-qa",
      phaseId: "tool-surface",
      teamId: "assurance",
      title: "Live verification on a running instance",
      brief:
        "Not a unit test. Start a dev instance on an unusual port against a scratch data dir " +
        "(another agent will be holding 4319), open a real PR on a scratch repo, and drive a full " +
        "review round through the renamed servers: watch_pr reports the round, resolve_thread " +
        "closes a thread, request_review re-queues the reviewer, approve_pr lands it. Then " +
        "confirm the permission card still appears for the self-gated tools, and that Metrics " +
        "shows one create_pr series rather than two. Attach evidence - this criterion is " +
        "verify:'human' because a green unit suite has already passed while the real path was " +
        "broken.",
      dependsOn: ["t-split-servers", "t-gate-rewire", "t-allowlist-migration"],
      satisfies: ["ts-live-verified"],
      acceptance: [],
      deliverable: "artifact",
      size: "l",
    },

    /* ---- phase 2: foundations ---- */
    {
      id: "t-schema",
      phaseId: "foundations",
      teamId: "platform",
      title: "Author the MissionSpec schemas",
      brief:
        "Create packages/shared/src/mission.ts with zod schemas for MissionSpec, Criterion, " +
        "Phase, MissionTask, Team, Persona, RoleTemplate and MissionPolicy, mirroring the approved " +
        "proposal. Export types via shared/src/index.ts. Every cap must be imported from " +
        "limits.ts (task t-limits) rather than written inline — coordinate, do not duplicate. " +
        "Docblock each field with why it exists, matching the house style in domain.ts. No " +
        "engine, no store, no UI in this task.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [
        {
          id: "ts-1",
          title: "Round-trips",
          then: "A spec parsed and re-serialized is byte-identical",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run mission",
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
        "Add the MISSION_CAPS constant block to packages/shared/src/limits.ts covering every " +
        "authoring limit in the proposal (title 80, objective 500, criteria 10, phases 5, teams " +
        "5, tasks 50, task brief 1500, event summary 280, wake events 8, remediation rounds 3, " +
        "and the rest). One exported frozen object. These are the numbers the schema, the " +
        "validator, the MCP tool descriptions and the UI must all quote.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [],
      deliverable: "pr",
      size: "s",
    },
    {
      id: "t-roles",
      phaseId: "foundations",
      teamId: "platform",
      title: "Role templates, tool profiles, skill profiles",
      brief:
        "The hire menu. Define the named tool profiles (observer / reader / author / integrator) " +
        "as deny-lists, and RoleTemplate = { toolProfile, default instructions, default skills, " +
        "model, effort, freshContext }. Add Persona.toolOverrides { allow, deny } so the mission " +
        "manager can widen or narrow any actor without editing the profile — and keep the two " +
        "separate in the type, because the profile carries the intent and the override carries " +
        "the exception. Provide effectiveDeny(persona, roles) as the single resolver everything " +
        "else calls.",
      dependsOn: [],
      satisfies: ["leads-hire"],
      acceptance: [
        {
          id: "tr-1",
          title: "Overrides resolve",
          given: "An observer persona with an allow override for Bash",
          when: "effectiveDeny runs",
          then: "Bash is absent from the deny-list and everything else in the profile remains",
          verify: "command",
          check: "pnpm --filter @dispatch/shared exec vitest run mission",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-validate",
      phaseId: "foundations",
      teamId: "assurance",
      title: "DAG and traceability validator",
      brief:
        "Write validateMissionSpec(). Structural rules: phase orders unique and contiguous from " +
        "1; every task's phaseId and teamId resolve; every dependsOn id exists AND is in the same " +
        "phase; the dependency graph is acyclic; no self-dependency; criterion ids unique within " +
        "their owner; every team referenced by at least one task; every phase has at least one " +
        "task; every hireableRole resolves to a role template. Traceability: every MISSION " +
        "criterion is satisfied by at least one task (phase criteria may be phase-wide — see the " +
        "gate fallback). Semantic: verify:'command' requires check; a Persona has exactly one of " +
        "agentId or instructions. A cycle error must NAME THE CYCLE PATH — 'a cycle exists' is " +
        "not an actionable error.",
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
          check: "pnpm --filter @dispatch/shared exec vitest run mission",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-store",
      phaseId: "foundations",
      teamId: "platform",
      title: "Run, event and remediation tables",
      brief:
        "Add one APPEND-ONLY migration step to store/db.ts creating mission_run (seq, id unique, " +
        "project_id, body), mission_event (seq, run_id, ts, body) indexed on (run_id, seq), and " +
        "mission_remediation (seq, run_id, phase_id, round, body). Add Store methods to read/write " +
        "runs, append/range events, and record remediations. Specs are NOT stored here — they " +
        "belong in the config root as JSON beside projects, because they are low-write, diffable " +
        "and reusable as templates. Only run state and the ledger are high-write.",
      dependsOn: ["t-schema"],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 2: comms (a BASE capability) ---- */
    {
      id: "t-courier",
      phaseId: "comms",
      teamId: "comms",
      title: "Server-side chat-to-chat delivery",
      brief:
        "Build ChatCourier.deliver(chatId, message, parts) on top of the same resume path " +
        "PrReviewWatcher uses: ensure a live session, then send with parts [{kind:'brief', label, " +
        "text}] so the transcript renders it as Dispatch speaking, never as a user turn. Handle " +
        "the busy case (target mid-run) by queuing rather than dropping. This is a GENERAL " +
        "service — it takes a chat id and a message and knows nothing about missions.",
      dependsOn: [],
      satisfies: ["comms-is-general"],
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
        "Append-only event writes plus a per-actor cursor so 'what has this actor not seen' is a " +
        "range query, not a scan. Enforce the caps at the WRITE boundary: a summary over 280 " +
        "chars is a validation error, not a silent truncation — a truncated summary reads as a " +
        "complete one and that is how a wake budget gets quietly exceeded.",
      dependsOn: [],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-chat-send",
      phaseId: "comms",
      teamId: "comms",
      title: "chat_send / chat_ask MCP tools",
      brief:
        "Expose the courier to agents as BASE manager tools available to every chat, not just " +
        "mission actors: chat_send(chatId, summary, detail?) fire-and-forget, and chat_ask(chatId, " +
        "question) which blocks for a reply. Guard rails: rate limit per sender, refuse a send to " +
        "a chat in another project unless explicitly allowed, and record every delivery on the " +
        "ledger. Inside a mission the engine additionally enforces routing (intra-team direct, " +
        "lead-to-lead via the RTE) — but that policy lives in the engine, not in these tools.",
      dependsOn: ["t-courier"],
      satisfies: ["comms-is-general"],
      acceptance: [
        {
          id: "tcs-1",
          title: "Works with no mission",
          given: "Two ordinary chats and no mission running",
          when: "One calls chat_send on the other",
          then: "The message is delivered and attributed to Dispatch",
          verify: "human",
        },
      ],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-report-tool",
      phaseId: "comms",
      teamId: "comms",
      title: "mission_report — the structured hand-up",
      brief:
        "How a hire finishes: outcome, summary (<=500), a verdict per acceptance criterion, and " +
        "followups. A structured shape, so a hire CANNOT hand its lead a wall of text — this is " +
        "the difference between a lead reading five reports and a lead reading five transcripts. " +
        "Reject free-form prose in place of the criteria array.",
      dependsOn: ["t-chat-send"],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-wake",
      phaseId: "comms",
      teamId: "comms",
      title: "Wake composer",
      brief:
        "Given an actor and its unseen events, compose the wake: at most 8 events, each at most " +
        "280 chars, plus a rendered state table of the actor's own tasks, plus pointers (chatId, " +
        "PR ref, row id) for anything deeper. Detail is NEVER inlined. If more than 8 events are " +
        "unseen, say how many were elided and let the actor pull the rest. This function is the " +
        "context-flood control — treat its budget as a contract and test it at the boundary.",
      dependsOn: ["t-chat-send", "t-ledger"],
      satisfies: ["context-bounded"],
      acceptance: [
        {
          id: "tw-1",
          title: "Budget holds",
          given: "40 unseen events",
          when: "A wake is composed",
          then: "It carries 8 summaries and an elision count, under the byte budget",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-wake",
        },
      ],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 4: engine ---- */
    {
      id: "t-readiness",
      phaseId: "engine",
      teamId: "engine",
      title: "Readiness resolver",
      brief:
        "A pure function from (spec, run) to the set of ready tasks. Under serialize-on-merge a " +
        "task is ready when every dependency has ALL of its PRs merged and a filed report — a " +
        "task may open more than one PR, so 'the PR merged' is the wrong test. Include accepted " +
        "remediation tasks in the effective task list. Respect team hireBudget and mission " +
        "maxParallelTasks. No database, no session, no model call.",
      dependsOn: [],
      satisfies: ["engine-schedules"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-hiring",
      phaseId: "engine",
      teamId: "engine",
      title: "Hiring and budget enforcement",
      brief:
        "Let a lead hire from its team's hireableRoles under a mission-grant consent (one " +
        "approval at run start, not one per chat — a five-phase mission would otherwise prompt " +
        "the human dozens of times). Enforce hireBudget per team and maxParallelTasks mission-" +
        "wide; a hire over budget is refused with the reason, not queued silently. Record the " +
        "role chosen and the lead's stated reason on the actor row: 'why is there a researcher " +
        "on this task' must be answerable later. Set Chat.purpose so the sidebar recognises them.",
      dependsOn: [],
      satisfies: ["leads-hire"],
      acceptance: [
        {
          id: "th-1",
          title: "Budget is enforced",
          given: "A team with hireBudget 2 and two live hires",
          when: "The lead hires a third",
          then: "It is refused with the budget named, and the lead is told which hires to release",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-hiring",
        },
      ],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-gates",
      phaseId: "engine",
      teamId: "engine",
      title: "Gate open, vote, adjudicate",
      brief:
        "Open a gate when every task satisfying a criterion is done. Signatories are DERIVED from " +
        "task.satisfies — the set of teams owning a satisfying task — and frozen at open time. A " +
        "PHASE criterion no task names falls back to every team working in that phase. agreed = " +
        "at least one 'met' and zero 'not-met'; any 'not-met' is disputed. A disputed gate " +
        "notifies the RTE; past the threshold it raises an Attention Queue item.",
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
          check: "pnpm --filter @dispatch/server exec vitest run mission-gates",
        },
      ],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-remediation",
      phaseId: "engine",
      teamId: "engine",
      title: "Remediation — QA reopens a phase",
      brief:
        "The loop that lets a phase adapt. QA proposes tasks against unmet criteria; the RTE " +
        "accepts or rejects; accepted tasks join the run's EFFECTIVE task list with " +
        "remediationRound set, and the phase returns to running. The spec itself is never " +
        "edited — it stays versioned and immutable, and the remediation record is the audit " +
        "trail. Hard cap at policy.maxRemediationRounds, after which the phase escalates to the " +
        "human instead of looping. A loop that cannot terminate is worse than a phase that fails.",
      dependsOn: ["t-readiness"],
      satisfies: ["qa-can-reopen"],
      acceptance: [
        {
          id: "trm-1",
          title: "It terminates",
          given: "QA that reports not-met on every round",
          when: "The round cap is reached",
          then: "The phase blocks on the human and no further QA round is spawned",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-remediation",
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
        "A lead chat is reused across contiguous phases and retired on either trigger: its team " +
        "has no tasks in the upcoming phase, or broker.getContextUsage(chatId) reports past " +
        "policy.leadRecycle.contextThreshold. On retirement the lead writes a LeadHandoff (carry " +
        "<= 1500 chars, <= 5 watch-outs) that seeds its successor. Both triggers are engine-" +
        "observable — never ask the lead whether it feels full.",
      dependsOn: ["t-hiring"],
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
        "One action that interrupts every actor chat on the run — RTE, leads, hires, any live QA " +
        "pass — and moves it to paused. It reads the actor rows off MissionRun, so it works " +
        "whether or not any agent cooperates. Must leave no orphaned worktree or subApp process, " +
        "and must be idempotent: a second press on a paused run is a no-op, not an error.",
      dependsOn: ["t-hiring"],
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
        "A lead calling approve_pr with allowNoReview or allowNoChecks must be refused AND have " +
        "the attempt converted into an escalation to the RTE — a bare refusal is something a " +
        "model retries in a loop. This upholds the rule PR #15 established: those flags are " +
        "requests that raise a permission card in front of a human, and an actor that could " +
        "self-approve would make that card unreachable.",
      dependsOn: ["t-hiring"],
      satisfies: ["no-self-granted-overrides"],
      acceptance: [
        {
          id: "tgu-1",
          title: "Refusal escalates",
          given: "A lead attempting allowNoReview",
          when: "The guard fires",
          then: "The call is refused and an escalation event is appended",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-guard",
        },
      ],
      deliverable: "pr",
      size: "m",
    },

    /* ---- phase 5: actors ---- */
    {
      id: "t-personas",
      phaseId: "actors",
      teamId: "platform",
      title: "Persona materializer",
      brief:
        "Compile a role template plus its persona overrides into an ephemeral AgentConfig at " +
        "spawn time — reusing the existing agent machinery rather than inventing a second system " +
        "for 'an agent's instructions'. Resolve in order: role template defaults, then persona " +
        "fields, then toolOverrides. Materialize the skill profile into the session. The " +
        "resulting disallowedTools is what makes 'an observer cannot edit' enforced rather than " +
        "merely requested, so it must actually reach the session's tool gating — test that it " +
        "does, at the session boundary, not at the type boundary.",
      dependsOn: [],
      satisfies: ["leads-hire"],
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
        "The orchestrator's loop: receive cross-team traffic, route it, convene gates, chase " +
        "non-voting signatories, mediate disputes, adjudicate QA remediation proposals, and " +
        "filter what reaches the manager. It must NOT be given scheduling tools — readiness is " +
        "the engine's, and an RTE that can schedule will start doing topological sort in prose.",
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
      title: "Team lead hire-and-intake loop",
      brief:
        "Phase brief on wake; for each ready task decide WHO it needs and hire from the menu " +
        "within budget, recording why; take structured reports on intake and judge them against " +
        "task acceptance; answer hire questions; vote at gates. A lead may stop or release its " +
        "own hires and escalate to the RTE; it may not touch another team's actors, and the " +
        "engine refuses if it tries.",
      dependsOn: ["t-personas"],
      satisfies: ["leads-hire", "gate-requires-consensus"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-qa",
      phaseId: "actors",
      teamId: "assurance",
      title: "Fresh-context phase QA",
      brief:
        "Spawn a NEW chat for every QA round — never reuse one, and never one that watched the " +
        "work happen: a verifier with memory of the build is confirming its own recollection, not " +
        "checking the result. Seed it with the mission objective, the phase criteria, the tasks " +
        "claiming to satisfy them, every task report, and read access to the whole project. It " +
        "returns a verdict per criterion with evidence, plus proposed tasks for anything unmet. " +
        "It cannot add tasks itself — it proposes, the RTE adjudicates.",
      dependsOn: ["t-personas"],
      satisfies: ["qa-can-reopen"],
      acceptance: [
        {
          id: "tq-1",
          title: "Always a new chat",
          given: "A phase on its second QA round",
          when: "QA is spawned",
          then: "The chat id differs from round one's and shares no transcript",
          verify: "command",
          check: "pnpm --filter @dispatch/server exec vitest run mission-qa",
        },
      ],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-handoff",
      phaseId: "actors",
      teamId: "engine",
      title: "Lead handoff",
      brief:
        "On retirement a lead writes LeadHandoff { carry <= 1500, watchOut: <= 5 x 200 } and the " +
        "engine seeds the successor chat with it plus the run state. Model it on " +
        "Chat.harnessHandoff, which solves the same problem for a runtime migration.",
      dependsOn: ["t-lead"],
      satisfies: ["context-bounded"],
      acceptance: [],
      deliverable: "pr",
      size: "s",
    },

    /* ---- phase 6: surface ---- */
    {
      id: "t-chat-type",
      phaseId: "surface",
      teamId: "experience",
      title: "Mission as a new chat type",
      brief:
        "Add Mission to the chats dropdown as its own type, visually distinct from BOTH an " +
        "ordinary chat and a quick action — its own icon, its own tint, its own row treatment in " +
        "the sidebar. A mission chat opens the board as its primary surface rather than a " +
        "transcript. Hires, leads, the RTE and QA rounds file UNDER it in the sidebar, the way " +
        "reviewer chats now file under the chat that opened their PR.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [
        {
          id: "tct-1",
          title: "Distinct at a glance",
          then: "A mission chat is not mistakable for a normal chat or a quick action",
          verify: "human",
        },
      ],
      deliverable: "pr",
      size: "m",
    },
    {
      id: "t-board",
      phaseId: "surface",
      teamId: "experience",
      title: "The drill-in board",
      brief:
        "Mission → phase → task → agent, each a screen with a breadcrumb back, not tabs. The base " +
        "screen lists phases with task count, wave count and phase-AC count. A phase screen shows " +
        "its waves, tasks, acceptance criteria and QA history. A task screen shows the brief, " +
        "dependencies, the criteria it satisfies and the agents that worked it. An agent screen " +
        "shows its persona, resolved toolset, skills and live state. Acceptance is NESTED at the " +
        "level it belongs to — it is not a top-level tab.",
      dependsOn: [],
      satisfies: ["spec-validated"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-minichat",
      phaseId: "surface",
      teamId: "experience",
      title: "Mini chat — the manager conversation",
      brief:
        "The human's only comms path into a run, embedded beside the board. It must be a REAL " +
        "chat — transcript, input, streaming, permission prompts, attention — with the rails a " +
        "manager has no use for omitted: no terminals sidebar, no ship/PR sidebar, no worktree " +
        "controls. Reuse the chat components rather than reimplementing them; a lookalike will " +
        "drift from the real one within a month.",
      dependsOn: ["t-chat-type"],
      satisfies: ["escalation-reaches-human"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
    {
      id: "t-tunables",
      phaseId: "surface",
      teamId: "experience",
      title: "Editable limits and overrides",
      brief:
        "Let the human change a running mission: concurrency limits (maxParallelTasks, per-team " +
        "hireBudget), tool profiles and per-persona overrides, effort and model. Every change is " +
        "an event on the ledger with who and why, and takes effect at the next scheduling pass " +
        "rather than mid-turn. Widening a tool profile on a live actor must NOT silently apply to " +
        "chats already running under the old one — restate it or restart them, but do not leave " +
        "the UI claiming something the session does not have.",
      dependsOn: ["t-board"],
      satisfies: ["leads-hire"],
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
        "Drive a small real mission from approval to completion against a scratch project: " +
        "actors spawn, a lead hires a researcher and then a developer, tasks serialize on merge, " +
        "a gate is disputed and resolved, QA sends one phase back once and it recovers, a lead is " +
        "recycled at a phase gap, and Stop all leaves nothing orphaned.",
      dependsOn: ["t-board", "t-minichat"],
      satisfies: ["engine-schedules", "qa-can-reopen"],
      acceptance: [],
      deliverable: "pr",
      size: "l",
    },
  ],
};
