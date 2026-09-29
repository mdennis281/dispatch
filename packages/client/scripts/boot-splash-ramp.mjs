/**
 * Regenerates the boot splash's exchange keyframes, in both places they live.
 *
 * WHY THIS EXISTS RATHER THAN NUMBERS TYPED BY HAND. The exchange ramps up and
 * down, and that ease cannot be a timing function on the keyframes: the two live
 * fronts have to advance in x together or the mark's width breathes, and they
 * are on opposite parts of their segments — one losing its trunk over the first
 * 60% of the exchange while the other grows its branches over the first 40%. A
 * per-interval ease restarts at each of those boundaries, which are in different
 * places, so the fronts come apart by about three units either side of the
 * crossover.
 *
 * So the ease is applied to the exchange AS A WHOLE and sampled, and every road
 * and the pan share the sampled curve. Sixteen steps, which puts each velocity
 * level at about 40ms — under three frames, so the staircase does not read. At
 * eight it did.
 *
 * It writes the CSS `@keyframes` AND the worker's `ROADS`/`PAN` tables, so the
 * two cannot differ by a transcription; bootMarkSchedule.test.ts then checks
 * they still agree. Run it from packages/client after changing the ease, the
 * hold, or the trunk/branch split:
 *
 *     node scripts/boot-splash-ramp.mjs           # patch index.html
 *     node scripts/boot-splash-ramp.mjs --print   # just show what it would write
 *
 * The hold and the split are duplicated here from index.html on purpose: this is
 * a tool that rewrites that file, not something it imports at runtime. If they
 * disagree the tests catch it, because the windows they imply stop matching.
 */
import { readFileSync, writeFileSync } from "node:fs";

// A gentle symmetric S. The exchange is 648ms for 40 units, so a stronger curve
// would put the midpoint faster than the old draw ever was.
const [X1, Y1, X2, Y2] = [0.42, 0, 0.58, 1];
const ease = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = 1, u = t, x;
  for (let i = 0; i < 40; i++) {
    u = (lo + hi) / 2;
    x = 3 * (1 - u) ** 2 * u * X1 + 3 * (1 - u) * u * u * X2 + u ** 3;
    if (x < t) lo = u; else hi = u;
  }
  return 3 * (1 - u) ** 2 * u * Y1 + 3 * (1 - u) * u * u * Y2 + u ** 3;
};

const HOLD = 23, EXCH = 27, N = 16;
const clamp = (v) => Math.max(0, Math.min(1, v));
const r2 = (v) => +v.toFixed(2);
const r3 = (v) => +v.toFixed(3);

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

/** Stops for one moving stretch, with runs of an unchanged value collapsed. */
function stretch(startPct, f) {
  const raw = [];
  for (let i = 0; i <= N; i++) {
    const g = i / N;
    raw.push([r2(startPct + g * EXCH), r3(f(ease(g)))]);
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[i - 1], next = raw[i + 1];
    // Drop a stop only when it sits inside a flat run; its neighbours carry it.
    if (prev && next && prev[1] === raw[i][1] && next[1] === raw[i][1]) continue;
    out.push(raw[i]);
  }
  return out;
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
  // Collapse duplicate percents produced by the joins.
  const seen = new Map();
  for (const [p, v] of out) seen.set(p, v);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}

const panStops = [
  [0, 0], [HOLD, 0],
  ...Array.from({ length: N }, (_, i) => {
    const g = (i + 1) / N;
    return [r2(HOLD + g * EXCH), r2(-40 * ease(g))];
  }),
  [HOLD + 50, -40],
  ...Array.from({ length: N }, (_, i) => {
    const g = (i + 1) / N;
    return [r2(HOLD + 50 + g * EXCH), r2(-40 - 40 * ease(g))];
  }),
];

const cssRoad = (name) =>
  `      @keyframes boot-splash-road-${name} {\n` +
  stopsFor(name).map(([p, v]) => `        ${p}% { stroke-dashoffset: ${v}; }`).join("\n") +
  `\n      }`;

const cssPan =
  `      @keyframes boot-splash-pan {\n` +
  panStops.map(([p, v]) => `        ${p}% { transform: translateX(${v}px); }`).join("\n") +
  `\n      }`;

const workerRoads =
  `          var ROADS = {\n` +
  Object.keys(ROADS)
    .map((n) => `            "${n}": [${stopsFor(n).map(([p, v]) => `[${p}, [${v}]]`).join(", ")}],`)
    .join("\n") +
  `\n          };`;

const workerPan = `          var PAN = [${panStops.map(([p, v]) => `[${p}, [${v}]]`).join(", ")}];`;

if (process.argv.includes("--print")) {
  console.log(cssPan + "\n");
  for (const n of Object.keys(ROADS)) console.log(cssRoad(n));
  console.log("\n" + workerPan + "\n" + workerRoads);
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
swap("          var PAN = [", "];", workerPan);
swap("          var ROADS = {", "\n          };", workerRoads);
writeFileSync(TARGET, html);
console.log("boot-splash ramp: patched index.html");
