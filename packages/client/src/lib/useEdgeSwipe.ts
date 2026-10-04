import { useEffect, useRef } from "react";
import {
  beginEdgeSwipe,
  commitEdgeSwipe,
  trackEdgeSwipe,
  type EdgeSwipe,
  type SwipeDir,
} from "./edgeSwipe.js";
import type { SwipeDragHandle } from "./swipeDrag.js";

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
 * All four are STILL `{ passive: true }` now that the gesture moves a panel
 * mid-drag. Claiming the touch is for stopping a scroll that would otherwise
 * happen, and none would: a vertical scroller does not scroll sideways, and a
 * finger that turns vertical hands the gesture over (`CROSS_SLOP`) before it
 * has moved anything. A non-passive `touchmove` on `window` is a documented
 * scroll-jank tax on exactly the device this is for, and it would be paid on
 * every touch in the app to prevent a scroll that never starts.
 *
 * `onBegin` is how the caller opts a gesture into following the finger: return
 * a grip on whatever this swipe will move (see `swipeDrag.ts`), or `null` to
 * leave it a threshold flick. It is asked ONCE, at `touchstart`, so the gesture
 * previews the same move it will later commit.
 */
export function useEdgeSwipe(
  enabled: boolean,
  onSwipe: (dir: SwipeDir) => void,
  onBegin?: (dir: SwipeDir) => SwipeDragHandle | null,
): void {
  // The gesture lives in a ref, not state: `touchmove` fires at refresh rate and
  // re-rendering the whole shell on each one is not a cost the phone can pay.
  // Only the commit — one call, at the end — reaches React.
  const swipe = useRef<EdgeSwipe | null>(null);
  // So the effect doesn't re-subscribe on every render of a parent that passes
  // an inline arrow.
  const fire = useRef(onSwipe);
  fire.current = onSwipe;
  const begin = useRef(onBegin);
  begin.current = onBegin;
  // The panel this gesture has hold of, if any. Same reason as `swipe` above:
  // it changes on every `touchmove` and must never reach React.
  const drag = useRef<SwipeDragHandle | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const point = (t: Touch) => ({ x: t.clientX, y: t.clientY, t: performance.now() });

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      // A gesture already in flight that never got a `touchend` (a second
      // finger, a cancelled sequence) must let go of its panel before this one
      // takes hold, or the panel is left wherever the last frame put it.
      drag.current?.settle(false);
      drag.current = null;
      swipe.current = beginEdgeSwipe({
        ...point(touch),
        width: window.innerWidth,
        touches: e.touches.length,
        inHorizontalScroller: startsInHorizontalScroller(e.target),
      });
      if (swipe.current) drag.current = begin.current?.(swipe.current.dir) ?? null;
    };

    const onMove = (e: TouchEvent) => {
      const live = swipe.current;
      const touch = e.touches[0];
      if (!live || !touch) return;
      const next = trackEdgeSwipe(live, point(touch), e.touches.length);
      swipe.current = next;
      // `null` means a scroller has claimed the gesture: put the panel back
      // where it was rather than abandoning it part-way out.
      if (!next) {
        drag.current?.settle(false);
        drag.current = null;
        return;
      }
      drag.current?.move(touch.clientX - live.origin.x);
    };

    const onEnd = (e: TouchEvent) => {
      const live = swipe.current;
      swipe.current = null;
      // `changedTouches`, not `touches`: by `touchend` the finger that lifted is
      // gone from the live list, so `touches[0]` is either absent or a DIFFERENT
      // finger that was resting on the screen.
      const touch = e.changedTouches[0];
      const grip = drag.current;
      drag.current = null;
      if (!live || !touch) {
        grip?.settle(false);
        return;
      }
      const dir = commitEdgeSwipe(live, point(touch));
      // Settle BEFORE the commit. The panel's landing position is a property of
      // the gesture, and `fire` re-renders the shell — doing it the other way
      // round means the panel is still inline-pinned to the finger during the
      // commit's render, which is the one frame the class position changes in.
      grip?.settle(dir !== null);
      if (dir) fire.current(dir);
    };

    const onCancel = () => {
      swipe.current = null;
      drag.current?.settle(false);
      drag.current = null;
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
      drag.current?.settle(false);
      drag.current = null;
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
