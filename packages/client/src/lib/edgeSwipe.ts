/**
 * The iOS-style edge swipe, as a pure recognizer.
 *
 * THERE IS NO APPLE API FOR THIS. The system "swipe back" belongs to Safari's
 * tab history: it is tab chrome, and an installed PWA in standalone mode has
 * neither a tab nor a history stack it is allowed to pop. So the gesture has to
 * be recognized from raw touches. (In a browser TAB, Safari's own edge pan may
 * still claim the leftmost ~20px before a `touchmove` ever reaches us — the
 * INSTALLED app is what this is built for, and the band below is kept narrow so
 * the two overlap as little as possible.)
 *
 * Everything that decides whether a drag counts lives here, with no DOM —
 * `useEdgeSwipe` is the half that touches the browser. Same split, for the same
 * reason, as `pressHold.ts` under `useLongPress`: the client's vitest is a node
 * runner that renders no JSX (see vitest.config.ts), so a rule written inside an
 * event handler can only be checked by a phone in someone's hand, and every
 * iOS gesture fix in this repo so far has been built from a DESCRIPTION of the
 * glitch rather than from something that could be re-run.
 */

/** Which way the shell should move. */
export type SwipeDir = "back" | "forward";

/** A finger, at a moment. `t` is `performance.now()`-style ms. */
export interface TouchPoint {
  x: number;
  y: number;
  t: number;
}

/** A gesture in flight. */
export interface EdgeSwipe {
  dir: SwipeDir;
  origin: TouchPoint;
}

/**
 * How close to the screen edge the finger has to START (px).
 *
 * Squeezed from both ends, like `HOLD_MS`. Narrower than ~24 and a thumb
 * reaching across the phone misses it often enough to feel broken. Wider and it
 * starts eating the first flick of the transcript's HORIZONTAL scrollers — a
 * code fence or a wide table begins just inside the transcript's 12px gutter, so
 * at 48 a swipe meant to read the end of a long line would navigate instead.
 * (The hook also refuses outright to start inside a horizontal scroller; this
 * band is the cheap half of that answer, the walk is the exact half.)
 *
 * 28 also sits about as close to Safari's own edge-pan region as it can without
 * being inside it — see the note above about browser tabs.
 */
export const EDGE_PX = 28;

/** How far a deliberate drag has to travel to commit (px). */
export const COMMIT_PX = 64;

/**
 * A flick commits short. Below `COMMIT_PX` the gesture can still win on speed,
 * because a fast flick is over in ~80ms and the finger simply never gets that
 * far: requiring 64px of travel from a flick means the gesture only works when
 * performed slowly, which is the opposite of how anyone navigates one-handed.
 */
export const FLICK_PX = 24;
/** px/ms, averaged over the whole gesture. ~0.5 is a flick; a drag is ~0.1. */
export const FLICK_SPEED = 0.5;

/**
 * How far the finger may wander off-axis before the gesture is abandoned (px).
 *
 * The transcript is a vertical scroller and the chat list is another, so most
 * touches that begin in the edge band are the start of a SCROLL. Handing the
 * gesture over as soon as it reads as vertical is what keeps this from
 * occasionally hijacking one — and it is checked continuously rather than only
 * at release, so a scroll that happens to end up 70px to the right of where it
 * started cannot commit a navigation on `touchend`.
 */
export const CROSS_SLOP = 36;

/**
 * Qualify a touch as the start of an edge swipe, or reject it.
 *
 * `inHorizontalScroller` is the caller's answer (it needs the DOM) to "is this
 * finger already inside something that pans sideways" — see `useEdgeSwipe`.
 */
export function beginEdgeSwipe(input: {
  x: number;
  y: number;
  t: number;
  /** Viewport width, for the right-hand band. */
  width: number;
  /** Live touch count. Two fingers is a pinch, never a navigation. */
  touches: number;
  inHorizontalScroller: boolean;
}): EdgeSwipe | null {
  if (input.touches !== 1) return null;
  if (input.inHorizontalScroller) return null;
  const origin: TouchPoint = { x: input.x, y: input.y, t: input.t };
  if (input.x <= EDGE_PX) return { dir: "back", origin };
  if (input.x >= input.width - EDGE_PX) return { dir: "forward", origin };
  return null;
}

/**
 * Keep tracking, or abandon. `null` means this gesture is over and belongs to
 * something else (a scroller, or a second finger).
 *
 * Returns the SAME object when nothing changed so the hook can early-out on
 * identity — `touchmove` fires at refresh rate for the whole of a scroll.
 */
export function trackEdgeSwipe(
  swipe: EdgeSwipe,
  point: TouchPoint,
  touches = 1,
): EdgeSwipe | null {
  if (touches !== 1) return null;
  const dx = Math.abs(point.x - swipe.origin.x);
  const dy = Math.abs(point.y - swipe.origin.y);
  // Off-axis AND not yet clearly sideways: the scroller has it.
  if (dy > CROSS_SLOP && dy >= dx) return null;
  return swipe;
}

/**
 * The finger left the glass: navigate, or do nothing.
 *
 * The sign check is what makes the two bands mean opposite things rather than
 * "a swipe happened near an edge" — a drag that starts at the left edge and
 * travels LEFT is someone dismissing something, or Safari's own pan, and must
 * not count as going back.
 */
export function commitEdgeSwipe(swipe: EdgeSwipe, point: TouchPoint): SwipeDir | null {
  const travel = point.x - swipe.origin.x;
  const dx = Math.abs(travel);
  const dy = Math.abs(point.y - swipe.origin.y);
  // Must read as sideways at the end too, not merely have stayed within slop.
  if (dx <= dy) return null;
  if (swipe.dir === "back" ? travel <= 0 : travel >= 0) return null;
  // `max(1, …)` so a synthetic or coalesced pair of events with the same
  // timestamp can't divide by zero and commit on an infinite velocity.
  const speed = dx / Math.max(1, point.t - swipe.origin.t);
  if (dx >= COMMIT_PX) return swipe.dir;
  if (dx >= FLICK_PX && speed >= FLICK_SPEED) return swipe.dir;
  return null;
}
