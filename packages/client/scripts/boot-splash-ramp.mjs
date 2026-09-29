/**
 * Regenerates the boot splash's exchange keyframes, in every place they live.
 *
 * WHY THIS EXISTS RATHER THAN NUMBERS TYPED BY HAND. The exchange ramps up and
 * snaps, and that shape cannot be a timing function on the keyframes: the two
 * live fronts have to advance in x together or the mark's width breathes, and
 * they are on opposite parts of their segments — one losing its trunk over the
 * first 60% of the exchange while the other grows its branches over the first
 * 40%. A per-interval ease restarts at each of those boundaries, which are in
 * different places, so the fronts come apart by about three units either side of
 * the crossover.
 *
 * So the curve is applied to the exchange AS A WHOLE and sampled, and every road
 * and the pan share the sampled stops. The draw gets 20 of them, about 25ms
 * apart; the recoil gets a step of its own, about 36ms, because it is faster
 * than the draw it follows.
 *
 * It writes the CSS `@keyframes` AND the worker's `ROADS`/`PAN`/`DOTS` tables,
 * so the two cannot differ by a transcription; bootMarkSchedule.test.ts then
 * checks they still agree. Run it from packages/client after changing anything
 * below:
 *
 *     node scripts/boot-splash-ramp.mjs           # patch index.html
 *     node scripts/boot-splash-ramp.mjs --print   # just show what it would write
 *
 * The hold and the trunk/branch split are duplicated here from index.html on
 * purpose: this is a tool that rewrites that file, not something it imports at
 * runtime. If they disagree the tests catch it, because the windows they imply
 * stop matching.
 */
import { readFileSync, writeFileSync } from "node:fs";

/* ── THE SHAPE OF ONE EXCHANGE ────────────────────────────────────────────────
 *
 * Not a bezier. A bezier that arrives fast cannot also leave slowly, and a
 * bezier can only overshoot ONCE — so the whole thing is written as a velocity
 * profile with a spring hung off the end of it, which says what is wanted
 * directly: wind up, run flat out, stop hard, shudder.
 *
 *   ACCEL   the share of the draw spent winding up, on a smoothstep. Two thirds,
 *           so the acceleration is the thing you notice rather than a nicety at
 *           the edges — this is what "more dramatic" cashes out as.
 *   DECEL   the share spent easing off, and it is SHORT. The draw does not glide
 *           to a halt; it is still doing 60% of its top speed (END_V) when it
 *           runs out of road, and the recoil is what absorbs the rest.
 *   DRAW_END  where in the window the ink is finished. The remaining quarter is
 *           the recoil, which needs somewhere to happen.
 */
const ACCEL = 0.66, DECEL = 0.1, END_V = 0.6;
const DRAW_END = 0.76;

/* ── THE RECOIL ──────────────────────────────────────────────────────────────
 *
 * The CAMERA only. The roads are done and hold; the frame carries the momentum
 * the stop threw away and rings it out, so the mark lurches past centre and
 * settles. That is the shake, and it is free of the constant-width invariant
 * because a pan is a rigid transform — it moves both fronts together or not at
 * all.
 *
 * It is a real damped oscillator seeded with the draw's own terminal velocity,
 * not a wobble bolted on: continuous in both position AND speed at the handoff,
 * which is the difference between a recoil and a glitch. Its amplitude is
 * therefore NOT a free parameter — it is v0/ωd, so a faster ring is a smaller
 * one. RING_PERIOD 0.34 of the window is about 220ms, which lands the first
 * lurch a unit and a half past centre and puts a 10% counter-swing behind it.
 * Slower reads as a sway; much faster is invisible.
 */
const ZETA = 0.34, RING_PERIOD = 0.34;
/** Below this many view-box units the recoil is subpixel and gets truncated. */
const RING_FLOOR = 0.02;

