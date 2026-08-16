/**
 * The markup document: what the editor actually edits.
 *
 * THE ONE RULE: every coordinate in here is in NATURAL IMAGE PIXELS, never in
 * screen pixels. The viewport (zoom/pan) is a pure view transform applied at
 * render time and is not part of the document. That is what lets zoom exist at
 * all — the old editor had none, because its markers were positioned against the
 * on-screen <img> box, so magnifying the image would have moved every marker.
 *
 * The second consequence matters more. Because a crop is a *coordinate change*
 * rather than a re-render, cropping maps every annotation through the same
 * affine instead of flattening them into the base bitmap. Annotations survive a
 * crop as live, selectable, re-editable objects. The previous editor had to
 * `render()` the whole marker layer to a PNG before handing the pixels to CROPRO,
 * which is why cropping silently ended your ability to move or undo anything you
 * had already drawn.
 */

/** Tools that produce a shape. `select` and `crop` are modes, not shapes. */
export type ShapeKind = "pen" | "highlight" | "arrow" | "rect" | "ellipse" | "text" | "redact";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShapeBase {
  id: string;
  kind: ShapeKind;
}

/** Pen and highlighter are the same geometry; only stroke style differs. */
export interface StrokeShape extends ShapeBase {
  kind: "pen" | "highlight";
  /** Flat [x0,y0,x1,y1,…] — Konva's Line format, so no conversion on render. */
  points: number[];
  color: string;
  width: number;
}

export interface ArrowShape extends ShapeBase {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface BoxShape extends ShapeBase {
  kind: "rect" | "ellipse" | "redact";
  /** Always normalized: w and h are non-negative. */
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Ignored by `redact`, which is an opaque fill with no outline. */
  width: number;
}

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}

export type Shape = StrokeShape | ArrowShape | BoxShape | TextShape;

/** A shape with an axis-aligned box (everything except strokes and text). */
export function isBox(s: Shape): s is BoxShape {
  return s.kind === "rect" || s.kind === "ellipse" || s.kind === "redact";
}

let seq = 0;
/** Ids only need to be unique within one editing session, so a counter does. */
export function newId(prefix = "s"): string {
  seq += 1;
  return `${prefix}${seq}`;
}

