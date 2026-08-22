/**
 * Drill-in navigation for the board.
 *
 * A route, not a tab set. The levels nest — program → phase → task → agent —
 * and acceptance criteria live at whichever level owns them rather than in a
 * screen of their own, because "the acceptance tab" divorces a criterion from
 * the work that satisfies it, which is the one thing you always want beside it.
 */
export type Route =
  | { at: "program" }
  | { at: "phase"; phaseId: string }
  | { at: "task"; taskId: string }
  | { at: "agent"; actorId: string };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
}
