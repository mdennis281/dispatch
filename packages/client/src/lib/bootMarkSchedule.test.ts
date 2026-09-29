/**
 * The one thing about the canvas renderer that CAN drift, pinned.
 *
 * The boot mark is drawn twice — as SVG driven by `@keyframes` in index.html's
 * <style>, and into an `OffscreenCanvas` by the worker further down the same
 * file. Everything else those two share is shared for real: the geometry is read
 * off the generated SVG at runtime, the colours come from one rotation. The
 * SCHEDULE cannot be, because CSS cannot read a number out of JavaScript.
 *
 * So it is written twice, and this reads BOTH out of index.html and fails if
 * they disagree. Change a keyframe percentage and the worker goes on drawing the
 * old one — the splash would look right for the three seconds anyone watches it
 * and be wrong in a way nothing else would ever catch.
 *
 * Deliberately parsed rather than imported. There is nothing importable here:
 * one side is CSS and the other is a function that only exists to be stringified
 * into a Blob. Parsing is the price of them both being in the document, and the
 * document is where they have to be — see the note over the <style>.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

/** Every stop of one `@keyframes` block, as [percent, declarations]. */
function keyframes(name: string): Array<[number, string]> {
  const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n      \\}`).exec(html);
  if (!block) throw new Error(`no @keyframes ${name} in index.html`);
  const out: Array<[number, string]> = [];
  // `20.57%,\n 32% { … }` is two stops sharing one body.
  const stop = /([\d.%,\s]+?)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = stop.exec(block[1]!))) {
    const body = m[2]!.trim();
    for (const pct of m[1]!.split(",")) {
      const t = pct.trim().replace("%", "");
      if (t) out.push([parseFloat(t), body]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * These are JS literals, not JSON: they carry a bare identifier for the easing
 * and are written over several lines with a trailing comma, both of which
 * `JSON.parse` refuses.
 *
 * ANY SHOUTING IDENTIFIER, not a list of the ones in use today. The list was
 * `LINEAR|SPRING|SINK|LEAVE`, and renaming an easing turned four real
 * comparisons into four parse errors — which at least failed loudly, but failed
 * for the wrong reason and would have been just as easy to "fix" by deleting
 * the tests.
 */
const asJson = (literal: string): string =>
  literal.replace(/\b([A-Z][A-Z_]+)\b/g, '"$1"').replace(/,(\s*[\]}])/g, "$1");

const num = (body: string, prop: string): number | null => {
  const m = new RegExp(`${prop}:\\s*(-?[\\d.]+)`).exec(body);
  return m ? parseFloat(m[1]!) : null;
};
const fn = (body: string, prop: string, f: string): number | null => {
  const m = new RegExp(`${prop}:\\s*${f}\\((-?[\\d.]+)`).exec(body);
  return m ? parseFloat(m[1]!) : null;
};

/** One of the worker's tracks, as [percent, values]. */
function track(name: string): Array<[number, number[]]> {
  const m = new RegExp(`var ${name} = (\\[[\\s\\S]*?\\]);`).exec(html);
  if (!m) throw new Error(`no worker track ${name} in index.html`);
  return (JSON.parse(asJson(m[1]!)) as Array<[number, number[], string?]>).map(([p, v]) => [p, v]);
}

/** The road tracks live in one object literal keyed by phase. */
function roadTrack(phase: string): Array<[number, number[]]> {
  const m = /var ROADS = \{([\s\S]*?)\n          \};/.exec(html);
  if (!m) throw new Error("no worker ROADS in index.html");
  const row = new RegExp(`"${phase}":\\s*(\\[.*?\\]),?\\n`).exec(m[1] + "\n");
  if (!row) throw new Error(`no worker road track ${phase}`);
  return JSON.parse(asJson(row[1]!)) as Array<[number, number[]]>;
}

function objectTrack(table: string, id: string): Array<[number, number[]]> {
  const m = new RegExp(`var ${table} = \\{([\\s\\S]*?)\\n          \\};`).exec(html);
  if (!m) throw new Error(`no worker ${table} in index.html`);
  const row = new RegExp(`^\\s*${id}:\\s*(\\[[\\s\\S]*?\\]),?$`, "m").exec(m[1]!);
  if (!row) throw new Error(`no worker ${table} track ${id}`);
  return (JSON.parse(asJson(row[1]!)) as Array<[number, number[], string?]>).map(([p, v]) => [p, v]);
}
const dotTrack = (id: string) => objectTrack("DOTS", id);
const mixTrack = (id: string) => objectTrack("MIX", id);

/**
 * Both sides are parsed out of a file, so "they match" is worth nothing until
 * you know neither parse silently produced nothing: a regex that stopped
 * matching would give an empty array on BOTH sides and `toEqual` would wave it
 * straight through.
 *
 * Two is the real floor, not a round number chosen to be safe. A track needs a
 * start and an end and nothing else is guaranteed — segment three's branches
 * and dot D only exist in the last stretch of the cycle, so they have three
 * stops where everything else has four or more.
 */
function bothParsed(a: Array<[number, number[]]>, b: Array<[number, number[]]>): void {
  expect(a.length).toBeGreaterThanOrEqual(2);
  expect(b.length).toBeGreaterThanOrEqual(2);
  // And the two must be the same shape, which an empty-vs-empty pass would not
  // have told us either.
  expect(a.length).toBe(b.length);
}

describe("the canvas renderer draws the same schedule as the stylesheet", () => {
  it("pans the frame through the same stops", () => {
    const css = keyframes("boot-splash-pan").map(
      ([p, body]) => [p, [fn(body, "transform", "translateX") ?? 0]] as [number, number[]],
    );
    bothParsed(track("PAN"), css);
    expect(track("PAN")).toEqual(css);
  });

  // Three segments — fork, merge, fork — each with a trunk and a pair of
  // branches timed apart, because the two live fronts have to advance in x
  // together for the mark to keep its width.
  for (const phase of ["s1-trunk", "s1-branch", "s2-trunk", "s2-branch", "s3-trunk", "s3-branch"]) {
    it(`draws road ${phase} through the same stops`, () => {
      const css = keyframes(`boot-splash-road-${phase}`).map(
        ([p, body]) => [p, [num(body, "stroke-dashoffset") ?? 0]] as [number, number[]],
      );
      bothParsed(roadTrack(phase), css);
      expect(roadTrack(phase)).toEqual(css);
    });
  }

  // Opacity, and nothing else: the dots fade rather than springing, so there is
  // no scale to compare. A drift here is the one that would actually be visible.
  //
  // Only the stops that DECLARE opacity, because the crossfading dots now carry
  // `fill`-only stops in the middle of the same block — and CSS interpolates a
  // property across the keyframes that declare IT, which is exactly what the
  // worker's separate tracks reproduce.
  for (const id of ["a", "b", "c", "d"]) {
    it(`fades dot ${id} through the same stops`, () => {
      const css = keyframes(`boot-splash-dot-${id}`)
        .filter(([, body]) => num(body, "opacity") !== null)
        .map(([p, body]) => [p, [num(body, "opacity")!]] as [number, number[]]);
      bothParsed(dotTrack(id), css);
      expect(dotTrack(id)).toEqual(css);
    });
  }

  /**
   * The crossfade, which is the one place a colour changes IN FRONT OF YOU.
   *
   * A held pose is a single colour, so the dot two roads share has to change
   * hands, and it does it over the exchange rather than in a dark window. That
   * makes it a schedule like any other — and one the worker cannot infer, since
   * it picks its fill from a colour bag rather than from `var()`.
   *
   * `fill: var(--c-b)` is 0 and `var(--c-b2)` is 1, the same as the worker's
   * MIX: what is compared is WHEN each dot is wearing which of its two colours.
   */
  for (const id of ["b", "c"]) {
    it(`hands dot ${id} over through the same stops`, () => {
      const css = keyframes(`boot-splash-dot-${id}`)
        .filter(([, body]) => /fill:/.test(body))
        .map(([p, body]) => [p, [/--c-[a-z]2\)/.test(body) ? 1 : 0]] as [number, number[]]);
      bothParsed(mixTrack(id), css);
      expect(mixTrack(id)).toEqual(css);
    });
  }

  /** And the other two must NOT have one — they are only ever one road's end. */
  it("leaves the unshared dots one colour", () => {
    for (const id of ["a", "d"]) {
      expect(keyframes(`boot-splash-dot-${id}`).some(([, b]) => /fill:/.test(b))).toBe(false);
      expect(() => mixTrack(id)).toThrow();
    }
  });

  /**
   * The stop positions agreeing is not the same as the ANIMATION agreeing.
   *
   * The roads are linear from end to end and the worker's `sample()` defaults to
   * linear, so the stylesheet has to say so out loud: CSS's initial value for
   * `animation-timing-function` is `ease`. Rewriting the road keyframes once
   * dropped the declaration and every road silently switched to `ease` — the
   * stops still matched, this file still passed, and the mark breathed by 48% of
   * its width because the two live fronts were no longer advancing together.
   */
  it("draws every road linearly, as the worker does", () => {
    const rule = /\.boot-splash__road \{([\s\S]*?)\n      \}/.exec(html);
    expect(rule, "no .boot-splash__road rule").not.toBeNull();
    expect(rule![1], "roads must declare linear; the initial value is `ease`").toMatch(
      /animation-timing-function:\s*linear/,
    );
    // And no road keyframe may quietly reintroduce a curve.
    for (const phase of ["s1-trunk", "s1-branch", "s2-trunk", "s2-branch", "s3-trunk", "s3-branch"]) {
      const block = new RegExp(`@keyframes boot-splash-road-${phase} \\{([\\s\\S]*?)\\n      \\}`).exec(html);
      expect(block![1]).not.toMatch(/animation-timing-function/);
    }
  });

  /**
   * The pan is the one track that does NOT end where it began, and it has to
   * miss by exactly one reset.
   *
   * At 100% the strip has slid two strides and the seam puts the next cycle's
   * segment one where segment three just was — so 100% and 0% are the same
   * picture 80 units apart, and the keyframes have to say so. They no longer
   * say it by landing on round numbers: the second recoil is still ringing when
   * the cycle wraps, so both ends carry the same leftover and the DIFFERENCE is
   * the only thing that is clean. Get it wrong and the mark jumps once a cycle,
   * forever, by however much you were out.
   */
  it("closes the pan cycle on exactly one reset", () => {
    const css = keyframes("boot-splash-pan");
    const at = (p: number) =>
      fn(css.find(([q]) => q === p)![1], "transform", "translateX")!;
    expect(at(100) - at(0)).toBeCloseTo(-80, 6);
  });

  /**
   * And it must interpolate straight, for the roads' reason and one of its own:
   * the recoil is a damped sine SAMPLED into stops, so a curve applied between
   * them would be a second curve on top of the one already baked in.
   */
  it("pans linearly between its stops", () => {
    const rule = /\.boot-splash__pan \{([\s\S]*?)\n      \}/.exec(html);
    expect(rule, "no .boot-splash__pan rule").not.toBeNull();
    expect(rule![1]).toMatch(/animation: boot-splash-pan var\(--boot-beat\) linear/);
    const block = /@keyframes boot-splash-pan \{([\s\S]*?)\n      \}/.exec(html);
    expect(block![1]).not.toMatch(/animation-timing-function/);
  });

  it("molds the exit over the same duration the stylesheet uses", () => {
    // `moldMs` in the worker's config against `boot-splash-mold`'s duration.
    const cssMs = /animation: boot-splash-mold (\d+)ms/.exec(html);
    const workerMs = /moldMs: (\d+)/.exec(html);
    expect(cssMs).not.toBeNull();
    expect(workerMs).not.toBeNull();
    expect(workerMs![1]).toBe(cssMs![1]);
  });

  it("runs on the same period as --boot-beat", () => {
    const beat = /--boot-beat: (\d+)ms/.exec(html);
    const period = /period: (\d+)/.exec(html);
    expect(beat).not.toBeNull();
    expect(period).not.toBeNull();
    expect(period![1]).toBe(beat![1]);
  });
});
