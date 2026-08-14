import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { QUIET_ZONE, qrLayout } from "./qrLayout.js";

const URI = "otpauth://totp/Dispatch:owner?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Dispatch";

/** Rasterize the layout the way the SVG paints it: white ground, dark modules. */
function raster(layout: ReturnType<typeof qrLayout>, scale: number) {
  const width = layout.size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < layout.dark.length; y++) {
    for (let x = 0; x < layout.dark[y]!.length; x++) {
      if (!layout.dark[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + QUIET_ZONE) * scale + dy) * width + (x + QUIET_ZONE) * scale + dx;
          pixels[px * 4] = 0; pixels[px * 4 + 1] = 0; pixels[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { pixels, width };
}

describe("TOTP setup QR", () => {
  it("scans back to the exact otpauth URI a phone would be handed", () => {
    const layout = qrLayout(URI);
    const { pixels, width } = raster(layout, 6);
    expect(jsQR(pixels, width, width)?.data).toBe(URI);
  });

  it("surrounds the code with the quiet zone scanners need", () => {
    const layout = qrLayout(URI);
    expect(layout.size).toBe(layout.dark.length + QUIET_ZONE * 2);
    // Every subpath sits inside the border, and there is exactly one per dark module.
    const modules = layout.dark.flat().filter(Boolean).length;
    expect(layout.path.match(/M/g)).toHaveLength(modules);
    for (const [, x, y] of layout.path.matchAll(/M(\d+) (\d+)/g)) {
      for (const coord of [Number(x), Number(y)]) {
        expect(coord).toBeGreaterThanOrEqual(QUIET_ZONE);
        expect(coord).toBeLessThan(layout.size - QUIET_ZONE);
      }
    }
  });
});
