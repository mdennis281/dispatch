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
 * what is ultimately a few hundred bytes of flat colour. Re-run with
 * `pnpm --filter @dispatch/desktop icon` after changing the design below.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
/** Sizes packed into the .ico. Windows picks whichever fits the context. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [20, 23, 27]; // the app's dark shell
const FG = [229, 163, 60]; // signal amber

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

/* ----------------------------------------------------------------- the mark
 * A railway TURNOUT: one trunk arriving from the left and splitting at a switch
 * point — the product's own shape, one repo forking into parallel worktrees.
 *
 * Geometry is authored in a 64-unit box centred on the origin (the same space as
 * the SVG the client's favicon uses, minus 32 on each axis) and scaled to
 * whatever `size` is being rendered, so every size is a true render rather than
 * a resampled bitmap. Curves become short polylines once, up front; the
 * per-pixel job is then just "distance to the nearest segment".
 */
const UNITS = 64;
/** Half the stroke weight, in units. */
const HALF_W = 3;
/**
 * A turnout has ONE trunk and ONE diverging road — that is what the switch does.
 * Earlier drafts fanned into three: at 256px it was handsome, at 16px the tips
 * fused into a blob and the silhouette read as an asterisk. Two roads survive the
 * taskbar, and they still say the only thing that matters — work leaves the trunk
 * and runs somewhere else in parallel.
 *
 * Everything is shifted down by OFFSET so the asymmetric form sits optically
 * centred on the plate rather than hanging from the top.
 */
const OFFSET = 7.5;
/** The switch point, where the trunk splits. */
const JOINT = [-11, OFFSET];
const JOINT_R = 4;
/** Where each road terminates; nodes here make them destinations, not an arrow. */
const TIPS = [
  [18, OFFSET],
  [18, -OFFSET],
];
const TIP_R = 4.2;

/** Sample a cubic Bézier into `steps` segments. */
function cubic(p0, p1, p2, p3, steps = 14) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const m = 1 - t;
    pts.push([
      m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
      m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/**
 * The trunk, the straight-through road, and the one diverging road.
 *
 * The diverging control points ease AWAY from the joint and stay open at the
 * tip — a curve landing on a horizontal tangent makes the end curl back and the
 * whole mark reads as a bracket instead of a fork.
 */
const STROKES = [
  [[-21, OFFSET], JOINT],
  [JOINT, TIPS[0]],
  cubic(JOINT, [-3, OFFSET], [4, -5], TIPS[1]),
];

/** Distance from (px,py) to the segment a→b. */
function segDist(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const len = bax * bax + bay * bay;
  const h = len === 0 ? 0 : Math.min(Math.max((pax * bax + pay * bay) / len, 0), 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Distance from (px,py) to a polyline. */
function polyDist(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

/** Signed distance to the whole mark, in units. */
function markDistance(u, v) {
  let d = Infinity;
  for (const poly of STROKES) d = Math.min(d, polyDist(u, v, poly));
  d -= HALF_W;
  d = Math.min(d, Math.hypot(u - JOINT[0], v - JOINT[1]) - JOINT_R);
  for (const [tx, ty] of TIPS) d = Math.min(d, Math.hypot(u - tx, v - ty) - TIP_R);
  return d;
}

/** Render the mark at `size`, resolution-independently (all metrics scale). */
function render(size) {
  const px = Buffer.alloc(size * size * 4); // starts fully transparent
  const c = size / 2;
  const toUnits = UNITS / size;
  const toPixels = size / UNITS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      const fx = x - c + 0.5;
      const fy = y - c + 0.5;

      // Rounded-square plate.
      const plate = coverage(roundedRect(fx, fy, size * 0.47, size * 0.22));
      if (plate > 0) blend(px, at, BG, plate);

      // The turnout, clipped to the plate. Distances are computed in units and
      // converted back to pixels so the antialiasing band stays ~1.5px at EVERY
      // size — the whole reason this is drawn rather than downsampled.
      const a = coverage(markDistance(fx * toUnits, fy * toUnits) * toPixels) * plate;
      if (a > 0) blend(px, at, FG, a);
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
