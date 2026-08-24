import { describe, expect, it } from "vitest";
import {
  HOLD_IDLE,
  HOLD_MS,
  HOLD_SLOP,
  holdCompleted,
  holdSwallowsClick,
  reduceHold,
  type HoldState,
} from "./pressHold.js";

/** Run a gesture from idle and return where it ended up. */
function play(...events: Parameters<typeof reduceHold>[1][]): HoldState {
  return events.reduce(reduceHold, HOLD_IDLE);
}

const touch = { kind: "down", pointerType: "touch", x: 100, y: 100 } as const;

describe("reduceHold", () => {
  it("fires when a touch stays put for the whole delay", () => {
    expect(holdCompleted(play(touch, { kind: "elapsed" }))).toBe(true);
  });

  it("ignores a mouse or pen press — those have hover", () => {
    for (const pointerType of ["mouse", "pen"]) {
      const state = play({ kind: "down", pointerType, x: 100, y: 100 }, { kind: "elapsed" });
      expect(holdCompleted(state), pointerType).toBe(false);
    }
  });

  it("cancels when the finger travels far enough to be a scroll", () => {
    const scrolled = play(touch, { kind: "move", x: 100, y: 100 + HOLD_SLOP + 1 }, { kind: "elapsed" });
    expect(holdCompleted(scrolled)).toBe(false);
  });

  it("tolerates the wobble of a finger trying to stay still", () => {
    expect(holdCompleted(play(touch, { kind: "move", x: 103, y: 96 }, { kind: "elapsed" }))).toBe(true);
  });

  it("cancels when the browser claims the gesture before the delay", () => {
    expect(holdCompleted(play(touch, { kind: "cancel" }, { kind: "elapsed" }))).toBe(false);
  });

  it("survives the pointercancel Android fires for its own long-press", () => {
    // Ours lands at 400ms, Chrome's context-menu gesture at ~500ms — the cancel
    // arrives AFTER the tray is already out and must not take its click away.
    expect(holdCompleted(play(touch, { kind: "elapsed" }, { kind: "cancel" }))).toBe(true);
  });

  it("keeps its claim on the click after the finger lifts", () => {
    const lifted = play(touch, { kind: "elapsed" }, { kind: "up" });
    expect(holdSwallowsClick(lifted, 1)).toBe(true);
  });

  it("leaves a plain tap alone", () => {
    const tapped = play(touch, { kind: "up" });
    expect(holdCompleted(tapped)).toBe(false);
    expect(holdSwallowsClick(tapped, 1)).toBe(false);
  });

  it("swallows one click and only one", () => {
    const held = play(touch, { kind: "elapsed" }, { kind: "up" });
    expect(holdSwallowsClick(held, 1)).toBe(true);
    // `release` is what the hook does once it has consumed that click, so the
    // NEXT press on the row is an ordinary tap into the chat again.
    const spent = reduceHold(held, { kind: "release" });
    expect(holdSwallowsClick(spent, 1)).toBe(false);
    // And the tap after that is an ordinary tap into the chat.
    expect(holdSwallowsClick(play(touch, { kind: "up" }), 1)).toBe(false);
  });

  it("never swallows a click the keyboard synthesized", () => {
    // Enter on the row a touch left focused. Only a pointer clears the phase,
    // so swallowing this would latch the row dead until the screen was touched.
    const held = play(touch, { kind: "elapsed" }, { kind: "up" });
    expect(holdSwallowsClick(held, 0)).toBe(false);
  });

  it("returns the same object when nothing moved, so the caller can early-out", () => {
    const waiting = reduceHold(HOLD_IDLE, touch);
    expect(reduceHold(waiting, { kind: "move", x: 101, y: 101 })).toBe(waiting);
    expect(reduceHold(HOLD_IDLE, { kind: "release" })).toBe(HOLD_IDLE);
    expect(reduceHold(HOLD_IDLE, { kind: "elapsed" })).toBe(HOLD_IDLE);
  });

  it("holds the delay under the platform gestures it has to beat", () => {
    // Android's contextmenu is ~500ms and iOS's selection callout later still.
    // A delay at or past those loses the race and the OS menu wins instead.
    expect(HOLD_MS).toBeLessThan(500);
    // And above a deliberate tap, or rows lose the taps that meant to open them.
    expect(HOLD_MS).toBeGreaterThanOrEqual(300);
  });
});
