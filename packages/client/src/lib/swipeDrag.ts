import { dragPosition, dragOpenness } from "./edgeSwipe.js";

/**
 * Letting the edge swipe drag a `Drawer` panel under the finger.
 *
 * Why a registry rather than props or a store: `touchmove` fires at refresh
 * rate, and the panel's position has to change on every one of them. Routing
 * that through React state re-renders the whole shell sixty times a second on
 * the slowest device the app runs on — the recognizer keeps its gesture in a
 * ref for exactly this reason (see `useEdgeSwipe`). So the panel publishes its
 * element here once, and the gesture writes to that element directly. Only the
 * COMMIT — one call, at the end — reaches React.
 *
 * The panels are shell chrome that already exists in exactly two places, so the
 * ids are a closed set rather than an arbitrary string.
 */
export type SwipePanelId = "picker" | "pane";

interface Registration {
  panel: HTMLElement;
  /** The scrim, when this drawer is modal. Faded alongside the panel. */
  scrim: () => HTMLElement | null;
  /** Which edge it is parked against — gives the sign of "closed". */
  side: "left" | "right";
}

const panels = new Map<SwipePanelId, Registration>();

/**
 * Who currently owns a panel's inline styles, and the cleanup they scheduled.
 *
 * The settle below hands the easing back to the class and then has to remove
 * the inline values once the transition is over — but the panel is SHARED
 * state, and a gesture is cheap to start: a swipe that gets handed to a
 * scroller settles, and the next finger can be down again well inside those
 * 240ms. Without an owner, that first gesture's timer fires in the middle of
 * the second one's drag and wipes its inline position while the finger is
 * still down and the transition is suspended — the panel snapping to its class
 * position for a frame. Exactly the "gesture dropped" feeling the rubber-band
 * exists to avoid, except real.
 */
interface Owner {
  token: object;
  timer: number | null;
}
const owners = new Map<SwipePanelId, Owner>();

function clearPending(id: SwipePanelId): void {
  const owner = owners.get(id);
  if (owner?.timer !== null && owner?.timer !== undefined) window.clearTimeout(owner.timer);
}

export function registerSwipePanel(id: SwipePanelId, reg: Registration): () => void {
  panels.set(id, reg);
  return () => {
    if (panels.get(id) !== reg) return;
    panels.delete(id);
    // A drawer that unmounts mid-settle takes its pending cleanup with it —
    // the node is gone, and on the next mount the styles are fresh anyway.
    clearPending(id);
    owners.delete(id);
  };
}

/** A gesture's live grip on one panel. */
export interface SwipeDragHandle {
  /** Finger travel in px, signed, since the gesture began. */
  move(travel: number): void;
  /** Finger lifted. `committed` is whether the navigation is going through. */
  settle(committed: boolean): void;
}

/** How long the settle gets. Matches `Drawer`'s `duration-200`. */
const SETTLE_MS = 200;

/**
 * Take hold of a panel for the length of one gesture.
 *
 * `toOpen` is where this move is trying to get to, which also says where the
 * panel is sitting right now (the other end).
 *
 * Returns `null` when there is nothing to drag — the drawer isn't mounted at
 * this breakpoint, or has no width yet. The caller falls back to the threshold
 * flick, which is still the behaviour for every rung of the stack that is a
 * VIEW swap rather than a panel: there is no second copy of the homepage to
 * slide under a finger.
 */
export function beginPanelDrag(id: SwipePanelId, toOpen: boolean): SwipeDragHandle | null {
  const reg = panels.get(id);
  if (!reg) return null;
  const el = reg.panel;
  const width = el.offsetWidth;
  if (width <= 0) return null;

  // This grab now owns the panel's inline styles. Anything the previous one
  // scheduled is void — it was cleanup for a position this drag is replacing.
  clearPending(id);
  const token = {};
  owners.set(id, { token, timer: null });

  const closed = reg.side === "left" ? -width : width;
  const from = toOpen ? closed : 0;
  const to = toOpen ? 0 : closed;

  // Suspend the class-driven transition: it is what makes the panel ARRIVE
  // after a tap, and mid-drag it would make the panel chase the finger 200ms
  // behind instead of being held by it.
  el.style.transition = "none";
  el.style.willChange = "translate";
  const scrim = reg.scrim();
  if (scrim) scrim.style.transition = "none";

  const paint = (position: number) => {
    // `translate`, not `transform`. Tailwind v4 compiles `-translate-x-full` to
    // the standalone `translate` property, so an inline `transform` would sit
    // beside the class rather than override it and the panel would not move.
    el.style.translate = `${position}px`;
    if (scrim) scrim.style.opacity = String(dragOpenness(position, closed, 0));
  };

  paint(from);

  let released = false;
  return {
    move(travel) {
      if (released) return;
      paint(dragPosition(from, to, travel, width));
    },
    settle(committed) {
      if (released) return;
      released = true;
      const landing = committed ? to : from;
      // Hand the easing back to the class, then drive to the landing position
      // EXPLICITLY rather than by clearing the inline value. React's re-render
      // from the commit lands a tick later, so a cleared inline style would let
      // the old class position win for a frame — the panel jumping back to
      // where the drag started before animating forward again.
      el.style.transition = "";
      if (scrim) scrim.style.transition = "";
      paint(landing);
      const owner = owners.get(id);
      if (owner?.token !== token) return;
      owner.timer = window.setTimeout(() => {
        // Re-checked at FIRE time, not only at schedule time: a later grab can
        // take the panel over during the settle, and it is painting live.
        if (owners.get(id)?.token !== token) return;
        el.style.translate = "";
        el.style.willChange = "";
        if (scrim) scrim.style.opacity = "";
        owners.delete(id);
      }, SETTLE_MS + 40);
    },
  };
}
