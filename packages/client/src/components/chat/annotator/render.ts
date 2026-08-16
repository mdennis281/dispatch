/**
 * Pixel work: loading the base image, baking a crop into a new bitmap, and
 * exporting the finished markup.
 *
 * Export deliberately reuses the LIVE stage rather than re-drawing the shapes
 * into a second 2D context. A parallel renderer is a promise that two code paths
 * agree about every arrow head and dash pattern forever, and they never do — the
 * exported PNG drifts from what was on screen and nobody notices until it is in
 * someone's chat. Instead the stage is briefly reset to 1:1 at natural size,
 * read, and put back, all synchronously (see `exportStage`).
 */
import type Konva from "konva";
import { type BakeOp, bakedSize, rotatedBounds } from "./doc.js";

/** Anything we can hand to `drawImage`. */
export type Bitmap = HTMLImageElement | HTMLCanvasElement;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin asset endpoint today, but an un-tainted canvas is a hard
    // requirement for export, so ask explicitly rather than rely on that.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load image"));
    img.src = src;
  });
}

export function bitmapSize(b: Bitmap): { width: number; height: number } {
  return b instanceof HTMLCanvasElement
    ? { width: b.width, height: b.height }
    : { width: b.naturalWidth, height: b.naturalHeight };
}

/**
 * Produce a new base bitmap with `op` applied.
 *
 * The transform stack is written in the REVERSE of the order it applies to a
 * drawn point, so reading bottom-up gives `mapPoint`'s pipeline exactly: flip in
 * the source frame, rotate about the image centre, land in the rotated bounding
 * box, then shift by the crop origin. If these two ever drift apart, every
 * annotation slides off its target the first time someone crops.
 */
export function bakeImage(src: Bitmap, op: BakeOp): HTMLCanvasElement {
  const { width: srcW, height: srcH } = bitmapSize(src);
  const { width, height } = bakedSize(op);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const bounds = rotatedBounds(srcW, srcH, op.angle);
  ctx.translate(-op.crop.x, -op.crop.y);
  ctx.translate(bounds.w / 2, bounds.h / 2);
  ctx.rotate((op.angle * Math.PI) / 180);
  ctx.translate(-srcW / 2, -srcH / 2);
  if (op.flipH) {
    ctx.translate(srcW, 0);
    ctx.scale(-1, 1);
  }
  if (op.flipV) {
    ctx.translate(0, srcH);
    ctx.scale(1, -1);
  }
  ctx.drawImage(src, 0, 0);
  return canvas;
}

/**
 * Read the stage at natural size, whatever the user has it zoomed to.
 *
 * Every attribute is restored before returning, and `toDataURL` is synchronous,
 * so React never observes the stage in its temporarily-resized state and the
 * user never sees a flash. `listening(false)` keeps Konva from re-running hit
 * detection on the resize.
 */
export function exportStage(stage: Konva.Stage, width: number, height: number): string {
  const prev = {
    width: stage.width(),
    height: stage.height(),
    scale: stage.scale() ?? { x: 1, y: 1 },
    x: stage.x(),
    y: stage.y(),
  };
  stage.listening(false);
  try {
    stage.size({ width, height });
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    return stage.toDataURL({ mimeType: "image/png", pixelRatio: 1 });
  } finally {
    stage.size({ width: prev.width, height: prev.height });
    stage.scale(prev.scale);
    stage.position({ x: prev.x, y: prev.y });
    stage.listening(true);
    stage.batchDraw();
  }
}
