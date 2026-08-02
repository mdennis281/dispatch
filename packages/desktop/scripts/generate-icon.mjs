#!/usr/bin/env node
/**
 * Generate `assets/icon.png` (window + tray) and `assets/icon.ico` (Windows
 * shortcut + embedded exe icon).
 *
 * Both are needed and they are NOT interchangeable: a `.lnk`'s IconLocation and
 * an exe's embedded resource must be an `.ico`, while Electron's `nativeImage`
 * wants the PNG. The `.ico` packs several sizes because Windows picks per
 * context — 16px in the taskbar, 32px on the desktop, 256px in the jump list —
 * and a single upscaled bitmap looks visibly mushy at the small end.
 *
 * Hand-rolled encoders over `zlib` so the repo gains no image dependency for
 * what is ultimately a few hundred bytes of solid colour. Re-run with
 * `pnpm --filter @cm/desktop icon` after changing the design below.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
/** Sizes packed into the .ico. Windows picks whichever fits the context. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [24, 24, 27]; // zinc-900, matches the app's dark shell
const FG = [217, 119, 87]; // the Claude terracotta

/* --------------------------------------------------------------- png encode */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGBA (`SIZE*SIZE*4`) as a PNG buffer. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Each scanline is prefixed with its filter byte (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ design */

/** Signed distance to a rounded rect, used to antialias the edges. */
function roundedRect(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function blend(out, at, [r, g, b], alpha) {
  out[at] = Math.round(out[at] * (1 - alpha) + r * alpha);
  out[at + 1] = Math.round(out[at + 1] * (1 - alpha) + g * alpha);
  out[at + 2] = Math.round(out[at + 2] * (1 - alpha) + b * alpha);
  out[at + 3] = Math.max(out[at + 3], Math.round(255 * alpha));
}

/** Coverage of a shape whose signed distance is `d`, antialiased over ~1.5px. */
const coverage = (d) => Math.min(Math.max(0.5 - d / 1.5, 0), 1);

/** Render the mark at `size`, resolution-independently (all metrics scale). */
function render(size) {
  const px = Buffer.alloc(size * size * 4); // starts fully transparent
  const c = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      const fx = x - c + 0.5;
      const fy = y - c + 0.5;

      // Rounded-square plate.
      const plate = coverage(roundedRect(fx, fy, size * 0.47, size * 0.22));
      if (plate > 0) blend(px, at, BG, plate);

      // A ring with a gap on the right — a stylised "C" that still reads at 16px.
      const r = Math.hypot(fx, fy);
      const ring = Math.max(Math.abs(r - size * 0.26) - size * 0.062, 0);
      const angle = Math.atan2(fy, fx);
      const inGap = Math.abs(angle) < 0.55;
      if (!inGap) {
        const a = coverage(ring) * plate;
        if (a > 0) blend(px, at, FG, a);
      }
    }
  }
  return px;
}

/* --------------------------------------------------------------- ico encode */

/**
 * Pack PNG-encoded images into an .ico. Vista and later accept PNG payloads
 * directly, which avoids hand-rolling the legacy BMP+AND-mask format (whose
 * bottom-up rows and padded 1-bit mask are the classic source of upside-down or
 * black-boxed icons).
 */
function encodeIco(images) {
  const HEADER = 6;
  const ENTRY = 16;
  const dir = Buffer.alloc(HEADER + ENTRY * images.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const at = HEADER + i * ENTRY;
    // 256 is encoded as 0 — the field is a single byte.
    dir[at] = img.size >= 256 ? 0 : img.size;
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir[at + 2] = 0; // palette size (0 = truecolour)
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets");
mkdirSync(out, { recursive: true });

const png = join(out, "icon.png");
writeFileSync(png, encodePng(render(SIZE), SIZE));
console.log(`wrote ${png} (${SIZE}x${SIZE})`);

const ico = join(out, "icon.ico");
writeFileSync(
  ico,
  encodeIco(ICO_SIZES.map((size) => ({ size, data: encodePng(render(size), size) }))),
);
console.log(`wrote ${ico} (${ICO_SIZES.join(", ")})`);
