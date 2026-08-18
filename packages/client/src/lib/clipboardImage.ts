/**
 * Putting a picture on the system clipboard.
 *
 * Harder than it reads. `navigator.clipboard.write` accepts a very short list
 * of types, and in practice `image/png` is the only one every browser honours —
 * hand it a JPEG or a WebP and Chrome rejects the whole call with a
 * `NotAllowedError` that says nothing about type support. So anything that
 * isn't already PNG is decoded and re-encoded through a canvas first.
 *
 * SVG needs that round-trip too, and is the case most likely to fail: an `<img>`
 * holding an SVG has no intrinsic pixel size unless the file declared one, and
 * drawing a zero-sized image yields a blank canvas. The fallback below picks a
 * sane raster size rather than silently copying an empty rectangle.
 *
 * Safari adds one more constraint: the `ClipboardItem` must be constructed
 * SYNCHRONOUSLY inside the user-gesture task, or the write is rejected for
 * losing user activation. Passing the promise as the item value (rather than
 * awaiting it first) is what satisfies that, and is why the conversion is
 * threaded through as a `Promise<Blob>`.
 */

/** What a copy attempt did, so the caller can say so in the UI. */
export type CopyResult = "copied" | "unsupported" | "failed";

/** Longest edge for a rasterized SVG that declared no size of its own. */
const SVG_FALLBACK_SIZE = 1024;

/** Is the Async Clipboard API's image path available at all? */
export function canCopyImages(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

/**
 * Copy the image at `src` to the clipboard as PNG.
 *
 * `src` must be same-origin, a `blob:`, or a `data:` URL — every path in the
 * app resolves assets to an object URL before rendering, so it always is. A
 * cross-origin image would taint the canvas and `toBlob` would throw, which
 * lands as `"failed"` rather than as a silent empty copy.
 */
export async function copyImageToClipboard(src: string, mimeType?: string): Promise<CopyResult> {
  if (!canCopyImages()) return "unsupported";
  try {
    // Constructed with the PROMISE, not an awaited blob: Safari drops user
    // activation across an await, and rejects a write made after it.
    const item = new ClipboardItem({ "image/png": toPngBlob(src, mimeType) });
    await navigator.clipboard.write([item]);
    return "copied";
  } catch {
    // A rejected permission, a tainted canvas, or a browser that took the
    // ClipboardItem and refused the write. Nothing actionable to distinguish.
    return "failed";
  }
}

/** Decode `src` and re-encode it as PNG. */
async function toPngBlob(src: string, mimeType?: string): Promise<Blob> {
  // Already PNG and reachable as bytes: skip the decode entirely. Re-encoding
  // is lossless here but not free — a 4000px screenshot costs a full raster.
  if (mimeType === "image/png") {
    const response = await fetch(src);
    if (response.ok) {
      const blob = await response.blob();
      if (blob.type === "image/png") return blob;
    }
  }

  const img = await decode(src);
  // `naturalWidth` is 0 for an SVG with no intrinsic size. Rasterize it at a
  // fixed size instead of drawing nothing.
  const width = img.naturalWidth || SVG_FALLBACK_SIZE;
  const height = img.naturalHeight || SVG_FALLBACK_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, width, height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
      "image/png",
    );
  });
}

/** An `<img>` that has finished loading `src`, or a rejection. */
function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Harmless for same-origin/blob/data, and the difference between a usable
    // canvas and a tainted one if an asset ever is served cross-origin.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}
