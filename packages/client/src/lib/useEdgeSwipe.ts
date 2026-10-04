import { useEffect, useRef } from "react";
import {
  beginEdgeSwipe,
  commitEdgeSwipe,
  trackEdgeSwipe,
  type EdgeSwipe,
  type SwipeDir,
} from "./edgeSwipe.js";

/**
 * The DOM half of the edge swipe. See `edgeSwipe.ts` for the rules and why each
 * one is there; this is only the plumbing — four listeners and one ref.
 *
 * TOUCH events, not pointer events, and that is not a style choice. WebKit fires
 * `pointercancel` the moment it hands a gesture to a scroller, and both surfaces
 * this gesture starts over (the transcript, the chat list) are scrollers — so a
 * pointer-based recognizer gets cancelled on roughly every swipe that matters,
 * while `touchmove` keeps arriving for the whole gesture. The existing device
 * recorder (`lib/interactionTrace.ts`) logs touch events for the same reason.
 *
 * Listeners go on `window` rather than on the shell box: the gesture is about
 * the SCREEN's edges, and the shell is `position: fixed` to exactly those edges
 * anyway, so a window listener means no ref to thread through `App` and no
 * chance of a stray overlay eating the capture.
 *
 * All four are `{ passive: true }`. Nothing here calls `preventDefault` — the
 * recognizer never moves anything mid-drag (see the "threshold flick" decision),
 * so claiming the touch would only make the page's own scrolling worse, and a
 * non-passive `touchmove` listener on `window` is a documented scroll-jank tax
 * on exactly the device this is for.
 */
export function useEdgeSwipe(enabled: boolean, onSwipe: (dir: SwipeDir) => void): void {
  // The gesture lives in a ref, not state: `touchmove` fires at refresh rate and
  // re-rendering the whole shell on each one is not a cost the phone can pay.
  // Only the commit — one call, at the end — reaches React.
  const swipe = useRef<EdgeSwipe | null>(null);
  // So the effect doesn't re-subscribe on every render of a parent that passes
  // an inline arrow.
  const fire = useRef(onSwipe);
  fire.current = onSwipe;

  useEffect(() => {
    if (!enabled) return;

    const point = (t: Touch) => ({ x: t.clientX, y: t.clientY, t: performance.now() });

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      swipe.current = beginEdgeSwipe({
        ...point(touch),
        width: window.innerWidth,
        touches: e.touches.length,
        inHorizontalScroller: startsInHorizontalScroller(e.target),
      });
    };

    const onMove = (e: TouchEvent) => {
      const live = swipe.current;
      const touch = e.touches[0];
      if (!live || !touch) return;
      swipe.current = trackEdgeSwipe(live, point(touch), e.touches.length);
    };

    const onEnd = (e: TouchEvent) => {
      const live = swipe.current;
      swipe.current = null;
      // `changedTouches`, not `touches`: by `touchend` the finger that lifted is
      // gone from the live list, so `touches[0]` is either absent or a DIFFERENT
      // finger that was resting on the screen.
      const touch = e.changedTouches[0];
      if (!live || !touch) return;
      const dir = commitEdgeSwipe(live, point(touch));
      if (dir) fire.current(dir);
    };

    const onCancel = () => {
      swipe.current = null;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onCancel);
      swipe.current = null;
    };
  }, [enabled]);
}

/**
 * Is this finger already inside something that pans sideways, or on somebody
 * else's screen?
 *
 * Two refusals, because both are "this touch is already spoken for":
 *
 *  - A HORIZONTAL SCROLLER. A code fence, a wide table, the review screenshot
 *    grid. The edge band is narrow enough that this is rare, but a transcript
 *    gutter is only ~12px wide, so a wide code block's own first flick can
 *    begin inside the band — and losing it to a navigation is unrecoverable
 *    (you can't scroll the block at all from its left end).
 *  - A MODAL. Anything carrying `aria-modal="true"` owns the window while it is
 *    up — the code viewer, the image annotator, the file picker, Workspace —
 *    and navigating the shell out from under it would leave a dialog floating
 *    over a screen it has nothing to do with. The shell's own `Drawer` panels
 *    are stamped `data-swipe-nav` and are explicitly NOT this: the chat picker
 *    and the More sheet are chrome the swipe navigates BETWEEN, which is the
 *    whole second half of the gesture (picker → home).
 *
 * Checked at `touchstart` only. One ancestor walk per touch, no listeners, and
 * nothing in the move path.
 */
function startsInHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  for (; el; el = el.parentElement) {
    if (el.getAttribute("aria-modal") === "true") return !el.hasAttribute("data-swipe-nav");
    // `+ 1` for the sub-pixel rounding a zoomed-out layout leaves behind: at
    // some widths a box that does not scroll still reports scrollWidth one
    // fractional pixel over its client width.
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
  }
  return false;
}
