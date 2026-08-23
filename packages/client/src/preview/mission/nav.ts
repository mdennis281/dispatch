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
    // "Mission Base" rather than the mission title. The title is already on the
    // sidebar row and in the window, so repeating it here spends the widest
    // crumb on the one thing you cannot be confused about. Naming the
    // DESTINATION instead makes the leftmost crumb read as somewhere to go.
    label: "Mission Base",
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

/**
 * One level up from where you are — what the Back control goes to.
 *
 * Derived from the route rather than a history stack on purpose: after
 * jumping from an agent straight to a task via the sidebar, "back" should mean
 * UP THE TREE, not "undo my last click". A history stack would send you back to
 * the agent you were deliberately leaving.
 */
export function parentOf(plan: Plan, route: Route): Route | undefined {
  if (route.at === "mission") return undefined;
  if (route.at === "phase") return { at: "mission" };
  if (route.at === "task") {
    const t = plan.tasks.find((x) => x.id === route.taskId);
    return t ? { at: "phase", phaseId: t.phaseId } : { at: "mission" };
  }
  const a = plan.run?.actors.find((x) => x.id === route.actorId);
  if (a?.taskId && plan.tasks.some((t) => t.id === a.taskId)) {
    return { at: "task", taskId: a.taskId };
  }
  return { at: "mission" };
}

/** The page title: what you are looking at, as opposed to how you got here. */
export interface PageTitle {
  /** "Phase", "Task" — the KIND, in muted lead-in position. */
  kind: string;
  /** The thing itself. */
  name: string;
  /** Ordinal for a phase, so "3." survives without bloating the name. */
  ordinal?: number;
}

export function titleFor(plan: Plan, route: Route): PageTitle {
  const { spec, run } = plan;
  if (route.at === "mission") return { kind: "Mission", name: spec.title };
  if (route.at === "phase") {
    const p = spec.phases.find((x) => x.id === route.phaseId);
    return { kind: "Phase", name: p?.title ?? route.phaseId, ordinal: p?.order };
  }
  if (route.at === "task") {
    const t = plan.tasks.find((x) => x.id === route.taskId);
    return { kind: "Task", name: t?.title ?? route.taskId };
  }
  const a = run?.actors.find((x) => x.id === route.actorId);
  return { kind: "Agent", name: a?.name ?? route.actorId };
}
