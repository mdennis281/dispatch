import { describe, it, expect } from "vitest";
import { swapArrival, shouldSwap, SWAP_MS } from "./useSurfaceSwap.js";

/**
 * The hook itself needs a DOM and this suite is node-environment by design (see
 * vitest.config.ts), so what is asserted here is the two pure pieces it is made
 * of. The motion is verified by eye — see the clip on the PR.
 */
describe("swapArrival", () => {
  it("starts transparent at the given scale and lands at rest", () => {
    expect(swapArrival(0.99).keyframes).toEqual([
      { opacity: 0, transform: "scale(0.99)" },
      { opacity: 1, transform: "scale(1)" },
    ]);
  });

  it("is short — a surface arriving, not a page loading", () => {
    expect(SWAP_MS).toBeGreaterThanOrEqual(120);
    expect(SWAP_MS).toBeLessThanOrEqual(220);
    expect(swapArrival(1.01).options.duration).toBe(SWAP_MS);
  });

  it("leaves no inline transform behind on the box the drawers position against", () => {
    expect(swapArrival(1.01).options.fill).toBe("none");
  });

  it("animates only composited properties, whatever the direction", () => {
    for (const from of [0.99, 1.01]) {
      for (const frame of swapArrival(from).keyframes) {
        expect(Object.keys(frame).sort()).toEqual(["opacity", "transform"]);
      }
    }
  });
});

describe("shouldSwap", () => {
  it("plays when the view crosses the full-bleed boundary", () => {
    expect(shouldSwap(false, true, false)).toBe(true);
    expect(shouldSwap(true, false, false)).toBe(true);
  });

  it("stays silent when the token did not change", () => {
    // Also the first commit, where the hook seeds prev with the current token:
    // the app appearing is the boot splash's job, not this one's.
    expect(shouldSwap(false, false, false)).toBe(false);
    expect(shouldSwap(true, true, false)).toBe(false);
  });

  it("plays nothing at all under prefers-reduced-motion", () => {
    expect(shouldSwap(false, true, true)).toBe(false);
    expect(shouldSwap(true, false, true)).toBe(false);
  });
});
