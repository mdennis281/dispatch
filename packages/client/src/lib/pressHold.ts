/**
 * The touch long-press behind `ChatRow`'s action tray, as a pure machine.
 *
 * The tray (rename, delete, reap processes) slides in on HOVER, and a touch
 * screen has no hover to give. It used to answer that by parking the tray
 * permanently out on a coarse pointer — but a tray that is always out is a
 * 32px gutter overhanging every title in the list, on the device with the
 * least width to spare. Holding is the gesture every platform already uses for
 * "give me this row's actions", and it costs the list nothing at rest.
 *
 * The hook owns the DOM and one `setTimeout`; everything that decides WHETHER
 * a press becomes a hold lives here, because the client's vitest runs in the
 * node environment and renders no JSX (see `vitest.config.ts`).
 */

/**
 * How long the finger stays put before the press counts as a hold (ms).
 *
 * Squeezed from both ends. Shorter and an unhurried tap on a row turns into a
 * tray and loses the tap that meant to open the chat. Longer and the platform's
 * own long-press wins first: Chrome on Android raises `contextmenu` at ~500ms,
 * and iOS starts a selection later still. 400 sits under both and above a
 * deliberate tap.
 */
export const HOLD_MS = 400;

/**
 * How far the finger may drift while holding (px).
 *
 * A press that travels is a SCROLL — the chat list is a scroller and every
 * flick starts on some row. Chromium also stops sending `pointermove` and fires
 * `pointercancel` once it claims the gesture, so this is the belt to that
 * braces: whichever arrives first cancels the pending hold.
 */
export const HOLD_SLOP = 10;

export interface HoldState {
  /**
   * `waiting` — a finger is down and the clock is running.
   * `held` — the clock ran out; this gesture opened something.
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
  /** The gesture's click was consumed, or the trigger went away. */
  | { kind: "release" };

export const HOLD_IDLE: HoldState = { phase: "idle", origin: null };

/**
 * Returns the SAME object when nothing changed, so the caller can early-out on
 * identity — `move` fires at screen refresh rate for the whole of a scroll.
 */
export function reduceHold(state: HoldState, event: HoldEvent): HoldState {
  switch (event.kind) {
    case "down":
      // Touch only. A mouse and a pen both hover, and the tray is already
      // theirs the moment they arrive over the row.
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
      // A completed hold OUTLIVES the finger, by exactly one click: the press
      // that opened the tray still has a `click` to deliver, and that click
      // belongs to the gesture rather than to the row under it.
      return state.phase === "held" ? state : HOLD_IDLE;

    case "cancel":
      // Not necessarily a lost gesture: Android fires `pointercancel` when it
      // recognises its OWN long-press, ~100ms after ours has already fired.
      // Before that it means a scroll took over, which must cancel.
      return state.phase === "held" ? state : HOLD_IDLE;

    case "release":
      return state.phase === "idle" ? state : HOLD_IDLE;
  }
}

/** Did this gesture complete — is there something open because of it? */
export function holdCompleted(state: HoldState): boolean {
  return state.phase === "held";
}

/**
 * Must this click be swallowed as the tail of a hold?
 *
 * The hold happens ON the chat row's own button, so without this, holding a row
 * to reach its delete button also navigates you into the chat you were about to
 * act on.
 *
 * `detail` is the click's, and it is what keeps the swallow from LATCHING. A
 * click the keyboard synthesised (Enter on the row a touch left focused) would
 * otherwise be eaten too, and go on being eaten until the user touched the
 * screen again. A keyboard click reports `detail === 0` where a pointer-driven
 * one counts its presses.
 */
export function holdSwallowsClick(state: HoldState, detail: number): boolean {
  return state.phase === "held" && detail > 0;
}