const HOLD = 23, EXCH = 27;
/** How far the frame travels in one exchange, in view-box units. */
const STRIDE = 40;
const N_DRAW = 20;
/** Recoil sample step, in units of g — ~36ms, two frames. */
const RING_STEP = 0.055;
/** Arrivals fade over this much of the cycle, departures over 5%. */
const FADE_IN = 8, FADE_OUT = 5;

const clamp = (v) => Math.max(0, Math.min(1, v));
const r2 = (v) => +v.toFixed(2);
const r3 = (v) => +v.toFixed(3);

/** The integral of smoothstep — the distance a wind-up of that shape covers. */
const iss = (x) => x ** 3 - x ** 4 / 2;

/** Peak speed, chosen so the profile covers exactly one stride. */
const V = 1 / (ACCEL / 2 + (1 - ACCEL - DECEL) + (DECEL * (1 + END_V)) / 2);

/** Distance drawn, as a fraction of the stride, at t through the draw. */
function drawn(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < ACCEL) return V * ACCEL * iss(t / ACCEL);
  if (t < 1 - DECEL) return V * (ACCEL / 2 + (t - ACCEL));
  const y = (t - (1 - DECEL)) / DECEL;
  return V * (ACCEL / 2 + (1 - DECEL - ACCEL) + DECEL * (y - (1 - END_V) * iss(y)));
}

const WD = (2 * Math.PI) / RING_PERIOD;
const WN = WD / Math.sqrt(1 - ZETA * ZETA);
/** Speed at the moment the ink stops, per unit g. */
const V0 = (V * END_V) / DRAW_END;
const ring = (u) => (V0 / WD) * Math.exp(-ZETA * WN * u) * Math.sin(WD * u);
/** Truncated where the envelope drops under a subpixel. */
const RING_LEN =
  Math.ceil(Math.log(((V0 / WD) * STRIDE) / RING_FLOOR) / (ZETA * WN) / RING_STEP) * RING_STEP;

/** The frame's progress, draw then recoil, as a fraction of the stride. */
const phi = (g) => (g < DRAW_END ? drawn(g / DRAW_END) : 1 + ring(g - DRAW_END));
/** The ink's progress. Monotone, and done at DRAW_END. */
const drive = (g) => drawn(clamp(g / DRAW_END));

/** Where in the cycle each exchange's ink finishes. */
const E1_DONE = r2(HOLD + DRAW_END * EXCH);
const E2_DONE = r2(HOLD + 50 + DRAW_END * EXCH);

/** A part's progress from the exchange's, given where it sits in the x-span. */
const part = (G, from, to) => clamp((G - from) / (to - from));

// Each road, as: which exchange it moves in, and its offset for a given G.
// `from`/`to` are the road's share of the 40 units of x the front travels.
const ROADS = {
  "s1-trunk": { at: HOLD, f: (G) => -1.06 * part(G, 0, 0.6) },
  "s1-branch": { at: HOLD, f: (G) => -1.06 * part(G, 0.6, 1) },
  "s2-branch": {
    at: HOLD, f: (G) => 1.06 * (1 - part(G, 0, 0.4)),
    at2: HOLD + 50, f2: (G) => -1.06 * part(G, 0, 0.4),
  },
  "s2-trunk": {
    at: HOLD, f: (G) => 1.06 * (1 - part(G, 0.4, 1)),
    at2: HOLD + 50, f2: (G) => -1.06 * part(G, 0.4, 1),
  },
  "s3-trunk": { at: HOLD + 50, f: (G) => 1.06 * (1 - part(G, 0, 0.6)) },
  "s3-branch": { at: HOLD + 50, f: (G) => 1.06 * (1 - part(G, 0.6, 1)) },
};

/** Drop stops inside a run of one unchanged value; their neighbours carry it. */
function thin(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[i - 1], next = raw[i + 1];
    if (prev && next && prev[1] === raw[i][1] && next[1] === raw[i][1]) continue;
    out.push(raw[i]);
  }
  return out;
}

