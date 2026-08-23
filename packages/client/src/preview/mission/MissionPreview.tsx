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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  HardHat,
  Info,
  Layers,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  Target,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Chip, IconButton } from "../../components/ui/index.js";
import { MOCK_MISSION } from "./mock.js";
import { MOCK_MANAGER_CHAT, MOCK_RUN, effectiveTasks } from "./mockRun.js";
import { validate, type Plan } from "./derive.js";
import type { MissionPolicy, MissionSpec, TeamId } from "./types.js";
import { Crumbs, RowButton, RunStatusPill } from "./chrome.js";
import { crumbsFor, parentOf, titleFor, type Nav, type Route } from "./nav.js";
import { defaultOpen, type SectionState } from "./sections.js";

import { MissionScreen } from "./MissionScreen.js";
import { PhaseScreen } from "./PhaseScreen.js";
import { TaskScreen } from "./TaskScreen.js";
import { AgentScreen } from "./AgentScreen.js";
import { Sidebar } from "./Sidebar.js";
import { MiniChat } from "./MiniChat.js";
import type { SettingsDraft } from "./SettingsSection.js";

/**
 * Viewport y below which a section counts as "the one you are reading" — just
 * under the two header bands (44px title + 36px nav).
 */
const SPY_LINE = 96;

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
  const [active, setActive] = useState<string | undefined>();
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

  // Scroll-spy for the rail's current-section marker. `SectionState.active` was
  // declared and documented but never assigned, so the comparison in Sidebar
  // was always false and the rail silently had no indicator — the field being
  // optional meant nothing type-errored either.
  //
  // Positions are measured rather than read off IntersectionObserver entries:
  // "which section is nearest the top" is a question about the whole set, and
  // an entry-by-entry callback has to reconstruct that set anyway. The observer
  // is just a cheap trigger; the `scroll` listener is capturing, because the
  // element that actually scrolls is a nested div inside each screen and its
  // events never reach window in the bubble phase.
  useEffect(() => {
    let queued = false;
    const compute = () => {
      queued = false;
      let best: string | undefined;
      let bestTop = -Infinity;
      let firstId: string | undefined;
      let firstTop = Infinity;
      for (const [id, el] of refs.current) {
        const { top } = el.getBoundingClientRect();
        if (top <= SPY_LINE && top > bestTop) [bestTop, best] = [top, id];
        if (top < firstTop) [firstTop, firstId] = [top, id];
      }
      // Nothing has crossed the line yet (top of a short screen) — mark the
      // first section rather than nothing, so the rail is never blank.
      setActive(best ?? firstId);
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(compute);
    };
    schedule();
    const io = new IntersectionObserver(schedule, { threshold: [0, 0.5, 1] });
    for (const el of refs.current.values()) io.observe(el);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [route, open]);

  const sections: SectionState = useMemo(
    () => ({
      active,
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
    [active, open, setOpen],
  );

  const nav: Nav = { route, go: setRoute };
  const issues = validate(plan);
  const errors = issues.filter((i) => i.severity === "error");
  const run = MOCK_RUN;
  const title = titleFor(plan, route);

  return (
    <div className="flex h-dvh w-full bg-app text-primary">
      <Sidebar plan={plan} nav={nav} sections={sections} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------------------------------------------------------- title */}
        {/* Two bands, because they answer different questions and were fighting
            for one row: this one is WHAT you are looking at plus the run's
            global state, the strip below it is HOW TO MOVE. Folding them
            together is what pushed the breadcrumb into truncation. */}
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-2-ghost text-accent-2-hi">
            <TitleIcon at={route.at} />
          </span>
          <h1 className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-sm text-muted">{title.kind}:</span>
            {title.ordinal !== undefined && (
              <span className="cm-mono shrink-0 text-sm text-faint">{title.ordinal}.</span>
            )}
            <span className="truncate text-sm font-semibold text-primary">{title.name}</span>
          </h1>

          <div className="flex-1" />

          <RunStatusPill status={run.status} />
          <span className="shrink-0 text-2xs text-muted">
            {run.actors.filter((a) => a.status !== "retired").length} live
          </span>
          {dirty && <Chip tone="accent">settings modified</Chip>}
          <RowButton
            onClick={() => setIssuesOpen((v) => !v)}
            className="shrink-0"
            title="Validation detail"
          >
            {errors.length > 0 ? (
              <Chip tone="danger">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </Chip>
            ) : (
              <Chip tone="success">validates</Chip>
            )}
          </RowButton>
          {issues.length - errors.length > 0 && (
            <RowButton onClick={() => setIssuesOpen((v) => !v)} className="shrink-0">
              <Chip tone="warn">{issues.length - errors.length} advisory</Chip>
            </RowButton>
          )}
          <IconButton
            size="sm"
            onClick={() => setChatOpen((v) => !v)}
            tip={chatOpen ? "Hide manager chat" : "Show manager chat"}
            className="shrink-0"
          >
            {chatOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </IconButton>
        </div>

        {/* ------------------------------------------------------------ nav */}
        <div className="flex h-9 shrink-0 items-center gap-2 bg-surface px-3 cm-hairline-b">
          <Crumbs
            crumbs={crumbsFor(plan, nav)}
            onBack={(() => {
              const up = parentOf(plan, route);
              return up ? () => setRoute(up) : undefined;
            })()}
          />
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

/** One glyph per level, so the title bar is recognisable before it is read. */
function TitleIcon({ at }: { at: Route["at"] }) {
  if (at === "mission") return <Target className="size-3.5" />;
  if (at === "phase") return <Layers className="size-3.5" />;
  if (at === "task") return <ListChecks className="size-3.5" />;
  return <HardHat className="size-3.5" />;
}
