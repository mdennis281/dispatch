import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  HOLD_IDLE,
  HOLD_MS,
  holdCompleted,
  holdSwallowsClick,
  reduceHold,
  type HoldEvent,
  type HoldState,
} from "./pressHold.js";

/** Spread onto the element the press happens on. */
export interface PressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onContextMenu: (e: { preventDefault: () => void }) => void;
}

export interface LongPress {
  press: PressHandlers;
  /**
   * Call from the element's own `onClick`, FIRST: true means this click was the
   * tail of a hold and the element's normal action must not run.
   *
   * Consuming it here rather than swallowing the event in a capture handler is
   * deliberate — React runs capture and bubble listeners on the SAME element
   * out of one dispatch queue, so `stopPropagation` there is a subtlety, and a
   * plain question the click handler asks is a thing the next reader can follow.
   * It also means the swallow applies to exactly one click and can never latch.
   */
  swallowsClick: (e: { detail: number }) => boolean;
}

/**
 * Touch long-press, wired to React. See `pressHold.ts` for the rules and why
 * each one is there; this is only the DOM half — one timer and the handlers.
 *
 * `onHold` fires once, at the moment the press becomes a hold, with the finger
 * still down. Nothing fires on release: what a hold opened is the caller's to
 * close.
 */
export function useLongPress(onHold: () => void): LongPress {
  // The gesture lives in a REF, not state: `pointermove` fires at refresh rate
  // for the whole of a scroll, and re-rendering a sidebar row on each one is a
  // cost the row cannot pay. Only the hold itself — one call, at the end —
  // reaches React.
  const hold = useRef<HoldState>(HOLD_IDLE);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Typed explicitly because the body calls itself: an un-annotated recursive
  // `const` arrow is TS7022 ("implicitly has type any").
  const dispatch = useCallback<(event: HoldEvent) => void>(
    (event) => {
      const prev = hold.current;
      const next = reduceHold(prev, event);
      if (next === prev) return;
      hold.current = next;

      // The machine says whether the clock should be running; this keeps the
      // one real timer in step with it, so no path can leave a hold armed.
      if (next.phase !== "waiting" && timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
      if (next.phase === "waiting" && !timer.current) {
        timer.current = setTimeout(() => {
          timer.current = undefined;
          dispatch({ kind: "elapsed" });
        }, HOLD_MS);
      }
      if (holdCompleted(next) && !holdCompleted(prev)) onHold();
    },
    [onHold],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    press: {
      onPointerDown: (e) =>
        dispatch({ kind: "down", pointerType: e.pointerType, x: e.clientX, y: e.clientY }),
      onPointerMove: (e) => {
        // Cheapest possible no-op for the common case: the pointer crossing a
        // row it is not pressing.
        if (hold.current.phase !== "waiting") return;
        dispatch({ kind: "move", x: e.clientX, y: e.clientY });
      },
      onPointerUp: () => dispatch({ kind: "up" }),
      onPointerCancel: () => dispatch({ kind: "cancel" }),
      // A finger that slides off the element abandons the press. On touch this
      // also arrives right after `pointerup` — the touch pointer ceases to
      // exist — where a completed hold ignores it and keeps its click.
      onPointerLeave: () => dispatch({ kind: "cancel" }),
      // Android raises `contextmenu` from its own long-press at ~500ms, a beat
      // after ours has fired. Suppressed only while a hold is in flight, so a
      // right-click still gets its menu.
      onContextMenu: (e) => {
        if (hold.current.phase !== "idle") e.preventDefault();
      },
    },
    swallowsClick: (e) => {
      if (!holdSwallowsClick(hold.current, e.detail)) return false;
      hold.current = reduceHold(hold.current, { kind: "release" });
      return true;
    },
  };
}