/** Stops for one road's moving stretch. Only the draw moves ink. */
function stretch(startPct, f) {
  const raw = [];
  for (let i = 0; i <= N_DRAW; i++) {
    const g = (i / N_DRAW) * DRAW_END;
    raw.push([r2(startPct + g * EXCH), r3(f(drive(g)))]);
  }
  return thin(raw);
}

function stopsFor(name) {
  const spec = ROADS[name];
  const out = [];
  // Before the first stretch, the road holds whatever it starts the cycle at.
  const first = stretch(spec.at, spec.f);
  if (spec.at > 0) out.push([0, first[0][1]]);
  out.push(...first);
  if (spec.f2) {
    const second = stretch(spec.at2, spec.f2);
    out.push([spec.at2 - 0.001 > second[0][0] ? spec.at2 : second[0][0], second[0][1]]);
    out.push(...second.slice(1));
  }
  if (out[out.length - 1][0] < 100) out.push([100, out[out.length - 1][1]]);
  const seen = new Map();
  for (const [p, v] of out) seen.set(p, v);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}

/* ── THE PAN ────────────────────────────────────────────────────────────────
 *
 * Still `32 − midpoint(live span)` while ink is moving — a span of constant
 * width whose ends advance together has a midpoint that advances at the same
 * rate — and then it keeps going, which is the whole point of the recoil.
 *
 * The second exchange's recoil runs PAST 100% and lands in the next cycle, so
 * the stops at the top of the loop are its tail. That is exactly right: the seam
 * maps C→A and D→B with an 80-unit reset, so `phi` at the same g on either side
 * of it describes the same picture, and the pan is continuous through it by 80.
 */
function panStops() {
  const gs = [];
  for (let i = 1; i <= N_DRAW; i++) gs.push((i / N_DRAW) * DRAW_END);
  for (let u = RING_STEP; u <= RING_LEN + 1e-9; u += RING_STEP) gs.push(DRAW_END + u);

  const raw = [];
  // The tail of the PREVIOUS cycle's second recoil, wrapped to the top. Its
  // base has been reset by the seam, so all that is left of it is the ring.
  const wrapped = gs.filter((g) => HOLD + 50 - 100 + g * EXCH > 0);
  raw.push([0, r2(-STRIDE * (phi((100 - HOLD - 50) / EXCH) - 1))]);
  for (const g of wrapped) raw.push([r2(HOLD + 50 - 100 + g * EXCH), r2(-STRIDE * (phi(g) - 1))]);
  raw.push([HOLD, 0]);

  for (const [start, base] of [[HOLD, 0], [HOLD + 50, -STRIDE]]) {
    for (const g of gs) raw.push([r2(start + g * EXCH), r2(base - STRIDE * phi(g))]);
    // Then held, until the next exchange begins. The second one is never held:
    // it is still ringing when the cycle ends.
    if (start === HOLD) raw.push([HOLD + 50, r2(base - STRIDE)]);
  }

  // The cycle has to CLOSE, and it closes one whole reset below where it opened
  // — the second recoil is still ringing at 100%, so this is not -80. Omit it
  // and CSS falls back to the element's own transform at the top of the loop,
  // which is none: a jump of forty units, once a cycle.
  raw.push([100, r2(raw[0][1] - 2 * STRIDE)]);

  const seen = new Map();
  for (const [p, v] of raw) if (p <= 100) seen.set(p, v);
  return thin([...seen.entries()].sort((a, b) => a[0] - b[0]));
}

/* ── THE DOTS ───────────────────────────────────────────────────────────────
 *
 * A dot is an end of a stroke, so it belongs to a moment the PEN defines. Two of
 * those moments are exchange STARTS, which are fixed; the other two are where
 * the ink FINISHES, which moves with DRAW_END — so they are generated here
 * rather than typed next to the roads and left behind when the shape changes.
 */
