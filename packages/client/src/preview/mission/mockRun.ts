/**
 * A mock run, caught mid-flight — the live state the board drills into.
 *
 * Nothing here is wired to a server; it exists so the UI can be designed
 * against the shape the engine WILL produce rather than against an empty
 * skeleton. The moment `MissionRun` is real, this file is deleted and the same
 * components read the real thing.
 *
 * The scenario is deliberately not the happy path. It carries the four states
 * that are easy to design past and expensive to discover late:
 *   - a lead RETIRED at a phase gap (Platform and Comms have no phase-3 work),
 *   - a lead near its context threshold and about to be recycled,
 *   - a phase that FAILED QA once and came back with remediation tasks,
 *   - a hire that is a researcher rather than a developer, because the lead
 *     decided the task needed a question answered first.
 */
import { MOCK_MISSION } from "./mock.js";
import type { LiveActor, LiveTask, ManagerTurn, MissionEvent, MissionRun, MissionTask } from "./types.js";

const T0 = Date.parse("2026-08-22T09:00:00Z");
const min = (n: number) => T0 + n * 60_000;

/* ------------------------------------------------------------------ actors */

const ACTORS: LiveActor[] = [
  {
    id: "a-rte",
    chatId: "chat-rte-01",
    kind: "orchestrator",
    name: "RTE",
    status: "running",
    contextFill: 0.34,
    activity: "Adjudicating QA round 1 remediation for Chat-to-chat comms",
    startedAt: min(0),
  },
  {
    id: "a-lead-platform",
    chatId: "chat-lead-platform-01",
    kind: "lead",
    teamId: "platform",
    name: "Platform Lead",
    status: "retired",
    contextFill: 0.41,
    activity: "Retired at the phase-3 gap — handoff written",
    startedAt: min(2),
    retiredAt: min(430),
  },
  {
    id: "a-lead-comms",
    chatId: "chat-lead-comms-01",
    kind: "lead",
    teamId: "comms",
    name: "Comms Lead",
    status: "retired",
    contextFill: 0.72,
    activity: "Retired at the phase-3 gap — was also over the 60% threshold",
    startedAt: min(95),
    retiredAt: min(430),
  },
  {
    id: "a-lead-engine",
    chatId: "chat-lead-engine-01",
    kind: "lead",
    teamId: "engine",
    name: "Engine Lead",
    status: "running",
    contextFill: 0.58,
    activity: "Holding 3 tasks; 2 hires live, 1 slot free",
    startedAt: min(430),
  },
  {
    id: "a-lead-assurance",
    chatId: "chat-lead-assurance-01",
    kind: "lead",
    teamId: "assurance",
    name: "Assurance Lead",
    status: "waiting-human",
    contextFill: 0.23,
    activity: "Escalated: t-guard needs a PR override it cannot grant itself",
    startedAt: min(120),
  },
  {
    id: "a-hire-readiness",
    chatId: "chat-hire-readiness",
    kind: "hire",
    roleTemplateId: "developer",
    teamId: "engine",
    taskId: "t-readiness",
    name: "Developer · readiness resolver",
    status: "idle",
    contextFill: 0.61,
    activity: "Reported done — PR #212 merged",
    startedAt: min(435),
    hiredBecause: "Pure-function work with a clear brief; no unknowns to research first.",
  },
  {
    id: "a-hire-hiring",
    chatId: "chat-hire-hiring",
    kind: "hire",
    roleTemplateId: "developer",
    teamId: "engine",
    taskId: "t-hiring",
    name: "Developer · hiring & budget",
    status: "running",
    contextFill: 0.38,
    activity: "Writing the budget-refusal path; PR #218 open",
    startedAt: min(505),
    hiredBecause: "Straight implementation once the readiness resolver landed.",
  },
  {
    id: "a-hire-gates-research",
    chatId: "chat-hire-gates-research",
    kind: "hire",
    roleTemplateId: "researcher",
    teamId: "engine",
    taskId: "t-gates",
    name: "Researcher · existing gate arithmetic",
    status: "running",
    contextFill: 0.19,
    activity: "Reading approve_pr's thread/check logic before we design ours",
    startedAt: min(520),
    hiredBecause:
      "Cheaper to answer 'what does approve_pr already enforce' than to have a developer " +
      "discover it halfway through a PR and rewrite.",
  },
  {
    id: "a-hire-guard",
    chatId: "chat-hire-guard",
    kind: "hire",
    roleTemplateId: "developer",
    teamId: "assurance",
    taskId: "t-guard",
    name: "Developer · override guard",
    status: "blocked",
    contextFill: 0.44,
    activity: "Blocked on the escalation its lead raised",
    startedAt: min(470),
    hiredBecause: "Guard rule with a named test; no research needed.",
  },
  {
    id: "a-qa-foundations",
    chatId: "chat-qa-foundations-r1",
    kind: "qa",
    roleTemplateId: "qa-specialist",
    name: "QA · Foundations round 1",
    status: "retired",
    contextFill: 0.52,
    activity: "All 3 criteria met — phase passed on the first round",
    startedAt: min(300),
    retiredAt: min(340),
  },
  {
    id: "a-qa-comms-r1",
    chatId: "chat-qa-comms-r1",
    kind: "qa",
    roleTemplateId: "qa-specialist",
    name: "QA · Comms round 1",
    status: "retired",
    contextFill: 0.66,
    activity: "c-usable-without-a-mission NOT met — proposed 1 task",
    startedAt: min(395),
    retiredAt: min(425),
  },
];

