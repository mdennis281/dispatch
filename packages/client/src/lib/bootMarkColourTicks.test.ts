/**
 * Every colour tick must land while nothing wearing that colour is on screen.
 *
 * The splash re-dyes the mark as it loops, and a variable can only change during
 * a window in which nothing is wearing it — otherwise the recolour happens in
 * front of you. Those windows come from the `@keyframes` in index.html and the
 * ticks come from the script beside them, and until this test existed the only
 * thing keeping the two in agreement was a comment doing the arithmetic by hand.
 *
 * It got the arithmetic wrong. Dot B's window was written down as closing at
 * 2532 — 20.57%, where the branches LAND on the dot — when the dot actually
 * springs open from 17%, at 2457. So its tick sat at 2400 with a believed 132ms
 * of room and a real 57ms, and a timer during boot is 131-362ms late. It missed
 * on every cycle: the two right-hand dots were drawn in the PREVIOUS colour and
 * corrected a frame or two later, which is exactly what it looked like.
 *
 * So the windows are computed from the keyframes here rather than trusted, and
 * every tick is required to clear its edge by a margin no timer is going to eat.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

const PERIOD = Number(/--boot-beat: (\d+)ms/.exec(html)![1]);

/**
 * How much room a tick must leave before whatever it dyes comes back.
 *
 * Measured: with the ticks re-anchored to the clock each cycle they land 0-5ms
 * late once running, but the FIRST one after a start can be ~414ms late if it
 * was armed just before a long task. So the threshold has to clear THAT, not
 * merely beat the 57ms that shipped the bug — a tick placed with 300ms of room
 * would look fine here and still fire on screen during a slow first boot, which
 * is the whole failure this file exists to catch.
 *
 * The tightest margin in the loop is dot B's 507ms, which clears this by 57ms.
 * That is deliberate rather than lucky: dot B's dark window is only 630ms wide,
 * so if a future change needs more room than this allows, the answer is to move
 * the KEYFRAMES rather than to lower the bar.
 */
const MIN_MARGIN_MS = 450;

/**
 * Which keyframes wear each custom property — and for the two dots that change
 * hands mid-cycle, WHICH OF THEIR TWO COLOURS.
 *
 * A held pose is a single colour now, so the dot two roads share crossfades from
 * one to the other across the exchange. That makes "is anything wearing this"
 * finer than "is the element on screen": dot B is lit from 0% to 78% but it has
 * stopped wearing `--c-b` by 43.5%, and that difference is a whole 400ms of room
 * for the tick that re-dyes it.
 */
const WORN_BY: Record<string, Array<{ keyframes: string; fill?: string }>> = {
  "--c-a": [{ keyframes: "boot-splash-dot-a" }],
  "--c-b": [{ keyframes: "boot-splash-dot-b", fill: "--c-b" }],
  "--c-b2": [{ keyframes: "boot-splash-dot-b", fill: "--c-b2" }],
  "--c-c": [{ keyframes: "boot-splash-dot-c", fill: "--c-c" }],
  "--c-c2": [{ keyframes: "boot-splash-dot-c", fill: "--c-c2" }],
  "--c-d": [{ keyframes: "boot-splash-dot-d" }],
  "--c-s1": [{ keyframes: "boot-splash-road-s1-trunk" }, { keyframes: "boot-splash-road-s1-branch" }],
  "--c-s2": [{ keyframes: "boot-splash-road-s2-trunk" }, { keyframes: "boot-splash-road-s2-branch" }],
  "--c-s3": [{ keyframes: "boot-splash-road-s3-trunk" }, { keyframes: "boot-splash-road-s3-branch" }],
  // `--c-ball` is read once, at dismissal, by which time the ticks have stopped.
  // There is no window to respect and nothing wearing it during the loop.
};

/** One stop: whether the element is on screen there, and which fill is in force. */
type Stop = { pct: number; lit: boolean; fill: string | null };

