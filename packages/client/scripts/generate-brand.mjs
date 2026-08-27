#!/usr/bin/env node
/**
 * Render every brand asset the PWA needs, from one vector definition.
 *
 * ── Why this is drawn and not resampled ─────────────────────────────────────
 * The mark is a signed-distance field, so each output is a TRUE render at its
 * own size: the antialiasing band stays ~1.5px whether the target is a 16px
 * favicon or a 2732px iPad splash. Downsampling one master PNG is what makes
 * small icons look mushy and large ones look soft, and it is exactly what this
 * avoids. Geometry is authored in a 64-unit box centred on the origin — the
 * same space as `public/favicon.svg`. Change one, change the other.
 *
 * ── Why there is no image library ───────────────────────────────────────────
 * PNG is deflate plus a CRC, and .ico is a directory of PNGs. Hand-rolling both
 * costs ~80 lines and buys total independence from native toolchains. The
 * alternative — sharp, or a headless-Chromium generator — drags in prebuilt
 * binaries, platform-specific build scripts, and the pnpm build-approval dance
 * that has broken this install before.
 *
 * Outputs (all under public/icons/, all gitignored — they are derived):
 *   favicon.ico                  browser tab + the Windows shortcut's icon
 *   icon-{192,512}.png           manifest `purpose: any` — rounded, transparent corners
 *   icon-{192,512}-maskable.png  manifest `purpose: maskable` — full bleed, mark in the safe zone
 *   apple-touch-icon.png         iOS home screen: 180px, opaque, NOT pre-rounded
 *   splash-*.png                 iOS `apple-touch-startup-image`, portrait + landscape
 *
 * It also rewrites the generated block in `index.html` between the
 * `brand:generated` markers, so the splash <link> matrix can never drift from
 * the files on disk.
 *
 * Idempotent: a stamp of this file and the shared mark geometry short-circuits
 * the whole run, so it sits in front of `vite` in both `dev` and `build` for
 * ~1ms when nothing changed. Force with `--force`.
 */
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_MARK_BRANCHES,
  DISPATCH_MARK_NODES,
  DISPATCH_MARK_STROKE_WIDTH,
} from "../src/brand/dispatchMark.ts";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const outDir = join(clientRoot, "public", "icons");
const indexHtml = join(clientRoot, "index.html");
const markGeometryFile = join(clientRoot, "src", "brand", "dispatchMark.ts");

const BG = [20, 23, 27]; // #14171B — the app's dark shell
const FG = [229, 163, 60]; // #E5A33C — signal amber
/**
 * The window frame's color, which is NOT the icon plate's.
 *
 * Chromium paints an installed window's title bar — and, with the window controls
 * overlay, the slab behind the minimise/maximise/close buttons — with this. So it
 * has to be the color of the thing those buttons sit IN, which is the top bar:
 * `--p-surface` from `src/theme/dark.css`. It was `BG` (the icon plate), and at
 * the top-right corner of the header that read as a seam.
 *
 * Only the DARK value can go here, because a static meta tag cannot know the
 * theme. `syncThemeColor` in `src/stores/theme.ts` overwrites it from the live
 * palette as soon as the bundle runs; this is the value the frame has for the few
 * ms before that, and dark is the default theme.
 */
export const THEME_COLOR = "#0e1114";

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

