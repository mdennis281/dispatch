/**
 * The touch long-press behind `ui/Tooltip`, as a pure machine.
 *
 * A tooltip is a hover affordance, and a touch screen has no hover — so on a
 * phone the sidebar's row markers (`rowMarkers.ts`: 10px glyphs whose counts
 * live ONLY in their tooltip) had nothing at all to say. Holding is the gesture
 * every platform already uses for "tell me about this without doing it".
 *
 * The component owns the DOM and one `setTimeout`; everything that decides
 * WHETHER a press becomes a tooltip lives here, because the client's vitest
 * runs in the node environment and renders no JSX (see `vitest.config.ts`).
 */

/**
 * How long the finger stays put before the press counts as a hold (ms).
 *
 * Squeezed from both ends. Shorter and an unhurried tap on the row underneath
 * turns into a tooltip and loses its click, which is the one failure that would
 * make the row feel broken. Longer and the platform's own long-press wins
 * first: Chrome on Android raises `contextmenu` at ~500ms, and iOS starts a
 * selection later still. 400 sits under both and above a deliberate tap.
 */
export const HOLD_MS = 400;

/**
 * How far the finger may drift while holding (px).
 *
 * A press that travels is a SCROLL — the sidebar is a scroller and every list
 * flick starts on some row. Chromium also stops sending `pointermove` and fires
 * `pointercancel` once it claims the gesture, so this is the belt to that
 * braces: whichever arrives first cancels the pending tooltip.
 */
export const HOLD_SLOP = 10;

export interface HoldState {
  /**
   * `waiting` — a finger is down and the clock is running.
   * `held` — the clock ran out; the bubble is up because of this gesture.
   */
  phase: "idle" | "waiting" | "held";
  origin: { x: number; y: number } | null;
}

export type HoldEvent =
  | { kind: "down"; pointerType: string; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  /** `HOLD_MS` passed with the finger still down. */
  | { kind: "elapsed" }
  | { kind: "up" }
  | { kind: "cancel" }
  /** A press landed somewhere else, or the trigger went away. */
  | { kind: "dismiss" };

export const HOLD_IDLE: HoldState = { phase: "idle", origin: null };

/**
 * Returns the SAME object when nothing changed, so the caller can early-out on
 * identity — `move` fires at screen refresh rate for the whole of a scroll.
 */
export function reduceHold(state: HoldState, event: HoldEvent): HoldState {
  switch (event.kind) {
    case "down":
      // Touch only. A mouse or pen already opened the bubble on hover, and for
      // those a press is the moment `Tooltip` DISMISSES — arming a hold on one
      // would fight its own dismissal.
      if (event.pointerType !== "touch") return state.phase === "idle" ? state : HOLD_IDLE;
      return { phase: "waiting", origin: { x: event.x, y: event.y } };

    case "move": {
      if (state.phase !== "waiting" || !state.origin) return state;
      const dx = event.x - state.origin.x;
      const dy = event.y - state.origin.y;
      return Math.hypot(dx, dy) > HOLD_SLOP ? HOLD_IDLE : state;
    }

    case "elapsed":
      return state.phase === "waiting" ? { phase: "held", origin: state.origin } : state;

    case "up":
      // The bubble OUTLIVES the finger. Lifting is how you get your hand off
      // what you just asked about — closing then would show the answer only
      // while it was covered. The next press anywhere takes it away.
      return state.phase === "held" ? state : HOLD_IDLE;

    case "cancel":
      // Not necessarily a lost gesture: Android fires `pointercancel` when it
      // recognises its OWN long-press, ~100ms after ours has already opened.
      // Before that it means a scroll took over, which must cancel.
      return state.phase === "held" ? state : HOLD_IDLE;

    case "dismiss":
      return state.phase === "idle" ? state : HOLD_IDLE;
  }
}

/** Is the bubble up because of a hold (rather than hover or focus)? */
export function holdOpen(state: HoldState): boolean {
  return state.phase === "held";
}

/**
 * Must the click that ends this gesture be swallowed?
 *
 * These triggers sit INSIDE the thing they describe — the row markers are in
 * the chat row's own button, an `IconButton`'s tip wraps the button itself. So
 * without this, reading a tooltip navigates you away from the row you were
 * reading about, or presses the button you were checking the meaning of.
 */
export function holdSwallowsClick(state: HoldState): boolean {
  return state.phase === "held";
}