/** Every stop of one keyframes block, sorted. */
function visibility(name: string): Stop[] {
  const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n      \\}`).exec(html);
  if (!block) throw new Error(`no @keyframes ${name}`);
  const rows: Array<{ pct: number; opacity: number | null; dash: number | null; fill: string | null }> = [];
  const stop = /([\d.%,\s]+?)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = stop.exec(block[1]!))) {
    const body = m[2]!;
    const opacity = /opacity:\s*([\d.]+)/.exec(body);
    const dash = /stroke-dashoffset:\s*(-?[\d.]+)/.exec(body);
    const f = /fill:\s*var\((--c-[a-z0-9]+)\)/.exec(body);
    for (const pct of m[1]!.split(",")) {
      const t = pct.trim().replace("%", "");
      if (!t) continue;
      rows.push({
        pct: parseFloat(t),
        opacity: opacity ? parseFloat(opacity[1]!) : null,
        dash: dash ? parseFloat(dash[1]!) : null,
        fill: f ? f[1]! : null,
      });
    }
  }
  rows.sort((a, b) => a.pct - b.pct);

  // A crossfading dot has stops that name only `fill`. CSS interpolates opacity
  // across the stops that declare IT, so that is what this has to do too —
  // read the missing ones off the neighbours rather than treating them as zero.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.opacity !== null) continue;
    let a = i - 1, b = i + 1;
    while (a >= 0 && rows[a]!.opacity === null) a--;
    while (b < rows.length && rows[b]!.opacity === null) b++;
    if (a < 0 || b >= rows.length) continue;
    const [lo, hi] = [rows[a]!, rows[b]!];
    const t = (rows[i]!.pct - lo.pct) / (hi.pct - lo.pct);
    rows[i]!.opacity = lo.opacity! + (hi.opacity! - lo.opacity!) * t;
  }

  let inForce: string | null = null;
  return rows.map((row) => {
    if (row.fill) inForce = row.fill;
    return {
      pct: row.pct,
      // A dot shows when it has any opacity; a road shows while its dash is
      // anywhere between "not yet drawn" (+1.06) and "retracted past its end".
      lit:
        row.opacity !== null
          ? row.opacity > 0
          : row.dash !== null
            ? Math.abs(row.dash) < 1.06
            : false,
      fill: inForce,
    };
  });
}

/**
 * The stretches of the cycle, in ms, during which NOTHING wearing `name` is on
 * screen. An interval between two stops counts as dark only when both ends are
 * dark — anything else is a fade, and a fade is on screen.
 */
function darkWindows(name: string): Array<[number, number]> {
  const lit: Array<[number, number]> = [];
  for (const source of WORN_BY[name]!) {
    const stops = visibility(source.keyframes);
    for (let i = 0; i < stops.length - 1; i++) {
      const [a, b] = [stops[i]!, stops[i + 1]!];
      if (!a.lit && !b.lit) continue;
      // And for a dot that changes hands, this colour has to be one of the two
      // the interval runs BETWEEN. Asking only whether it is in force at either
      // END would light the whole hold before a crossfade starts, which is a
      // colour's widest window written off for no reason.
      if (source.fill && a.fill !== source.fill && b.fill !== source.fill) continue;
      lit.push([(a.pct / 100) * PERIOD, (b.pct / 100) * PERIOD]);
    }
  }
  lit.sort((a, b) => a[0] - b[0]);
  const dark: Array<[number, number]> = [];
  let at = 0;
  for (const [from, to] of lit) {
    if (from > at) dark.push([at, from]);
    at = Math.max(at, to);
  }
  if (at < PERIOD) dark.push([at, PERIOD]);
  return dark;
}

/** Each tick's authored offset and the properties it sets. */
function ticks(): Array<{ at: number; sets: string[] }> {
  const block = /var TICKS = \[([\s\S]*?)\n        \];/.exec(html);
  if (!block) throw new Error("no TICKS in index.html");
  const parts = block[1]!.split(/\bat:\s*(\d+)\s*,/).slice(1);
  const out: Array<{ at: number; sets: string[] }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sets = [...parts[i + 1]!.matchAll(/set\("(--c-[a-z0-9]+)"/g)].map((m) => m[1]!);
    out.push({ at: Number(parts[i]), sets });
  }
  return out;
}

/**
 * How long after `phase` the dark window it sits in stays dark. Negative if it
 * is not in one at all — i.e. the recolour would happen on screen.
 *
 * THE CYCLE IS A LOOP, and getting that wrong is most of the point of this file.
 * Dot B is dark from 1827 to the end of the cycle and on to 357 of the next; as
 * two windows that reads as 273ms of room, and the whole 507ms only appears once
 * they are joined. Measuring against the unjoined pair is a quieter version of
 * the same arithmetic slip that shipped the bug.
 */
function marginAt(name: string, phase: number): number {
  const windows = darkWindows(name);
  if (!windows.length) return -1;
  const first = windows[0]!;
  const last = windows[windows.length - 1]!;
  if (windows.length > 1 && last[1] >= PERIOD && first[0] === 0) {
    windows[windows.length - 1] = [last[0], first[1] + PERIOD];
    windows.shift();
  }
  const p = ((phase % PERIOD) + PERIOD) % PERIOD;
  for (const [from, to] of windows) {
    if (p >= from && p < to) return to - p;
    // The same instant, seen from the previous cycle, for a joined window.
    if (p + PERIOD >= from && p + PERIOD < to) return to - (p + PERIOD);
  }
  return -1;
}

describe("splash colour ticks land while nothing is wearing the colour", () => {
  const all = ticks();

  it("finds every tick and every dyed property", () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
    const dyed = new Set(all.flatMap((t) => t.sets));
    // Guards the parser: if the regexes stop matching, the loop below would be
    // vacuously green.
    for (const name of Object.keys(WORN_BY)) expect(dyed).toContain(name);
  });

  for (const name of Object.keys(WORN_BY)) {
    it(`${name} is re-dyed out of sight, with room to spare`, () => {
      const setters = all.filter((t) => t.sets.includes(name));
      expect(setters.length).toBeGreaterThan(0);
      for (const tick of setters) {
        const margin = marginAt(name, tick.at);
        // A negative margin means the tick fires while the thing is on screen.
        expect(margin, `${name} at ${tick.at}ms is not in a dark window`).toBeGreaterThan(0);
        expect(
          margin,
          `${name} at ${tick.at}ms has only ${Math.round(margin)}ms before it is needed; ` +
            `a timer during boot is routinely later than that`,
        ).toBeGreaterThanOrEqual(MIN_MARGIN_MS);
      }
    });
  }

  it("prepares the seam from a colour that has already been chosen", () => {
    // The ordering that makes the whole thing work. At the seam segment three
    // becomes segment one and dot D becomes dot B, so both have to be dyed from
    // `segment3` — which means AFTER the tick that picks it. Reverse either and
    // the mark is a cycle behind for ever, which no margin would fix.
    const s3 = all.find((t) => t.sets.includes("--c-s3"))!;
    const s1 = all.find((t) => t.sets.includes("--c-s1"))!;
    const b = all.find((t) => t.sets.includes("--c-b"))!;
    expect(s1.at).toBeGreaterThan(s3.at);
    expect(b.at).toBeGreaterThan(s3.at);
  });
});