/* ------------------------------------------------------------------- tasks */

/** Task ids that are finished, in the order they landed. */
const DONE = [
  "t-taxonomy",
  "t-split-servers",
  "t-gate-rewire",
  "t-allowlist-migration",
  "t-name-sweep",
  "t-surface-gaps",
  "t-tool-qa",
  "t-schema",
  "t-limits",
  "t-roles",
  "t-validate",
  "t-store",
  "t-courier",
  "t-ledger",
  "t-chat-send",
  "t-report-tool",
  "t-wake",
  "t-readiness",
];

const PRS: Record<string, LiveTask["prs"]> = {
  "t-schema": [{ number: 201, state: "merged", title: "feat(mission): the spec schemas" }],
  "t-roles": [
    { number: 204, state: "merged", title: "feat(mission): tool profiles" },
    { number: 206, state: "merged", title: "feat(mission): role templates + overrides" },
  ],
  "t-chat-send": [
    { number: 209, state: "merged", title: "feat(mcp): chat_send" },
    { number: 210, state: "merged", title: "feat(mcp): chat_ask" },
  ],
  "t-readiness": [{ number: 212, state: "merged", title: "feat(mission): readiness resolver" }],
  "t-hiring": [{ number: 218, state: "open", title: "feat(mission): hiring + budget" }],
};

function buildTasks(): Record<string, LiveTask> {
  const out: Record<string, LiveTask> = {};
  for (const t of MOCK_MISSION.tasks) {
    out[t.id] = { status: "blocked", actorIds: [], prs: [], attempts: 0 };
  }
  for (const id of DONE) {
    out[id] = {
      status: "done",
      actorIds: [],
      prs: PRS[id] ?? [{ number: 200, state: "merged", title: "…" }],
      attempts: 1,
      report: {
        outcome: "done",
        summary: "Delivered and merged. Acceptance checked against the running tests.",
        criteria: [],
        followups: [],
      },
      startedAt: min(10),
      endedAt: min(200),
    };
  }
  // The remediation task QA added to phase 2 — done, and it is why comms passed.
  out["t-comms-standalone"] = {
    status: "done",
    actorIds: [],
    prs: [{ number: 216, state: "merged", title: "test(mcp): chat_send with no mission" }],
    attempts: 1,
    startedAt: min(425),
    endedAt: min(468),
  };

  out["t-readiness"] = { ...out["t-readiness"]!, actorIds: ["a-hire-readiness"] };
  out["t-hiring"] = {
    status: "running",
    actorIds: ["a-hire-hiring"],
    prs: PRS["t-hiring"]!,
    attempts: 1,
    startedAt: min(505),
  };
  out["t-gates"] = {
    status: "running",
    actorIds: ["a-hire-gates-research"],
    prs: [],
    attempts: 1,
    startedAt: min(520),
  };
  out["t-remediation"] = { status: "ready", actorIds: [], prs: [], attempts: 0 };
  out["t-recycle"] = { status: "blocked", actorIds: [], prs: [], attempts: 0 };
  out["t-killswitch"] = { status: "blocked", actorIds: [], prs: [], attempts: 0 };
  out["t-guard"] = {
    status: "blocked",
    actorIds: ["a-hire-guard"],
    prs: [{ number: 215, state: "open", title: "feat(mission): override guard" }],
    attempts: 1,
    startedAt: min(470),
  };
  return out;
}

