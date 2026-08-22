/**
 * PROPOSAL PREVIEW — the Program module, rendered so it can be argued with.
 * Reachable at `/program-preview` in a DEV build only (see main.tsx).
 *
 * Nothing here talks to a server. The plan is the static mock in `mock.ts`, the
 * live state is `mockRun.ts`, and every number on screen — waves, concurrency
 * steps, gate signatories, cap usage, validation errors, effective tool
 * deny-lists — is derived from them by `derive.ts`. That is deliberate: it makes
 * the picture a real test of the schema rather than an illustration of it, and
 * editing the mock immediately shows whether the shape can express what you
 * wanted. It has already earned that twice — once on the phase-criterion rule,
 * once on discovering the run needs an EFFECTIVE task list distinct from the
 * spec's, because QA can add tasks to a phase that is already running.
 *
 * LAYOUT is part of the proposal: the sidebar treatment on the left (so
 * "visually distinct from a quick action" can be judged by comparison rather
 * than asserted), the drill-in board in the middle, and the manager's mini chat
 * on the right — because the board and the conversation about it are ONE chat,
 * not two places.
 */
import { useState } from "react";
import { AlertTriangle, Info, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { MOCK_PROGRAM } from "./mock.js";
import { MOCK_MANAGER_CHAT, MOCK_RUN, effectiveTasks } from "./mockRun.js";
import { validate, type Plan } from "./derive.js";
import { CAPS } from "./types.js";
import { RunStatusPill } from "./chrome.js";
import type { Route } from "./nav.js";
import { ProgramScreen } from "./ProgramScreen.js";
import { PhaseScreen } from "./PhaseScreen.js";
import { TaskScreen } from "./TaskScreen.js";
import { AgentScreen } from "./AgentScreen.js";
import { SidebarMock } from "./SidebarMock.js";
import { MiniChat } from "./MiniChat.js";

export function ProgramPreview() {
  const plan: Plan = { spec: MOCK_PROGRAM, tasks: effectiveTasks(), run: MOCK_RUN };
  const [route, setRoute] = useState<Route>({ at: "program" });
  const [chatOpen, setChatOpen] = useState(true);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const nav = { route, go: setRoute };

  const issues = validate(plan);
  const errors = issues.filter((i) => i.severity === "error");
  const run = plan.run!;

  return (
    <div className="flex h-dvh w-full bg-app text-primary">
      <SidebarMock plan={plan} nav={nav} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* -------------------------------------------------------- header */}
        <div className="flex h-11 shrink-0 items-center gap-2 px-3 cm-hairline-b">
          <RunStatusPill status={run.status} />
          <span className="shrink-0 text-2xs text-faint">
            phase {plan.spec.phases.find((p) => p.id === run.currentPhaseId)?.order} of{" "}
            {plan.spec.phases.length}
          </span>
          <span className="shrink-0 text-2xs text-faint">·</span>
          <span className="shrink-0 text-2xs text-faint">
            {run.actors.filter((a) => a.status !== "retired").length} live actors
          </span>

          <div className="flex-1" />

          <CapMeter label="objective" used={plan.spec.objective.length} cap={CAPS.objective} />
          <CapMeter label="criteria" used={plan.spec.acceptance.length} cap={CAPS.criteria} />
          <CapMeter label="phases" used={plan.spec.phases.length} cap={CAPS.phases} />
          <CapMeter label="teams" used={plan.spec.teams.length} cap={CAPS.teams} />
          <CapMeter label="tasks" used={plan.tasks.length} cap={CAPS.tasks} />

          <button
            type="button"
            onClick={() => setIssuesOpen((v) => !v)}
            className="ml-1 shrink-0"
            title="Validation detail"
          >
            {errors.length > 0 ? (
              <Chip tone="danger">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </Chip>
            ) : (
              <Chip tone="success">validates</Chip>
            )}
          </button>
          {issues.length - errors.length > 0 && (
            <button type="button" onClick={() => setIssuesOpen((v) => !v)} className="shrink-0">
              <Chip tone="warn">{issues.length - errors.length} advisory</Chip>
            </button>
          )}

          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? "Hide manager chat" : "Show manager chat"}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
          >
            {chatOpen ? (
              <PanelRightClose className="size-3.5" />
            ) : (
              <PanelRightOpen className="size-3.5" />
            )}
          </button>
        </div>

        {issuesOpen && issues.length > 0 && <IssueBanner issues={issues} />}

        {/* -------------------------------------------------------- screen */}
        {route.at === "program" && <ProgramScreen plan={plan} nav={nav} />}
        {route.at === "phase" && <PhaseScreen plan={plan} phaseId={route.phaseId} nav={nav} />}
        {route.at === "task" && <TaskScreen plan={plan} taskId={route.taskId} nav={nav} />}
        {route.at === "agent" && <AgentScreen plan={plan} actorId={route.actorId} nav={nav} />}
      </div>

      {chatOpen && <MiniChat turns={MOCK_MANAGER_CHAT} status={run.status} />}
    </div>
  );
}

/* ----------------------------------------------------------------- header */

/** A cap and how much of it the plan spends — the authoring budget, made visible. */
function CapMeter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = Math.min(100, (used / cap) * 100);
  const hot = pct > 90;
  return (
    <div className="w-[4.8rem] shrink-0" title={`${label}: ${used} of ${cap}`}>
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

function IssueBanner({ issues }: { issues: ReturnType<typeof validate> }) {
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-b border-line bg-panel-2 px-4 py-2">
      <div className="flex flex-col gap-1">
        {issues.map((i, n) => (
          <div key={n} className="flex items-start gap-1.5 text-2xs leading-relaxed">
            {i.severity === "error" ? (
              <AlertTriangle className="mt-px size-3 shrink-0 text-danger" />
            ) : (
              <Info className="mt-px size-3 shrink-0 text-warn" />
            )}
            <span className="cm-mono shrink-0 text-faint">{i.where}</span>
            <span className={i.severity === "error" ? "text-danger-hi" : "text-secondary"}>
              {i.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
