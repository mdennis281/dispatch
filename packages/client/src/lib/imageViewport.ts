/**
 * Zoom and pan, as pure arithmetic.
 *
 * The viewport maps image space onto the visible box, and is the ONLY place the
 * two spaces meet. Keeping it here rather than inside the component means the
 * fiddly parts — anchoring a zoom under the cursor, keeping a pinch centred
 * between two fingers, refusing to let the image be flung off screen — are
 * testable without a canvas or a DOM.
 *
 * Lives in `lib/` because it has two consumers: the annotator it was written
 * for, and the chat's media viewer. Zoom-under-cursor is exactly the kind of
 * arithmetic that is wrong in subtly different ways in each of two copies.
 *
 * The old editor had no zoom at all: it sized the image with `objectFit:
 * contain` into a fixed 64vh box, so a 3000px-wide screenshot was viewed at
 * roughly a third of scale and you annotated details you could not see.
 */
/**
 * The rectangle `zoomToRect` frames. Declared structurally rather than imported
 * from the annotator's `doc.ts`: this module moved OUT of the annotator so the
 * chat's media viewer could share its arithmetic, and importing a shape back
 * from the feature it was extracted from would re-couple the two.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  /** Image pixels per screen pixel. */
  scale: number;
  /** Screen position of the image's top-left corner, within the box. */
  x: number;
  y: number;
}

export interface Box {
  width: number;
  height: number;
}

/** Hard ceiling. Past this you are annotating individual pixels. */
export const MAX_SCALE = 16;
/** Floor is relative to fit, so a huge screenshot can still zoom out past "all". */
const MIN_FIT_FRACTION = 0.25;

/** The scale at which the whole image is visible inside `box`. */
export function fitScale(image: Box, box: Box): number {
  if (!image.width || !image.height || !box.width || !box.height) return 1;
  return Math.min(box.width / image.width, box.height / image.height);
}

/**
 * Opening view: the whole image, centred, never magnified past 1:1. Upscaling
 * a small image on open would just show it blurry and imply detail that is not
 * in the file — the user can still zoom in deliberately.
 */
export function fit(image: Box, box: Box): Viewport {
  const scale = Math.min(fitScale(image, box), 1);
  return centered(scale, image, box);
}

/** Centre the image in the box at a given scale. */
export function centered(scale: number, image: Box, box: Box): Viewport {
  return {
    scale,
    x: (box.width - image.width * scale) / 2,
    y: (box.height - image.height * scale) / 2,
  };
}

export function clampScale(scale: number, image: Box, box: Box): number {
  const min = Math.min(fitScale(image, box), 1) * MIN_FIT_FRACTION;
  return Math.max(min, Math.min(MAX_SCALE, scale));
}

/** Screen point → image point. */
export function toImage(vp: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - vp.x) / vp.scale, (sy - vp.y) / vp.scale];
}

/** Image point → screen point. */
export function toScreen(vp: Viewport, ix: number, iy: number): [number, number] {
  return [ix * vp.scale + vp.x, iy * vp.scale + vp.y];
}

/**
 * Scale about a fixed screen point, so whatever is under the cursor (or between
 * two pinching fingers) stays under it. Anchoring at the box centre instead is
 * the single thing that makes a zoom feel broken.
 */
export function zoomAt(
  vp: Viewport,
  nextScale: number,
  anchorX: number,
  anchorY: number,
  image: Box,
  box: Box,
): Viewport {
  const scale = clampScale(nextScale, image, box);
  const [ix, iy] = toImage(vp, anchorX, anchorY);
  return clampPan({ scale, x: anchorX - ix * scale, y: anchorY - iy * scale }, image, box);
}

/**
 * Keep the image tethered to the box: centred on any axis where it is smaller
 * than the box, and otherwise never dragged far enough for an edge to come
 * inside it. Without this you can flick a zoomed image into the void and have no
 * way back except Fit.
 */
export function clampPan(vp: Viewport, image: Box, box: Box): Viewport {
  const w = image.width * vp.scale;
  const h = image.height * vp.scale;
  const axis = (pos: number, size: number, extent: number) =>
    size <= extent ? (extent - size) / 2 : Math.max(extent - size, Math.min(0, pos));
  return { scale: vp.scale, x: axis(vp.x, w, box.width), y: axis(vp.y, h, box.height) };
}

/** Zoom so `rect` (image space) fills the box — used to frame a crop. */
export function zoomToRect(rect: Rect, box: Box, image: Box, padding = 24): Viewport {
  if (!rect.w || !rect.h) return fit(image, box);
  const scale = clampScale(
    Math.min((box.width - padding * 2) / rect.w, (box.height - padding * 2) / rect.h),
    image,
    box,
  );
  return clampPan(
    {
      scale,
      x: box.width / 2 - (rect.x + rect.w / 2) * scale,
      y: box.height / 2 - (rect.y + rect.h / 2) * scale,
    },
    image,
    box,
  );
}

/** Euclidean distance between two touch points, for pinch scale. */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint of two touch points, used as the pinch anchor. */
export function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Wheel notch → scale factor. `deltaMode` matters: Firefox reports lines (1) and
 * pages (2) rather than pixels (0), and treating a line count as a pixel count
 * makes every Firefox wheel tick a near-imperceptible zoom.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * 0.0015);
}