/* ------------------------------------------------------------- remediation */

/** The task QA added to phase 2. Joins the run's EFFECTIVE task list. */
const REMEDIATION_TASK: MissionTask = {
  id: "t-comms-standalone",
  phaseId: "comms",
  teamId: "comms",
  title: "Prove chat_send works with no mission",
  brief:
    "QA found the criterion 'two ordinary chats can message each other with no mission in " +
    "play' untested — every existing test constructs a run first, so the Mission-only coupling " +
    "would not have been caught. Add a test that opens two plain chats in a scratch project and " +
    "sends between them with no MissionRun anywhere, and fix whatever it turns up.",
  dependsOn: [],
  satisfies: ["comms-is-general"],
  acceptance: [
    {
      id: "tcso-1",
      title: "No run required",
      given: "Two plain chats and an empty mission_run table",
      when: "chat_send is called",
      then: "It delivers, and no code path reads a run",
      verify: "command",
      check: "pnpm --filter @dispatch/server exec vitest run chat-send",
    },
  ],
  deliverable: "pr",
  size: "s",
  remediationRound: 1,
};

/* ------------------------------------------------------------------ events */

const EVENTS: MissionEvent[] = [
  {
    seq: 141,
    ts: min(396),
    from: { role: "qa" },
    to: { role: "orchestrator" },
    kind: "report",
    phaseId: "comms",
    summary:
      "Comms QA r1: 2 of 3 criteria met. c-usable-without-a-mission NOT met — every test " +
      "constructs a run first, so the coupling is untested.",
    detail: "…full evidence, file by file…",
  },
  {
    seq: 142,
    ts: min(410),
    from: { role: "orchestrator" },
    to: { role: "lead", teamId: "comms" },
    kind: "decision",
    phaseId: "comms",
    summary: "Accepted QA's remediation: 1 task, t-comms-standalone, owned by Comms. Round 1 of 3.",
  },
  {
    seq: 156,
    ts: min(430),
    from: { role: "engine" },
    to: { role: "lead", teamId: "comms" },
    kind: "directive",
    summary: "Retiring you at the phase-3 gap (no Comms tasks) — context was 72%. Write your handoff.",
  },
  {
    seq: 171,
    ts: min(520),
    from: { role: "lead", teamId: "engine" },
    to: { role: "engine" },
    kind: "hire",
    taskId: "t-gates",
    summary:
      "Hiring a researcher, not a developer, for t-gates: need to know what approve_pr already " +
      "enforces before designing gate arithmetic. 2 of 3 budget used.",
  },
  {
    seq: 178,
    ts: min(538),
    from: { role: "lead", teamId: "assurance" },
    to: { role: "orchestrator" },
    kind: "escalation",
    taskId: "t-guard",
    summary:
      "t-guard's PR #215 is green but has no reviewer queued. I cannot grant the override myself. " +
      "Requesting a human decision.",
  },
  {
    seq: 179,
    ts: min(540),
    from: { role: "orchestrator" },
    to: { role: "creator" },
    kind: "escalation",
    taskId: "t-guard",
    summary:
      "Forwarding: Assurance needs a PR override on #215 (no reviewer queued). I can't resolve " +
      "this — it is exactly the decision the guard exists to put in front of you.",
  },
];

