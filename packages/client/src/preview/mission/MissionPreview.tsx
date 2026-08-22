/**
 * PROPOSAL PREVIEW — the Mission module, rendered so it can be argued with.
 * Reachable at `/mission-preview` in a DEV build only (see main.tsx).
 *
 * Nothing here talks to a server. The plan is the static mock in `mock.ts`, the
 * live state is `mockRun.ts`, and every number on screen — waves, concurrency
 * steps, gate signatories, cap usage, validation errors, effective tool
 * deny-lists — is derived from them by `derive.ts`. That is deliberate: it makes
 * the picture a real test of the schema rather than an illustration of it, and
 * editing the mock immediately shows whether the shape can express what you
 * wanted. It has earned that twice already — once on the phase-criterion rule,
 * once on discovering the run needs an EFFECTIVE task list distinct from the
 * spec's, because QA can add tasks to a phase that is already running.
 *
 * THE SETTINGS ARE LIVE. `policy` and the per-team hire budgets are state here,
 * not constants, and the whole board re-derives from them. That is the argument
 * for putting them on the board at all: the effect of `maxParallelTasks` is not
 * legible from the number, only from what it does to a phase's schedule, so the
 * form and the thing it changes have to be on the same screen.
 *
 * NAVIGATION lives in one place. The sidebar tree, the header breadcrumb and the
 * content all read the same {@link Route}; the sidebar also owns which sections
 * of the current screen are open. An earlier draft had a decorative sidebar
 * beside a board that navigated by clicking cards, which meant two unrelated
 * ways to reach anything and a rail that never agreed with the content.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip } from "../../components/ui/index.js";
import { MOCK_MISSION } from "./mock.js";
import { MOCK_MANAGER_CHAT, MOCK_RUN, effectiveTasks } from "./mockRun.js";
import { validate, type Plan } from "./derive.js";
import type { MissionPolicy, MissionSpec, TeamId } from "./types.js";
import { Crumbs, RunStatusPill } from "./chrome.js";
import { crumbsFor, parentOf, type Nav, type Route } from "./nav.js";
import { defaultOpen, type SectionState } from "./sections.js";
import { MissionScreen } from "./MissionScreen.js";
import { PhaseScreen } from "./PhaseScreen.js";
import { TaskScreen } from "./TaskScreen.js";
import { AgentScreen } from "./AgentScreen.js";
import { Sidebar } from "./Sidebar.js";
import { MiniChat } from "./MiniChat.js";
import type { SettingsDraft } from "./SettingsSection.js";

const BASE_DRAFT: SettingsDraft = {
  policy: MOCK_MISSION.policy,
  hireBudgets: Object.fromEntries(MOCK_MISSION.teams.map((t) => [t.id, t.hireBudget])),
};

export function MissionPreview() {
  const [route, setRoute] = useState<Route>({ at: "mission" });
  const [chatOpen, setChatOpen] = useState(true);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft>(BASE_DRAFT);
  const [open, setOpenMap] = useState<Record<string, boolean>>(defaultOpen);
  const refs = useRef(new Map<string, HTMLElement>());

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(BASE_DRAFT);

  // The spec the board actually renders: the mock, with the owner's live
  // settings folded in. Everything downstream derives from this, which is what
  // makes moving a slider change the concurrency preview two screens away.
  const spec: MissionSpec = useMemo(
    () => ({
      ...MOCK_MISSION,
      policy: draft.policy,
      teams: MOCK_MISSION.teams.map((t) => ({
        ...t,
        hireBudget: draft.hireBudgets[t.id] ?? t.hireBudget,
      })),
    }),
    [draft],
  );

  const plan: Plan = useMemo(
    () => ({ spec, tasks: effectiveTasks(), run: MOCK_RUN }),
    [spec],
  );

  const setOpen = useCallback(
    (id: string, v: boolean) => setOpenMap((m) => ({ ...m, [id]: v })),
    [],
  );

  const sections: SectionState = useMemo(
    () => ({
      isOpen: (id) => open[id] ?? true,
      toggle: (id) => setOpenMap((m) => ({ ...m, [id]: !(m[id] ?? true) })),
      setOpen,
      focus: (id) => {
        setOpenMap((m) => ({ ...m, [id]: true }));
        // Next frame: the section may have just been expanded, and scrolling to
        // a zero-height element lands in the wrong place.
        requestAnimationFrame(() =>
          refs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
      },
      register: (id, el) => {
        if (el) refs.current.set(id, el);
        else refs.current.delete(id);
      },
    }),
    [open, setOpen],
  );

  const nav: Nav = { route, go: setRoute };
  const issues = validate(plan);
  const errors = issues.filter((i) => i.severity === "error");
  const run = MOCK_RUN;

  return (
    <div className="flex h-dvh w-full bg-app text-primary">
      <Sidebar plan={plan} nav={nav} sections={sections} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* -------------------------------------------------------- header */}
        <div className="flex h-11 shrink-0 items-center gap-2 px-3 cm-hairline-b">
          <Crumbs
            crumbs={crumbsFor(plan, nav)}
            onBack={(() => {
              const up = parentOf(plan, route);
              return up ? () => setRoute(up) : undefined;
            })()}
          />
          <span className="shrink-0 text-faint">·</span>
          <RunStatusPill status={run.status} />
          <span className="shrink-0 text-2xs text-faint">
            {run.actors.filter((a) => a.status !== "retired").length} live
          </span>

          <div className="flex-1" />

          {dirty && <Chip tone="accent">settings modified</Chip>}

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
        {route.at === "mission" && (
          <MissionScreen
            plan={plan}
            nav={nav}
            sections={sections}
            draft={draft}
            dirty={dirty}
            onDraft={setDraft}
            onReset={() => setDraft(BASE_DRAFT)}
          />
        )}
        {route.at === "phase" && (
          <PhaseScreen plan={plan} phaseId={route.phaseId} nav={nav} sections={sections} />
        )}
        {route.at === "task" && (
          <TaskScreen plan={plan} taskId={route.taskId} nav={nav} sections={sections} />
        )}
        {route.at === "agent" && (
          <AgentScreen plan={plan} actorId={route.actorId} nav={nav} sections={sections} />
        )}
      </div>

      {chatOpen && <MiniChat turns={MOCK_MANAGER_CHAT} status={run.status} />}
    </div>
  );
}

/* ----------------------------------------------------------------- header */


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
