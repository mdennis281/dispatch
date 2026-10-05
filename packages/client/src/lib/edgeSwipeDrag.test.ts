import { describe, it, expect } from "vitest";
import { dragPosition, dragOpenness, rubberBand, RUBBER_C } from "./edgeSwipe.js";

/** The phone the gesture is built for. */
const W = 390;
/** A left drawer: parked off-canvas at -W, open at 0. */
const CLOSED = -W;
const OPEN = 0;

describe("dragPosition", () => {
  it("pins the panel to the finger 1:1 inside the span", () => {
    // Anything less than 1:1 reads as lag — this is the whole feature.
    for (const travel of [1, 40, 195, 300, 389]) {
      expect(dragPosition(CLOSED, OPEN, travel, W)).toBe(CLOSED + travel);
    }
  });

  it("starts exactly where the panel is parked", () => {
    expect(dragPosition(CLOSED, OPEN, 0, W)).toBe(CLOSED);
    expect(dragPosition(OPEN, CLOSED, 0, W)).toBe(OPEN);
  });

  it("lands exactly on the far rest at full travel, with nothing left over", () => {
    expect(dragPosition(CLOSED, OPEN, W, W)).toBe(OPEN);
    expect(dragPosition(OPEN, CLOSED, -W, W)).toBe(CLOSED);
  });

  it("resists past the end instead of clamping dead", () => {
    // A panel that stops dead under a finger still moving reads as the gesture
    // having been dropped.
    const a = dragPosition(CLOSED, OPEN, W + 30, W);
    const b = dragPosition(CLOSED, OPEN, W + 90, W);
    expect(a).toBeGreaterThan(OPEN);
    expect(b).toBeGreaterThan(a);
    expect(b - OPEN).toBeLessThan(90); // …but by much less than the finger moved
  });

  it("resists past the CLOSED end too, in the other direction", () => {
    const back = dragPosition(CLOSED, OPEN, -60, W);
    expect(back).toBeLessThan(CLOSED);
    expect(CLOSED - back).toBeLessThan(60);
  });

  it("works the same for a right-hand panel, whose closed side is positive", () => {
    expect(dragPosition(0, W, 100, W)).toBe(100);
    expect(dragPosition(0, W, W + 50, W)).toBeGreaterThan(W);
    expect(dragPosition(0, W, -40, W)).toBeLessThan(0);
  });
});

describe("rubberBand", () => {
  it("never lets the panel run away, however hard it is pulled", () => {
    // The asymptote is the point: an unbounded overshoot would drag the panel
    // clean off the other side of the screen. It is `dim` — at most one panel
    // width past the stop, for any pull at all.
    for (const pull of [500, 5_000, 1_000_000]) {
      expect(Math.abs(rubberBand(pull, W))).toBeLessThan(W);
    }
    // And it really is approached, not merely bounded.
    expect(rubberBand(1_000_000, W)).toBeGreaterThan(0.99 * W);
  });

  it("is sign-preserving and still 'free' for the first pixel", () => {
    expect(rubberBand(0, W)).toBe(0);
    expect(rubberBand(-10, W)).toBeLessThan(0);
    expect(rubberBand(10, W)).toBeGreaterThan(0);
    // Resistance ramps in rather than switching on: the first pixel past the
    // stop must not jump.
    expect(Math.abs(rubberBand(1, W))).toBeCloseTo(RUBBER_C, 1);
  });

  it("is a no-op when there is no dimension to scale against", () => {
    expect(rubberBand(50, 0)).toBe(0);
  });
});

describe("dragOpenness", () => {
  it("reads 0 parked, 1 open, and tracks linearly between", () => {
    expect(dragOpenness(CLOSED, CLOSED, OPEN)).toBe(0);
    expect(dragOpenness(OPEN, CLOSED, OPEN)).toBe(1);
    expect(dragOpenness(-W / 2, CLOSED, OPEN)).toBeCloseTo(0.5, 5);
  });

  it("clamps, because dragPosition is outside the span by design", () => {
    // The scrim must not go to opacity 1.3 because someone pulled past the end.
    expect(dragOpenness(40, CLOSED, OPEN)).toBe(1);
    expect(dragOpenness(-W - 40, CLOSED, OPEN)).toBe(0);
  });
});