/** Encode raw RGBA (`w*h*4`) as a PNG buffer. */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  // Each scanline is prefixed with its filter byte (0 = None).
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const at = y * (w * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------------- the mark
 * A FORK: one trunk arriving from the left and splitting at a switch point into
 * two roads — one repo forking into parallel worktrees.
 */
const UNITS = 64;
/**
 * Half the stroke weight, in units. Deliberately hairline: what kills a 16px
 * icon is not detail, it is INK. A heavy stroke leaves too little dark between
 * the roads and the whole plate flares into one amber smudge.
 */
const HALF_W = DISPATCH_MARK_STROKE_WIDTH / 2;

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
 * The trunk, then one road curving off each way. Each road leaves the joint on
 * the trunk's own tangent so the split reads as a switch rather than a corner.
 */
const centered = ([x, y]) => [x - UNITS / 2, y - UNITS / 2];
const STROKES = DISPATCH_MARK_BRANCHES.map((branch) => {
  const points = branch.points.map(centered);
  return branch.kind === "line" ? points : cubic(...points);
});
const NODES = DISPATCH_MARK_NODES.map((node) => ({
  x: node.cx - UNITS / 2,
  y: node.cy - UNITS / 2,
  radius: node.radius,
}));

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
  for (const node of NODES) {
    d = Math.min(d, Math.hypot(u - node.x, v - node.y) - node.radius);
  }
  return d;
}

/** Signed distance to a rounded rect, used to antialias the plate's edges. */
function roundedRect(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Coverage of a shape whose signed distance is `d`, antialiased over ~1.5px. */
const coverage = (d) => Math.min(Math.max(0.5 - d / 1.5, 0), 1);

function blend(out, at, [r, g, b], alpha) {
  out[at] = Math.round(out[at] * (1 - alpha) + r * alpha);
  out[at + 1] = Math.round(out[at + 1] * (1 - alpha) + g * alpha);
  out[at + 2] = Math.round(out[at + 2] * (1 - alpha) + b * alpha);
  out[at + 3] = Math.max(out[at + 3], Math.round(255 * alpha));
}

/* ------------------------------------------------------------------ canvases */

/** Fill the whole buffer with an opaque colour. */
function fill(px, w, h, [r, g, b]) {
  for (let i = 0; i < w * h; i++) {
    const at = i * 4;
    px[at] = r;
    px[at + 1] = g;
    px[at + 2] = b;
    px[at + 3] = 255;
  }
}

/**
 * Draw the mark centred at (cx,cy), with the 64-unit box spanning `boxPx`
 * pixels, clipped by `clip(x,y) -> 0..1`.
 *
 * Only the mark's own bounding box is walked, not the canvas. On a 2048×2732
 * splash that is the difference between 5.6M distance evaluations and ~150k —
 * the reason a full iOS splash matrix renders in well under a second.
 */
function drawMark(px, w, h, cx, cy, boxPx, clip) {
  const pixelsPerUnit = boxPx / UNITS;
  const unitsPerPixel = UNITS / boxPx;
  // Shared geometry fits inside 25 units from center; pad past the AA band.
  const reach = (25 + HALF_W + 2) * pixelsPerUnit;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(w - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(h - 1, Math.ceil(cy + reach));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const fx = x - cx + 0.5;
      const fy = y - cy + 0.5;
      // Distances are computed in units and converted back to pixels so the
      // antialiasing band stays ~1.5px at EVERY size.
      const a = coverage(markDistance(fx * unitsPerPixel, fy * unitsPerPixel) * pixelsPerUnit);
      if (a <= 0) continue;
      const c = clip ? clip(fx, fy) : 1;
      if (c > 0) blend(px, (y * w + x) * 4, FG, a * c);
    }
  }
}

/**
 * A square icon on the rounded dark plate, transparent outside it. This is the
 * `purpose: any` shape — the corners have to be transparent so the icon reads
 * as an icon on a light desktop, not as a dark tile.
 */
function renderPlateIcon(size) {
  const px = Buffer.alloc(size * size * 4); // starts fully transparent
  const c = size / 2;
  const plateAt = (fx, fy) => coverage(roundedRect(fx, fy, size * 0.47, size * 0.22));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = plateAt(x - c + 0.5, y - c + 0.5);
      if (a > 0) blend(px, (y * size + x) * 4, BG, a);
    }
  }
  drawMark(px, size, size, c, c, size, plateAt);
  return px;
}

/**
 * Full-bleed opaque square. Used for BOTH `purpose: maskable` and the iOS
 * touch icon, because each platform applies its own mask and a shape we
 * pre-round would be rounded twice — the classic "icon with dark corners
 * inside a squircle" artefact.
 *
 * `markFraction` is what keeps the mark inside the mask's safe zone: the
 * maskable spec can crop to a circle of 80% diameter, so the mark gets 60%.
 * iOS crops far less, so its icon can breathe wider.
 */
