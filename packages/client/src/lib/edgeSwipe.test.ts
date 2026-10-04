/**
 * The rules a swipe has to pass, and — mostly — the ones it has to FAIL.
 *
 * A navigation gesture that is too eager is worse than no gesture at all: it
 * takes the screen away mid-read, which is exactly the complaint that started
 * this ("I was scrolling, then randomly got switched into another chat"). So the
 * negative cases below are the point of this suite — a vertical scroll that
 * drifts sideways, a pinch, a drag that starts mid-screen, a swipe that travels
 * the wrong way out of its own edge — and they are the ones that can't be
 * checked on a device, because the correct outcome is "nothing happened".
 */
import { describe, it, expect } from "vitest";
import {
  beginEdgeSwipe,
  trackEdgeSwipe,
  commitEdgeSwipe,
  COMMIT_PX,
  CROSS_SLOP,
  EDGE_PX,
  FLICK_PX,
  type EdgeSwipe,
} from "./edgeSwipe.js";

const WIDTH = 390; // iPhone 14/15 logical width.

const start = (over: Partial<Parameters<typeof beginEdgeSwipe>[0]> = {}) =>
  beginEdgeSwipe({
    x: 4,
    y: 300,
    t: 0,
    width: WIDTH,
    touches: 1,
    inHorizontalScroller: false,
    ...over,
  });

const BACK: EdgeSwipe = { dir: "back", origin: { x: 4, y: 300, t: 0 } };
const FORWARD: EdgeSwipe = { dir: "forward", origin: { x: WIDTH - 4, y: 300, t: 0 } };

describe("beginEdgeSwipe", () => {
  it("claims a touch that lands in either edge band", () => {
    expect(start()?.dir).toBe("back");
    expect(start({ x: EDGE_PX })?.dir).toBe("back");
    expect(start({ x: WIDTH - EDGE_PX })?.dir).toBe("forward");
    expect(start({ x: WIDTH - 1 })?.dir).toBe("forward");
  });

  it("ignores a touch that starts anywhere else", () => {
    expect(start({ x: EDGE_PX + 1 })).toBeNull();
    expect(start({ x: WIDTH / 2 })).toBeNull();
    expect(start({ x: WIDTH - EDGE_PX - 1 })).toBeNull();
  });

  it("ignores a second finger — a pinch is not a navigation", () => {
    expect(start({ touches: 2 })).toBeNull();
  });

  it("ignores a touch that begins inside something that pans sideways", () => {
    // A code fence at the left end of its scroll: the gesture would be
    // unrecoverable, since there is no other way to scroll it from there.
    expect(start({ inHorizontalScroller: true })).toBeNull();
  });
});

describe("trackEdgeSwipe", () => {
  it("keeps a sideways drag, and returns the same object so the hook can early-out", () => {
    expect(trackEdgeSwipe(BACK, { x: 40, y: 302, t: 60 })).toBe(BACK);
  });

  it("hands a vertical scroll back to the scroller", () => {
    expect(trackEdgeSwipe(BACK, { x: 10, y: 300 + CROSS_SLOP + 1, t: 80 })).toBeNull();
    // Upward too — the transcript scrolls both ways.
    expect(trackEdgeSwipe(BACK, { x: 10, y: 300 - CROSS_SLOP - 1, t: 80 })).toBeNull();
  });

  it("keeps a diagonal that is still mostly sideways", () => {
    // Off-axis past the slop, but travelling further across than down: this is a
    // swipe performed with the thumb, which arcs.
    expect(trackEdgeSwipe(BACK, { x: 120, y: 300 + CROSS_SLOP + 20, t: 90 })).toBe(BACK);
  });

  it("drops the gesture the moment a second finger arrives", () => {
    expect(trackEdgeSwipe(BACK, { x: 40, y: 300, t: 60 }, 2)).toBeNull();
  });
});

describe("commitEdgeSwipe", () => {
  it("commits a deliberate drag", () => {
    expect(commitEdgeSwipe(BACK, { x: 4 + COMMIT_PX, y: 300, t: 400 })).toBe("back");
    expect(commitEdgeSwipe(FORWARD, { x: WIDTH - 4 - COMMIT_PX, y: 300, t: 400 })).toBe(
      "forward",
    );
  });

  it("commits a short, fast flick", () => {
    // 30px in 40ms = 0.75 px/ms. Under COMMIT_PX, and the gesture everyone
    // actually performs one-handed.
    expect(commitEdgeSwipe(BACK, { x: 4 + 30, y: 300, t: 40 })).toBe("back");
  });

  it("does nothing for a slow drag that never got anywhere", () => {
    expect(commitEdgeSwipe(BACK, { x: 4 + FLICK_PX, y: 300, t: 900 })).toBeNull();
  });

  it("does nothing when the finger travelled out of the wrong side of its band", () => {
    // Started at the left edge and moved LEFT: a dismissal, or Safari's own pan.
    expect(commitEdgeSwipe(BACK, { x: 4 - COMMIT_PX, y: 300, t: 200 })).toBeNull();
    expect(commitEdgeSwipe(FORWARD, { x: WIDTH - 4 + COMMIT_PX, y: 300, t: 200 })).toBeNull();
  });

  it("does nothing for a gesture that ends up mostly vertical", () => {
    // Travelled far enough sideways, but further down — a scroll with a lean on
    // it. `trackEdgeSwipe` usually catches this first; this is the backstop for
    // the flick that reaches `touchend` inside one `touchmove`.
    expect(commitEdgeSwipe(BACK, { x: 4 + COMMIT_PX, y: 300 + COMMIT_PX + 10, t: 200 })).toBeNull();
  });

  it("cannot commit on a zero-length gesture with a repeated timestamp", () => {
    // Guards the velocity divide: same `t`, no travel, must not read as
    // infinitely fast.
    expect(commitEdgeSwipe(BACK, { x: 4, y: 300, t: 0 })).toBeNull();
  });
});
