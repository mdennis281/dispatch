import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  clampPan,
  clampScale,
  fit,
  fitScale,
  toImage,
  toScreen,
  wheelFactor,
  zoomAt,
  zoomToRect,
} from "./imageViewport.js";

const image = { width: 1000, height: 500 };
const box = { width: 500, height: 500 };

describe("fit", () => {
  it("shows the whole image, centred", () => {
    const vp = fit(image, box);
    expect(vp.scale).toBe(0.5);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(125);
  });

  it("never magnifies a small image past 1:1 on open", () => {
    // Upscaling here would imply detail the file does not contain.
    expect(fit({ width: 100, height: 100 }, box).scale).toBe(1);
    expect(fitScale({ width: 100, height: 100 }, box)).toBe(5);
  });
});

describe("zoomAt", () => {
  it("keeps the image point under the anchor fixed", () => {
    const vp = { scale: 1, x: -200, y: -100 };
    const anchor = { x: 250, y: 250 };
    const before = toImage(vp, anchor.x, anchor.y);
    const after = toImage(zoomAt(vp, 2, anchor.x, anchor.y, image, box), anchor.x, anchor.y);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it("refuses to zoom past the ceiling", () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1000, 0, 0, image, box).scale).toBe(MAX_SCALE);
  });

  it("has a floor relative to fit, so a huge image can still zoom out", () => {
    const huge = { width: 20000, height: 20000 };
    const min = clampScale(0, huge, box);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThan(fitScale(huge, box));
  });
});

describe("clampPan", () => {
  it("centres an axis where the image is smaller than the box", () => {
    const vp = clampPan({ scale: 0.5, x: 9999, y: -9999 }, image, box);
    expect(vp.x).toBe(0); // 1000*0.5 === box width, so exactly flush
    expect(vp.y).toBe(125);
  });

  it("stops an edge coming inside the box when zoomed in", () => {
    // 2× → 2000×1000, both larger than the 500×500 box.
    expect(clampPan({ scale: 2, x: 300, y: 300 }, image, box).x).toBe(0);
    expect(clampPan({ scale: 2, x: -9999, y: 0 }, image, box).x).toBe(500 - 2000);
  });
});

describe("zoomToRect", () => {
  it("frames the rect near the centre of the box", () => {
    const vp = zoomToRect({ x: 400, y: 200, w: 200, h: 100 }, box, image, 0);
    const [cx, cy] = toScreen(vp, 500, 250);
    expect(cx).toBeCloseTo(250, 3);
    expect(cy).toBeCloseTo(250, 3);
  });
});

describe("wheelFactor", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
  });

  it("scales line and page deltas up to pixels", () => {
    // Firefox reports lines, not pixels; treating 3 lines as 3px makes every
    // Firefox wheel tick imperceptible.
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0), 10);
    expect(wheelFactor(1, 2)).toBeCloseTo(wheelFactor(400, 0), 10);
  });
});