function renderFullBleed(size, markFraction) {
  const px = Buffer.alloc(size * size * 4);
  fill(px, size, size, BG);
  drawMark(px, size, size, size / 2, size / 2, size * markFraction, null);
  return px;
}

/** An iOS launch image: the plate colour, with the mark centred and modest. */
function renderSplash(w, h) {
  const px = Buffer.alloc(w * h * 4);
  fill(px, w, h, BG);
  drawMark(px, w, h, w / 2, h / 2, Math.min(w, h) * 0.28, null);
  return px;
}

/* --------------------------------------------------------------- ico encode */

/**
 * Pack PNG-encoded images into an .ico. Vista and later accept PNG payloads
 * directly, which avoids the legacy BMP+AND-mask format (whose bottom-up rows
 * and padded 1-bit mask are the classic source of upside-down or black-boxed
 * icons).
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

/* ------------------------------------------------------------- iOS splashes
 * iOS picks a launch image by matching device-width/height and DPR EXACTLY, so
 * this is a lookup table, not a range: a device with no matching entry gets a
 * blank white flash instead. Sizes are CSS px (the logical viewport); the file
 * is that multiplied by the DPR, with width and height swapped for landscape.
 */
const IOS_DEVICES = [
  { w: 320, h: 568, dpr: 2, name: "iPhone SE (1st gen)" },
  { w: 375, h: 667, dpr: 2, name: "iPhone SE / 8" },
  { w: 414, h: 736, dpr: 3, name: "iPhone 8 Plus" },
  { w: 375, h: 812, dpr: 3, name: "iPhone X / XS / 11 Pro" },
  { w: 414, h: 896, dpr: 2, name: "iPhone XR / 11" },
  { w: 414, h: 896, dpr: 3, name: "iPhone XS Max / 11 Pro Max" },
  { w: 390, h: 844, dpr: 3, name: "iPhone 12 / 13 / 14" },
  { w: 428, h: 926, dpr: 3, name: "iPhone 12/13 Pro Max / 14 Plus" },
  { w: 393, h: 852, dpr: 3, name: "iPhone 14 Pro / 15 / 16" },
  { w: 430, h: 932, dpr: 3, name: "iPhone 14 Pro Max / 15 Pro Max" },
  { w: 402, h: 874, dpr: 3, name: "iPhone 16 Pro" },
  { w: 440, h: 956, dpr: 3, name: "iPhone 16 Pro Max" },
  { w: 768, h: 1024, dpr: 2, name: 'iPad mini / 9.7"' },
  { w: 810, h: 1080, dpr: 2, name: "iPad 10.2" },
  { w: 820, h: 1180, dpr: 2, name: "iPad Air 10.9" },
  { w: 834, h: 1112, dpr: 2, name: 'iPad Pro 10.5"' },
  { w: 834, h: 1194, dpr: 2, name: 'iPad Pro 11"' },
  { w: 1024, h: 1366, dpr: 2, name: 'iPad Pro 12.9"' },
];