/* ------------------------------------------------------------- manager chat */

export const MOCK_MANAGER_CHAT: ManagerTurn[] = [
  {
    id: "m1",
    author: "human",
    ts: min(0),
    text: "Kick it off. Don't ask me about anything the RTE can decide.",
  },
  {
    id: "m2",
    author: "manager",
    ts: min(1),
    text:
      "Started. 6 phases, 35 tasks, 5 teams. Mission-grant consent is on, so leads hire without " +
      "prompting you — I'll surface budget refusals, disputed gates and anything past the QA round cap.",
  },
  {
    id: "m3",
    author: "manager",
    ts: min(412),
    brief: { label: "Phase 2 — QA round 1", text: "Chat-to-chat comms" },
    text:
      "QA sent Comms back. 'Two ordinary chats can message each other with no mission' was never " +
      "tested — every test built a run first, so a Mission-only coupling would have shipped. RTE " +
      "accepted one remediation task. Round 1 of 3; no action needed from you.",
  },
  {
    id: "m4",
    author: "human",
    ts: min(415),
    text: "Good catch. That's the whole point of that criterion — keep it strict.",
  },
  {
    id: "m5",
    author: "manager",
    ts: min(470),
    text:
      "Comms passed on round 2 and Phase 2 is closed. Platform and Comms leads retired at the " +
      "phase-3 gap — Comms was at 72% context anyway. Phase 3 is running with Engine and Assurance.",
  },
  {
    id: "m6",
    author: "manager",
    ts: min(541),
    brief: { label: "Escalation — needs you", text: "t-guard · PR #215" },
    text:
      "Assurance is blocked. PR #215 is green but has no reviewer queued, and the lead cannot " +
      "grant itself the override — which is the guard behaving correctly. Do you want to review " +
      "#215 yourself, queue a reviewer, or approve the override?",
  },
];

/* --------------------------------------------------------------------- run */

export const MOCK_RUN: MissionRun = {
  id: "run-01",
  specId: MOCK_MISSION.id,
  specVersion: 1,
  status: "running",
  currentPhaseId: "engine",
  startedAt: T0,
  actors: ACTORS,
  tasks: buildTasks(),
  remediations: [
    {
      id: "rem-comms-1",
      phaseId: "comms",
      round: 1,
      raisedBy: { role: "qa", chatId: "chat-qa-comms-r1" },
      unmet: ["c-usable-without-a-mission"],
      findings:
        "Every chat_send test constructs a MissionRun before sending. The criterion asks for the " +
        "opposite — that the primitive works with no mission at all — so the coupling it exists to " +
        "prevent is precisely what nothing exercises. Two call sites read run state on the delivery " +
        "path (courier.ts:88, chat-send.ts:140) and would throw for a plain chat.",
      tasks: [REMEDIATION_TASK],
      status: "accepted",
      decidedBy: { role: "orchestrator", chatId: "chat-rte-01" },
    },
  ],
  phases: {
    "tool-surface": { status: "done", qaRounds: 1, gates: [] },
    foundations: { status: "done", qaRounds: 1, gates: [] },
    comms: { status: "done", qaRounds: 2, gates: [] },
    engine: { status: "running", qaRounds: 0, gates: [] },
    actors: { status: "pending", qaRounds: 0, gates: [] },
    surface: { status: "pending", qaRounds: 0, gates: [] },
  },
  events: EVENTS,
};

/**
 * Spec tasks plus every accepted remediation task — what the run is ACTUALLY
 * executing. The board must read this rather than `spec.tasks`, or a phase that
 * QA reopened renders as though it never changed.
 */
export function effectiveTasks(): MissionTask[] {
  const extra = MOCK_RUN.remediations
    .filter((r) => r.status === "accepted")
    .flatMap((r) => r.tasks);
  return [...MOCK_MISSION.tasks, ...extra];
}