/** Swap negative width/height for a positive box — drags go in all directions. */
export function normalize(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Clamp a rect to the image, so a crop can never select outside the pixels. */
export function clampRect(r: Rect, imgW: number, imgH: number): Rect {
  const x = Math.max(0, Math.min(r.x, imgW));
  const y = Math.max(0, Math.min(r.y, imgH));
  return { x, y, w: Math.min(r.w, imgW - x), h: Math.min(r.h, imgH - y) };
}

/**
 * A destructive edit to the BASE IMAGE — the only kind there is.
 *
 * Applied in this order: flip in the source frame, rotate clockwise about the
 * image centre, then crop. `angle` is free degrees, so a 90° turn and a 3°
 * straighten are the SAME operation rather than two code paths that have to
 * agree with each other. `crop` is expressed in the rotated frame (see
 * `rotatedBounds`), because that is the frame the user drew it in.
 */
export interface BakeOp {
  /** Clockwise degrees. Quarter turns are just 90 / 180 / 270. */
  angle: number;
  flipH: boolean;
  flipV: boolean;
  /** In the ROTATED frame, whose origin is the rotated bounding box's corner. */
  crop: Rect;
}

/**
 * Axis-aligned bounds of a w×h rectangle rotated by `angle`. This is the frame
 * a straighten produces, and it is bigger than the source — the corners that
 * stick out are why a straighten is normally followed by a crop.
 */
export function rotatedBounds(w: number, h: number, angle: number): { w: number; h: number } {
  const { cos, sin } = trig(angle);
  return {
    w: Math.abs(w * cos) + Math.abs(h * sin),
    h: Math.abs(w * sin) + Math.abs(h * cos),
  };
}

/**
 * Snap the exact quarter turns. `Math.cos(Math.PI / 2)` is 6.1e-17, not 0, and
 * left alone that error puts a sub-pixel skew into every rotate-90 — invisible
 * once, visibly soft after four of them.
 */
function trig(angle: number): { cos: number; sin: number } {
  const norm = ((angle % 360) + 360) % 360;
  if (norm % 90 === 0) {
    const q = norm / 90;
    return { cos: [1, 0, -1, 0][q]!, sin: [0, 1, 0, -1][q]! };
  }
  const r = (norm * Math.PI) / 180;
  return { cos: Math.cos(r), sin: Math.sin(r) };
}

/**
 * The largest axis-aligned rectangle that fits inside a w×h image rotated by
 * `angle`, centred in the rotated frame — i.e. the crop that removes exactly the
 * transparent wedges a straighten introduces and nothing more.
 *
 * Without this, straightening by 2° leaves four triangular holes and the user
 * has to eyeball a crop that hides them. With it, the default crop after any
 * straighten is already the right one. (Standard largest-inscribed-rectangle
 * construction; the first branch is the degenerate case where the inscribed
 * rectangle collapses onto the image's own diagonal.)
 */
export function insetCrop(srcW: number, srcH: number, angle: number): Rect {
  const bounds = rotatedBounds(srcW, srcH, angle);
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const rad = (angle * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const longSide = Math.max(srcW, srcH);
  const shortSide = Math.min(srcW, srcH);
  const wide = srcW >= srcH;

  let w: number;
  let h: number;
  if (shortSide <= 2 * sin * cos * longSide || Math.abs(sin - cos) < 1e-10) {
    const half = 0.5 * shortSide;
    w = wide ? half / sin : half / cos;
    h = wide ? half / cos : half / sin;
  } else {
    const cos2 = cos * cos - sin * sin;
    w = (srcW * cos - srcH * sin) / cos2;
    h = (srcH * cos - srcW * sin) / cos2;
  }
  w = Math.max(1, Math.min(w, bounds.w));
  h = Math.max(1, Math.min(h, bounds.h));
  return { x: (bounds.w - w) / 2, y: (bounds.h - h) / 2, w, h };
}

export const IDENTITY_OP = (imgW: number, imgH: number): BakeOp => ({
  angle: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, w: imgW, h: imgH },
});

/** Output dimensions: exactly the crop box, since the crop is the last step. */
export function bakedSize(op: BakeOp): { width: number; height: number } {
  return { width: op.crop.w, height: op.crop.h };
}

/**
 * Map one point from the pre-bake image space into the post-bake one, given the
 * source dimensions. This is the whole reason annotations survive a crop: run
 * every shape's coordinates through here and they land exactly where they
 * looked before. It must stay in lockstep with `bakeImage`'s transform stack.
 */
export function mapPoint(
  op: BakeOp,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
): [number, number] {
  const px = op.flipH ? srcW - x : x;
  const py = op.flipV ? srcH - y : y;
  const { cos, sin } = trig(op.angle);
  const dx = px - srcW / 2;
  const dy = py - srcH / 2;
  const bounds = rotatedBounds(srcW, srcH, op.angle);
  return [
    dx * cos - dy * sin + bounds.w / 2 - op.crop.x,
    dx * sin + dy * cos + bounds.h / 2 - op.crop.y,
  ];
}

/**
 * Rebuild a shape in the post-bake coordinate space.
 *
 * Boxes are mapped by all FOUR corners and re-bounded rather than by two, since
 * a flip or a turn swaps which corner is the origin and a free-angle straighten
 * leaves the box no longer axis-aligned. For quarter turns the result is exact;
 * for a straighten the box grows to the bounding box of its rotated self, which
 * is the honest answer for a shape type that has no rotation of its own.
 *
 * Text keeps its upright orientation deliberately — straightening a screenshot
 * should not leave you with a tilted label — so only its anchor moves.
 */
export function mapShape(op: BakeOp, srcW: number, srcH: number, s: Shape): Shape {
  const at = (x: number, y: number) => mapPoint(op, srcW, srcH, x, y);
  switch (s.kind) {
    case "pen":
    case "highlight": {
      const points: number[] = new Array(s.points.length);
      for (let i = 0; i < s.points.length; i += 2) {
        const [x, y] = at(s.points[i]!, s.points[i + 1]!);
        points[i] = x;
        points[i + 1] = y;
      }
      return { ...s, points };
    }
    case "arrow": {
      const [x1, y1] = at(s.x1, s.y1);
      const [x2, y2] = at(s.x2, s.y2);
      return { ...s, x1, y1, x2, y2 };
    }
    case "text": {
      const [x, y] = at(s.x, s.y);
      return { ...s, x, y };
    }
    default: {
      const corners = [
        at(s.x, s.y),
        at(s.x + s.w, s.y),
        at(s.x + s.w, s.y + s.h),
        at(s.x, s.y + s.h),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { ...s, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

/**
 * Whether a shape still intersects the image after a bake. A crop that cuts away
 * the region a marker lived in should drop the marker rather than leave it
 * stranded off-canvas where only Select-All could ever reach it again.
 */
export function withinImage(s: Shape, width: number, height: number): boolean {
  const b = shapeBounds(s);
  return b.x + b.w > 0 && b.y + b.h > 0 && b.x < width && b.y < height;
}

/** Axis-aligned bounds in image space, ignoring stroke width. */
export function shapeBounds(s: Shape): Rect {
  switch (s.kind) {
    case "pen":
    case "highlight": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < s.points.length; i += 2) {
        minX = Math.min(minX, s.points[i]!);
        maxX = Math.max(maxX, s.points[i]!);
        minY = Math.min(minY, s.points[i + 1]!);
        maxY = Math.max(maxY, s.points[i + 1]!);
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "arrow":
      return normalize({ x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 });
    case "text":
      // An estimate: the real extent needs a laid-out text node, and this is only
      // used for the off-canvas test, where being generous is the safe direction.
      return { x: s.x, y: s.y, w: s.text.length * s.fontSize * 0.6, h: s.fontSize * 1.4 };
    default:
      return { x: s.x, y: s.y, w: s.w, h: s.h };
  }
}

/** Apply a bake to a whole shape list, dropping anything cropped away. */
export function bakeShapes(op: BakeOp, srcW: number, srcH: number, shapes: Shape[]): Shape[] {
  const { width, height } = bakedSize(op);
  return shapes
    .map((s) => mapShape(op, srcW, srcH, s))
    .filter((s) => withinImage(s, width, height));
}