/** Every splash file + the media query iOS matches it against. */
function splashTargets() {
  const out = [];
  for (const d of IOS_DEVICES) {
    for (const orientation of ["portrait", "landscape"]) {
      const portrait = orientation === "portrait";
      out.push({
        file: `splash-${d.w}x${d.h}@${d.dpr}x-${orientation}.png`,
        px: portrait ? d.w * d.dpr : d.h * d.dpr,
        py: portrait ? d.h * d.dpr : d.w * d.dpr,
        media:
          `(device-width: ${d.w}px) and (device-height: ${d.h}px) ` +
          `and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: ${orientation})`,
        name: d.name,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ index.html */

const START = "<!-- brand:generated:start -->";
const END = "<!-- brand:generated:end -->";

/**
 * Rewrite the generated <link> block in index.html.
 *
 * The splash matrix is ~36 tags that must match the files on disk exactly, so
 * hand-maintaining it guarantees drift. Generating it into the committed HTML
 * keeps the source readable and costs nothing at runtime.
 */
function writeIndexHtml(splashes) {
  const html = readFileSync(indexHtml, "utf8");
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from === -1 || to === -1) {
    throw new Error(`index.html is missing the ${START} / ${END} markers`);
  }

  const lines = [
    `    <!-- Generated by scripts/generate-brand.mjs — do not edit by hand. -->`,
    `    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
    `    <link rel="icon" type="image/x-icon" href="/icons/favicon.ico" />`,
    `    <link rel="manifest" href="/manifest.webmanifest" />`,
    `    <meta name="theme-color" content="${THEME_COLOR}" />`,
    ``,
    `    <!-- iOS has no manifest support worth relying on: the home-screen icon,`,
    `         the standalone flag and the status-bar style all come from these. -->`,
    `    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />`,
    `    <meta name="apple-mobile-web-app-capable" content="yes" />`,
    `    <meta name="mobile-web-app-capable" content="yes" />`,
    `    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
    `    <meta name="apple-mobile-web-app-title" content="Dispatch" />`,
    ``,
    ...splashes.map(
      (s) =>
        `    <link rel="apple-touch-startup-image" media="${s.media}" href="/icons/${s.file}" />`,
    ),
  ];

  const next = html.slice(0, from + START.length) + "\n" + lines.join("\n") + "\n" + html.slice(to);
  if (next !== html) writeFileSync(indexHtml, next);
  return next !== html;
}

/* ------------------------------------------------------------------- driver */

const force = process.argv.includes("--force");
const stampFile = join(outDir, ".stamp");
// The SVG component and generated install assets share dispatchMark.ts. Hashing
// both inputs prevents a geometry-only edit from leaving cached raster icons stale.
const stamp = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update("\0")
  .update(readFileSync(markGeometryFile))
  .digest("hex");

const splashes = splashTargets();
const expected = [
  "favicon.ico",
  "icon-192.png",
  "icon-512.png",
  "icon-192-maskable.png",
  "icon-512-maskable.png",
  "apple-touch-icon.png",
  ...splashes.map((s) => s.file),
];

const upToDate =
  !force &&
  existsSync(stampFile) &&
  readFileSync(stampFile, "utf8") === stamp &&
  expected.every((f) => existsSync(join(outDir, f)));

if (upToDate) {
  console.log(`brand: up to date (${expected.length} assets)`);
  process.exit(0);
}

// A stale stamp means the design moved; clear the directory so a renamed or
// dropped asset can't linger and get shipped.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(
  join(outDir, "favicon.ico"),
  encodeIco(
    ICO_SIZES.map((size) => ({ size, data: encodePng(renderPlateIcon(size), size, size) })),
  ),
);
console.log(`brand: favicon.ico (${ICO_SIZES.join(", ")})`);

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), encodePng(renderPlateIcon(size), size, size));
  writeFileSync(
    join(outDir, `icon-${size}-maskable.png`),
    encodePng(renderFullBleed(size, 0.6), size, size),
  );
}
console.log("brand: icon-{192,512}.png + maskable");

// 180 is the size iOS actually asks for; anything else is rescaled by the OS.
writeFileSync(
  join(outDir, "apple-touch-icon.png"),
  encodePng(renderFullBleed(180, 0.76), 180, 180),
);
console.log("brand: apple-touch-icon.png (180)");

for (const s of splashes) {
  writeFileSync(join(outDir, s.file), encodePng(renderSplash(s.px, s.py), s.px, s.py));
}
console.log(`brand: ${splashes.length} iOS splash screens (${IOS_DEVICES.length} devices × 2)`);

const changed = writeIndexHtml(splashes);
console.log(`brand: index.html ${changed ? "updated" : "already current"}`);

writeFileSync(stampFile, stamp);