const DOTS = {
  a: [[0, 1], [HOLD, 1], [HOLD + FADE_OUT, 0], [100, 0]],
  b: [[0, 1], [HOLD + 50, 1], [HOLD + 50 + FADE_OUT, 0], [100, 0]],
  c: [[0, 0], [r2(E1_DONE - FADE_IN), 0], [E1_DONE, 1], [100, 1]],
  d: [[0, 0], [r2(E2_DONE - FADE_IN), 0], [E2_DONE, 1], [100, 1]],
};
/** The interval LEAVING each dot's second stop is its fade, and only that one. */
const FADING = 1;

const PAN = panStops();

const cssRoad = (name) =>
  `      @keyframes boot-splash-road-${name} {\n` +
  stopsFor(name).map(([p, v]) => `        ${p}% { stroke-dashoffset: ${v}; }`).join("\n") +
  `\n      }`;

const cssPan =
  `      @keyframes boot-splash-pan {\n` +
  PAN.map(([p, v]) => `        ${p}% { transform: translateX(${v}px); }`).join("\n") +
  `\n      }`;

const cssDot = (id) =>
  `      @keyframes boot-splash-dot-${id} {\n` +
  DOTS[id]
    .map(([p, v], i) =>
      i === FADING
        ? `        ${p}% { opacity: ${v}; animation-timing-function: cubic-bezier(0.42, 0, 0.58, 1); }`
        : `        ${p}% { opacity: ${v}; }`,
    )
    .join("\n") +
  `\n      }`;

const workerRoads =
  `          var ROADS = {\n` +
  Object.keys(ROADS)
    .map((n) => `            "${n}": [${stopsFor(n).map(([p, v]) => `[${p}, [${v}]]`).join(", ")}],`)
    .join("\n") +
  `\n          };`;

const workerPan = `          var PAN = [${PAN.map(([p, v]) => `[${p}, [${v}]]`).join(", ")}];`;

const workerDots =
  `          var DOTS = {\n` +
  Object.keys(DOTS)
    .map(
      (id) =>
        `            ${id}: [${DOTS[id]
          .map(([p, v], i) => `[${p}, [${v}]${i === FADING ? ", EASE" : ""}]`)
          .join(", ")}],`,
    )
    .join("\n") +
  `\n          };`;

if (process.argv.includes("--print")) {
  console.log(cssPan + "\n");
  for (const n of Object.keys(ROADS)) console.log(cssRoad(n));
  for (const id of Object.keys(DOTS)) console.log(cssDot(id));
  console.log("\n" + workerPan + "\n" + workerRoads + "\n" + workerDots);
  let lurch = 0;
  for (let u = 0; u < RING_LEN; u += 0.001) lurch = Math.max(lurch, ring(u) * STRIDE);
  console.error(
    `\npeak speed ${r2((V * STRIDE) / ((DRAW_END * EXCH * 24) / 1000))}u/s · ` +
      `ink done at ${E1_DONE}% / ${E2_DONE}% · ` +
      `recoil ${r2(RING_LEN * EXCH)}% of the cycle, ` +
      `first lurch ${r2(lurch)} units past centre · ${PAN.length} pan stops`,
  );
  process.exit(0);
}

const TARGET = new URL("../index.html", import.meta.url);
let html = readFileSync(TARGET, "utf8");
function swap(startMarker, endMarker, next) {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error("no " + startMarker.slice(0, 50));
  const j = html.indexOf(endMarker, i);
  if (j < 0) throw new Error("no end for " + startMarker.slice(0, 50));
  html = html.slice(0, i) + next + html.slice(j + endMarker.length);
}
swap("      @keyframes boot-splash-pan {", "\n      }", cssPan);
for (const n of Object.keys(ROADS)) {
  swap(`      @keyframes boot-splash-road-${n} {`, "\n      }", cssRoad(n));
}
for (const id of Object.keys(DOTS)) {
  swap(`      @keyframes boot-splash-dot-${id} {`, "\n      }", cssDot(id));
}
swap("          var PAN = [", "];", workerPan);
swap("          var ROADS = {", "\n          };", workerRoads);
swap("          var DOTS = {", "\n          };", workerDots);
writeFileSync(TARGET, html);
console.log("boot-splash ramp: patched index.html");
