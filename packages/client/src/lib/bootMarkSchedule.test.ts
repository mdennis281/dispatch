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

/** These are JS literals, not JSON: they are written over several lines with a
 *  trailing comma, which `JSON.parse` refuses. */
const asJson = (literal: string): string =>
  literal.replace(/\b(LINEAR|SPRING|SINK|LEAVE)\b/g, '"$1"').replace(/,(\s*[\]}])/g, "$1");

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

function dotTrack(id: string): Array<[number, number[]]> {
  const m = /var DOTS = \{([\s\S]*?)\n          \};/.exec(html);
  if (!m) throw new Error("no worker DOTS in index.html");
  const row = new RegExp(`${id}:\\s*(\\[[\\s\\S]*?\\]),?\\n`).exec(m[1] + "\n");
  if (!row) throw new Error(`no worker dot track ${id}`);
  return (JSON.parse(asJson(row[1]!)) as Array<[number, number[], string?]>).map(([p, v]) => [p, v]);
}

/**
 * Both sides are parsed out of a file, so "they match" is worth nothing until
 * you know neither parse silently produced nothing. Every track in the loop has
 * at least four stops; a regex that stopped matching would give an empty array
 * on both sides and `toEqual` would wave it straight through.
 */
function bothParsed(a: Array<[number, number[]]>, b: Array<[number, number[]]>): void {
  expect(a.length).toBeGreaterThanOrEqual(4);
  expect(b.length).toBeGreaterThanOrEqual(4);
}

describe("the canvas renderer draws the same schedule as the stylesheet", () => {
  it("pans the frame through the same stops", () => {
    const css = keyframes("boot-splash-pan").map(
      ([p, body]) => [p, [fn(body, "transform", "translateX") ?? 0]] as [number, number[]],
    );
    bothParsed(track("PAN"), css);
    expect(track("PAN")).toEqual(css);
  });

  // `--1a` is the fork's trunk, `--1b` its branches, `--2a` the merge's branches
  // and `--2b` its trunk. Each is drawn out of one anchor and retracted into the
  // next, which is what the four separate schedules encode.
  for (const phase of ["1a", "1b", "2a", "2b"]) {
    it(`draws road ${phase} through the same stops`, () => {
      const css = keyframes(`boot-splash-road-${phase}`).map(
        ([p, body]) => [p, [num(body, "stroke-dashoffset") ?? 0]] as [number, number[]],
      );
      bothParsed(roadTrack(phase), css);
      expect(roadTrack(phase)).toEqual(css);
    });
  }

  // [opacity, scale] — the dots carry all the punctuation in the loop, so a
  // drift here is the one that would actually be visible.
  for (const id of ["a", "b", "c"]) {
    it(`pops dot ${id} through the same stops`, () => {
      const css = keyframes(`boot-splash-dot-${id}`).map(
        ([p, body]) => [p, [num(body, "opacity") ?? 0, fn(body, "transform", "scale") ?? 0]] as [number, number[]],
      );
      bothParsed(dotTrack(id), css);
      expect(dotTrack(id)).toEqual(css);
    });
  }

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
