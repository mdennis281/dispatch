import { describe, expect, it } from "vitest";
import {
  type BakeOp,
  type Shape,
  IDENTITY_OP,
  bakeShapes,
  bakedSize,
  clampRect,
  insetCrop,
  mapPoint,
  mapShape,
  normalize,
  rotatedBounds,
  shapeBounds,
} from "./doc.js";

const W = 100;
const H = 50;

const op = (patch: Partial<BakeOp> = {}): BakeOp => ({ ...IDENTITY_OP(W, H), ...patch });

/** Shorthand: map a point through an op against the standard 100×50 source. */
const at = (o: BakeOp, x: number, y: number) => mapPoint(o, W, H, x, y);

/** Rounded compare — quarter turns must be exact, straightens only close. */
const near = (v: number) => Math.round(v * 1e6) / 1e6;

describe("mapPoint", () => {
  it("is the identity for an untransformed op", () => {
    expect(at(op(), 30, 40).map(near)).toEqual([30, 40]);
  });

  it("shifts by the crop origin", () => {
    const o = op({ crop: { x: 10, y: 20, w: 50, h: 30 } });
    expect(at(o, 30, 40).map(near)).toEqual([20, 20]);
  });

  it("rotates a quarter turn with no floating-point drift", () => {
    // 90° clockwise takes the top-left corner to the top-right of a 50×100 frame.
    const o = op({ angle: 90, crop: { x: 0, y: 0, w: H, h: W } });
    expect(at(o, 0, 0).map(near)).toEqual([50, 0]);
    expect(at(o, W, 0).map(near)).toEqual([50, 100]);
    expect(at(o, 0, H).map(near)).toEqual([0, 0]);
  });

  it("returns to the original point after four quarter turns", () => {
    let p: [number, number] = [17, 33];
    let w = W;
    let h = H;
    for (let i = 0; i < 4; i++) {
      const bounds = rotatedBounds(w, h, 90);
      const o: BakeOp = { angle: 90, flipH: false, flipV: false, crop: { x: 0, y: 0, ...bounds } };
      p = mapPoint(o, w, h, p[0], p[1]);
      [w, h] = [bounds.w, bounds.h];
    }
    expect(p.map(near)).toEqual([17, 33]);
  });

  it("mirrors across the vertical axis when flipped horizontally", () => {
    expect(at(op({ flipH: true }), 30, 40).map(near)).toEqual([70, 40]);
    expect(at(op({ flipV: true }), 30, 40).map(near)).toEqual([30, 10]);
  });
});

describe("rotatedBounds", () => {
  it("swaps the axes on a quarter turn", () => {
    expect(rotatedBounds(W, H, 90)).toEqual({ w: H, h: W });
    expect(rotatedBounds(W, H, 180)).toEqual({ w: W, h: H });
  });

  it("grows on any other angle", () => {
    const b = rotatedBounds(W, H, 30);
    expect(b.w).toBeGreaterThan(W);
    expect(b.h).toBeGreaterThan(H);
  });
});

describe("insetCrop", () => {
  it("is the whole image when there is no rotation", () => {
    expect(insetCrop(W, H, 0)).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it("excludes the wedges a straighten opens up", () => {
    const angle = 5;
    const bounds = rotatedBounds(W, H, angle);
    const c = insetCrop(W, H, angle);
    // Strictly inside the rotated frame, and strictly smaller than the source —
    // both are what "no transparent corners" means.
    expect(c.x).toBeGreaterThan(0);
    expect(c.y).toBeGreaterThan(0);
    expect(c.x + c.w).toBeLessThanOrEqual(bounds.w + 1e-9);
    expect(c.y + c.h).toBeLessThanOrEqual(bounds.h + 1e-9);
    expect(c.w).toBeLessThan(W);
  });
});

describe("mapShape", () => {
  const stroke: Shape = {
    id: "a",
    kind: "pen",
    points: [10, 10, 20, 20],
    color: "#fff",
    width: 2,
  };

  it("keeps an annotation on its target through a crop", () => {
    const o = op({ crop: { x: 5, y: 5, w: 60, h: 40 } });
    const out = mapShape(o, W, H, stroke);
    expect(out.kind === "pen" && out.points).toEqual([5, 5, 15, 15]);
  });

  it("re-normalizes a box whose origin corner moved", () => {
    const box: Shape = { id: "b", kind: "rect", x: 10, y: 10, w: 20, h: 10, color: "#fff", width: 2 };
    const o = op({ angle: 180, crop: { x: 0, y: 0, w: W, h: H } });
    const out = mapShape(o, W, H, box);
    // Mirrored through the centre, but still a positive-extent box.
    expect(out.kind === "rect" && [out.x, out.y, out.w, out.h].map(near)).toEqual([70, 30, 20, 10]);
  });

  it("leaves text upright, moving only its anchor", () => {
    const text: Shape = { id: "t", kind: "text", x: 10, y: 10, text: "hi", color: "#fff", fontSize: 16 };
    const out = mapShape(op({ angle: 90, crop: { x: 0, y: 0, w: H, h: W } }), W, H, text);
    expect(out.kind).toBe("text");
    expect(out.kind === "text" && out.fontSize).toBe(16);
  });
});

describe("bakeShapes", () => {
  const inside: Shape = { id: "in", kind: "rect", x: 10, y: 10, w: 10, h: 10, color: "#f00", width: 2 };
  const outside: Shape = { id: "out", kind: "rect", x: 80, y: 10, w: 10, h: 10, color: "#f00", width: 2 };

  it("drops shapes the crop cut away and keeps the rest", () => {
    const o = op({ crop: { x: 0, y: 0, w: 40, h: 40 } });
    const out = bakeShapes(o, W, H, [inside, outside]);
    expect(out.map((s) => s.id)).toEqual(["in"]);
  });
});

describe("helpers", () => {
  it("normalize turns a backwards drag into a positive box", () => {
    expect(normalize({ x: 30, y: 30, w: -10, h: -20 })).toEqual({ x: 20, y: 10, w: 10, h: 20 });
  });

  it("clampRect never selects outside the image", () => {
    expect(clampRect({ x: -5, y: -5, w: 200, h: 200 }, W, H)).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  it("bakedSize is the crop box", () => {
    expect(bakedSize(op({ crop: { x: 3, y: 4, w: 20, h: 30 } }))).toEqual({ width: 20, height: 30 });
  });

  it("shapeBounds spans every point of a stroke", () => {
    const s: Shape = { id: "s", kind: "pen", points: [5, 9, 25, 1], color: "#fff", width: 1 };
    expect(shapeBounds(s)).toEqual({ x: 5, y: 1, w: 20, h: 8 });
  });
});
