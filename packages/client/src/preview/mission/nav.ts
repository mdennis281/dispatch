/**
 * Drill-in navigation for the board.
 *
 * A route, not a tab set. The levels nest — mission → phase → task → agent —
 * and acceptance criteria live at whichever level owns them rather than in a
 * screen of their own, because "the acceptance tab" divorces a criterion from
 * the work that satisfies it, which is the one thing you always want beside it.
 *
 * There is exactly ONE route, read by three surfaces that must never disagree:
 * the sidebar tree, the header breadcrumb, and the content. {@link crumbsFor}
 * lives here rather than in a screen so the breadcrumb is derived from the
 * route rather than assembled by whichever component happens to be rendering.
 */
import type { Crumb } from "./chrome.js";
import type { Plan } from "./derive.js";

export type Route =
  | { at: "mission" }
  | { at: "phase"; phaseId: string }
  | { at: "task"; taskId: string }
  | { at: "agent"; actorId: string };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
}

/** The breadcrumb trail for a route — the full ancestry, deepest crumb inert. */
export function crumbsFor(plan: Plan, nav: Nav): Crumb[] {
  const { spec, run } = plan;
  const { route } = nav;
  const root: Crumb = {
    label: spec.title,
    onClick: route.at === "mission" ? undefined : () => nav.go({ at: "mission" }),
  };
  if (route.at === "mission") return [root];

  const phaseCrumb = (phaseId: string, last: boolean): Crumb => {
    const p = spec.phases.find((x) => x.id === phaseId);
    return {
      label: p ? `${p.order}. ${p.title}` : phaseId,
      onClick: last ? undefined : () => nav.go({ at: "phase", phaseId }),
    };
  };
  const taskCrumb = (taskId: string, last: boolean): Crumb => {
    const t = plan.tasks.find((x) => x.id === taskId);
    return {
      label: t?.title ?? taskId,
      onClick: last ? undefined : () => nav.go({ at: "task", taskId }),
    };
  };

  if (route.at === "phase") return [root, phaseCrumb(route.phaseId, true)];

  if (route.at === "task") {
    const t = plan.tasks.find((x) => x.id === route.taskId);
    return t
      ? [root, phaseCrumb(t.phaseId, false), taskCrumb(t.id, true)]
      : [root, { label: route.taskId }];
  }

  // agent — include its task ancestry when it has one (a lead or the RTE does not)
  const a = run?.actors.find((x) => x.id === route.actorId);
  const t = a?.taskId ? plan.tasks.find((x) => x.id === a.taskId) : undefined;
  const trail: Crumb[] = [root];
  if (t) {
    trail.push(phaseCrumb(t.phaseId, false), taskCrumb(t.id, false));
  }
  trail.push({ label: a?.name ?? route.actorId });
  return trail;
}
